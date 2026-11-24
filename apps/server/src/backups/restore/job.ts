/**
 * The preview and the restore of an uploaded file (BF-04, BF-06, BF-07, BF-08). Both read the whole file first (every
 * chunk authenticated, so a damaged one is refused before anything changes). The preview runs every record through
 * its restorer without writing; the restore runs the chosen categories in dependency order, in batches through
 * `backup.restore_batch`, then checks every restored connection, moves the members' read markers past restored history,
 * signs `backup.restored` and keeps the summary.
 */
import {
  BACKUP_SUMMARY_NAMES_MAX,
  type BackupCategoryId,
  type BackupFileManifest,
  type BackupNote,
  type BackupOnDifferent,
  type BackupProgress,
  type BackupRestoreCategoryPreview,
  type BackupRestorePreview,
  type BackupRestoreSummary,
  type BackupServersChoice,
  type BackupServersPreview,
  type BackupServersSummary,
  sortBackupCategories,
} from '@whombat/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { BurrowRow } from '../../commit/types';
import { recheckConnection, setConnectionTool, viewerFor } from '../../connections/connect';
import type { ConnectionViewer } from '../../connections/store';
import { setConnectionToolLimits } from '../../connections/tool-limits';
import { checkConnection } from '../../connectors/store';
import { connections, connectionTools, messages, readStates } from '../../db/schema/index';
import { thePerson } from '../../domain/the-person';
import { iso } from '../../lib/time';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { addNetwork } from '../../vault/networks';
import { restoringVault } from '../../vault/onepassword/restore';
import {
  type BatchResult,
  backupRestored,
  liveRestores,
  restoreBatch,
  restoredNeedsSignIn,
} from '../commands';
import { spooledLines } from '../spool';
import { applyRecords, RESTORE_ORDER, type RestorePhase } from './batch';
import type { ReadUpload } from './read';
import {
  type CategoryTally,
  emptyFollowUps,
  emptyTally,
  type RecordOutcome,
  type RestoredTool,
  type RestoreFollowUps,
  RestoreRun,
} from './run';
import { previewServersTally, readFileServers, restoreServersStep, serversFit } from './servers';

/** Records per restore batch (messages and files go in bigger ones: they are many and small). */
const BATCH = 100;
const BIG_BATCH = 250;

export interface PreviewInput {
  services: Services;
  burrow: BurrowRow;
  restorer: PrincipalRow;
  restorerEmail: string;
  read: ReadUpload;
  fileName: string;
  size: number;
}

/** What a restore would do, per category of the file (nothing is written). */
export async function previewRestore(p: PreviewInput): Promise<BackupRestorePreview> {
  const m = p.read.manifest;
  const run = new RestoreRun({
    services: p.services,
    db: p.services.db,
    burrow: p.burrow,
    restorer: p.restorer,
    restorerEmail: p.restorerEmail,
    sourceBurrowId: m.source.burrowId,
    onDifferent: 'keep',
    dry: true,
    directory: p.read.directory,
    ctx: null,
    makerEmail: m.madeBy.email,
    scratch: null,
    blobs: p.read.blobs,
  });
  const inFile = new Set(m.categories.map((c) => c.id));
  // The servers: where they fit here and the address question (BF-14, BF-15); counted as servers, not records.
  let servers: BackupServersPreview | null = null;
  if (inFile.has('servers')) {
    const file = await readFileServers(p.read);
    if (file.unreadable) run.note('unreadable', 'servers', file.unreadable);
    if (file.hub) {
      servers = (await serversFit(p.services, p.burrow, file.hub)).preview;
      run.tallies.set('servers', await previewServersTally(p.services, p.burrow.id, servers, file));
    }
  }
  for (const category of RESTORE_ORDER) {
    if (!inFile.has(category) || category === 'servers') continue;
    const s = p.read.spools.get(category);
    if (!s) continue;
    let batch: unknown[] = [];
    for await (const line of spooledLines(s.spool)) {
      batch.push(line);
      if (batch.length >= 500) {
        await applyRecords(run, category, batch);
        batch = [];
      }
    }
    if (batch.length) await applyRecords(run, category, batch);
  }
  const notes = run.noteList();
  if (p.read.unreadableDirectory)
    notes.push({ code: 'unreadable', category: null, count: p.read.unreadableDirectory });
  // What making the file had to leave out (BF-19, BF-S12): sign-ins that didn't open, files without Files.
  for (const n of m.notes ?? []) if (n.category === null || inFile.has(n.category)) notes.push({ ...n });
  const categories: BackupRestoreCategoryPreview[] = sortBackupCategories(inFile).map((id) => {
    const t = run.tallies.get(id) ?? emptyTally();
    return {
      id,
      count: t.added + t.unchanged + t.different,
      new: t.added,
      here: t.unchanged,
      different: t.different,
      notes: notes.filter((x) => x.category === id).slice(0, 20) as BackupNote[],
    };
  });
  return {
    fileName: p.fileName,
    size: p.size,
    manifest: m,
    sameBurrow: m.source.burrowId === p.burrow.id,
    categories,
    notes: notes.filter((x) => x.category === null).slice(0, 20) as BackupNote[],
    servers,
  };
}

