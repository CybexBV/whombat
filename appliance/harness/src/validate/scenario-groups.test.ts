import { readdirSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_DIR, ports } from '../lib/paths.ts';
import { LIVE_PORT_SHIFT } from '../ship/live.ts';
import { busyPorts, ISOLATED_SCENARIOS, isolatedScenarioFiles, scenarioEnv } from './scenario-groups.ts';

const options = {
  scenarioJobs: 3,
  scenarios: null,
  reuseEnv: false,
  live: false,
  public: false,
  agents: 'scripted' as const,
};

describe('scenario isolation', () => {
  it('retains every repository scenario exactly once for all concurrency settings', () => {
    const files = readdirSync(join(HARNESS_DIR, 'scenarios'))
      .filter((f) => f.endsWith('.scenario.ts'))
      .sort();
    for (const scenarioJobs of [1, 2, 3]) {
      const isolated = isolatedScenarioFiles({ ...options, scenarioJobs });
      expect(isolated).toHaveLength(scenarioJobs - 1);
      expect([...files.filter((f) => !isolated.includes(f)), ...isolated].sort()).toEqual(files);
    }
    expect(ISOLATED_SCENARIOS.every((f) => files.includes(f))).toBe(true);
  });

  it('keeps selective, reused, live and public runs serial', () => {
    for (const override of [
      { scenarios: 'licence' },
      { reuseEnv: true },
      { live: true },
      { public: true },
      { agents: 'live' as const },
    ])
      expect(isolatedScenarioFiles({ ...options, ...override })).toEqual([]);
  });

  it('separates all ports, homes, database containers and sign-in recipients, including live ports', () => {
    const base = { home: '/ci/run', container: 'ci-pg', ports };
    const a = scenarioEnv(base, 1);
    const b = scenarioEnv(base, 2);
    expect(a.WB_MGD_HOME).not.toBe(b.WB_MGD_HOME);
    expect(a.WB_MGD_PG_CONTAINER).not.toBe(b.WB_MGD_PG_CONTAINER);
    expect(a.WB_MGD_PERSONA_SUFFIX).not.toBe(b.WB_MGD_PERSONA_SUFFIX);
    expect(a.WB_MGD_PERSONA_SUFFIX).not.toBe(
      scenarioEnv({ ...base, home: '/other/run' }, 1).WB_MGD_PERSONA_SUFFIX,
    );
    const all = [
      ...Object.values(ports),
      ...Object.values(ports).map((p) => p + LIVE_PORT_SHIFT),
      ...Object.entries(a)
        .filter(([k]) => k.endsWith('_PORT'))
        .map(([, v]) => Number(v)),
      ...Object.entries(b)
        .filter(([k]) => k.endsWith('_PORT'))
        .map(([, v]) => Number(v)),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const slot of [0, 3, 1.5]) expect(() => scenarioEnv(base, slot)).toThrow();
  });
});

describe('busyPorts (IN-131)', () => {
  it('names the variables whose port something already listens on', async () => {
    const server = createServer();
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const taken = (server.address() as AddressInfo).port;
    try {
      const busy = await busyPorts(
        {
          CONTROL_ADMIN_PORT: String(taken),
          WB_MGD_HOME: '/x',
          RELAY_PORT: 'nope',
        },
        { tries: 2, waitMs: 10 },
      );
      expect(busy).toEqual([`CONTROL_ADMIN_PORT=${taken}`]);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
    expect(await busyPorts({ CONTROL_ADMIN_PORT: String(taken) }, { tries: 2, waitMs: 10 })).toEqual([]);
  });

  it('a port held only for a moment (a client connection’s ephemeral port) is not in use', async () => {
    const server = createServer();
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const taken = (server.address() as AddressInfo).port;
    setTimeout(() => server.close(), 30);
    expect(await busyPorts({ CONTROL_ADMIN_PORT: String(taken) }, { tries: 5, waitMs: 50 })).toEqual([]);
  });
});
