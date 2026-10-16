/** Worker-only evidence encoding/IO. Plain CJS so installed runtimes need no TS worker loader. */
const { parentPort, workerData } = require('node:worker_threads');
// Synchronous IO is confined to this isolated thread, avoiding per-write Promise allocation.
const { mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { directory, limits, run } = workerData;
const MiB = 1024 * 1024;
const DAY = 86400000;
let segment;
let lastRetention = -Infinity;
let lastStatus = 0;
let lastDropped = -1;
function encode(entry, stats) {
  const fields = entry.fields;
  const row = {
    version: 1, run, seq: entry.seq, tick: entry.tick, deal: entry.deal, stage: entry.stage,
    monoMs: entry.monoMs, utcMs: entry.utcMs,
    sourceTime: null, sourceTimeUnit: null, sourceTimeStatus: 'UNKNOWN', clockErrorMs: null,
    wireSendMonoMs: null, connection: 'UNKNOWN', path: 'UNKNOWN',
    quantityUnit: 'base', conversion: 'venue-normalized-base', fillIdentity: 'UNKNOWN',
    actualExposureStatus: 'UNKNOWN', ...stats,
  };
  if (fields.reasonCode) row.reasonCode = fields.reasonCode;
  for (const key of ['client', 'order', 'fill', 'cacheKey', 'reason']) {
    if (fields[key] != null) row[key] = fields[key];
  }
  for (const key of ['quantity', 'cumulative', 'aFilled', 'bFilled', 'aReserved', 'bReserved', 'unreserved', 'price', 'actualUnhedged']) {
    const value = fields[key];
    if (value === null || typeof value === 'string' && /^-?\d{1,40}(\.\d{1,18})?$/.test(value)) row[key] = value;
  }
  for (const key of ['leg', 'outcome', 'operation', 'mode', 'policy', 'action', 'errorCategory', 'waitState']) {
    if (typeof fields[key] === 'string' && /^[a-zA-Z-]{1,48}$/.test(fields[key])) row[key] = fields[key];
  }
  if (fields.contract && /^[A-Z0-9_]{1,120}$/.test(fields.contract)) {
    row.market = fields.contract; row.venue = fields.contract.split('_')[0];
  }
  for (const key of ['cacheHit', 'cacheWrittenUtcMs', 'receivedUtcMs', 'cacheResidenceMs', 'startedMonoMs', 'httpStatus', 'waitMs']) {
    if (key === 'waitMs' && fields[key] === null) row[key] = null;
    else if (typeof fields[key] === 'boolean' || typeof fields[key] === 'number' && Number.isFinite(fields[key])) row[key] = fields[key];
  }
  return JSON.stringify(row) + '\n';
}
function retain(kind, incoming, counts) {
  const dir = path.join(directory, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cap = kind === 'details' ? limits.detailBytes : 10 * MiB;
  const age = kind === 'details' ? limits.detailAgeMs : 30 * DAY;
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!/^obs-\d+-[a-f0-9]+-\d+\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    const info = statSync(file);
    entries.push({ file, size: info.size, at: Number(name.split('-')[1]) });
  }
  entries.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  let total = entries.reduce((sum, f) => sum + f.size, 0) + incoming;
  for (const entry of entries) {
    if (entry.at >= Date.now() - age && total <= cap) continue;
    try { unlinkSync(entry.file); }
    catch (error) { counts.rotationFailures++; throw error; }
    if (segment?.file === entry.file) segment = undefined;
    counts.rotations++; total -= entry.size;
  }
  if (incoming > cap) throw new Error('observation batch exceeds disk budget');
}
parentPort.on('message', ({ records, stats, seq, forceStatus }) => {
  const counts = { dropped: 0, writeFailures: 0, rotations: 0, rotationFailures: 0 };
  try {
    const lines = records.map(entry => encode(entry, stats));
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    if (bytes > records.reduce((sum, entry) => sum + entry.cost, 0)) throw new Error('encoded buffer exceeded reservation');
    const segmentLimit = Math.min(MiB, limits.detailBytes);
    if (bytes > segmentLimit) throw new Error('batch exceeds detail capacity');
    const newSegment = bytes > 0 && (!segment || segment.size + bytes > segmentLimit);
    const sweep = performance.now() - lastRetention >= 60000;
    if (newSegment || sweep) {
      retain('details', newSegment ? segmentLimit : bytes, counts);
      if (sweep) { retain('reports', 0, counts); lastRetention = performance.now(); }
    }
    if (bytes) {
      if (!segment || segment.size + bytes > segmentLimit) {
        segment = { file: path.join(directory, 'details', `obs-${Date.now()}-${run}-${seq}.jsonl`), size: 0 };
      }
      const file = openSync(segment.file, 'a', 0o600);
      try { writeFileSync(file, lines.join('')); segment.size += bytes; }
      finally { closeSync(file); }
    }
    if (forceStatus || Date.now() - lastStatus >= 1000 || stats.dropped !== lastDropped) {
      const statusFile = path.join(directory, 'status.json');
      writeFileSync(statusFile + '.tmp', JSON.stringify({ run, seq, ...stats,
        rotations: stats.rotations + counts.rotations }), { mode: 0o600 });
      renameSync(statusFile + '.tmp', statusFile);
      lastStatus = Date.now(); lastDropped = stats.dropped;
    }
  } catch {
    counts.writeFailures++; counts.dropped += records.length;
  }
  parentPort.postMessage(counts);
});
