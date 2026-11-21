import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { Component } from '../manifest/pins.ts';
import { gateKey, pruneGateCache, readGateCache, saveGateCache } from './gate-cache.ts';
import type { GateResult } from './validate.ts';

const component = Component.parse({
  id: 'appliance-manager',
  repository: 'whombat-appliance',
  source: '/repo',
  ref: 'main',
  commit: 'a'.repeat(40),
  version: '1',
  gates: [{ id: 'go-test', run: ['go', 'test', '-count=1', './...'] }],
});
const gate = component.gates[0];
if (!gate) throw new Error('missing test gate');
const setup = { go: 'go1.26', postgres: 'sha256:postgres', runner: 'runner' };
const now = Date.parse('2026-09-30T10:00:00Z');
let root: string;
let result: GateResult;

beforeEach(() => {
  root = mkdtempSync(join(TMP_DIR, 'gate-cache-test-'));
  const log = join(root, 'source.log');
  writeFileSync(log, 'ok package\n[exit 0]\n');
  result = {
    component: component.id,
    repository: component.repository,
    commit: component.commit,
    gate: gate.id,
    command: gate.run.join(' '),
    cwd: gate.cwd,
    outcome: 'passed',
    exitCode: 0,
    durationMs: 225000,
    log,
    summary: 'go: 1 package ok',
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('successful gate receipts', () => {
  it('keys exact source, command, environment, timeout and tools independent of object property order', () => {
    const key = gateKey(component, gate, setup);
    expect(gateKey(component, { ...gate, env: { B: '2', A: '1' } }, setup)).toBe(
      gateKey(component, { ...gate, env: { A: '1', B: '2' } }, setup),
    );
    expect(gateKey(component, gate, { runner: 'runner', postgres: 'sha256:postgres', go: 'go1.26' })).toBe(
      key,
    );
    for (const c of [
      { ...component, commit: 'b'.repeat(40) },
      { ...component, repository: 'Whombat' as const },
    ])
      expect(gateKey(c, gate, setup)).not.toBe(key);
    for (const g of [
      { ...gate, run: ['go', 'test', '-race', './...'] },
      { ...gate, cwd: 'backup' },
      { ...gate, env: { WB_REST_SERVER: 'other' } },
      { ...gate, timeoutS: 1 },
      { ...gate, needsPostgres: true },
    ])
      expect(gateKey(component, g, setup)).not.toBe(key);
    for (const field of Object.keys(setup))
      expect(gateKey(component, gate, { ...setup, [field]: 'changed' })).not.toBe(key);
  });

  it('keeps successful evidence and permissions, and does not reset its age on a cache hit', () => {
    const key = gateKey(component, gate, setup);
    saveGateCache(root, key, result, now);
    expect(readGateCache(root, key, now + 1000)).toMatchObject({
      finishedAt: new Date(now).toISOString(),
      durationMs: 225000,
      summary: result.summary,
    });
    expect(readFileSync(join(root, key, 'log'), 'utf8')).toBe(readFileSync(result.log, 'utf8'));
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, key, 'receipt.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, key, 'log')).mode & 0o777).toBe(0o600);
    saveGateCache(root, key, result, now + 1000);
    expect(readGateCache(root, key, now + 1000)?.finishedAt).toBe(new Date(now).toISOString());
  });

  it.each(['failed', 'timeout', 'not-run'] as const)('does not cache %s', (outcome) => {
    const key = gateKey(component, gate, setup);
    saveGateCache(root, key, { ...result, outcome }, now);
    expect(readGateCache(root, key, now)).toBeNull();
    saveGateCache(root, key, { ...result, exitCode: 1 }, now);
    expect(readGateCache(root, key, now)).toBeNull();
  });

  it('rejects future, expired, malformed and tampered evidence', () => {
    const key = gateKey(component, gate, setup);
    saveGateCache(root, key, result, now);
    expect(readGateCache(root, key, now - 1)).toBeNull();
    expect(readGateCache(root, key, now + 7 * 86400000 + 1)).toBeNull();
    writeFileSync(join(root, key, 'log'), 'changed');
    expect(readGateCache(root, key, now)).toBeNull();
    saveGateCache(root, key, result, now);
    writeFileSync(join(root, key, 'receipt.json'), '{}');
    expect(readGateCache(root, key, now)).toBeNull();
    saveGateCache(root, key, result, now);
    const receipt = readGateCache(root, key, now);
    if (!receipt) throw new Error('missing successful receipt');
    writeFileSync(join(root, key, 'receipt.json'), JSON.stringify({ ...receipt, key: 'f'.repeat(64) }));
    expect(readGateCache(root, key, now)).toBeNull();
  });

  it('invalidates an older success when the same gate fails on a fresh rerun', () => {
    const key = gateKey(component, gate, setup);
    saveGateCache(root, key, result, now);
    expect(readGateCache(root, key, now)).not.toBeNull();
    saveGateCache(root, key, { ...result, outcome: 'failed', exitCode: 1 }, now + 1000);
    expect(readGateCache(root, key, now + 1000)).toBeNull();
  });

  it('prunes expired evidence while preserving unrelated files', () => {
    const key = gateKey(component, gate, setup);
    saveGateCache(root, key, result, now);
    const freshKey = gateKey({ ...component, commit: 'b'.repeat(40) }, gate, setup);
    saveGateCache(root, freshKey, result, now + 86400000);
    pruneGateCache(root, now + 7 * 86400000 + 1);
    expect(readGateCache(root, key, now)).toBeNull();
    expect(readGateCache(root, freshKey, now + 7 * 86400000 + 1)).not.toBeNull();
    expect(readFileSync(result.log, 'utf8')).toContain('[exit 0]');
  });
});
