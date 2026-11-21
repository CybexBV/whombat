/**
 * Starting a runner on a managed appliance (docs/decisions/managed-sandbox.md MSB-09, MSB-16): advance the
 * generation (and hold the runner's state), build the task sandbox and check that this host can enforce it,
 * then kill what earlier generations left behind — all before the first claim. A host that can't build the
 * sandbox still starts (it reports, and every live turn is refused with the reason); it never runs one outside.
 */
import { join } from 'node:path';
import {
  type CgroupBackend,
  DelegatedCgroups,
  type EgressGrant,
  findBwrap,
  ManagedSandbox,
  onPath,
  SystemdUserCgroups,
} from '@whombat/agent-runtime';
import { nextGeneration, type RunnerGeneration } from './generation';
import type { ManagedPolicy } from './managed';

export interface ManagedSettings {
  WHOMBAT_HOME: string;
  WHOMBAT_WORKSPACES: string;
  WHOMBAT_CREDENTIALS_ROOT?: string | undefined;
  WHOMBAT_RUNNER_STATE?: string | undefined;
  WHOMBAT_SANDBOX_BWRAP?: string | undefined;
  WHOMBAT_SANDBOX_NSENTER?: string | undefined;
  WHOMBAT_SANDBOX_CGROUP: 'delegated' | 'systemd-user';
  WHOMBAT_SANDBOX_SLICE: string;
  WHOMBAT_SANDBOX_RO_PATHS?: string | undefined;
  WHOMBAT_SANDBOX_EGRESS_ALLOW?: string | undefined;
  WHOMBAT_SANDBOX_GRANTS?: string | undefined;
  WHOMBAT_SANDBOX_MEMORY_MB: number;
  WHOMBAT_SANDBOX_PIDS: number;
  WHOMBAT_SANDBOX_CPU_WEIGHT: number;
  WHOMBAT_SANDBOX_TMP_MB: number;
  WHOMBAT_SANDBOX_OUTPUT_MB: number;
  WHOMBAT_SANDBOX_WALL_MINUTES: number;
  RUNNER_ID?: string | undefined;
}

/** `10.20.0.0/16:5432,8080;fd12::/48` → grants. */
export function parseGrants(value: string | undefined): EgressGrant[] {
  return (value ?? '')
    .split(';')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => {
      const at = g.lastIndexOf(':');
      const hasPorts = at > g.indexOf('/') && /^[\d,]+$/.test(g.slice(at + 1));
      return hasPorts
        ? {
            cidr: g.slice(0, at),
            ports: g
              .slice(at + 1)
              .split(',')
              .map(Number),
          }
        : { cidr: g };
    });
}

export interface ManagedStart {
  generation: RunnerGeneration;
  policy: ManagedPolicy;
  probe: { ok: boolean; detail: string };
  orphans: string[];
  /** Kills this generation's tasks, releases its cgroup root and the runner's state (shutdown). */
  shutdown(): Promise<void>;
}

export async function startManaged(
  settings: ManagedSettings,
  env: NodeJS.ProcessEnv = process.env,
  cgroups?: (generation: string) => CgroupBackend,
): Promise<ManagedStart> {
  const state = settings.WHOMBAT_RUNNER_STATE ?? join(settings.WHOMBAT_HOME, 'runner');
  const generation = await nextGeneration(state, settings.RUNNER_ID ?? 'rnr_appliance');
  const backend =
    cgroups?.(generation.prefix) ??
    (settings.WHOMBAT_SANDBOX_CGROUP === 'systemd-user'
      ? new SystemdUserCgroups({ slice: settings.WHOMBAT_SANDBOX_SLICE, generation: generation.prefix })
      : new DelegatedCgroups({ generation: generation.prefix }));
  const bwrap = settings.WHOMBAT_SANDBOX_BWRAP ?? findBwrap(env) ?? '/usr/bin/bwrap';
  // How a command joins its holder (one-person.md OP-07): util-linux's nsenter.
  const nsenter = settings.WHOMBAT_SANDBOX_NSENTER ?? onPath('nsenter', env) ?? '/usr/bin/nsenter';
  const sandbox = new ManagedSandbox({
    bwrap,
    nsenter,
    cgroups: backend,
    stateDir: join(state, 'sandbox'),
    prefix: generation.prefix,
    readOnlyPaths: (settings.WHOMBAT_SANDBOX_RO_PATHS ?? '').split(':').filter((p) => p.startsWith('/')),
    // Never visible to a task, even through a mounted parent: Whombat's home and the runner's state, every
    // identity's credentials (the person's own home is mounted on its own), the workspaces of other turns.
    deniedPaths: [
      settings.WHOMBAT_HOME,
      state,
      ...(settings.WHOMBAT_CREDENTIALS_ROOT ? [settings.WHOMBAT_CREDENTIALS_ROOT] : []),
    ],
    limits: {
      memoryBytes: settings.WHOMBAT_SANDBOX_MEMORY_MB * 1024 * 1024,
      pids: settings.WHOMBAT_SANDBOX_PIDS,
      cpuWeight: settings.WHOMBAT_SANDBOX_CPU_WEIGHT,
      tmpBytes: settings.WHOMBAT_SANDBOX_TMP_MB * 1024 * 1024,
      outputBytes: settings.WHOMBAT_SANDBOX_OUTPUT_MB * 1024 * 1024,
    },
  });
  const probe = await sandbox.probe();
  // Orphans first, whatever the probe says: nothing of an earlier generation keeps running.
  const orphans = await sandbox.killOrphans().catch(() => [] as string[]);
  const egressAllow = (settings.WHOMBAT_SANDBOX_EGRESS_ALLOW ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    generation,
    probe,
    orphans,
    shutdown: async () => {
      await sandbox.shutdown().catch(() => {});
      await generation.lock.release();
    },
    policy: {
      credentialsRoot: settings.WHOMBAT_CREDENTIALS_ROOT,
      ...(probe.ok ? { sandbox } : {}),
      generation: generation.generation,
      egressAllow,
      grants: parseGrants(settings.WHOMBAT_SANDBOX_GRANTS),
      wallMs: settings.WHOMBAT_SANDBOX_WALL_MINUTES * 60_000,
    },
  };
}
