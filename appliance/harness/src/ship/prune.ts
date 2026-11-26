/**
 * Old release folders go (`release/ship prune`, and whombat-ops `candidate` after every run that ended well). Each
 * `release/build` leaves a folder under ~/.cache/whombat-releases (a few hundred MB of blobs hard-linked into the shared
 * `nar/` cache, Nix GC roots for what it built, and for a promoted host release a 4 GB installer ISO). Nothing else
 * removes them, and their GC roots keep the Nix store from freeing what they built.
 *
 * What stays (`prunePlan`):
 * - every release Beta or Production lists (a box rolls back only to a listed release, and `promote` takes one of
 *   them), and the build before each of them here (what a rollback or an upgrade gate starts from);
 * - the newest `keep` production builds (default 10), whatever their channel;
 * - anything changed in the last day (a build or an ISO in progress, a run that stopped and carries on);
 * - the host build of everything kept (a runtime-only release runs, reuses and installs its host's).
 *
 * The rest goes: older production builds, the DEV twins from before one image, failed builds. Folders whose name is no
 * release id (`nar/`, community builds, anything else) are never touched. In what stays, an installer ISO goes too
 * unless it is the newest Production release's host, the one before it, or Beta's newest release's host: `promote`
 * builds one again when it has none. Last, the `nar/` cache loses the blobs no release folder links any more.
 *
 * It refuses without both channels' lists. The callers hold the locks: `candidate` its own and the heavy lock,
 * `release/ship prune` both, taken without waiting (it skips when either is busy).
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { channelReleaseIds, cloneChannelIds, type ShipContext, say } from './context.ts';
import { compareIds, parseReleaseId, type ReleaseId } from './ids.ts';

export const DEFAULT_KEEP_NEWEST = 10;
/** Folders and blobs changed this recently stay whatever else is true. */
export const RECENT_MS = 24 * 3_600_000;

/** A release folder here, as the keep rule sees it. */
export interface ReleaseDir {
  id: string;
  /** The host release it runs (`build.json` `tuple.host.version`): its own id for a host release. */
  host: string | null;
  /** It has an installer ISO recorded in `iso.json` (older builds record theirs in build.json: left alone). */
  iso: boolean;
  /** Last change of the folder (a new file or folder in it: the build finishing, an ISO added). */
  modifiedAt: number;
}

export interface Listed {
  beta: readonly string[];
  production: readonly string[];
}

export interface KeepRules {
  listed: Listed;
  keep: number;
  now: number;
}

export interface PrunePlan {
  /** Folders that stay, with why (the first reason found). */
  keep: Map<string, string>;
  /** Folders to remove, oldest first. */
  remove: string[];
  /** Kept folders whose ISO goes. */
  dropIso: string[];
}

const byId = (a: ReleaseId, b: ReleaseId) => compareIds(a, b);

/** The newest of `ids` by release id order, null when none parses. */
function newestOf(ids: Iterable<string>): ReleaseId | null {
  let best: ReleaseId | null = null;
  for (const id of ids) {
    const r = parseReleaseId(id);
    if (r && (!best || compareIds(r, best) > 0)) best = r;
  }
  return best;
}

/** What to keep and what to remove (the module's comment says why). Pure. */
export function prunePlan(dirs: readonly ReleaseDir[], rules: KeepRules): PrunePlan {
  const byName = new Map(dirs.map((d) => [d.id, d]));
  const parsed = dirs
    .map((d) => parseReleaseId(d.id))
    .filter((r): r is ReleaseId => r !== null)
    .sort(byId);
  const prod = parsed.filter((r) => r.env === 'prod');
  const keep = new Map<string, string>();
  const add = (id: string, why: string) => {
    if (byName.has(id) && !keep.has(id)) keep.set(id, why);
  };

  const listed = new Map<string, string>();
  for (const id of rules.listed.production) listed.set(id, 'in Production');
  for (const id of rules.listed.beta) if (!listed.has(id)) listed.set(id, 'in Beta');
  for (const [id, why] of listed) {
    add(id, why);
    // The build before it here, whether or not a channel lists that one.
    const r = parseReleaseId(id);
    if (!r) continue;
    const before = prod.filter((p) => compareIds(p, r) < 0).at(-1);
    if (before) add(before.id, `the build before ${id}`);
  }
  for (const r of rules.keep > 0 ? prod.slice(-rules.keep) : []) add(r.id, `one of the newest ${rules.keep}`);
  for (const d of dirs) if (rules.now - d.modifiedAt < RECENT_MS) add(d.id, 'changed in the last day');
  // Hosts of what stays (a host's host is itself, so one pass settles it; looped for safety).
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...keep.keys()]) {
      const host = byName.get(id)?.host;
      if (host && byName.has(host) && !keep.has(host)) {
        keep.set(host, `the host of ${id}`);
        changed = true;
      }
    }
  }

  const remove = parsed.map((r) => r.id).filter((id) => !keep.has(id));

  // ISOs worth keeping: what the download site has now (Production's newest), the one before it, and the next to be
  // promoted (Beta's newest), each its host's.
  const isoKeep = new Set<string>();
  const hostOf = (id: string | undefined) => (id ? (byName.get(id)?.host ?? id) : null);
  const productionOrder = rules.listed.production
    .map((id) => parseReleaseId(id))
    .filter((r): r is ReleaseId => r !== null)
    .sort(byId);
  for (const r of productionOrder.slice(-2)) {
    const h = hostOf(r.id);
    if (h) isoKeep.add(h);
  }
  const betaHost = hostOf(newestOf(rules.listed.beta)?.id);
  if (betaHost) isoKeep.add(betaHost);
  const dropIso = [...keep.keys()]
    .filter((id) => {
      const d = byName.get(id);
      return d?.iso && !isoKeep.has(id) && rules.now - d.modifiedAt >= RECENT_MS;
    })
    .sort((a, b) => byId(parseReleaseId(a) as ReleaseId, parseReleaseId(b) as ReleaseId));

  return { keep, remove, dropIso };
}

