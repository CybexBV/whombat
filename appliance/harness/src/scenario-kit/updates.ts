/**
 * Update slice C helpers (IN-21): publish a candidate release in the dev TUF repository's channel, which is what offers
 * it to the dev appliance (every box takes the newest release its channel lists, Whombat whombat-link.md LNK-20; control
 * assigns nothing), read the manager's update status, and wait for journal states. The manager looks at its
 * repository every 20 s here; the scenarios restart it to make it look now — a shortcut, recorded as such.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseTuple } from '@whombat/release';
import { envPath, loadEnv } from '../dev/env.ts';
import { nextReleaseId, publishRelease, type ReleaseOptions, runtimeFacts } from '../dev/releases.ts';
import { restartService } from '../dev/restart.ts';
import { unixJson } from '../dev/services.ts';
import { paths } from '../lib/paths.ts';
import { sleep } from '../lib/proc.ts';
import { env } from './world.ts';

export interface UpdateStatus {
  state: string;
  current: string;
  knownGood?: string;
  candidate?: string | null;
  failure?: string | null;
  hold?: boolean;
  readOnly?: boolean;
  explanation?: string;
  [k: string]: unknown;
}

export async function updateStatus(): Promise<UpdateStatus> {
  const r = await unixJson(env().appliance?.managerSocket ?? '', 'GET', '/v1/update/status');
  if (r.status !== 200) throw new Error(`update status: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as UpdateStatus;
}

function managerBin(): string {
  const src = loadEnv()?.sources['appliance-manager'];
  if (!src) throw new Error('no appliance-manager source in env.json');
  return join(
    paths.bin,
    `${src.commit ? `appliance-manager@${src.commit.slice(0, 12)}` : ''}${src.dirty ? '-dirty' : ''}`,
  );
}

/**
 * The id of the next candidate: the repository's next `whombat-dev-YYYYMMDD.N` (a channel lists ordered ids only).
 * Among releases of equal versions the box takes the one whose id sorts last, so the candidate published last is the
 * channel's newest.
 */
export function nextCandidateId(): string {
  return nextReleaseId(tufDir());
}

export function tufDir(): string {
  return envPath('manager', 'tuf');
}

/**
 * Publishes a runtime release describing the real runtime (options: health, declared schema range) in the box's
 * channel. The box takes it when it is the newest there: its versions aren't lower than the installed release's and,
 * among equal versions, its id sorts last (`nextCandidateId`).
 */
export async function publishCandidate(
  o: Omit<ReleaseOptions, 'runtime'> & { runtime?: ReleaseOptions['runtime'] },
): Promise<ReleaseTuple> {
  const rt = loadEnv()?.sources['whombat-runtime'];
  if (!rt) throw new Error('no runtime source');
  return publishRelease(
    managerBin(),
    tufDir(),
    { ...o, runtime: o.runtime ?? runtimeFacts(rt.path) },
    join(paths.logs, 'updates.log'),
  );
}

/** Makes the manager look at its channel now (a restart; it reads its update repository at start). */
export async function pollNow(): Promise<void> {
  await restartService('manager');
}

export async function waitForStatus(
  pred: (s: UpdateStatus) => boolean,
  timeoutMs: number,
  label: string,
): Promise<{ status: UpdateStatus; seen: string[] }> {
  const until = Date.now() + timeoutMs;
  const seen: string[] = [];
  let last: UpdateStatus | null = null;
  while (Date.now() < until) {
    try {
      last = await updateStatus();
      const tag = `${last.state}${last.candidate ? `(${last.candidate})` : ''}${last.failure ? `!${last.failure}` : ''}`;
      if (seen.at(-1) !== tag) seen.push(tag);
      if (pred(last)) return { status: last, seen };
    } catch (err) {
      const tag = `unreachable: ${String(err).slice(0, 80)}`;
      if (seen.at(-1) !== tag) seen.push(tag);
    }
    await sleep(500);
  }
  throw new Error(
    `${label}: not reached in ${timeoutMs} ms; states ${seen.join(' → ')}; last ${JSON.stringify(last)}`,
  );
}

/** The fake activator's effects log (import, set-runtime, restart-runtime, migrate…). */
export function activatorEvents(): string[] {
  const f = envPath('manager', 'fake', 'events.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
}

export function bridgeLog(): string[] {
  const f = join(paths.logs, 'bridge.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
}

export { sleep };
