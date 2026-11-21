/**
 * The shared-copies cache on the device (data/sharedCache.ts): `cache/shared/`, one directory per attachment.
 */
import { Directory, type File, Paths } from 'expo-file-system';
import { SHARED_CACHE_DIR, type SharedFiles, staleSharedEntries } from '../data/sharedCache';

function sharedRoot(): Directory {
  return new Directory(Paths.cache, SHARED_CACHE_DIR);
}

function modifiedAt(entry: Directory | File): number | null {
  try {
    const time = entry instanceof Directory ? entry.info().modificationTime : entry.modificationTime;
    return typeof time === 'number' ? time : null;
  } catch {
    return null;
  }
}

export const sharedFiles: SharedFiles = {
  async clear() {
    const root = sharedRoot();
    if (root.exists) root.delete();
  },
  async sweep(now = Date.now()) {
    const root = sharedRoot();
    if (!root.exists) return;
    const entries = root.list();
    const stale = new Set(
      staleSharedEntries(
        entries.map((e) => ({ name: e.name, modifiedAt: modifiedAt(e) })),
        now,
      ),
    );
    for (const entry of entries) {
      if (!stale.has(entry.name)) continue;
      try {
        entry.delete();
      } catch {
        // Still in use by a share in progress: the next start removes it.
      }
    }
  },
};
