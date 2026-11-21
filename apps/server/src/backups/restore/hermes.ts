/**
 * Putting a Hermes home back from a backup file (hermes-engine.md HE-38, HE-S115, HE-S123): its archive, kept in the
 * job's scratch, goes to the runner in chunks and is put in place there (`home.importBegin` … `home.importCommit`).
 */
import { createReadStream } from 'node:fs';
import type { BackupCategoryId, HermesHomeRef, HermesImportMode } from '@whombat/core';
import { HermesHomeCallError, hermesHome, importHome } from '../../hermes-home/service';
import type { RestoreRun } from './run';

/** How many files came back, how many things here were kept; null when the file or the runner couldn't. */
export async function restoreHermesArchive(
  run: RestoreRun,
  category: BackupCategoryId,
  home: HermesHomeRef,
  archive: { sha256: string; size: number },
  mode: HermesImportMode,
): Promise<{ files: number; kept: number } | null> {
  const path = run.blobPath(archive.sha256);
  if (!path) {
    run.note('missing_reference', category);
    return null;
  }
  const exec = hermesHome(run.services);
  try {
    return await importHome(
      exec,
      home,
      {
        bytes: archive.size,
        sha256: archive.sha256,
        read: () => createReadStream(path) as AsyncIterable<Uint8Array>,
      },
      mode,
    );
  } catch (err) {
    run.services.log.warn(
      { err: String(err), code: err instanceof HermesHomeCallError ? err.code : null, category },
      'restore: a Hermes home couldn’t be put back',
    );
    run.note('unreadable', category);
    return null;
  }
}
