/**
 * A Hermes home in a backup file (hermes-engine.md HE-38, HE-S115, HE-S123): its archive (the runner packs the running
 * Whombat's, `home.exportBegin`; a backup opened for reading packs its own copy) goes into the file as a blob
 * (`files/<sha256>`), read in chunks while the body is written. When nothing can pack it, the file leaves it out and
 * says so.
 */
import type { BackupCategoryId, HermesHomeRef } from '@whombat/core';
import type { CategoryOut, CollectScope } from './scope';

/** The archive of `home`, as a blob of the file, or null (empty, or it couldn't be packed: noted). */
export async function hermesArchive(
  scope: CollectScope,
  out: CategoryOut,
  home: HermesHomeRef,
  category: BackupCategoryId,
): Promise<{ sha256: string; size: number; files: number } | null> {
  try {
    const archive = await scope.source.hermesArchive(home);
    if (!archive) {
      out.note('unreadable');
      return null;
    }
    if (archive.files === 0) {
      await archive.discard();
      return null;
    }
    out.blob({ sha256: archive.sha256, size: archive.bytes, open: async () => archive.read() });
    return { sha256: archive.sha256, size: archive.bytes, files: archive.files };
  } catch (err) {
    scope.services.log.warn({ err: String(err), category }, 'backup: a Hermes home couldn’t be packed');
    out.note('unreadable');
    return null;
  }
}
