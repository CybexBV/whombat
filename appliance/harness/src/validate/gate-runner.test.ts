import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanClone } from '../lib/git.ts';
import { TMP_DIR } from '../lib/paths.ts';
import { type RunResult, run } from '../lib/proc.ts';
import { Component } from '../manifest/pins.ts';
import { runGates } from './validate.ts';

vi.mock('../lib/proc.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/proc.ts')>()),
  run: vi.fn(),
}));
vi.mock('../lib/git.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/git.ts')>()),
  cleanClone: vi.fn(),
}));

const components = ['backup', '.'].map((cwd) =>
  Component.parse({
    id: cwd === '.' ? 'manager' : 'backup',
    repository: 'whombat-appliance',
    source: '/fixture/source',
    ref: 'main',
    commit: 'a'.repeat(40),
    version: '1',
    gates: [{ id: 'test', cwd, run: ['go', 'test', '-count=1', './...'], timeoutS: 10 }],
  }),
);
let dir: string;
let exitCodes: number[];
let layout: string;
beforeEach(() => {
  dir = mkdtempSync(join(TMP_DIR, 'gate-runner-test-'));
  exitCodes = [0];
  layout = 'go.mod\n';
  vi.mocked(cleanClone).mockReset().mockResolvedValue(undefined);
  vi.mocked(run)
    .mockReset()
    .mockImplementation(async (cmd, args, options): Promise<RunResult> => {
      const code = cmd === 'git' ? 0 : (exitCodes.shift() ?? 0);
      if (options.logFile) {
        mkdirSync(dirname(options.logFile), { recursive: true });
        writeFileSync(options.logFile, `output\n[exit ${code}]\n`);
      }
      return {
        code,
        command: [cmd, ...args].join(' '),
        cwd: options.cwd,
        stdout: cmd === 'git' ? layout : 'ok package',
        stderr: '',
        signal: null,
        durationMs: 10,
        timedOut: false,
      };
    });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const execute = (enabled = true, jobs = 2) =>
  runGates(components, dir, null, jobs, () => {}, {
    root: join(dir, 'cache'),
    enabled,
    setup: { tools: 'fixture' },
  });

it('runs the root before its dependent subset even with reversed inputs and one worker', async () => {
  const result = await execute(false, 1);
  expect(result).toHaveLength(2);
  expect(result.every((g) => g.outcome === 'passed')).toBe(true);
  expect(result.find((g) => g.component === 'backup')?.coveredBy).toMatchObject({
    component: 'manager',
    gate: 'test',
  });
  expect(vi.mocked(run).mock.calls.filter(([cmd]) => cmd === 'go')).toHaveLength(1);
  expect(cleanClone).toHaveBeenCalledTimes(1);
});

it('reuses successful evidence without cloning or running the command again', async () => {
  await execute();
  const warm = await execute();
  expect(warm.find((g) => g.component === 'manager')?.reused).toBeDefined();
  expect(warm.find((g) => g.component === 'backup')?.coveredBy).toBeDefined();
  expect(vi.mocked(run).mock.calls.filter(([cmd]) => cmd === 'go')).toHaveLength(1);
  expect(cleanClone).toHaveBeenCalledTimes(1);
});

it('runs the subset independently after a root failure', async () => {
  exitCodes = [1, 0];
  const result = await execute(false);
  expect(result.find((g) => g.component === 'manager')?.outcome).toBe('failed');
  expect(result.find((g) => g.component === 'backup')).toMatchObject({ outcome: 'passed' });
  expect(result.find((g) => g.component === 'backup')?.coveredBy).toBeUndefined();
  expect(vi.mocked(run).mock.calls.filter(([cmd]) => cmd === 'go')).toHaveLength(2);
});

it('does not cover a nested Go module from the root check', async () => {
  layout = 'go.mod\nbackup/go.mod\n';
  const result = await execute(false);
  expect(result.find((g) => g.component === 'backup')?.coveredBy).toBeUndefined();
  expect(vi.mocked(run).mock.calls.filter(([cmd]) => cmd === 'go')).toHaveLength(2);
});
