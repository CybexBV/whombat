/**
 * Restoring memories (BF-04; hermes-engine.md HE-39, HE-S115, HE-S123; one-person.md OP-S75): the person's Hermes home
 * and the outside turns' come back into the same homes here. A home with nothing here comes back whole; one that is
 * here keeps what it has (only what is missing is added), or with “Use the backup” is replaced by the file's. The
 * agent's notes come back when there are none, and replace different ones with “Use the backup”.
 */
import type { BackupAgentNotesRecord, BackupHermesHomeRecord, BackupMemoriesLine } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../../db/schema/index';
import { hermesHomeRestored, kickHermesHousekeeping } from '../../hermes-home/housekeeping';
import { agentNotesOf } from '../../memory/notes';
import { restoreHermesArchive } from './hermes';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreMemories(run: RestoreRun, record: BackupMemoriesLine): Promise<RecordOutcome> {
  return record.type === 'agent_notes' ? notes(run, record) : home(run, record);
}

async function home(run: RestoreRun, r: BackupHermesHomeRecord): Promise<RecordOutcome> {
  if (!run.hasBlob(r.archive.sha256)) {
    run.note('missing_reference', 'memories');
    return 'skipped';
  }
  if (run.dry) return 'added';
  const mode = run.onDifferent === 'replace' ? 'replace' : 'fill';
  const put = await restoreHermesArchive(run, 'memories', { kind: 'profile', home: r.home }, r.archive, mode);
  if (!put) return 'skipped';
  // The archive may hold sessions forgotten since it was made: they are deleted again (hermes-native.md HN-K03); and
  // ones no thread here names (a home from another Whombat) go once idle long enough (HN-K11).
  await hermesHomeRestored(run.tx, r.home);
  kickHermesHousekeeping(run.ctx, { home: r.home });
  if (mode === 'replace') return 'updated';
  // Filled: whole when nothing of it was here, else what was here stayed (and only what was missing came back).
  return put.kept > 0 ? 'kept' : 'added';
}

async function notes(run: RestoreRun, r: BackupAgentNotesRecord): Promise<RecordOutcome> {
  const here = await agentNotesOf(run.db, run.burrow.id);
  if (here?.text === r.text) return 'unchanged';
  const write = async () => {
    await run.tx
      .update(burrows)
      .set({
        agentNotes: r.text ? { text: r.text, updatedAt: r.updatedAt, updatedById: run.restorer.id } : null,
      })
      .where(eq(burrows.id, run.burrow.id));
  };
  if (here) return run.different(write);
  if (run.dry) return 'added';
  await write();
  return 'added';
}
