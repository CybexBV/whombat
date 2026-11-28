/**
 * What a connected service's own backups say about where its data is kept (docs/decisions/backup-trust.md), from what
 * the health pass already reads: Home Assistant's backups and the places they went, Synology Hyper Backup's tasks and
 * where they back up to, TrueNAS's replication, cloud sync and snapshot tasks. Written to
 * `catalog_connections.protection` by the health pass; the What's protected page reads it. `undefined`: the read said
 * nothing either way (the part wasn't read), so what was kept stays.
 */
import type { StoredProtection } from '../db/schema/index';

/** A copy kept elsewhere beats one on the same machine, which beats none. */
const RANK = { copied: 2, local: 1, none: 0 } as const;

export function betterProtection(
  a: StoredProtection | null | undefined,
  b: StoredProtection | null | undefined,
): StoredProtection | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] > RANK[b.state] ? a : b;
  return Date.parse(a.lastAt ?? '') >= Date.parse(b.lastAt ?? '') || !b.lastAt ? a : b;
}

const iso = (d: Date | null | undefined) => (d && Number.isFinite(d.getTime()) ? d.toISOString() : null);

/**
 * A fact as the page may say it: copied or local only with a backup that worked (its time), so a fact kept from
 * before that rule, a plan without a backup that worked, reads as none and planned.
 */
export function provenProtection(f: StoredProtection | null | undefined): StoredProtection | null {
  if (!f) return null;
  if (f.state === 'none' || f.lastAt) return f;
  return {
    state: 'none',
    lastAt: null,
    where: null,
    planned: true,
    ...(f.failedAt ? { failedAt: f.failedAt } : {}),
  };
}

/* Home Assistant ----------------------------------------------------------------------------------------------------- */

/** The name of a Home Assistant backup location (`cloud.cloud`, `hassio.nas_backups`, `google_drive.…`). */
export function haAgentName(agent: string): string {
  const [domain, rest] = [agent.split('.')[0] ?? agent, agent.split('.').slice(1).join('.')];
  if (domain === 'cloud') return 'Home Assistant Cloud';
  // A network storage Home Assistant OS mounted: its own name.
  if (domain === 'hassio' || domain === 'backup') return rest.replace(/_/g, ' ') || agent;
  const known: Record<string, string> = {
    google_drive: 'Google Drive',
    onedrive: 'OneDrive',
    synology_dsm: 'Synology',
    backblaze_b2: 'Backblaze B2',
    webdav: 'WebDAV',
    aws_s3: 'Amazon S3',
    s3: 'S3',
    kitchen_sink: 'Test storage',
  };
  return known[domain] ?? domain.replace(/_/g, ' ');
}

export interface HaBackupFacts {
  at: Date | null;
  /** Where it went other than Home Assistant's own disk (agent ids). */
  elsewhere: readonly string[];
}

export function haProtection(backups: readonly HaBackupFacts[] | null): StoredProtection | undefined {
  if (backups === null) return undefined;
  const dated = backups.filter((b) => b.at).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const away = dated.find((b) => b.elsewhere.length);
  if (away)
    return {
      state: 'copied',
      lastAt: iso(away.at),
      where: [...new Set(away.elsewhere.map(haAgentName))].join(', ').slice(0, 160) || null,
    };
  if (dated[0]) return { state: 'local', lastAt: iso(dated[0].at), where: null };
  return { state: 'none', lastAt: null, where: null };
}

/* Synology Hyper Backup -------------------------------------------------------------------------------------------- */

export interface HyperBackupFacts {
  name: string;
  result: string;
  last: Date | null;
  /** `cloud`, `remote` (another NAS or rsync server) or `local` (a shared folder or USB disk on the NAS). */
  target?: string | null;
}

/**
 * Copied only from a task that sends its backups away (the cloud, another NAS) and worked; local from one that worked on
 * the NAS itself; none (planned) while tasks exist but none of them has worked yet.
 */
export function synologyProtection(tasks: readonly HyperBackupFacts[] | null): StoredProtection | undefined {
  if (tasks === null) return undefined;
  const away = (t: HyperBackupFacts) => t.target === 'cloud' || t.target === 'remote';
  const worked = (t: HyperBackupFacts) => (t.result === 'ok' || t.result === 'partial') && !!iso(t.last);
  return taskProtection(
    tasks,
    away,
    worked,
    (t) => t.last,
    (t) => t.result === 'failed',
  );
}

/* TrueNAS ---------------------------------------------------------------------------------------------------------- */

export interface TrueNasTaskFacts {
  kind: 'snapshot' | 'replication' | 'cloudsync' | 'cloudbackup';
  name: string;
  result: string | null;
  at: Date | null;
}

/** Replication and cloud tasks send copies away, snapshot tasks keep them on the NAS; by the same rule as Synology's. */
export function truenasProtection(tasks: readonly TrueNasTaskFacts[] | null): StoredProtection | undefined {
  if (tasks === null) return undefined;
  return taskProtection(
    tasks,
    (t) => t.kind !== 'snapshot',
    (t) => t.result === 'ok' && !!iso(t.at),
    (t) => t.at,
    (t) => t.result === 'failed',
  );
}

/**
 * A NAS's backup tasks as one fact: copied from the newest away task that worked, else local from the newest one that
 * worked, else none (planned when there are tasks). The newest finished run of the tasks it counts says when it failed.
 */
function taskProtection<T extends { name: string; result: string | null }>(
  tasks: readonly T[],
  away: (t: T) => boolean,
  worked: (t: T) => boolean,
  at: (t: T) => Date | null,
  failed: (t: T) => boolean,
): StoredProtection {
  const newest = (list: readonly T[]) =>
    [...list].sort((a, b) => (at(b)?.getTime() ?? 0) - (at(a)?.getTime() ?? 0))[0];
  const awayOk = newest(tasks.filter((t) => away(t) && worked(t)));
  const ok = awayOk ?? newest(tasks.filter(worked));
  const counted = awayOk ? tasks.filter(away) : tasks;
  const last = newest(counted.filter((t) => t.result !== 'running' && at(t)));
  const failedAt = last && failed(last) ? iso(at(last)) : null;
  const fail = failedAt ? { failedAt } : {};
  if (!ok)
    return { state: 'none', lastAt: null, where: null, ...(tasks.length ? { planned: true } : {}), ...fail };
  return {
    state: awayOk ? 'copied' : 'local',
    lastAt: iso(at(ok)),
    where: awayOk ? awayOk.name.slice(0, 160) : null,
    ...fail,
  };
}
