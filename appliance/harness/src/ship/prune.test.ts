import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { holdIfFree, prunePlan, pruneReleases, RECENT_MS, type ReleaseDir, unionListed } from './prune.ts';

const NOW = Date.parse('2026-11-26T20:00:00Z');
const OLD = NOW - 3 * RECENT_MS;

/** A host release (its own host) or a runtime-only one on `host`. */
const dir = (id: string, o: Partial<ReleaseDir> = {}): ReleaseDir => ({
  id,
  host: id,
  iso: false,
  modifiedAt: OLD,
  ...o,
});
const days = (from: number, to: number, n: number) => {
  const out: string[] = [];
  for (let d = from; d <= to; d++) for (let i = 1; i <= n; i++) out.push(`whombat-202611${d}.${i}`);
  return out;
};

describe('prunePlan', () => {
  const rules = (o: Partial<Parameters<typeof prunePlan>[1]> = {}) => ({
    listed: { beta: [], production: [] },
    keep: 3,
    now: NOW,
    ...o,
  });

  it('keeps what a channel lists, the build before each, the newest and what changed today', () => {
    const ids = days(10, 14, 3); // 20261110.1 … 20261114.3
    const dirs = ids.map((id) => dir(id, { modifiedAt: id === 'whombat-20261110.2' ? NOW - 1000 : OLD }));
    const p = prunePlan(
      dirs,
      rules({
        listed: { beta: ['whombat-20261112.3', 'whombat-20261113.1'], production: ['whombat-20261111.2'] },
      }),
    );
    expect([...p.keep.keys()].sort()).toEqual(
      [
        'whombat-20261110.2', // changed in the last day
        'whombat-20261111.1', // before Production's
        'whombat-20261111.2', // Production
        'whombat-20261112.2', // before Beta's
        'whombat-20261112.3', // Beta, and before the next Beta one
        'whombat-20261113.1', // Beta
        'whombat-20261114.1', // the newest three
        'whombat-20261114.2',
        'whombat-20261114.3',
      ].sort(),
    );
    expect(p.keep.get('whombat-20261111.2')).toBe('in Production');
    expect(p.remove).toContain('whombat-20261110.1');
    expect(p.remove).toContain('whombat-20261113.3');
    // Oldest first.
    expect(p.remove[0]).toBe('whombat-20261110.1');
  });

  it('keeps the host of everything kept, however old', () => {
    const dirs = [
      dir('whombat-20261101.1'),
      dir('whombat-20261101.2'),
      dir('whombat-20261110.1'),
      dir('whombat-20261120.1', { host: 'whombat-20261101.2' }),
      dir('whombat-20261120.2', { host: 'whombat-20261101.2' }),
    ];
    const p = prunePlan(dirs, rules({ keep: 1, listed: { beta: ['whombat-20261120.1'], production: [] } }));
    expect(p.keep.get('whombat-20261101.2')).toBe('the host of whombat-20261120.1');
    expect(p.keep.get('whombat-20261110.1')).toBe('the build before whombat-20261120.1');
    expect(p.remove).toEqual(['whombat-20261101.1']);
  });

  it('removes the DEV twins and failed builds, and never counts them as the build before', () => {
    const dirs = [
      dir('whombat-dev-20261118.1'),
      dir('whombat-20261118.1'),
      dir('whombat-dev-20261119.1'),
      dir('whombat-20261119.1', { host: null }), // no build.json
      dir('whombat-20261120.1'),
    ];
    const p = prunePlan(dirs, rules({ keep: 1, listed: { beta: ['whombat-20261120.1'], production: [] } }));
    expect([...p.keep.keys()].sort()).toEqual(['whombat-20261119.1', 'whombat-20261120.1']);
    expect([...p.remove].sort()).toEqual([
      'whombat-20261118.1',
      'whombat-dev-20261118.1',
      'whombat-dev-20261119.1',
    ]);
  });

  it("drops an ISO unless it is Production's newest, the one before, or Beta's newest's host", () => {
    const dirs = [
      dir('whombat-20261120.1', { iso: true }),
      dir('whombat-20261121.1', { iso: true }),
      dir('whombat-20261122.1', { iso: true }),
      dir('whombat-20261123.1', { iso: true }),
      dir('whombat-20261124.1', { iso: true }),
      dir('whombat-20261125.1', { host: 'whombat-20261124.1' }),
      dir('whombat-20261126.1', { iso: true, modifiedAt: NOW - 1000 }),
    ];
    const p = prunePlan(
      dirs,
      rules({
        keep: 10,
        listed: {
          production: ['whombat-20261120.1', 'whombat-20261122.1', 'whombat-20261123.1'],
          beta: ['whombat-20261123.1', 'whombat-20261125.1'],
        },
      }),
    );
    expect(p.remove).toEqual([]);
    expect(p.dropIso).toEqual(['whombat-20261120.1', 'whombat-20261121.1']);
  });

  it('touches nothing that is no release id', () => {
    const p = prunePlan([dir('whombat-20261120.1')], rules({ keep: 0 }));
    expect(p.remove).toEqual(['whombat-20261120.1']);
    expect(prunePlan([], rules()).remove).toEqual([]);
  });
});