/** The release folders under `root` (names that are release ids; everything else is left out). */
export function listReleaseDirs(root: string): ReleaseDir[] {
  if (!existsSync(root)) return [];
  const out: ReleaseDir[] = [];
  for (const id of readdirSync(root)) {
    if (!parseReleaseId(id)) continue;
    const dir = join(root, id);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      let host: string | null = null;
      try {
        const b = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as {
          tuple?: { host?: { version?: string } };
        };
        host = b.tuple?.host?.version ?? null;
      } catch {
        // no build.json: a build that never finished
      }
      out.push({ id, host, iso: existsSync(join(dir, 'iso.json')), modifiedAt: lstatSync(dir).mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** Every regular file under `path` (no symlinks followed). */
function* files(path: string): Generator<string> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) for (const name of readdirSync(path)) yield* files(join(path, name));
  else if (st.isFile()) yield path;
}

/** The GC roots a folder holds (`gcroots/*`). */
function gcRootsOf(dir: string): number {
  const g = join(dir, 'gcroots');
  return existsSync(g) ? readdirSync(g).length : 0;
}

export interface PruneResult {
  plan: PrunePlan;
  folders: number;
  isos: number;
  gcRoots: number;
  blobs: number;
  /** Bytes freed (a dry run: would be). */
  bytes: number;
}

/**
 * Applies the keep rule to `root` (a dry run only counts). The bytes are the files whose every link goes: those only
 * in what is removed, and the `nar/` blobs left linked by no folder.
 */
export function pruneReleases(
  root: string,
  o: { listed: Listed; keep?: number; now?: number; dryRun: boolean },
): PruneResult {
  const now = o.now ?? Date.now();
  const dirs = listReleaseDirs(root);
  const plan = prunePlan(dirs, { listed: o.listed, keep: o.keep ?? DEFAULT_KEEP_NEWEST, now });
  const gone = [
    ...plan.remove.map((id) => join(root, id)),
    ...plan.dropIso.flatMap((id) => [join(root, id, 'iso'), join(root, id, 'iso.json')]),
  ];
  // Links per inode among what goes.
  const links = new Map<number, { count: number; nlink: number; size: number }>();
  for (const g of gone)
    for (const f of files(g)) {
      const st = statSync(f);
      const l = links.get(st.ino) ?? { count: 0, nlink: st.nlink, size: st.size };
      l.count++;
      links.set(st.ino, l);
    }
  let bytes = 0;
  for (const l of links.values()) if (l.count >= l.nlink) bytes += l.size;

  // The nar/ cache: a blob goes when no release folder links it once these are gone (its own link is the last), and
  // it is older than a day (a build links what it adds right away).
  const cache = join(root, 'nar');
  const blobs: string[] = [];
  if (existsSync(cache))
    for (const name of readdirSync(cache)) {
      const f = join(cache, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      if (!st.isFile() || now - st.mtimeMs < RECENT_MS) continue;
      const others = st.nlink - 1 - (links.get(st.ino)?.count ?? 0);
      if (others <= 0) {
        blobs.push(f);
        bytes += st.size;
      }
    }

  const gcRoots = plan.remove.reduce((n, id) => n + gcRootsOf(join(root, id)), 0);
  if (!o.dryRun) {
    for (const g of gone) rmSync(g, { recursive: true, force: true });
    for (const b of blobs) rmSync(b, { force: true });
  }
  return {
    plan,
    folders: plan.remove.length,
    isos: plan.dropIso.length,
    gcRoots,
    blobs: blobs.length,
    bytes,
  };
}

/** One line for people: what went (or would go) and how much it freed. */
export function pruneWords(r: PruneResult, dryRun: boolean): string {
  const gb = (r.bytes / 1e9).toFixed(1);
  const verb = dryRun ? 'would remove' : 'removed';
  return `${verb} ${r.folders} old release folders (${r.gcRoots} Nix GC roots), ${r.isos} installer ISOs and ${r.blobs} unused cached blobs: ${gb} GB; ${r.plan.keep.size} folders stay`;
}

/**
 * Takes `lock` (`flock`) only when it is free, held until `release()`: a `flock -n … cat` child whose stdin is ours, so
 * the lock goes when we do. Null when something else holds it.
 */
export async function holdIfFree(lock: string): Promise<{ release: () => Promise<void> } | null> {
  mkdirSync(dirname(lock), { recursive: true });
  const child = spawn('flock', ['-n', lock, 'sh', '-c', 'echo held; exec cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const held = await new Promise<boolean>((resolve) => {
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('held')) resolve(true);
    });
    child.on('exit', () => resolve(false));
    child.on('error', () => resolve(false));
  });
  if (!held) return null;
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return {
    release: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

/** Both channels' lists from these sources, each a union of what the sources say; null when a channel has none. */
export function unionListed(
  sources: readonly { beta: string[] | null; production: string[] | null }[],
): Listed | null {
  const beta = sources.map((s) => s.beta).filter((x): x is string[] => x !== null);
  const production = sources.map((s) => s.production).filter((x): x is string[] => x !== null);
  if (!beta.length || !production.length) return null;
  return { beta: [...new Set(beta.flat())], production: [...new Set(production.flat())] };
}

/** The candidate's lock (whombat-ops `candidate` holds it for a whole run): `WB_CANDIDATE_LOCK`, else its default. */
export const candidateLock = (env = process.env) =>
  env.WB_CANDIDATE_LOCK || join(env.TMPDIR || join(homedir(), '.cache', 'wb-tmp'), 'dev-candidate.lock');

/**
 * `release/ship prune [--dry-run]`: the channels from releases.whombat.com and, when `WHOMBAT_RELEASES_DIR` names it,
 * the publisher's clone; it skips while a candidate or other heavy work runs.
 */
export async function shipPrune(ctx: ShipContext, a: { dryRun: boolean }): Promise<void> {
  const clone = process.env.WHOMBAT_RELEASES_DIR;
  const listed = unionListed([
    {
      beta: await channelReleaseIds(ctx.prod.releasesUrl, 'development'),
      production: await channelReleaseIds(ctx.prod.releasesUrl, 'production'),
    },
    ...(clone
      ? [{ beta: cloneChannelIds(clone, 'development'), production: cloneChannelIds(clone, 'production') }]
      : []),
  ]);
  if (!listed)
    throw new Error(
      `prune: can't read what Beta and Production list (${ctx.prod.releasesUrl}): nothing removed`,
    );
  const locks: { release: () => Promise<void> }[] = [];
  try {
    for (const lock of [candidateLock(), ctx.heavyLock]) {
      const h = await holdIfFree(lock);
      if (!h) {
        say(`prune: ${lock} is held (a candidate or other heavy work runs): nothing removed, try later`);
        return;
      }
      locks.push(h);
    }
    const r = pruneReleases(ctx.root, { listed, dryRun: a.dryRun });
    if (a.dryRun) for (const id of r.plan.remove) say(`prune: would remove ${id}`);
    for (const id of r.plan.dropIso) say(`prune: ${a.dryRun ? 'would drop' : 'dropped'} the ISO of ${id}`);
    for (const [id, why] of r.plan.keep) say(`prune: keeps ${id} (${why})`);
    say(`prune: ${pruneWords(r, a.dryRun)}`);
  } finally {
    for (const l of locks.reverse()) await l.release();
  }
}

/**
 * After a candidate's run (it holds the candidate lock already): the channels from the publisher's clone it just
 * published to; skipped while other heavy work holds the heavy lock. Never stops the run.
 */
export async function pruneAfterCandidate(
  root: string,
  clone: string,
  heavyLock: string,
  tell: (s: string) => void,
): Promise<void> {
  try {
    const listed = unionListed([
      { beta: cloneChannelIds(clone, 'development'), production: cloneChannelIds(clone, 'production') },
    ]);
    if (!listed) {
      tell(`old release folders stay: ${clone} lists no Beta or Production`);
      return;
    }
    const h = await holdIfFree(heavyLock);
    if (!h) {
      tell('old release folders stay this time: other heavy work holds the heavy lock');
      return;
    }
    try {
      const r = pruneReleases(root, { listed, dryRun: false });
      if (r.folders || r.isos || r.blobs) tell(pruneWords(r, false));
    } finally {
      await h.release();
    }
  } catch (err) {
    tell(`old release folders were not pruned (${(err as Error).message.split('\n')[0]})`);
  }
}
