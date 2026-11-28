/**
 * Docker Compose app updates (Whombat app-updates.md): what the hosts service says about a container Compose started
 * (`HostGuest.app`), and the pure rules every surface shares — which apps ask first and why, what the page offers, how
 * an ended update reads. The agent pulls the app's image, recreates its one service, watches it and puts the previous
 * image back by itself when it doesn't come up (hosts `docs/MANAGE.md` 2.11).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** How an app's last update ended. `held`: a new major version waits for the person (an unattended run). */
export const APP_UPDATE_STATUSES = ['updated', 'current', 'held', 'rolled_back', 'failed'] as const;
export type AppUpdateStatus = (typeof APP_UPDATE_STATUSES)[number];

/** An app's last update, as the server's agent keeps it. */
export const HostAppLast = z.object({
  status: z.string().max(32),
  reason: z.string().max(32).nullable(),
  from: z.string().max(64).nullable(),
  to: z.string().max(64).nullable(),
  at: Timestamp.nullable(),
});
export type HostAppLast = z.infer<typeof HostAppLast>;

/**
 * A Docker container Compose started, which Whombat can update: its service, its version and the newer image's when
 * known, why it can't be updated (`pinned`: its image is named by digest), whether an update runs now, and the last one.
 * Absent for containers `docker run` started, and on every container of an agent older than app updates.
 */
export const HostGuestApp = z.object({
  service: z.string().max(200),
  version: z.string().max(64).nullable(),
  newVersion: z.string().max(64).nullable(),
  blocked: z.string().max(32).nullable(),
  updating: z.boolean(),
  last: HostAppLast.nullable(),
  /**
   * The newer image's registry digest (`sha256:…`) and Compose's hash of the service's settings, when the agent says
   * them: an update carries them back, so it deploys exactly what was checked and refuses when the app changed.
   */
  newDigest: z.string().max(80).nullable().optional(),
  configHash: z.string().max(128).nullable().optional(),
});
export type HostGuestApp = z.infer<typeof HostGuestApp>;

/** One app's outcome in an ended app task (`HostTask.apps`). */
export const HostAppResult = z.object({
  app: z.string().max(200),
  service: z.string().max(200).optional(),
  status: z.string().max(32),
  reason: z.string().max(32).optional(),
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  message: z.string().max(500).optional(),
});
export type HostAppResult = z.infer<typeof HostAppResult>;

/** At most this many apps in one update (one approval, one task). */
export const APP_UPDATE_MAX = 10;

/**
 * Why an update asks first, never automatic: `database` (a database's update changes its data, and putting the old
 * version back can't undo that) and `major` (a new major version). Said on the card, so the call carries them.
 */
export const APP_ASK_REASONS = ['database', 'major'] as const;
export type AppAskReason = (typeof APP_ASK_REASONS)[number];

/**
 * What keeps data an update can change: databases, search and vector stores, queues and object stores. Matched as a
 * word of the image's last path part, its digits at the end left off (`vchord-postgres` → `postgres`, `cp-kafka` →
 * `kafka`, `mysql8` → `mysql`).
 */
const DATABASE_WORDS = new Set([
  'postgres',
  'postgresql',
  'postgis',
  'pgvector',
  'pgvecto',
  'vchord',
  'vectorchord',
  'timescaledb',
  'mariadb',
  'mysql',
  'percona',
  'mssql',
  'mongo',
  'mongodb',
  'redis',
  'valkey',
  'keydb',
  'dragonfly',
  'dragonflydb',
  'couchdb',
  'couchbase',
  'cassandra',
  'scylla',
  'scylladb',
  'influxdb',
  'elasticsearch',
  'opensearch',
  'solr',
  'meilisearch',
  'typesense',
  'clickhouse',
  'neo4j',
  'etcd',
  'cockroach',
  'cockroachdb',
  'questdb',
  'surrealdb',
  'rethinkdb',
  'arangodb',
  'memgraph',
  'qdrant',
  'weaviate',
  'chroma',
  'chromadb',
  'milvus',
  'rabbitmq',
  'kafka',
  'zookeeper',
  'minio',
]);

