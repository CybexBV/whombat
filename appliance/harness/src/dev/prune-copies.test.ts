import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// paths.ts reads WB_MGD_HOME when it is first imported: a private home for this file.
const home = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/prune-copies-home-${process.pid}-${Date.now()}`;
  process.env.WB_MGD_HOME = dir;
  return dir;
});

import type { EnvState, SourceState } from './env.ts';
import {
  type Copy,
  copiesInUse,
  keepFromEnv,
  parseCopy,
  pruneCopies,
  RECENT_MS,
  selectPrunable,
  touchCopy,
} from './prune-copies.ts';

afterAll(() => rmSync(home, { recursive: true, force: true }));

const C = (n: number) => `${n.toString(16).padStart(2, '0')}`.repeat(6);
const NOW = Date.parse('2026-10-29T18:00:00Z');
const DAY = 86_400_000;

const copy = (dir: Copy['dir'], name: string, usedAt: number): Copy => {
  const p = parseCopy(dir, name);
  if (!p) throw new Error(`not a copy: ${name}`);
  return { dir, name, path: `/h/${dir}/${name}`, ...p, usedAt };
};

describe('per-commit copies: names', () => {
  it('recognises clones, markers, builds and fixtures, and nothing else', () => {
    expect(parseCopy('src', `whombat-runtime@${C(1)}`)).toEqual({
      component: 'whombat-runtime',
      commit: C(1),
    });
    expect(parseCopy('src', `whombat-app@${C(1)}.installed`)).toEqual({
      component: 'whombat-app',
      commit: C(1),
    });
    expect(parseCopy('bin', `whombat-hosts@${C(2)}-dirty-agents`)).toEqual({
      component: 'whombat-hosts',
      commit: C(2),
    });
    expect(parseCopy('bin', `appliance-manager@${C(2)}-dirty`)?.component).toBe('appliance-manager');
    expect(parseCopy('fixtures', `runtime-expand@${C(3)}-f2`)).toEqual({
      component: 'runtime-expand',
      commit: C(3),
    });
    for (const [dir, name] of [
      ['bin', 'rest-server-v0.14.0'],
      ['bin', 'postgresql-17'],
      ['bin', 'whombat-console'],
      ['src', `whombat-app@${C(1)}.tmp`],
      ['src', 'whombat-app@abc'],
      ['fixtures', `runtime-expand@${C(3)}`],
    ] as const)
      expect(parseCopy(dir, name)).toBeNull();
  });

  it('reads WB_MGD_KEEP_COPIES', () => {
    expect(keepFromEnv(undefined)).toBe(3);
    expect(keepFromEnv('5')).toBe(5);
    expect(keepFromEnv('0')).toBe(0);
    expect(keepFromEnv('all')).toBeNull();
    expect(() => keepFromEnv('lots')).toThrow(/number or all/);
  });
});

describe('per-commit copies: what stays', () => {
  const rules = { keep: 2, now: NOW, commits: [] as string[], inUse: new Set<string>() };

  it('keeps the newest per component and directory, and removes a version whole', () => {
    const copies = [
      copy('src', `whombat-runtime@${C(1)}`, NOW - 5 * DAY),
      copy('src', `whombat-runtime@${C(1)}.installed`, NOW - 5 * DAY),
      copy('src', `whombat-runtime@${C(2)}`, NOW - 4 * DAY),
      copy('src', `whombat-runtime@${C(3)}`, NOW - 3 * DAY),
      // The marker is newer than its clone: the version counts as used then.
      copy('src', `whombat-app@${C(1)}`, NOW - 9 * DAY),
      copy('src', `whombat-app@${C(1)}.installed`, NOW - 2 * DAY),
      copy('src', `whombat-app@${C(2)}`, NOW - 4 * DAY),
      copy('src', `whombat-app@${C(3)}`, NOW - 3 * DAY),
      // bin/ counts on its own.
      copy('bin', `whombat-runtime@${C(1)}`, NOW - 5 * DAY),
    ];
    expect(selectPrunable(copies, rules).map((c) => c.name)).toEqual([
      `whombat-app@${C(2)}`,
      `whombat-runtime@${C(1)}`,
      `whombat-runtime@${C(1)}.installed`,
    ]);
  });

  it('keeps what env.json runs, what a process uses and what was used in the last hour', () => {
    const copies = [
      copy('src', `whombat-runtime@${C(1)}`, NOW - 30 * DAY),
      copy('src', `whombat-runtime@${C(2)}`, NOW - 20 * DAY),
      copy('src', `whombat-runtime@${C(3)}`, NOW - 10 * DAY),
      copy('src', `whombat-runtime@${C(4)}`, NOW - RECENT_MS + 60_000),
      copy('src', `whombat-runtime@${C(5)}`, NOW - 2 * DAY),
      copy('src', `whombat-runtime@${C(6)}`, NOW - DAY),
      copy('bin', `whombat-hermes@${C(1)}`, NOW - 30 * DAY),
    ];
    // The two newest are C(4) (used in the last hour) and C(6).
    const out = selectPrunable(copies, {
      keep: 2,
      now: NOW,
      // Full commits from env.json: compared by their first 12 characters, whatever the component.
      commits: [`${C(1)}ffffffffffffffff`],
      inUse: new Set([`/h/src/whombat-runtime@${C(2)}`]),
    });
    expect(out.map((c) => c.name)).toEqual([`whombat-runtime@${C(3)}`, `whombat-runtime@${C(5)}`]);
  });

  it('keeps nothing extra with WB_MGD_KEEP_COPIES=0 but still what runs', () => {
    const copies = [
      copy('fixtures', `runtime-expand@${C(1)}-f2`, NOW - 3 * DAY),
      copy('fixtures', `runtime-expand@${C(2)}-f2`, NOW - 2 * DAY),
    ];
    expect(selectPrunable(copies, { ...rules, keep: 0, commits: [C(2)] }).map((c) => c.name)).toEqual([
      `runtime-expand@${C(1)}-f2`,
    ]);
  });
});

describe('per-commit copies: processes', () => {
  it('finds the copies a process works in, runs or names on its command line', () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'prune-proc-'));
    const proc = join(root, 'proc');
    const src = join(root, 'h', 'src');
    const bin = join(root, 'h', 'bin');
    const pid = (n: number, cwd: string, exe: string, cmd: string[]) => {
      mkdirSync(join(proc, String(n)), { recursive: true });
      symlinkSync(cwd, join(proc, String(n), 'cwd'));
      symlinkSync(exe, join(proc, String(n), 'exe'));
      writeFileSync(join(proc, String(n), 'cmdline'), `${cmd.join('\0')}\0`);
    };
    pid(10, join(src, `whombat-runtime@${C(1)}`, 'apps', 'server'), '/usr/bin/node', ['node', 'main.js']);
    pid(11, '/', join(bin, `appliance-manager@${C(2)}`, 'whombat-manager'), ['whombat-manager']);
    pid(12, '/', '/usr/bin/node', ['node', join(src, `whombat-app@${C(3)}`, 'node_modules/.bin/vite')]);
    pid(13, src, '/usr/bin/bash', ['bash']);
    mkdirSync(join(proc, 'self'));
    expect([...copiesInUse([src, bin], proc)].sort()).toEqual([
      join(bin, `appliance-manager@${C(2)}`),
      join(src, `whombat-app@${C(3)}`),
      join(src, `whombat-runtime@${C(1)}`),
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('per-commit copies: on disk', () => {
  const at = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
  const make = (path: string, usedAt: number, dir = true) => {
    if (dir) {
      mkdirSync(join(path, 'node_modules', 'x'), { recursive: true });
      writeFileSync(join(path, 'node_modules', 'x', 'index.js'), '');
    } else writeFileSync(path, 'sha\n');
    at(path, usedAt);
  };
  const state = (sources: Partial<SourceState>[]) =>
    ({ sources: Object.fromEntries(sources.map((s) => [s.id, s])) }) as unknown as EnvState;

  it('removes the old copies, leaves the rest and other files alone', () => {
    const src = join(home, 'src');
    const bin = join(home, 'bin');
    const fixtures = join(home, 'fixtures');
    const now = Date.now();
    for (let i = 1; i <= 6; i++) {
      make(join(src, `whombat-runtime@${C(i)}`), now - (10 - i) * DAY);
      make(join(src, `whombat-runtime@${C(i)}.installed`), now - (10 - i) * DAY, false);
      make(join(bin, `whombat-hosts@${C(i)}`), now - (10 - i) * DAY);
      make(join(bin, `whombat-hosts@${C(i)}-agents`), now - (10 - i) * DAY);
    }
    make(join(fixtures, `runtime-expand@${C(1)}-f2`), now - 9 * DAY);
    make(join(bin, 'rest-server-v0.14.0'), now - 90 * DAY);
    make(join(bin, 'postgresql-17'), now - 90 * DAY);
    // A read-only tree (a Go module cache, a skill version) goes too.
    const ro = join(src, `whombat-runtime@${C(2)}`, 'node_modules', 'x');
    utimesSync(join(src, `whombat-runtime@${C(2)}`), new Date(now - 8 * DAY), new Date(now - 8 * DAY));
    chmodSync(ro, 0o555);

    const lines: string[] = [];
    const dry = pruneCopies(state([{ id: 'whombat-runtime', commit: `${C(1)}aaaa` }]), (l) => lines.push(l), {
      dryRun: true,
      keep: 2,
    });
    expect(dry.removed.length).toBe(6 + 6); // runtime 2, 3, 4 with their markers; hosts 2, 3, 4 with their agents
    expect(existsSync(join(src, `whombat-runtime@${C(2)}`))).toBe(true);

    // Reusing a copy marks it: whombat-runtime@3 becomes one of the two newest.
    touchCopy(join(src, `whombat-runtime@${C(3)}`));
    const r = pruneCopies(state([{ id: 'whombat-runtime', commit: `${C(1)}aaaa` }]), (l) => lines.push(l), {
      keep: 2,
    });
    expect(r.removed.map((c) => c.name).filter((n) => n.startsWith('whombat-runtime@'))).toEqual([
      `whombat-runtime@${C(2)}`,
      `whombat-runtime@${C(2)}.installed`,
      `whombat-runtime@${C(4)}`,
      `whombat-runtime@${C(4)}.installed`,
      `whombat-runtime@${C(5)}`,
      `whombat-runtime@${C(5)}.installed`,
    ]);
    expect(readdirSync(src).sort()).toEqual([
      `whombat-runtime@${C(1)}`,
      `whombat-runtime@${C(1)}.installed`,
      `whombat-runtime@${C(3)}`,
      `whombat-runtime@${C(3)}.installed`,
      `whombat-runtime@${C(6)}`,
      `whombat-runtime@${C(6)}.installed`,
    ]);
    // hosts: C(1) runs (same commit, another component's source is enough), C(5) and C(6) are the newest.
    expect(readdirSync(bin).sort()).toEqual([
      'postgresql-17',
      'rest-server-v0.14.0',
      `whombat-hosts@${C(1)}`,
      `whombat-hosts@${C(1)}-agents`,
      `whombat-hosts@${C(5)}`,
      `whombat-hosts@${C(5)}-agents`,
      `whombat-hosts@${C(6)}`,
      `whombat-hosts@${C(6)}-agents`,
    ]);
    // The fixture's commit runs: it stays.
    expect(readdirSync(fixtures)).toEqual([`runtime-expand@${C(1)}-f2`]);
    expect(lines.at(-1)).toMatch(
      /^copies: removed \d+ old per-commit copies, kept \d+ \(WB_MGD_KEEP_COPIES=2\)$/,
    );
  });

  it('does nothing with WB_MGD_KEEP_COPIES=all', () => {
    const r = pruneCopies(null, () => {}, { keep: null });
    expect(r.removed).toEqual([]);
    expect(r.kept).toBeGreaterThan(0);
  });
});
