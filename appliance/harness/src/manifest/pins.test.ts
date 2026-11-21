import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Component, loadPins, rootIn, treeIn } from './pins.ts';

describe('a component that is a folder of its repository (control and the relay in whombat-cloud)', () => {
  const commit = 'c'.repeat(40);

  it('has its root in its folder when the checkout holds it there', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'pins-dir-'));
    mkdirSync(join(checkout, 'control'));
    expect(rootIn(checkout, { dir: 'control' })).toBe(join(checkout, 'control'));
    expect(treeIn(checkout, { dir: 'control', commit })).toBe(`${commit}:control`);
  });

  it('is the whole checkout at a commit from before it moved there, and without a folder', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'pins-dir-'));
    expect(rootIn(checkout, { dir: 'control' })).toBe(checkout);
    expect(treeIn(checkout, { dir: 'control', commit })).toBe(commit);
    expect(rootIn(checkout, {})).toBe(checkout);
  });

  it('takes a folder name, never a path out of the repository', () => {
    const base = {
      id: 'whombat-api',
      repository: 'whombat-api',
      source: '~/Code/whombat-cloud',
      ref: 'main',
      commit,
      version: '0.1.0',
    };
    expect(Component.parse({ ...base, dir: 'control' }).dir).toBe('control');
    expect(Component.parse(base).dir).toBeUndefined();
    expect(() => Component.parse({ ...base, dir: '../x' })).toThrow();
    expect(() => Component.parse({ ...base, dir: 'a/b' })).toThrow();
  });

  it('is how the pins name control and the relay, under the names the contracts know', () => {
    const byId = new Map(loadPins().components.map((c) => [c.id, c]));
    for (const [id, dir] of [
      ['whombat-api', 'control'],
      ['whombat-relay', 'relay'],
    ] as const) {
      const c = byId.get(id);
      expect(c?.repository).toBe(id);
      expect(c?.dir).toBe(dir);
      // The remote is informational, and pins made from the component list name none (the list holds no address).
      if (c?.remote) expect(c.remote).toContain('whombat-cloud');
      expect(c?.live?.endsWith(`/whombat-cloud/${dir}`)).toBe(true);
    }
  });
});
