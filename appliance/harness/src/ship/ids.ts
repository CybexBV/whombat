/**
 * Release ids (NX-67, PI-23): production `whombat-YYYYMMDD.N`, the dev instance `whombat-dev-YYYYMMDD.N` (UTC day of
 * the build, `N` from 1). The ids before PI-23, `pve-YYYYMMDD.N` and `pve-dev-YYYYMMDD.N` (generation 0), are read and
 * ordered but never made: every `whombat-…` id sorts after every `pve-…` id of its environment, as the helper's
 * `CompareVersions` orders host versions ("whombat" after "pve"). A PROD candidate's DEV twin (UP-C1) is
 * `whombat-dev-<the same day>.<the first N free on DEV>`.
 */
export interface ReleaseId {
  id: string;
  env: 'prod' | 'dev';
  /** 0: `pve-…` (before PI-23), 1: `whombat-…`. */
  gen: 0 | 1;
  day: string;
  n: number;
}

const RE = /^(pve|whombat)-(dev-)?(\d{8})\.([1-9]\d{0,3})$/;

export function parseReleaseId(id: string): ReleaseId | null {
  const m = RE.exec(id);
  if (!m?.[3] || !m[4]) return null;
  const day = m[3];
  const d = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10).replaceAll('-', '') !== day) return null;
  return { id, env: m[2] ? 'dev' : 'prod', gen: m[1] === 'whombat' ? 1 : 0, day, n: Number(m[4]) };
}

export function prodId(id: string): ReleaseId {
  const r = parseReleaseId(id);
  if (r?.env !== 'prod') throw new Error(`${id} is not a production release id (whombat-YYYYMMDD.N, NX-67)`);
  return r;
}

/**
 * The first production release of the migration baseline: the bridge (Whombat `1488be2a`, candidate 0.268.0), which
 * moves a database across to the chain that replaced the old one (IN-768; Whombat report-trackers.md). Every later
 * runtime refuses a database still on the old chain as foreign, so a box on an older release must take the bridge
 * first, and the upgrade gates never start from one (IN-415).
 */
export const BASELINE_RELEASE = 'whombat-20261115.11';

/** A production release from the migration baseline on. */
export function fromBaseline(r: ReleaseId): boolean {
  return r.env === 'prod' && compareIds(r, prodId(BASELINE_RELEASE)) >= 0;
}

/** A production id a new release may have: of the current generation (PI-23). */
export function newProdId(id: string): ReleaseId {
  const r = prodId(id);
  if (r.gen !== 1) throw new Error(`${id} is an id from before PI-23: a new release is whombat-YYYYMMDD.N`);
  return r;
}

/** Generation, then day, then counter (helper `CompareVersions` orders host ids the same way). */
export function compareIds(a: ReleaseId, b: ReleaseId): number {
  if (a.gen !== b.gen) return a.gen - b.gen;
  return a.day < b.day ? -1 : a.day > b.day ? 1 : a.n - b.n;
}

/**
 * The twin's id: `whombat-dev-<the PROD id's day>.<the highest N DEV has that day + 1>` among `taken` (ids published on
 * DEV, registered with its control, or built here). Not the first free N: TUF signs a DEV release only when its id
 * sorts after the family's newest (MG-50), so a gap below the newest is never usable. When DEV already has a release of
 * a later day than the PROD id, no id of that day sorts after it: refused, naming `--twin`. DEV's `pve-dev-…` ids are
 * all older (PI-23).
 */
export function twinIdFor(prod: ReleaseId, taken: Iterable<string>): string {
  let max = 0;
  let newest: ReleaseId | null = null;
  for (const t of taken) {
    const r = parseReleaseId(t);
    if (r?.env !== 'dev') continue;
    if (!newest || compareIds(r, newest) > 0) newest = r;
    if (r.gen === prod.gen && r.day === prod.day) max = Math.max(max, r.n);
  }
  if (newest && newest.gen === prod.gen && newest.day > prod.day)
    throw new Error(
      `DEV already has ${newest.id}, of a later day than ${prod.id}: no whombat-dev-${prod.day}.N sorts after it (MG-50). Build ${prod.id}'s twin under a later day with --twin whombat-dev-${newest.day}.${newest.n + 1}, or use a PROD id of that day`,
    );
  if (max >= 9999) throw new Error(`no dev release id left on ${prod.day}`);
  return `${prod.gen === 1 ? 'whombat' : 'pve'}-dev-${prod.day}.${max + 1}`;
}

/** The newest id of `env` strictly older than `than`, among `ids`. */
export function newestBefore(ids: Iterable<string>, than: ReleaseId, env: 'prod' | 'dev'): string | null {
  let best: ReleaseId | null = null;
  for (const id of ids) {
    const r = parseReleaseId(id);
    if (!r || r.env !== env || compareIds(r, than) >= 0) continue;
    if (!best || compareIds(r, best) > 0) best = r;
  }
  return best?.id ?? null;
}

/**
 * Release ids named by TUF release targets: `releases/<id>.json` in the targets metadata, `releases/<digest>.<id>.json`
 * on disk (consistent snapshots).
 */
export function idsFromTargets(targets: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const m = /^releases\/(?:[0-9a-f]{64}\.)?(.+)\.json$/.exec(t);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Versions as the helper and control order them: the contracts' `compareVersions` (CT-135; build metadata ignored,
 * dotted core numerically, a pre-release before its release, numeric pre-release parts before alphanumeric ones).
 */
export { compareVersions } from '@whombat/release';
