/**
 * Installers never hand an upgraded ledger back to an older program (ticket
 * 20). The storage barrier already keeps such a program from booting; this is
 * the installer saying so instead of "rolling back" into a dead service.
 * install.sh runs for real under bash; install.ps1 is checked statically —
 * no PowerShell here, so its runtime behavior is unverified on this host.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEDGER_VERSION } from '../../src/engine/ledger/version';

const read = (f: string): string => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';

function shFunction(sh: string, name: string): string {
  const start = sh.indexOf(`\n${name}() {`);
  expect(start, `${name} is gone from install.sh`).toBeGreaterThan(0);
  return sh.slice(start, sh.indexOf('\n}', start) + 2);
}

function psFunction(ps: string, name: string): string {
  const start = ps.indexOf(`\nfunction ${name} {`);
  expect(start, `${name} is gone from install.ps1`).toBeGreaterThan(0);
  return ps.slice(start, ps.indexOf('\n}', start) + 2);
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run install.sh's restore_app against a temp root whose service steps
 * succeed, so only the ledger decides the outcome. */
function restore(opts: { marker?: string; support?: string }): { status: number | null; err: string; app: string; old: boolean } {
  const t = mkdtempSync(join(tmpdir(), 'ledger-rollback-'));
  dirs.push(t);
  const root = join(t, 'root');
  for (const d of ['app', 'app.old', 'data']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'app', 'VERSION'), 'new');
  writeFileSync(join(root, 'app.old', 'VERSION'), 'old');
  if (opts.marker !== undefined) writeFileSync(join(root, 'data', 'ledger-version.json'), opts.marker);
  if (opts.support !== undefined) writeFileSync(join(root, 'app.old', 'ledger-support.json'), opts.support);
  const sh = read('install.sh');
  const script = [
    'set -euo pipefail',
    `ROOT='${root}'`,
    `LOG_DIR='${t}'`,
    'PORT=7792',
    'install_service() { :; }',
    'wait_for_server() { :; }',
    shFunction(sh, 'ledger_blocks_rollback'),
    shFunction(sh, 'restore_app'),
    'restore_app',
  ].join('\n');
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8' });
  return {
    status: r.status,
    err: r.stderr,
    app: readFileSync(join(root, 'app', 'VERSION'), 'utf8'),
    old: existsSync(join(root, 'app.old')),
  };
}

const marker = (version: unknown) => `${JSON.stringify({ version }, null, 2)}\n`;

describe('install.sh restore_app', () => {
  it('refuses to put back a program that predates the ledger version, and moves nothing', () => {
    const r = restore({ marker: marker(1) });
    expect(r.status).toBe(1);
    expect(r.err).toContain('Not rolling back: the new version already upgraded the trade ledger');
    expect(r.err).not.toContain('Rolling back to the previous version');
    expect(r.app).toBe('new');
    expect(r.old).toBe(true);
  });

  it('treats an unreadable marker as upgraded', () => {
    expect(restore({ marker: '{"version": "?"}' }).status).toBe(1);
  });

  it.each([
    ['no marker (the new version never upgraded)', {}],
    ['a version-0 ledger', { marker: marker(0) }],
    ['a program that declares it supports the version', { marker: marker(1), support: '{\n  "maxLedgerVersion": 1\n}\n' }],
  ])('rolls back with %s', (_name, opts) => {
    const r = restore(opts);
    expect(r.status).toBe(0);
    expect(r.err).toContain('Rolling back to the previous version');
    expect(r.app).toBe('old');
  });
});

describe('install.ps1 Restore-App', () => {
  const ps = read('install.ps1');

  it('asks the ledger before it stops or moves anything', () => {
    const fn = psFunction(ps, 'Restore-App');
    const check = fn.indexOf('if (Test-LedgerBlocksRollback) {');
    expect(check).toBeGreaterThan(0);
    for (const later of ['Unregister-ScheduledTask', 'Stop-StaleServer', 'Move-Item']) {
      expect(fn.indexOf(later)).toBeGreaterThan(check);
    }
    expect(fn.slice(check, fn.indexOf('}', check))).toMatch(/return \$false/);
  });

  it('reads the same marker and declaration as install.sh, and fails closed on a bad marker', () => {
    const fn = psFunction(ps, 'Test-LedgerBlocksRollback');
    expect(fn).toContain("Join-Path $Root 'data\\ledger-version.json'");
    expect(fn).toContain("Join-Path $Root 'app.old\\ledger-support.json'");
    expect(fn).toMatch(/catch \{ return \$true \}/);
    expect(fn).toMatch(/return \$have -gt \$old/);
  });
});

describe('ledger-support.json', () => {
  it('declares exactly the ledger version this program migrates to', () => {
    expect(JSON.parse(read('ledger-support.json'))).toEqual({ maxLedgerVersion: LEDGER_VERSION });
  });
});
