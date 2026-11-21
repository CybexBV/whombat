/**
 * Restoring skills (BF-04; hermes-engine.md HE-41, HE-S123; hermes-skills.md HSK-S14): the file's skills replace the
 * shared skills directory whole — the person's changes, what is off, Hermes's hub lock and its manifest (so a
 * removed built-in stays removed) come back as they were — and the runner then runs Hermes's sync (`skills.sync`, which
 * keeps the person's changes and, for a file from before Hermes's skills, takes Whombat's old ones out first). Records of
 * Whombat's own skill store from older files have nowhere to go: the reader leaves them out as unreadable.
 */
import type { BackupSkillsLine } from '@whombat/core';
import { hermesHome } from '../../hermes-home/service';
import { restoreHermesArchive } from './hermes';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreSkills(run: RestoreRun, record: BackupSkillsLine): Promise<RecordOutcome> {
  if (!run.hasBlob(record.archive.sha256)) {
    run.note('missing_reference', 'skills');
    return 'skipped';
  }
  if (run.dry) return 'added';
  const put = await restoreHermesArchive(run, 'skills', { kind: 'skills' }, record.archive, 'replace');
  if (!put) return 'skipped';
  await hermesHome(run.services)
    .call('skills.sync', {}, { timeoutMs: 120_000 })
    .catch((err: unknown) =>
      run.services.log.warn({ err: String(err) }, 'restore: Hermes’s skills weren’t synced'),
    );
  return 'updated';
}
