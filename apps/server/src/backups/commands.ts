/**
 * Backup files through the commit pipeline (docs/decisions/backup-file.md BF-01, BF-03, BF-08, BF-D07): every command
 * here is the person's (an agent never reaches one: no MCP tool, no keys-engine path), and each is signed. The
 * restore's batches run only inside a restore job of the same person (`liveRestores`): the command carries the records,
 * the job the file's directory and choices.
 */
import {
  BACKUP_CATEGORY_IDS,
  type BackupCategoryId,
  BackupCategoryList,
  type BackupDirectoryEntry,
  BackupFileId,
  type BackupFileManifest,
  type BackupOnDifferent,
  BackupRestoreId,
  type BackupRestoreSummary,
  backupFileMadeText,
  backupRestoredText,
  ConnectionId,
  sortBackupCategories,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { burrowWhere } from '../commands/burrows';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { backupRestores, burrows, catalogConnections, connections } from '../db/schema/index';
import { loadPrincipalRow } from '../read/principals';
import { backupError } from './errors';
import { offeredCategories } from './offered';
import { applyRecords } from './restore/batch';
import { type CategoryTally, type RecordOutcome, type RestoreFollowUps, RestoreRun } from './restore/run';
import { toDefaults } from './store';

/** People only (BF-01; one-person.md OP-S79). */
export function requirePersonActor(ctx: ApplyContext): void {
  if (ctx.actor.kind !== 'person') throw backupError('people_only');
}

/** “Make these the default” (BF-09). */
export const setBackupDefaults = defineCommand({
  name: 'backup.set_defaults',
  schema: z.object({ categories: BackupCategoryList }),
  async apply(tx, ctx, input) {
    requirePersonActor(ctx);
    const categories = sortBackupCategories(input.categories);
    const [row] = await tx
      .update(burrows)
      .set({ backupDefaults: categories, backupDefaultsAt: ctx.now })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    await ctx.emit({
      type: 'backup.defaults_changed',
      kind: 'System',
      text: 'Changed what a new backup file holds',
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      payload: { categories },
    });
    return toDefaults(row ?? ctx.burrow, await offeredCategories(ctx.services, ctx.burrow.id));
  },
});

/** A backup file was made (BF-08): the maker's signed event (nobody else to tell, one-person.md OP-S74). */
export const backupFileMade = defineCommand({
  name: 'backup.file_made',
  schema: z.object({
    fileId: BackupFileId,
    categories: z.array(z.enum(BACKUP_CATEGORY_IDS)).min(1),
    size: z.number().int().min(0),
  }),
  async apply(_tx, ctx, input) {
    requirePersonActor(ctx);
    const event = await ctx.emit({
      type: 'backup.file_made',
      kind: 'System',
      text: backupFileMadeText(input.categories),
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      payload: { fileId: input.fileId, categories: input.categories, size: input.size },
    });
    return { eventId: event.id };
  },
});

/** What a running restore job knows that its batches need (never in a command's input). */
export interface LiveRestore {
  restorerId: string;
  restorerEmail: string;
  sourceBurrowId: string;
  makerEmail: string;
  onDifferent: BackupOnDifferent;
  directory: ReadonlyMap<string, BackupDirectoryEntry>;
  scratch: string;
  blobs: ReadonlySet<string>;
  manifest: BackupFileManifest;
  /** Each record's outcome comes back with its batch (bringing back picked things, backup-look.md). */
  outcomes?: boolean;
}

/** The restore jobs running in this process. */
export const liveRestores = new Map<string, LiveRestore>();

export interface BatchResult {
  tallies: [BackupCategoryId, CategoryTally][];
  notes: ReturnType<RestoreRun['noteList']>;
  followUps: RestoreFollowUps;
  touched: string[];
  /** Each record's outcome by its key, when the restore asked for them. */
  outcomes?: [string, RecordOutcome][];
}

/**
 * One batch of a restore (BF-04, BF-D06): its records through their restorer in this transaction, the restore map
 * updated, one signed event (no text: the restore's own event says what came back).
 */
export const restoreBatch = defineCommand({
  name: 'backup.restore_batch',
  schema: z.object({
    restoreId: BackupRestoreId,
    category: z.enum(BACKUP_CATEGORY_IDS),
    phase: z.enum(['records', 'threads', 'later']).default('records'),
    records: z.array(z.unknown()).max(2000),
  }),
  async apply(tx, ctx, input): Promise<BatchResult> {
    requirePersonActor(ctx);
    const live = liveRestores.get(input.restoreId);
    if (!live || live.restorerId !== ctx.actor.id) throw backupError('restore_failed');
    const [row] = await tx.select().from(backupRestores).where(eq(backupRestores.id, input.restoreId));
    if (
      !row ||
      row.burrowId !== ctx.burrow.id ||
      row.restoredById !== ctx.actor.id ||
      row.status !== 'restoring'
    )
      throw backupError('restore_failed');
    const me = await loadPrincipalRow(tx, ctx.actor.id);
    if (!me) throw backupError('people_only');
    const run = new RestoreRun({
      services: ctx.services,
      db: tx,
      burrow: ctx.burrow,
      restorer: me,
      restorerEmail: live.restorerEmail,
      sourceBurrowId: live.sourceBurrowId,
      onDifferent: live.onDifferent,
      dry: false,
      directory: live.directory,
      ctx,
      makerEmail: live.makerEmail,
      scratch: live.scratch,
      blobs: live.blobs,
      outcomes: live.outcomes === true,
    });
    await applyRecords(run, input.category, input.records, input.phase);
    const t = run.tally(input.category);
    await ctx.emit({
      type: 'backup.restore_batch',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        restoreId: input.restoreId,
        category: input.category,
        phase: input.phase,
        records: input.records.length,
        added: t.added,
        updated: t.updated,
      },
    });
    return {
      tallies: [...run.tallies.entries()],
      notes: run.noteList(),
      followUps: run.followUps,
      touched: [...run.touched],
      ...(run.outcomes ? { outcomes: run.outcomes } : {}),
    };
  },
});

