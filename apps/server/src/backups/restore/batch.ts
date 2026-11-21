/**
 * Records through their category's restorer (BF-04, BF-D06), the same for the preview and the restore: each record
 * parsed against its schema (a bad one is left out with a note, never the restore), restored in its own savepoint (one
 * that fails is skipped; the batch goes on), counted, and the batch's pairs written into the restore map.
 */
import {
  type BackupCategoryId,
  type BackupCategoryRecords,
  collectBackupIds,
  type JsonValue,
  parseBackupRecord,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { attachments, messages } from '../../db/schema/index';
import { outcomeKey } from '../look/pick';
import { restoreAgents, restoreScheduleThread } from './agents';
import { restoreAutomations } from './automations';
import { restoreConnections } from './connections';
import { restoreFiles } from './files';
import { restoreMemories } from './memories';
import { restoreMessages } from './messages';
import { restoreRepositories } from './repositories';
import type { RecordOutcome, RestoreRun } from './run';
import { restoreServersLine } from './servers';
import { restoreSettings, restoreWidget } from './settings';
import { restoreSkills } from './skills';
import { restoreVault } from './vault';

type Restorer<C extends BackupCategoryId> = (
  run: RestoreRun,
  record: BackupCategoryRecords[C],
) => Promise<RecordOutcome>;

export const RESTORERS: { [C in BackupCategoryId]: Restorer<C> } = {
  agents: restoreAgents,
  memories: restoreMemories,
  automations: restoreAutomations,
  connections: restoreConnections,
  skills: restoreSkills,
  settings: restoreSettings,
  vault: restoreVault,
  messages: restoreMessages,
  servers: restoreServersLine,
  files: restoreFiles,
  repositories: restoreRepositories,
};

/**
 * The order a restore brings categories back in: what others point to first (people and channels, connections, agents,
 * the Vault agents hold keys to, the servers — pointed here with those keys —, skills attached to agents and bound to
 * Vault entries, …; servers before automations, which may name them, BF-S43).
 */
export const RESTORE_ORDER: readonly BackupCategoryId[] = [
  'settings',
  'connections',
  'agents',
  'vault',
  'servers',
  'skills',
  'memories',
  'automations',
  'messages',
  'files',
  'repositories',
];

/**
 * When a batch runs: `records` (its category's turn), `threads` (agents again after Messages, for their schedules'
 * threads, BF-S09) or `later` (the person's widgets again after Connections, BF-S17).
 */
export type RestorePhase = 'records' | 'threads' | 'later';

/** One batch of records in one phase. */
export async function applyRecords(
  run: RestoreRun,
  category: BackupCategoryId,
  records: readonly unknown[],
  phase: RestorePhase = 'records',
): Promise<void> {
  const ids = new Set<string>();
  for (const r of records) collectBackupIds(r as JsonValue, ids);
  await run.preload(ids);
  // Restoring into the burrow a file came from: its messages and files that are still here are themselves.
  if (run.sameBurrow && phase === 'records' && (category === 'messages' || category === 'files')) {
    const own = records
      .map((r) => r as { id?: unknown; type?: unknown })
      .filter((r) => (r.type === 'message' || r.type === 'file') && typeof r.id === 'string')
      .map((r) => r.id as string)
      .filter((id) => !run.mapped(id));
    if (own.length) {
      const table = category === 'messages' ? messages : attachments;
      const here = await run.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.burrowId, run.burrow.id), inArray(table.id, own)));
      for (const h of here) run.remember(h.id, h.id, category);
    }
  }
  const restorer = RESTORERS[category] as Restorer<BackupCategoryId>;
  for (const raw of records) {
    const parsed = parseBackupRecord(category, raw);
    if (!parsed.ok) {
      if (phase === 'records') {
        run.note('unreadable', category);
        run.tally(category).skipped++;
      }
      continue;
    }
    const record = parsed.record;
    if (phase === 'threads') {
      if (category === 'agents' && !run.dry)
        await run.tx.transaction(async () => restoreScheduleThread(run, record as never)).catch(() => {});
      continue;
    }
    if (phase === 'later') {
      if (category === 'settings' && !run.dry)
        await run.tx.transaction(async () => restoreWidget(run, record as never)).catch(() => {});
      continue;
    }
    let outcome: RecordOutcome;
    if (run.dry) outcome = await restorer(run, record);
    else {
      const mark = run.mark();
      try {
        outcome = await run.tx.transaction(async () => restorer(run, record));
      } catch (err) {
        run.rollback(mark);
        run.services.log.warn(
          { err: String(err), category, type: record.type },
          'backup restore: a record could not be restored',
        );
        outcome = 'skipped';
      }
    }
    run.count(category, record as { type: string }, outcome);
    if (run.outcomes) run.keepOutcome(outcomeKey(category, record as never), outcome);
  }
  if (run.unknownAuthors.size) {
    run.note('unknown_authors', 'messages', run.unknownAuthors.size);
    run.unknownAuthors.clear();
  }
  await run.flushMap();
}