export interface RestoreJob {
  services: Services;
  restoreId: string;
  burrow: BurrowRow;
  restorer: PrincipalRow;
  restorerEmail: string;
  read: ReadUpload;
  categories: BackupCategoryId[];
  onDifferent: BackupOnDifferent;
  /** The answer to the servers' address question (BF-15); absent: point them here when there is one. */
  servers?: BackupServersChoice | undefined;
  scratch: string;
  progress(p: BackupProgress): void;
  /** Hears each record's outcome by its key (bringing back picked things, backup-look.md); unset, none are kept. */
  onOutcome?: (key: string, outcome: RecordOutcome) => void;
}

/** Runs a restore to its end; returns its summary (a failure part-way throws with what it got to in `partial`). */
export async function runRestore(job: RestoreJob): Promise<BackupRestoreSummary> {
  const { services, read } = job;
  const m: BackupFileManifest = read.manifest;
  const chosen = new Set(job.categories);
  const tallies = new Map<BackupCategoryId, CategoryTally>();
  const notes = new Map<string, BackupNote>();
  const followUps = emptyFollowUps();
  const touched = new Set<string>();
  let serversSummary: BackupServersSummary | null = null;
  const merge = (r: BatchResult) => {
    for (const [id, t] of r.tallies) {
      const have = tallies.get(id) ?? emptyTally();
      for (const k of Object.keys(t) as (keyof CategoryTally)[]) have[k] += t[k];
      tallies.set(id, have);
    }
    for (const n of r.notes) {
      const key = `${n.code}:${n.category ?? ''}`;
      const have = notes.get(key);
      if (have) have.count += n.count;
      else notes.set(key, { ...n });
    }
    followUps.checkConnections.push(...r.followUps.checkConnections);
    followUps.automationsOff += r.followUps.automationsOff;
    followUps.schedulesPaused += r.followUps.schedulesPaused;
    followUps.homeNetworks.push(...r.followUps.homeNetworks);
    for (const c of r.touched) touched.add(c);
    for (const [key, outcome] of r.outcomes ?? []) job.onOutcome?.(key, outcome);
  };
  const total = Math.max(1, [...chosen].reduce((sum, c) => sum + (read.spools.get(c)?.lines ?? 0), 0) + 2);
  let done = 0;
  let step: BackupCategoryId | null = null;
  const tick = (n: number) => {
    done += n;
    job.progress({ done: Math.min(done, total - 1), total, step });
  };
  liveRestores.set(job.restoreId, {
    restorerId: job.restorer.id,
    restorerEmail: job.restorerEmail,
    sourceBurrowId: m.source.burrowId,
    makerEmail: m.madeBy.email,
    onDifferent: job.onDifferent,
    directory: read.directory,
    scratch: job.scratch,
    blobs: read.blobs,
    manifest: m,
    ...(job.onOutcome ? { outcomes: true } : {}),
  });
  const commitBatch = async (category: BackupCategoryId, records: unknown[], phase: RestorePhase) => {
    const commit = () =>
      services.pipeline.commit(
        restoreBatch,
        { restoreId: job.restoreId, category, phase, records },
        { burrowId: job.burrow.id, actorId: job.restorer.id },
      );
    // A Vault entry brought back may take back a pair whose item the 1Password sync is about to archive.
    const result = category === 'vault' ? await restoringVault(services, commit) : await commit();
    if (result.status !== 'ok') throw new Error('a restore batch was refused');
    merge(result.result);
  };
  /** A category's records of some types once more, in a later phase. */
  const recordsAgain = async (
    category: BackupCategoryId,
    phase: RestorePhase,
    wanted: (type: unknown) => boolean,
  ) => {
    const spool = read.spools.get(category);
    if (!spool) return;
    let again: unknown[] = [];
    for await (const line of spooledLines(spool.spool)) {
      if (!wanted((line as { type?: unknown }).type)) continue;
      again.push(line);
      if (again.length >= BATCH) {
        await commitBatch(category, again, phase);
        again = [];
      }
    }
    if (again.length) await commitBatch(category, again, phase);
  };
  const agentsAgain = (phase: RestorePhase, wanted: (type: unknown) => boolean) =>
    recordsAgain('agents', phase, wanted);
  try {
    for (const category of RESTORE_ORDER) {
      // The person's widgets read connections: once those are back (BF-S17), whether or not they were chosen.
      if (category === 'agents' && chosen.has('settings'))
        await recordsAgain('settings', 'later', (t) => t === 'widget');
      if (!chosen.has(category)) continue;
      const s = read.spools.get(category);
      if (!s) continue;
      step = category;
      // The servers are the hosts service's to take back (BF-14, BF-15); their choices go through the batches.
      if (category === 'servers') {
        const outcome = await restoreServersStep({
          services,
          burrow: job.burrow,
          restorer: job.restorer,
          read,
          pointHere: job.servers?.pointHere,
          commitBatch: (c, records) => commitBatch(c, records, 'records'),
          log: (message, extra) => services.log.warn({ restoreId: job.restoreId, ...extra }, message),
        });
        // The servers' own count, not their records' (a server's choices aren't counted things).
        tallies.set('servers', outcome.tally);
        serversSummary = outcome.summary;
        tick(s.lines);
        continue;
      }
      const size = category === 'messages' || category === 'files' ? BIG_BATCH : BATCH;
      let batch: unknown[] = [];
      for await (const line of spooledLines(s.spool)) {
        batch.push(line);
        if (batch.length >= size) {
          await commitBatch(category, batch, 'records');
          tick(batch.length);
          batch = [];
        }
      }
      if (batch.length) {
        await commitBatch(category, batch, 'records');
        tick(batch.length);
      }
      // Schedules' threads, once their messages are back (BF-S09): also for schedules an earlier restore brought back.
      if (category === 'messages') await agentsAgain('threads', (t) => t === 'schedule');
    }
    step = null;
    // Restored history counts as read (BF-D09).
    await markRead(services, job.burrow.id, [...touched]);
    if (followUps.homeNetworks.length && job.restorer.accountId)
      for (const n of followUps.homeNetworks)
        await addNetwork(services, job.restorer.accountId as string, n).catch(() => {});
    const toSignIn = await checkRestoredConnections(job, followUps.checkConnections);
    tick(1);
    const summary: BackupRestoreSummary = {
      categories: sortBackupCategories(chosen).map((id) => {
        const t = tallies.get(id) ?? emptyTally();
        return {
          id,
          added: t.added,
          updated: t.updated,
          unchanged: t.unchanged,
          kept: t.kept,
          skipped: t.skipped,
        };
      }),
      connectionsToSignIn: toSignIn.slice(0, BACKUP_SUMMARY_NAMES_MAX),
      automationsOff: followUps.automationsOff,
      schedulesPaused: followUps.schedulesPaused,
      notes: [...notes.values()].slice(0, 40),
      servers: serversSummary,
      finishedAt: iso(services.clock()),
    };
    await services.pipeline.commit(
      backupRestored,
      {
        restoreId: job.restoreId,
        madeAt: m.createdAt,
        timeZone: m.timeZone,
        sourceBurrowId: m.source.burrowId,
        summary,
      },
      { burrowId: job.burrow.id, actorId: job.restorer.id },
    );
    return summary;
  } catch (err) {
    (err as { partial?: BackupRestoreSummary }).partial = {
      categories: sortBackupCategories(chosen).map((id) => {
        const t = tallies.get(id) ?? emptyTally();
        return {
          id,
          added: t.added,
          updated: t.updated,
          unchanged: t.unchanged,
          kept: t.kept,
          skipped: t.skipped,
        };
      }),
      connectionsToSignIn: [],
      automationsOff: followUps.automationsOff,
      schedulesPaused: followUps.schedulesPaused,
      notes: [...notes.values()].slice(0, 40),
      servers: serversSummary,
      finishedAt: iso(services.clock()),
    };
    throw err;
  } finally {
    liveRestores.delete(job.restoreId);
  }
}