/** The restore's signed event (BF-03, BF-08): “Restored 9 automations from a backup made on 11 Oct”. */
export const backupRestored = defineCommand({
  name: 'backup.restored',
  schema: z.object({
    restoreId: BackupRestoreId,
    madeAt: z.string(),
    timeZone: z.string(),
    sourceBurrowId: z.string(),
    summary: z.custom<BackupRestoreSummary>((v) => !!v && typeof v === 'object'),
  }),
  async apply(_tx, ctx, input) {
    requirePersonActor(ctx);
    const event = await ctx.emit({
      type: 'backup.restored',
      kind: 'System',
      text: backupRestoredText(input.summary, { createdAt: input.madeAt, timeZone: input.timeZone }, ctx.now),
      where: burrowWhere(ctx.services, ctx.burrow.slug),
      payload: {
        restoreId: input.restoreId,
        sourceBurrowId: input.sourceBurrowId,
        categories: input.summary.categories.map((c) => ({ id: c.id, added: c.added, updated: c.updated })),
        automationsOff: input.summary.automationsOff,
      },
    });
    return { eventId: event.id };
  },
});

/**
 * A restored connection whose check failed here (BF-06): it needs a person — “Sign in again” under Connections → Needs
 * you — whatever the check called it (refused, unreachable, a client that stayed on the other Whombat).
 */
export const restoredNeedsSignIn = defineCommand({
  name: 'backup.connection_needs_sign_in',
  schema: z.object({
    connectionId: ConnectionId,
    source: z.enum(['catalog', 'connector']),
    message: z.string().max(500),
  }),
  async apply(tx, ctx, input) {
    requirePersonActor(ctx);
    const now = ctx.now;
    if (input.source === 'catalog') {
      await tx
        .update(catalogConnections)
        .set({
          status: 'needs_reauth',
          reauthReason: 'token_invalid',
          accessTokenEnc: null,
          accessExpiresAt: null,
          checks: [{ id: 'credential', state: 'error', message: input.message }],
          checkedAt: now,
          updatedAt: now,
        })
        .where(eq(catalogConnections.id, input.connectionId));
    } else {
      await tx
        .update(connections)
        .set({
          status: 'needs_reauth',
          reauthReason: 'revoked',
          accessTokenEnc: null,
          accessExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(connections.id, input.connectionId)));
    }
    await ctx.emit({
      type: 'backup.connection_needs_sign_in',
      kind: 'System',
      text: null,
      where: null,
      payload: { connectionId: input.connectionId },
    });
    return { ok: true as const };
  },
});

export const BACKUP_COMMANDS = [
  setBackupDefaults,
  backupFileMade,
  restoreBatch,
  backupRestored,
  restoredNeedsSignIn,
];
