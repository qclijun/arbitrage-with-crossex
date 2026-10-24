#!/usr/bin/env node
// Token budget guard: keeps committed text files small enough for an agent to
// read in one pass. Runs from the pre-commit hook (staged files only) and from
// CI (`--all`). Zero dependencies on purpose: a hook that needs a toolchain is
// a hook people disable.
//
// Estimate: tokens ~= asciiChars / 4 + nonAsciiChars * 1.2
//   English prose runs about 4 chars per token; CJK runs about 1 token per
//   character, so the 1.2 factor is deliberately conservative. Both numbers are
//   approximations of a tokenizer we do not have. Precision is not the point --
//   catching the 10x outlier is.
//
// Usage:
//   node scripts/check-file-size.mjs --staged            # hook: staged files
//   node scripts/check-file-size.mjs --all               # audit every tracked file
//   node scripts/check-file-size.mjs --all --strict      # ignore the baseline
//   node scripts/check-file-size.mjs --update-baseline   # lower/drop entries only
//   node scripts/check-file-size.mjs --update-baseline --allow-growth
//                                                        # also add or raise entries
//
// Exit codes: 0 pass, 1 budget exceeded, 2 setup/IO error.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CONFIG_FILE = '.token-budget.json';
const BASELINE_FILE = '.token-budget-baseline.json';

const DEFAULT_CONFIG = {
  limit: 5000,
  allow: [],
  ignore: [
    'yarn.lock',
    'package-lock.json',
    'pnpm-lock.yaml',
    'bun.lockb',
    'Cargo.lock',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',
    'composer.lock',
    'Gemfile.lock',
    'go.sum',
    '**/dist/**',
    '**/build/**',
    '**/generated/**',
    '**/__generated__/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/*.snap',
    '**/*.pb.go',
    '**/*.g.dart',
    '**/*.d.ts',
    '**/vendor/**',
    '**/third_party/**',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.gif',
    '**/*.webp',
    '**/*.ico',
    '**/*.pdf',
    '**/*.zip',
    '**/*.gz',
    '**/*.woff',
    '**/*.woff2',
    '**/*.ttf',
    '**/*.mp3',
    '**/*.mp4',
    '**/*.wasm',
  ],
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);

function git(args, options = {}) {
  return execFileSync('git', args, { maxBuffer: 1 << 28, ...options });
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(red(`cannot parse ${CONFIG_FILE}: ${error.message}`));
    process.exit(2);
  }
  return {
    limit: Number.isFinite(parsed.limit) ? parsed.limit : DEFAULT_CONFIG.limit,
    ignore: [...DEFAULT_CONFIG.ignore, ...(parsed.ignore ?? [])],
    allow: parsed.allow ?? [],
  };
}

// Minimal glob support: `**` crosses path separators, `*` and `?` do not.
// Patterns without a slash are matched against the basename, so "yarn.lock"
// covers every nested copy.
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*' && glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return { regexp: new RegExp(`^${source}$`), basenameOnly: !glob.includes('/') };
}

function buildMatcher(patterns) {
  const compiled = patterns.map(globToRegExp);
  return (filePath) => {
    const base = path.basename(filePath);
    return compiled.some(({ regexp, basenameOnly }) =>
      basenameOnly ? regexp.test(base) : regexp.test(filePath),
    );
  };
}

const BINARY_PROBE_BYTES = 8000;

// A NUL byte in the first block is the same heuristic git uses for binary.
function looksBinary(buffer) {
  return buffer.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

function estimateTokens(buffer) {
  if (looksBinary(buffer)) return null;
  const text = buffer.toString('utf8');
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return { tokens: Math.ceil(ascii / 4 + other * 1.2), lines: text.split('\n').length };
}

function stagedPaths(root) {
  const raw = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  return raw.split('\0').filter(Boolean);
}

// Reads every requested blob from the index in one git process. `git show :p`
// per file would fork hundreds of times and make the hook noticeably slow.
function stagedBlobs(root, files) {
  if (files.length === 0) return [];
  const input = files.map((file) => `:${file}`).join('\n') + '\n';
  let raw;
  try {
    raw = git(['cat-file', '--batch'], { cwd: root, input });
  } catch {
    // Falls back to the worktree copy, which differs from the index when a file
    // is only partially staged. Rare enough to accept over failing the commit.
    return files.map((file) => ({ file, buffer: readFileSync(path.join(root, file)) }));
  }
  const blobs = [];
  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = raw.subarray(offset, newline).toString('utf8');
    if (header.endsWith(' missing')) {
      offset = newline + 1;
      continue;
    }
    const [, , sizeText] = header.split(' ');
    const size = Number(sizeText);
    const start = newline + 1;
    blobs.push(raw.subarray(start, start + size));
    offset = start + size + 1;
  }
  if (blobs.length !== files.length) {
    // Paths containing newlines break the batch protocol; fall back to per-file reads.
    return files.map((file) => ({ file, buffer: readFileSync(path.join(root, file)) }));
  }
  return blobs.map((buffer, index) => ({ file: files[index], buffer }));
}

