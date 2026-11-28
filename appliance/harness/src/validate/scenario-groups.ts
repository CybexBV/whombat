/** The two suites that end a box's Whombat Link and install updates each receive a fresh, private appliance. */

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { z } from 'zod';
import type { ports } from '../lib/paths.ts';

export const ShardReport = z.object({
  $schema: z.literal('whombat.validation-report/1'),
  manifest: z.object({ ok: z.boolean(), pinsFile: z.string() }),
  pins: z.array(z.object({ id: z.string(), commit: z.string() })),
  harness: z.object({ outcome: z.string() }).nullable(),
  scenarios: z.array(
    z.object({
      file: z.string(),
      name: z.string(),
      outcome: z.enum(['passed', 'failed', 'blocked', 'skipped']),
      durationMs: z.number().nonnegative(),
      blocked: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  records: z.array(z.record(z.string(), z.unknown())),
  measurements: z.array(z.record(z.string(), z.unknown())),
  gaps: z.array(z.record(z.string(), z.unknown())),
});

export const ISOLATED_SCENARIOS = ['i-updates.scenario.ts', 'l-link.scenario.ts'];

export function scenarioEnv(
  base: { home: string; container: string; ports: typeof ports },
  slot: number,
): Record<string, string> {
  if (!Number.isInteger(slot) || slot < 1 || slot > 2) throw new Error('scenario slot must be 1 or 2');
  const shift = (slot + 1) * 100; // +400 is the live-agent environment's.
  const names = PORT_VARIABLES;
  return {
    WB_MGD_HOME: `${base.home}-scenarios-${slot}`,
    WB_MGD_PG_CONTAINER: `${base.container}-scenarios-${slot}`,
    WB_MGD_AGENTS: 'scripted',
    WB_MGD_PERSONA_SUFFIX: `-scenario-${createHash('sha256').update(base.home).digest('hex').slice(0, 12)}-${slot}`,
    WB_SCENARIO_EXCLUDE: '',
    ...Object.fromEntries(
      Object.entries(names).map(([key, name]) => [
        name,
        String(base.ports[key as keyof typeof ports] + shift),
      ]),
    ),
  };
}

/** The environment variable of each port an environment listens on. */
export const PORT_VARIABLES: Record<keyof typeof ports, string> = {
  postgres: 'WB_MGD_PG_PORT',
  control: 'CONTROL_PORT',
  controlAdmin: 'CONTROL_ADMIN_PORT',
  controlPanel: 'CONTROL_PANEL_PORT',
  relay: 'RELAY_PORT',
  relayAdmin: 'RELAY_ADMIN_PORT',
  runtime: 'RUNTIME_PORT',
  direct: 'WB_MGD_DIRECT_PORT',
  web: 'WEB_PORT',
  restic: 'RESTIC_PORT',
  tuf: 'WB_MGD_TUF_PORT',
  embed: 'EMBED_PORT',
  hostsAgent: 'WB_MGD_HOSTS_AGENT_PORT',
};

/**
 * The ports of `env` (a `scenarioEnv`) that something already listens on, as `NAME=port` (IN-131). A shifted
 * environment can land on a port another service of this machine holds (a VM's QEMU monitor on 5801 is
 * CONTROL_ADMIN_PORT 5501 + 300); its control would then exit at start and the suite fail without saying why.
 */
export async function busyPorts(
  env: Record<string, string>,
  options: { tries?: number; waitMs?: number } = {},
): Promise<string[]> {
  const tries = options.tries ?? 5;
  const waitMs = options.waitMs ?? 2000;
  const bindable = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
  let pending = Object.values(PORT_VARIABLES)
    .map((name) => ({ name, port: Number(env[name]) }))
    .filter((p) => Number.isInteger(p.port) && p.port > 0);
  // The Postgres ports (554x0) lie in Linux's ephemeral range (32768–60999): a client connection of anything on this
  // machine may hold one for a moment. Only a port that stays taken for `tries` attempts is in use.
  for (let i = 0; i < tries && pending.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, waitMs));
    const still: typeof pending = [];
    for (const p of pending) if (!(await bindable(p.port))) still.push(p);
    pending = still;
  }
  return pending.map((p) => `${p.name}=${p.port}`);
}

export function isolatedScenarioFiles(options: {
  scenarioJobs: number;
  scenarios: string | null;
  reuseEnv: boolean;
  live: boolean;
  public: boolean;
  agents: 'scripted' | 'live';
}): string[] {
  if (options.scenarios || options.reuseEnv || options.live || options.public || options.agents === 'live')
    return [];
  return ISOLATED_SCENARIOS.slice(0, options.scenarioJobs - 1);
}
