/**
 * A Hermes home's archive (hermes-engine.md HE-S114): a gzipped ustar whose first entry is its manifest
 * (`whombat-home.json`: format, kind, Hermes's version, the executable files), the files under `home/`. The runner
 * makes and reads them (`apps/runner/src/hermes-home/archive.ts`).
 */
import type { HermesHomeRef } from '@whombat/core';

/** The manifest's name, first in every archive. */
export const HERMES_HOME_MANIFEST = 'whombat-home.json';
/** The manifest's `format`. */
export const HERMES_HOME_FORMAT = 'whombat-hermes-home';
/** Where a home's files are inside the archive. */
export const HERMES_HOME_PREFIX = 'home/';

export interface HermesHomeManifest {
  format: typeof HERMES_HOME_FORMAT;
  kind: HermesHomeRef['kind'];
  hermes: string;
  /** Files that were executable (scripts of skills). */
  exec: string[];
}

/**
 * What a profile's archive holds, by top-level name: the person's own data in their home. `scripted-hermes` is the
 * scripted stand-in's session store (HE-33), Hermes's `state.db` for tests and the demo. Never Hermes's own login store
 * (`auth.json`, a ChatGPT sign-in: HN-03).
 */
export const HERMES_HOME_ENTRIES: readonly string[] = [
  'memories',
  'state.db',
  'state.db-wal',
  'sessions',
  'projects.db',
  'scripted-hermes',
];

/** Files no archive takes, wherever they are: locks, temporary files, backups Hermes made of a memory file. */
const SKIPPED = /(^|\/)(\.mem_[^/]*|[^/]*\.lock|[^/]*\.tmp|[^/]*\.bak\.\d+)$/;

/**
 * Whether a file of a home (its path relative to the home) belongs in its archive. The runner packs the running
 * Whombat's homes with it, and the server a backup's copy of them when it is opened for reading.
 */
export function hermesArchiveIncludes(kind: HermesHomeRef['kind'], rel: string): boolean {
  if (SKIPPED.test(rel)) return false;
  if (kind === 'skills') return true;
  const top = rel.split('/')[0] ?? '';
  if (!HERMES_HOME_ENTRIES.includes(top)) return false;
  // Only the memory files themselves (Hermes keeps locks and backups beside them).
  if (top === 'memories') return /^memories\/[^/]+\.md$/.test(rel);
  return true;
}