/** Words that make an image a tool beside a database, not the database (`postgres-exporter`, `mongo-express`). */
const NOT_DATABASE_WORDS = new Set([
  'exporter',
  'express',
  'commander',
  'admin',
  'ui',
  'web',
  'insight',
  'backup',
  'backups',
]);

/** An image reference's repository without registry, tag or digest, lower case: `ghcr.io/a/b:1` → `a/b`. */
export function imageRepo(image: string): string {
  let ref = image.trim().toLowerCase();
  const at = ref.indexOf('@');
  if (at >= 0) ref = ref.slice(0, at);
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) ref = ref.slice(0, colon);
  const parts = ref.split('/');
  // A first part with a dot or a port, or `localhost`, is the registry.
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0] ?? '')) parts.shift();
  return parts.join('/');
}

/** Whether an image is a database's, by a word of its name. */
export function isDatabaseImage(image: string): boolean {
  const repo = imageRepo(image);
  // Microsoft's SQL Server is `mssql/server`: its name is the folder's.
  if (/(^|\/)mssql\/(.+\/)?server$/.test(repo)) return true;
  const words = (repo.split('/').at(-1) ?? '').split(/[-_.]+/).map((w) => w.replace(/\d+$/, ''));
  if (words.some((w) => NOT_DATABASE_WORDS.has(w))) return false;
  return words.some((w) => DATABASE_WORDS.has(w));
}

/** A version as people read it: without a leading `v`. */
export function versionWords(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().replace(/^v(?=\d)/i, '');
  return s || null;
}

/**
 * A version's major number, or null when it has none. Calendar versions (a year first: `2024.12.1`) have none: a new
 * year isn't a breaking change.
 */
export function versionMajor(v: string | null | undefined): number | null {
  const m = /^v?(\d+)/i.exec((v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1000 ? null : n;
}

/** Whether `from` → `to` moves to a new major version (both known). */
export function isMajorJump(from: string | null | undefined, to: string | null | undefined): boolean {
  const a = versionMajor(from);
  const b = versionMajor(to);
  return a !== null && b !== null && b > a;
}

/** What Whombat knows about one app's update. */
export interface AppUpdateRisk {
  /** Why it asks first (empty: a safe app). */
  reasons: AppAskReason[];
  /** The version it runs and the one it goes to, as people read them; null when not known. */
  from: string | null;
  to: string | null;
}

/** Why an app's update asks first, from its image and versions (pure). */
export function appUpdateRisk(guest: { image: string; app?: HostGuestApp | null }): AppUpdateRisk {
  const app = guest.app ?? null;
  const reasons: AppAskReason[] = [];
  if (isDatabaseImage(guest.image)) reasons.push('database');
  if (isMajorJump(app?.version, app?.newVersion)) reasons.push('major');
  return { reasons, from: versionWords(app?.version), to: versionWords(app?.newVersion) };
}

/**
 * Where one container stands for an update (pure): `none` (not a Compose app: Whombat watches it only), `outdated`
 * (its server's agent is older than app updates; it updates itself), `blocked` (pinned), `updating`, `available` (the
 * registry has a newer image), `current` (it hasn't) or `unknown` (not checked, or the registry doesn't say).
 */
export type AppUpdateState =
  | 'none'
  | 'outdated'
  | 'blocked'
  | 'updating'
  | 'available'
  | 'current'
  | 'unknown';

export function appUpdateState(
  guest: { project?: string | null; updateAvailable?: boolean | null; app?: HostGuestApp | null },
  agentHasApps: boolean,
): AppUpdateState {
  const app = guest.app ?? null;
  if (!app) return guest.project && !agentHasApps ? 'outdated' : 'none';
  if (app.updating) return 'updating';
  if (app.blocked) return 'blocked';
  if (guest.updateAvailable === true) return 'available';
  if (guest.updateAvailable === false) return 'current';
  return 'unknown';
}

/** Whether a server's agent reports apps at all: one that does knows app updates. */
export function agentReportsApps(guests: readonly { app?: HostGuestApp | null }[]): boolean {
  return guests.some((g) => !!g.app);
}