function readHead(absolute) {
  const fd = openSync(absolute, 'r');
  try {
    const head = Buffer.alloc(BINARY_PROBE_BYTES);
    const read = readSync(fd, head, 0, BINARY_PROBE_BYTES, 0);
    return head.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function worktreeBlobs(root, files) {
  const out = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size <= 4 * 1024 * 1024) {
      out.push({ file, buffer: readFileSync(absolute) });
      continue;
    }
    // Multi-megabyte file: probe only the head, so a binary is still skipped
    // and only large text is estimated from its byte size.
    if (looksBinary(readHead(absolute))) continue;
    out.push({ file, buffer: null, oversized: stat.size });
  }
  return out;
}

function loadBaseline(root) {
  const file = path.join(root, BASELINE_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')).files ?? {};
  } catch {
    return {};
  }
}

// A file already over budget must stay editable: fixing a bug there should not
// require splitting it first. Allow a small drift above the recorded size, but
// not unlimited growth -- that is the ratchet.
function baselineTolerance(recorded) {
  return Math.max(500, Math.ceil(recorded * 0.02));
}

function writeBaseline(root, entries) {
  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
  const payload = {
    comment:
      'Files already over the token budget. Each may grow at most max(500, 2%) tokens above its entry. `node scripts/check-file-size.mjs --update-baseline` only lowers or drops entries; adding or raising one needs --allow-growth.',
    files: sorted,
  };
  writeFileSync(path.join(root, BASELINE_FILE), JSON.stringify(payload, null, 2) + '\n');
}

function parseArgs(argv) {
  const updateBaseline = argv.includes('--update-baseline');
  return {
    // Recording a baseline only makes sense against the whole tree, so it
    // implies --all instead of quietly capturing just the staged files.
    mode: updateBaseline || argv.includes('--all') ? 'all' : 'staged',
    strict: argv.includes('--strict'),
    updateBaseline,
    allowGrowth: argv.includes('--allow-growth'),
  };
}