/**
 * Every restored connection checked (BF-06): one whose sign-in doesn't work here — a Fusebox client key, Google tokens
 * of another OAuth client, a service this box can't reach — needs a person, and its tools' tiers come back once the
 * check found them.
 */
async function checkRestoredConnections(
  job: RestoreJob,
  list: RestoreFollowUps['checkConnections'],
): Promise<{ id: string; label: string }[]> {
  const { services } = job;
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const viewer = job.restorer.accountId
    ? await viewerFor(services, job.restorer.accountId, job.burrow.id)
    : null;
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    let ok = false;
    let message = 'It needs you to sign in again.';
    try {
      if (c.needsSignIn) {
        // Its sign-in couldn't go in the file (BF-S12): a check can't work, it asks for one.
        ok = false;
      } else if (c.source === 'catalog' && c.builtin) {
        // Nobody signs in to a built-in connection (BF-19): nothing to check, its tiers go back as the file has them.
        ok = true;
        if (viewer) await putToolsBack(services, viewer, c.id, c.tools ?? []);
      } else if (c.source === 'catalog' && viewer) {
        const { row } = await recheckConnection(services, viewer, c.id);
        ok = row.status === 'active';
        message = row.checks.find((x) => x.state === 'error')?.message ?? message;
        if (ok && c.tools?.length) await putToolsBack(services, viewer, c.id, c.tools);
      } else if (c.source === 'connector') {
        const [row] = await services.db.select().from(connections).where(eq(connections.id, c.id));
        if (row) ok = (await checkConnection(services, row)).status === 'active';
      }
    } catch (err) {
      services.log.info(
        { err: String(err), connectionId: c.id },
        'backup restore: a connection check failed',
      );
      ok = false;
    }
    if (ok) continue;
    await services.pipeline
      .commit(
        restoredNeedsSignIn,
        { connectionId: c.id, source: c.source, message: message.slice(0, 500) },
        { burrowId: job.burrow.id, actorId: job.restorer.id },
      )
      .catch(() => undefined);
    out.push({ id: c.id, label: c.label.slice(0, 200) || 'A connection' });
  }
  return out;
}

