/**
 * What the NAS drivers share (docs/decisions/backup-places.md BPL-03, BPL-04, BPL-05): the driver shape every place
 * kind answers to, the failure a step reports in one plain sentence, and what a driver needs from outside (the NAS's
 * numeric address, an HTTP probe, the clock), so the drivers are tested against fakes.
 */
import type { BackupPlaceKept } from '@whombat/core';
import type { PlaceKeep } from '../keep';
import type { LocationFacts } from '../locations';

/** Where the box's repository is after `ensure`: `rest:http://<address>:<port>/<client>/`. */
export interface PlaceEndpoint {
  /** The NAS's numeric LAN address (plain http needs one). */
  address: string;
  port: number;
  /** The folder the backups are in on the NAS, as the NAS names it (for people; the repository path is the client). */
  path: string;
  /** The pool or shared folder that folder is in (BPL-13). */
  location: string | null;
}

/** What a NAS says about itself in one visit: whether it can keep backups, its free space, where on it they can go. */
export interface NasLook {
  /** Null when it can, else one plain sentence why not. */
  reason: string | null;
  freeBytes: number | null;
  locations: LocationFacts[];
  /** Where Whombat kept backups on this kind of NAS before people could choose (BPL-N04). */
  wasIn: string | null;
}

/** A location the NAS lists, before the driver marks its pick. */
export const nasLocation = (id: string, freeBytes: number | null, recommended: boolean): LocationFacts => ({
  id,
  name: id,
  freeBytes,
  isNew: false,
  recommended,
  shared: false,
  pool: null,
  holdsOther: false,
});

/** One kind of place: what Whombat does on it (BPL-05), whichever way it reaches it. */
export interface PlaceDriver {
  /**
   * Makes the folder, installs or updates the backup app with this user, starts it and waits until it answers.
   * `location`: the pool or shared folder (absent: where the app keeps them now, else the recommended one); another than
   * the app's starts it on an empty folder there, and the backups made so far stay where they are.
   */
  ensure(client: string, restPassword: string, location?: string): Promise<PlaceEndpoint>;
  /** Hands the repository password to the weekly cleanup (redeploys the app with it). */
  cleanup(client: string, repositoryPassword: string, keep: PlaceKeep): Promise<void>;
  /** Removes the backup app; `deleteData` also removes the backups it kept. */
  forget(client: string, deleteData: boolean): Promise<void>;
  /** What the place keeps for this Whombat, or null when it has no backup app for it. */
  kept(client: string): Promise<BackupPlaceKept | null>;
}

/** A NAS driver also says whether this NAS can keep backups at all (BPL-04's `unsupported`). */
export interface NasPlaceDriver extends PlaceDriver {
  /** Null when it can, else one plain sentence why not. Reads only. */
  unsupported(): Promise<string | null>;
  /** The same, the free space where the backups would go and where they can go, in one visit. Reads only. */
  look(): Promise<NasLook>;
}

/** TrueNAS can also share a folder over NFS for a Proxmox server's nightly backups (BPL-12). */
export interface NfsPlaceDriver {
  nfsShare(name: string, clients: readonly string[]): Promise<{ export: string; addresses: string[] }>;
}

/**
 * A step that failed, in one plain sentence for the person (`message`).
 *
 * - `unsupported`: this NAS can't keep backups (too old, no Container Manager or Container Station, no apps pool);
 * - `manage`: the connection only looks;
 * - `refused`: the NAS refused a call (its account may not, or the API isn't the one Whombat knows);
 * - `unreachable`: the NAS didn't answer;
 * - `failed`: the app didn't start or didn't answer in time.
 */
export class NasPlaceError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'manage' | 'refused' | 'unreachable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'NasPlaceError';
  }
}

/** What a driver needs from outside. */
export interface NasDriverDeps {
  /** The NAS's numeric LAN address (its connection's address resolved). Throws `NasPlaceError` when there is none. */
  address(): Promise<string>;
  /** The HTTP status `url` answers with, or null when nothing answers (or Whombat may not ask it). */
  probe(url: string): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  /** Epoch ms. */
  now(): number;
  /** How long ensure waits for the app to answer (default 10 minutes: pulling the images can take a while). */
  readyMs?: number;
  /**
   * The host the app is asked at, as the connection reaches the NAS (its name or address); default the numeric address.
   * The box's own check of the repository is at the numeric address.
   */
  probeHost?: string;
}

/** The REST server answers 401 without a user: anything below 500 means it is up. */
export function answersHttp(status: number | null): boolean {
  return status !== null && status > 0 && status < 500;
}

/** Polls `check` until it answers non-null or `ms` passes; null when it never did. */
export async function waitFor<T>(
  deps: Pick<NasDriverDeps, 'sleep' | 'now'>,
  ms: number,
  check: () => Promise<T | null>,
  everyMs = 2000,
): Promise<T | null> {
  const until = deps.now() + ms;
  for (;;) {
    const got = await check();
    if (got !== null) return got;
    if (deps.now() >= until) return null;
    await deps.sleep(everyMs);
  }
}

/** A host as a URL takes it (an IPv6 address in brackets). */
function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Waits until the REST server at `address:port` answers HTTP; throws `NasPlaceError` `failed` when it doesn't. */
export async function waitUntilAnswers(
  deps: NasDriverDeps,
  address: string,
  port: number,
  said: string,
): Promise<void> {
  const ok = await waitFor(deps, deps.readyMs ?? 10 * 60_000, async () =>
    answersHttp(await deps.probe(`http://${hostForUrl(deps.probeHost ?? address)}:${port}/`)) ? true : null,
  );
  if (!ok)
    throw new NasPlaceError(
      'failed',
      `The backup app on ${said} started but doesn’t answer on port ${port}. Check that nothing else uses that port and that its firewall lets it through.`,
    );
}

/** The cleanup's status file as the cleanup writes it (compose.ts). */
export interface CleanupStatus {
  lastAt: string | null;
  ok: boolean | null;
}

export function readCleanupStatus(text: string | null): CleanupStatus | null {
  if (!text) return null;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return {
      lastAt: typeof json.last_run_at === 'string' ? json.last_run_at : null,
      ok: typeof json.last_ok === 'boolean' ? json.last_ok : null,
    };
  } catch {
    return null;
  }
}

/** One HTTP request to the NAS, relative to its connection's address. */
export interface NasRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** From the connection's base: `/webapi/entry.cgi`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** Longer than a connection call's 30 s for the calls that pull images and start containers. */
  deadlineMs?: number;
}

export interface NasAnswer {
  status: number;
  body: Buffer;
}

/** Sends one request to the NAS as its connection (its address, policy and pinned certificate). */
export type NasSend = (req: NasRequest) => Promise<NasAnswer>;

/** The answer as JSON, or null. */
export function jsonAnswer(answer: NasAnswer): unknown {
  try {
    return JSON.parse(answer.body.toString('utf8'));
  } catch {
    return null;
  }
}
