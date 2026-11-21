import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { type RunResult, run } from '../lib/proc.ts';
import { loadPins, PINS_FILE } from '../manifest/pins.ts';
import { busyPorts } from './scenario-groups.ts';
import { runScenarioShard } from './validate.ts';

vi.mock('../lib/proc.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/proc.ts')>()),
  run: vi.fn(),
}));
// The machine's real ports are not this test's business (a running suite holds them).
vi.mock('./scenario-groups.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scenario-groups.ts')>()),
  busyPorts: vi.fn(async () => []),
}));
const processResult = (code: number, stderr = ''): RunResult => ({
  command: 'mock',
  cwd: '.',
  code,
  signal: null,
  stdout: '',
  stderr,
  durationMs: 1,
  timedOut: false,
});
let dir: string;
const file = 'i-updates.scenario.ts';
const goodReport = () => ({
  $schema: 'whombat.validation-report/1',
  manifest: { ok: true, pinsFile: PINS_FILE },
  pins: loadPins().components.map(({ id, commit }) => ({ id, commit })),
  harness: { outcome: 'passed' },
  scenarios: [{ file: `scenarios/${file}`, name: 'real scenario', outcome: 'passed', durationMs: 123 }],
  records: [{ kind: 'note', detail: 'evidence' }],
  measurements: [],
  gaps: [],
});
function response(report: unknown, code = 0, cleanup = 0) {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  vi.mocked(run)
    .mockResolvedValueOnce(processResult(0))
    .mockResolvedValueOnce(processResult(code, `report: ${join(dir, 'report.md')}`))
    .mockResolvedValueOnce(processResult(cleanup));
}
beforeEach(() => {
  dir = mkdtempSync(join(TMP_DIR, 'scenario-shard-test-'));
  vi.mocked(run).mockReset();
  vi.mocked(busyPorts).mockResolvedValue([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('private scenario report aggregation', () => {
  it('imports the exact scenario and evidence, then purges only its private environment', async () => {
    response(goodReport());
    const result = await runScenarioShard(file, 1, dir, () => {});
    expect(result.scenarios).toEqual(goodReport().scenarios);
    expect(result.records).toContainEqual({ kind: 'note', detail: 'evidence' });
    const cleanupCall = vi.mocked(run).mock.calls[2];
    if (!cleanupCall) throw new Error('cleanup was not called');
    const [command, args, options] = cleanupCall;
    expect(command).toBe(process.execPath);
    expect(args).toContain('--purge');
    expect(args[0]).toMatch(/src\/dev\/down\.ts$/);
    expect(options.env?.WB_MGD_HOME).toMatch(/-scenarios-1$/);
    expect(options.env?.WB_MGD_PINS).toBe(PINS_FILE);
    expect(vi.mocked(run).mock.calls[0]?.[1]).toEqual(args);
    expect(vi.mocked(run).mock.calls[1]?.[2].env).toEqual(options.env);
  });

  it('clears a private environment a killed run left before checking its ports', async () => {
    response(goodReport());
    await runScenarioShard(file, 1, dir, () => {});
    const order = vi.mocked(run).mock.invocationCallOrder[0] ?? 0;
    expect(vi.mocked(busyPorts).mock.invocationCallOrder[0]).toBeGreaterThan(order);
  });

  it('refuses ports something else holds, and still cleans up', async () => {
    vi.mocked(busyPorts).mockResolvedValueOnce(['CONTROL_PORT=4800']);
    vi.mocked(run).mockResolvedValue(processResult(0));
    const result = await runScenarioShard(file, 1, dir, () => {});
    expect(result.scenarios[0]?.error).toContain('CONTROL_PORT=4800');
    expect(vi.mocked(run)).toHaveBeenCalledTimes(2);
  });

  it.each([
    'no scenarios',
    'wrong file',
    'wrong pins',
    'wrong manifest',
    'failed harness',
    'malformed report',
  ])('refuses a %s report and still cleans up', async (problem) => {
    const report = goodReport();
    if (problem === 'no scenarios') report.scenarios = [];
    if (problem === 'wrong file')
      report.scenarios = [
        {
          ...report.scenarios[0],
          file: 'scenarios/other.scenario.ts',
          name: 'other',
          outcome: 'passed',
          durationMs: 1,
        },
      ];
    if (problem === 'wrong pins') report.pins = report.pins.map((p) => ({ ...p, commit: '0'.repeat(40) }));
    if (problem === 'wrong manifest') report.manifest.pinsFile = '/other/pins.json';
    if (problem === 'failed harness') report.harness.outcome = 'failed';
    response(problem === 'malformed report' ? {} : report);
    const result = await runScenarioShard(file, 1, dir, () => {});
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.outcome).toBe('failed');
    expect(vi.mocked(run)).toHaveBeenCalledTimes(3);
  });

  it('cannot turn a nonzero child exit or cleanup failure into success', async () => {
    response(goodReport(), 1, 1);
    const result = await runScenarioShard(file, 1, dir, () => {});
    expect(result.scenarios.map((s) => s.outcome)).toEqual(['failed', 'failed']);
    expect(result.scenarios[0]?.error).toContain('exited 1');
    expect(result.scenarios[1]?.name).toContain('cleanup');
  });

  it('retains real failed scenario details', async () => {
    const report = goodReport();
    report.scenarios = report.scenarios.map((s) => ({ ...s, outcome: 'failed' }));
    response(report, 1);
    expect((await runScenarioShard(file, 1, dir, () => {})).scenarios).toEqual(report.scenarios);
  });

  it('cleans up after a missing report or child launch failure', async () => {
    vi.mocked(run)
      .mockResolvedValueOnce(processResult(0))
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockResolvedValueOnce(processResult(0));
    expect((await runScenarioShard(file, 1, dir, () => {})).scenarios[0]?.error).toContain('launch failed');
    expect(vi.mocked(run)).toHaveBeenCalledTimes(3);
    vi.mocked(run).mockReset();
    vi.mocked(run).mockResolvedValue(processResult(0));
    expect((await runScenarioShard(file, 1, dir, () => {})).scenarios[0]?.error).toContain('no report');
  });
});
