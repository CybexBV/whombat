/**
 * Downloaded copies of files the user shared or opened (`cache/shared/<attachment>/<name>`, ui/attachments.tsx) are
 * private conversation content outside the app's authorization (docs/decisions/bp-attachments.md BP-A21). They are
 * removed when the user signs out, and at app start once they are a day old. Pure: the file system is `lib/sharedCache.ts`.
 */

/** The directory in the app's cache that holds shared copies. */
export const SHARED_CACHE_DIR = 'shared';

/** How long a shared copy may stay (the share sheet and the app it went to have long finished with it). */
export const SHARED_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SharedEntry {
  name: string;
  /** Last modification, ms since the epoch; null when the platform doesn't say (removed, to be safe). */
  modifiedAt: number | null;
}

/** The entries to remove at start: older than the maximum age, or of unknown age. */
export function staleSharedEntries(
  entries: readonly SharedEntry[],
  now: number,
  maxAgeMs: number = SHARED_CACHE_MAX_AGE_MS,
): string[] {
  return entries.filter((e) => e.modifiedAt === null || now - e.modifiedAt >= maxAgeMs).map((e) => e.name);
}

/** What the session needs of the shared-copies cache (the app passes the file-system one). */
export interface SharedFiles {
  /** Removes every shared copy (sign-out). */
  clear(): Promise<void>;
  /** Removes shared copies older than a day (app start). */
  sweep(now?: number): Promise<void>;
}