describe('unionListed', () => {
  it('joins the sources and refuses without a list of each channel', () => {
    expect(unionListed([{ beta: ['a'], production: null }])).toBeNull();
    expect(
      unionListed([
        { beta: ['a'], production: null },
        { beta: ['a', 'b'], production: [] },
      ]),
    ).toEqual({ beta: ['a', 'b'], production: [] });
  });
});

describe('pruneReleases on disk', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'prune-releases-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const old = (p: string) => utimesSync(p, OLD / 1000, OLD / 1000);

  /** A release folder with blobs linked from the nar cache, a GC root and optionally an ISO. */
  const make = (id: string, blobs: string[], o: { host?: string; iso?: boolean } = {}) => {
    const d = join(root, id);
    mkdirSync(join(d, 'release', 'nar'), { recursive: true });
    mkdirSync(join(d, 'gcroots'));
    symlinkSync('/nix/store/does-not-exist', join(d, 'gcroots', 'runtime'));
    for (const b of blobs) {
      const cached = join(root, 'nar', b);
      if (!existsSync(cached)) {
        writeFileSync(cached, 'x'.repeat(1000));
        old(cached);
      }
      linkSync(cached, join(d, 'release', 'nar', b));
    }
    writeFileSync(join(d, 'build.json'), JSON.stringify({ tuple: { host: { version: o.host ?? id } } }));
    if (o.iso) {
      mkdirSync(join(d, 'iso'));
      writeFileSync(join(d, 'iso', 'x.iso'), 'i'.repeat(5000));
      writeFileSync(join(d, 'iso.json'), JSON.stringify({ file: 'x.iso' }));
    }
    old(d);
  };

  it('removes folders, ISOs and the blobs only they linked; a dry run removes nothing', () => {
    mkdirSync(join(root, 'nar'));
    make('whombat-20261110.1', ['a', 'b'], { iso: true });
    make('whombat-20261111.1', ['b', 'c'], { iso: true });
    make('whombat-20261112.1', ['c', 'd'], { host: 'whombat-20261111.1' });
    make('whombat-dev-20261112.1', ['e']);
    mkdirSync(join(root, 'whombat-community-20261112.1'));
    const listed = { beta: ['whombat-20261112.1'], production: [] };

    const dry = pruneReleases(root, { listed, keep: 1, now: NOW, dryRun: true });
    expect(dry.plan.remove).toEqual(['whombat-20261110.1', 'whombat-dev-20261112.1']);
    expect(dry.plan.dropIso).toEqual([]); // Beta's newest runs on 11.1's host
    expect({ folders: dry.folders, gcRoots: dry.gcRoots, blobs: dry.blobs, isos: dry.isos }).toEqual({
      folders: 2,
      gcRoots: 2,
      blobs: 2, // a and e; b is still linked by 11.1
      isos: 0,
    });
    // 10.1's ISO, its build.json, and the blobs a and e.
    expect(dry.bytes).toBeGreaterThanOrEqual(5000 + 2000);
    expect(existsSync(join(root, 'whombat-20261110.1'))).toBe(true);
    expect(existsSync(join(root, 'nar', 'a'))).toBe(true);

    const real = pruneReleases(root, { listed, keep: 1, now: NOW, dryRun: false });
    expect(real.bytes).toBe(dry.bytes);
    expect(existsSync(join(root, 'whombat-20261110.1'))).toBe(false);
    expect(existsSync(join(root, 'whombat-dev-20261112.1'))).toBe(false);
    expect(existsSync(join(root, 'whombat-community-20261112.1'))).toBe(true);
    expect(['a', 'b', 'c', 'd', 'e'].map((b) => existsSync(join(root, 'nar', b)))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(existsSync(join(root, 'whombat-20261111.1', 'iso.json'))).toBe(true);

    // Beta moves on to a host release of its own: 12.1 stays as the build before it, with its host 11.1, whose ISO
    // goes.
    make('whombat-20261113.1', ['d']);
    const later = pruneReleases(root, {
      listed: { beta: ['whombat-20261113.1'], production: [] },
      keep: 1,
      now: NOW,
      dryRun: false,
    });
    expect(later.plan.remove).toEqual([]);
    expect(later.plan.keep.get('whombat-20261112.1')).toBe('the build before whombat-20261113.1');
    expect(later.plan.keep.get('whombat-20261111.1')).toBe('the host of whombat-20261112.1');
    expect(later.plan.dropIso).toEqual(['whombat-20261111.1']);
    expect(existsSync(join(root, 'whombat-20261111.1', 'iso'))).toBe(false);
    expect(existsSync(join(root, 'whombat-20261111.1', 'build.json'))).toBe(true);
  });
});

describe('holdIfFree', () => {
  it('takes a free lock and gives up on a held one', async () => {
    const lock = join(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'prune-lock-')), 'l.lock');
    const h = await holdIfFree(lock);
    expect(h).not.toBeNull();
    expect(spawnSync('flock', ['-n', lock, 'true']).status).not.toBe(0);
    expect(await holdIfFree(lock)).toBeNull();
    await h?.release();
    expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
  });
});