/** The tiers and limits the person chose, on the tools a check found (or a built-in connection has), by name. */
async function putToolsBack(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
  tools: RestoredTool[],
): Promise<void> {
  const here = new Set(
    (
      await services.db
        .select({ name: connectionTools.name })
        .from(connectionTools)
        .where(eq(connectionTools.connectionId, id))
    ).map((t) => t.name),
  );
  for (const t of tools) {
    if (!here.has(t.name)) continue;
    await setConnectionTool(services, viewer, id, t.name, t.tier).catch(() => undefined);
    if (t.limits && Object.keys(t.limits.args ?? {}).length)
      await setConnectionToolLimits(services, viewer, id, t.name, t.limits).catch(() => undefined);
  }
}

/**
 * Restored history counts as read (BF-D09): the person's read marker moves to the conversation's latest message, so a
 * restore doesn't light up old conversations as unread. Only the person reads.
 */
async function markRead(services: Services, burrowId: string, conversationIds: string[]): Promise<void> {
  for (const conversationId of conversationIds) {
    await services.pipeline.transact(burrowId, async ({ tx }) => {
      const [latest] = await tx
        .select({ id: messages.id, ord: messages.ord, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), isNull(messages.threadRootId)))
        .orderBy(desc(messages.createdAt), desc(messages.ord))
        .limit(1);
      if (!latest) return;
      const person = await thePerson(tx, burrowId);
      if (!person) return;
      await tx
        .insert(readStates)
        .values({
          conversationId,
          principalId: person.id,
          lastReadMessageId: latest.id,
          lastReadAt: latest.createdAt,
          lastReadOrd: latest.ord,
          updatedAt: services.clock(),
        })
        .onConflictDoUpdate({
          target: [readStates.conversationId, readStates.principalId],
          set: {
            lastReadMessageId: latest.id,
            lastReadAt: latest.createdAt,
            lastReadOrd: latest.ord,
            updatedAt: services.clock(),
          },
          // Only forward: a marker past the latest message (by time) stays where it is.
          setWhere: sql`${readStates.lastReadAt} is null or ${readStates.lastReadAt} <= ${latest.createdAt.toISOString()}::timestamptz`,
        });
    });
  }
}
