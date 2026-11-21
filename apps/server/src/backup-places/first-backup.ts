/**
 * “I’ll tell you when the first backup is done” (docs/decisions/backup-options.md): when the assistant set a place up
 * on the person's yes, Whombat keeps the thread they said it in (`box_backup.firstBackup`) and says there, as the
 * assistant and without starting a turn, when the first backup to that place is done — or, when it failed, a plain
 * note. Told once: the note is taken before the words are posted, so the job and the backup's own end never both say
 * it. A note older than a day is dropped unsaid.
 */
import type { BackupServiceStatus } from '@whombat/control-contracts/local';
import { applyContext, loadBurrowRow } from '../commit/pipeline';
import { postMessage } from '../domain/messages';
import { agentContext } from '../guides/place';
import { iso } from '../lib/time';
import { boxBackupStatus } from '../managed/box-backup';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, toActor } from '../read/principals';
import type { Services } from '../services';
import { type BoxBackupNotes, changeBoxBackupNotes, loadBoxBackupNotes, without } from './notes';

type FirstBackupNote = NonNullable<BoxBackupNotes['firstBackup']>;

/** What the assistant says (to the person, in their thread). */
export const FIRST_BACKUP_TEXT = {
  done: (place: string) =>
    `The first backup to ${place} is done. Your Whombat backs up there on its own from now on.`,
  failed: (place: string) =>
    `The first backup to ${place} didn’t work. Whombat tries again by itself in a few minutes; if it keeps failing, it shows up in your Inbox.`,
} as const;

/** How long a note waits for the first backup's outcome. */
const KEEP_MS = 24 * 60 * 60_000;

/** Keeps the thread to tell (replacing an older note: the newest yes is the one to answer). */
export async function rememberFirstBackup(
  services: Services,
  note: Omit<FirstBackupNote, 'since'>,
): Promise<void> {
  const since = iso(services.clock());
  await changeBoxBackupNotes(services, (notes) => ({ ...notes, firstBackup: { ...note, since } }));
}

/** What to say now (pure): done, failed, or nothing yet; `drop` when the note is too old to say anything. */
export function firstBackupOutcome(
  note: Pick<FirstBackupNote, 'since'>,
  status: Pick<BackupServiceStatus, 'lastSuccess' | 'lastFailure'> | null,
  now: Date,
): 'done' | 'failed' | 'drop' | null {
  const since = Date.parse(note.since);
  const after = (at: string | undefined) => !!at && Date.parse(at) >= since;
  if (status && after(status.lastSuccess?.at)) return 'done';
  if (status && after(status.lastFailure?.at)) return 'failed';
  return now.getTime() - since > KEEP_MS ? 'drop' : null;
}

/** Posts `text` as the assistant in the noted thread, waking nobody; false when the thread or the assistant is gone. */
async function tellInThread(services: Services, note: FirstBackupNote, text: string): Promise<boolean> {
  const { result } = await services.pipeline.transact(note.burrowId, async (session) => {
    const [burrow, agent, room] = await Promise.all([
      loadBurrowRow(session.tx, note.burrowId),
      loadPrincipalRow(session.tx, note.agentId),
      loadConversationRow(session.tx, note.conversationId),
    ]);
    if (!burrow || agent?.kind !== 'agent' || !room || room.burrowId !== note.burrowId) return false;
    const now = services.clock();
    const ctx = applyContext(session, {
      burrow,
      actor: toActor(agent),
      now,
      at: iso(now),
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    await postMessage(agentContext(ctx, agent), {
      conversation: room,
      threadRootId: note.threadRootId,
      text,
      dispatch: false,
      notifyDmPerson: true,
    });
    return true;
  });
  return result;
}

/**
 * Says how the first backup went when it is known (the status asked anew unless given). `told` once said, `waiting`
 * while it runs, `none` without a note.
 */
export async function tellFirstBackup(
  services: Services,
  given?: BackupServiceStatus | null,
): Promise<'told' | 'waiting' | 'none'> {
  const note = (await loadBoxBackupNotes(services.db)).firstBackup;
  if (!note) return 'none';
  const status = given === undefined ? ((await boxBackupStatus(services, { fresh: true })) ?? null) : given;
  const outcome = firstBackupOutcome(note, status, services.clock());
  if (!outcome) return 'waiting';
  // Taken first: whoever takes it says it, once.
  let taken: FirstBackupNote | null = null;
  await changeBoxBackupNotes(services, (now) => {
    if (now.firstBackup?.since !== note.since) return null;
    taken = now.firstBackup;
    return without(now, 'firstBackup');
  });
  if (!taken || outcome === 'drop') return 'none';
  const text = outcome === 'done' ? FIRST_BACKUP_TEXT.done(note.place) : FIRST_BACKUP_TEXT.failed(note.place);
  const said = await tellInThread(services, taken, text).catch((err: unknown) => {
    services.log.warn({ err: String(err) }, 'backup places: the first backup wasn’t told');
    return false;
  });
  return said ? 'told' : 'none';
}