function splitHint(file, tokens, limit) {
  const ext = path.extname(file);
  const pieces = Math.ceil(tokens / limit);
  if (ext === '.md') {
    return [
      `Keep a short index page and move each top-level section into its own`,
      `file, linked from the index. About ${pieces} pages of <= ${limit} tokens.`,
    ];
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'].includes(ext)) {
    return [
      `Group related symbols into sibling modules and re-export them from the`,
      `existing entry point so callers do not change. About ${pieces} modules.`,
      `List the current top-level symbols with:`,
      ext === '.py'
        ? `    rg '^(class|def) ' ${file}`
        : `    rg '^export (async )?(function|class|const|interface|type|enum) ' ${file}`,
    ];
  }
  if (ext === '.json') {
    return [
      `Large literal data belongs in a dedicated fixture file that the source`,
      `imports, or should be generated at build time. About ${pieces} chunks.`,
    ];
  }
  return [`Split by responsibility into about ${pieces} files.`];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const config = loadConfig(root);
  const ignored = buildMatcher(config.ignore);
  const allowed = buildMatcher(config.allow);
  const limit = config.limit;

  const candidates = args.mode === 'all' ? git(['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean) : stagedPaths(root);
  const targets = candidates.filter((file) => !ignored(file) && !allowed(file));

  const entries = args.mode === 'all' ? worktreeBlobs(root, targets) : stagedBlobs(root, targets);

  const measured = [];
  for (const entry of entries) {
    if (entry.buffer === null) {
      const approx = Math.ceil(entry.oversized / 2);
      measured.push({ file: entry.file, tokens: approx, lines: 0, approximate: true });
      continue;
    }
    const result = estimateTokens(entry.buffer);
    if (result === null) continue;
    measured.push({ file: entry.file, tokens: result.tokens, lines: result.lines });
  }

  // The ratchet: by default an update may only lower or drop entries. Files no
  // longer measured (deleted, ignored, under budget) fall out of the baseline.
  // Adding a file or raising an entry is debt growth and must be asked for.
  if (args.updateBaseline) {
    const previous = loadBaseline(root);
    const next = {};
    const refused = [];
    for (const item of measured) {
      if (item.tokens <= limit) continue;
      const recorded = previous[item.file];
      if (args.allowGrowth || (recorded !== undefined && item.tokens <= recorded)) {
        next[item.file] = item.tokens;
      } else {
        if (recorded !== undefined) next[item.file] = recorded;
        refused.push({ ...item, recorded });
      }
    }
    writeBaseline(root, next);
    console.log(
      green(`baseline recorded: ${Object.keys(next).length} file(s) over ${limit} tokens in ${BASELINE_FILE}`),
    );
    if (refused.length === 0) return 0;
    console.error('');
    console.error(red(bold(`not recorded: ${refused.length} file(s) would add or raise debt`)));
    for (const item of refused) {
      const label =
        item.recorded !== undefined ? `kept at ${item.recorded}` : 'new over-budget file';
      console.error(`  ${item.file}  ${item.tokens} tok  ${yellow(label)}`);
    }
    console.error(dim('Split these files, or re-run with --allow-growth if the growth is intentional.'));
    return 1;
  }

  const baseline = args.strict ? {} : loadBaseline(root);
  const violations = [];
  for (const item of measured) {
    const recorded = baseline[item.file];
    if (item.tokens <= limit) continue;
    if (recorded !== undefined && item.tokens <= recorded + baselineTolerance(recorded)) continue;
    violations.push({ ...item, recorded });
  }

  const healed = Object.keys(baseline).filter(
    (file) =>
      !measured.some((item) => item.file === file && item.tokens > limit) &&
      args.mode === 'all',
  );

  if (violations.length === 0) {
    console.log(green(`token budget ok: ${measured.length} file(s) checked, limit ${limit} tokens`));
    if (healed.length > 0) {
      console.log(
        dim(
          `${healed.length} baseline entr(ies) are now under budget; drop them with: ` +
            `node scripts/check-file-size.mjs --update-baseline`,
        ),
      );
    }
    return 0;
  }

  violations.sort((a, b) => b.tokens - a.tokens);

  const width = Math.min(
    60,
    violations.reduce((max, item) => Math.max(max, item.file.length), 0) + 2,
  );

  console.error('');
  console.error(red(bold(`token budget exceeded: ${violations.length} file(s) over ${limit} tokens`)));
  console.error('');
  for (const item of violations) {
    const label =
      item.recorded !== undefined
        ? `grew from ${item.recorded} (+${baselineTolerance(item.recorded)} allowed)`
        : 'new over-budget file';
    const detail = item.approximate || item.lines === 0 ? '' : `, ${item.lines} lines`;
    console.error(
      `  ${item.file.padEnd(width)} ${String(item.tokens).padStart(7)} tok${detail}  ${yellow(label)}`,
    );
  }
  console.error('');
  console.error('Why this matters');
  console.error(
    dim(
      '  A file over the budget cannot be read in one pass, so an agent either\n' +
        '  skips it, reads it in fragments, or burns context reconstructing it.',
    ),
  );
  console.error('');
  console.error('How to fix');
  console.error('  1. Split by responsibility (preferred).');
  for (const item of violations.slice(0, 5)) {
    console.error(`     ${item.file}`);
    for (const line of splitHint(item.file, item.tokens, limit)) console.error(`       ${dim(line)}`);
  }
  if (violations.length > 5) {
    console.error(dim(`     ... and ${violations.length - 5} more, same approach`));
  }
  console.error('  2. If a tool generates the file, ignore it instead of splitting it:');
  console.error(`     add a glob to "ignore" in ${CONFIG_FILE}`);
  console.error('  3. If the growth is intentional, record it as debt (say why in the commit):');
  console.error('     node scripts/check-file-size.mjs --update-baseline --allow-growth');
  console.error('');
  console.error(
    dim(
      'Do not reflow code onto long lines or minify it to dodge the estimate;\n' +
        'the budget is about how much a reader has to hold, not about layout.',
    ),
  );
  console.error('');
  return 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(red(`token budget check failed to run: ${error.message}`));
  process.exit(2);
}
