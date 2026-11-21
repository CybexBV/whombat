/**
 * A followed server task as a live card in its thread (Whombat task-feedback.md TF-10, TF-11; contracts 0.116.0,
 * CT-880…CT-882). Whombat follows a task it started on a server (an Install of updates, a backup, a move) until it ends,
 * in the thread it was asked in: while it runs the card says what is happening and for how long (“Installing 23 updates
 * on Home Assistant · 12 s”), once it ended it settles into one line with how it went (“Home Assistant is up to date: 23
 * updates installed · 4 min”), opening to the full words. The runtime writes the words (its task words, `TaskWords`,
 * `taskOutcomeText`, `installedText`); web, Android and the desk show them with the helpers here, so they read the same
 * everywhere.
 */
import { z } from 'zod';
import { FollowedTaskId } from '../ids.js';
import { type DateInput, toDate } from '../text/time.js';
import { Timestamp } from './common.js';

/**
 * Where a followed task is: `running`, or how it ended — `ok`, `warning` (it finished with warnings), `error` (it
 * didn't work), `lost` (the hub couldn't tell about it any more; the server's Tasks tab has it).
 */
export const TASK_CARD_STATES = ['running', 'ok', 'warning', 'error', 'lost'] as const;
export const TaskCardState = z.enum(TASK_CARD_STATES);
export type TaskCardState = z.infer<typeof TaskCardState>;

/** How a followed task ended: every state but `running` (`DispatchContext.taskFinished`'s `result`). */
export const TASK_END_STATES = ['ok', 'warning', 'error', 'lost'] as const;
export const TaskEndState = z.enum(TASK_END_STATES);
export type TaskEndState = z.infer<typeof TaskEndState>;

/** The running words (“Installing 23 updates on Home Assistant”), at most this many characters. */
export const TASK_TITLE_MAX = 200;
/** The outcome words (“Home Assistant is up to date: 23 updates installed. It needs a restart…”), at most. */
export const TASK_RESULT_MAX = 600;
/** The server's name as the card shows it (“Home Assistant”, “pve-02”). */
export const TASK_SERVER_MAX = 80;
/** The hosts service's id of the server (`HostServer.id`). */
export const TASK_SERVER_ID_MAX = 200;

/**
 * The `task` card (TF-10, CT-880): server-made only, never `PostableCard`; the same shape is stored, and the runtime
 * updates it in place as the task runs and ends. `followedTaskId` is Whombat's own row for the task (`ftk_`), not the
 * hub's task id. `title` the running words, `server` the server's name and `serverId` its hosts service id (the card's
 * link to the server). `endedAt` null exactly while `running`; `result` the outcome words once it ended, null while it
 * runs (`taskCardValid`).
 */
export const TaskCard = z.object({
  kind: z.literal('task'),
  followedTaskId: FollowedTaskId,
  serverId: z.string().min(1).max(TASK_SERVER_ID_MAX),
  server: z.string().min(1).max(TASK_SERVER_MAX),
  title: z.string().min(1).max(TASK_TITLE_MAX),
  state: TaskCardState,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable().default(null),
  result: z.string().min(1).max(TASK_RESULT_MAX).nullable().default(null),
});
export type TaskCard = z.infer<typeof TaskCard>;

/** The card's words that aren't the runtime's (CT-882): a state's label and the words of a task Whombat lost track of. */
export const TASK_CARD_WORDS = {
  /** A state's label (a badge, a screen reader's word for the card's dot). */
  states: {
    running: 'Running',
    ok: 'Done',
    warning: 'Done with warnings',
    error: 'Didn’t work',
    lost: 'Lost track',
  } satisfies Record<TaskCardState, string>,
  /** What a lost card says after its title on its one line. */
  lostLine: 'lost track',
  /** A lost task's `result` (TF-11), `{server}` its name: the runtime writes it with `taskLostText`. */
  lost: 'Whombat lost track of this task. {server}’s Tasks tab has it.',
} as const;

/** Whether the card is still live (running): an active card, not yet a line (card-settle). */
export function taskCardActive(card: Pick<TaskCard, 'state'>): boolean {
  return card.state === 'running';
}

/** What the schema can't say (CT-880): `endedAt` null exactly while `running`, a `result` only once it ended. */
export function taskCardValid(card: Pick<TaskCard, 'state' | 'endedAt' | 'result'>): boolean {
  const running = card.state === 'running';
  return running === (card.endedAt === null) && !(running && card.result !== null);
}

/** How long the task ran, or has run so far (`now`), in ms; never negative. */
export function taskCardElapsedMs(card: Pick<TaskCard, 'startedAt' | 'endedAt'>, now: DateInput): number {
  const d = toDate(card.endedAt ?? now).getTime() - toDate(card.startedAt).getTime();
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/**
 * A task's time in words (CT-881): “0 s”, “12 s”, “4 min”, “1 h”, “1 h 5 min”, “1 d 3 h” — whole units, rounded down,
 * plain spaces (as `formatDeskUptime`).
 */
export function formatTaskDuration(milliseconds: number): string {
  const s = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

/**
 * The first sentence of the outcome words for a line (CT-881): the first line with text, up to its first `.`, `!`, `?`
 * or `…` followed by a space or the end (“v2.1.3” stays whole), without a closing full stop.
 */
export function taskResultLine(result: string): string {
  const line = (result.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  const sentence = /^(.+?[.!?…])(?=\s|$)/.exec(line)?.[1] ?? line;
  return sentence.endsWith('.') && !sentence.endsWith('..') ? sentence.slice(0, -1) : sentence;
}

/**
 * The card's one line (CT-881), as web, Android and the desk show it: while running its title and the time it has run
 * (“Installing 23 updates on Home Assistant · 12 s”); once ended the first sentence of its result and how long it took
 * (“Home Assistant is up to date: 23 updates installed · 4 min”, “Backing up web on pve-02 didn’t work: the storage is
 * full · 2 min”), its title and the state's label when it has no result; lost, its title and “lost track”. The full
 * result is what the card opens to.
 */
export function taskCardLine(
  card: Pick<TaskCard, 'title' | 'state' | 'startedAt' | 'endedAt' | 'result'>,
  now: DateInput,
): string {
  if (card.state === 'lost') return `${card.title} · ${TASK_CARD_WORDS.lostLine}`;
  const time = formatTaskDuration(taskCardElapsedMs(card, now));
  if (card.state === 'running') return `${card.title} · ${time}`;
  const said = card.result ? taskResultLine(card.result) : '';
  return said ? `${said} · ${time}` : `${card.title} · ${TASK_CARD_WORDS.states[card.state]} · ${time}`;
}

/** A lost task's result (TF-11): “Whombat lost track of this task. pve-02’s Tasks tab has it.” */
export function taskLostText(server: string): string {
  return TASK_CARD_WORDS.lost.replace('{server}', server);
}

/**
 * The card as text (inbox, search, other agents' windows): `[task: Installing 23 updates on Home Assistant, ok — Home
 * Assistant is up to date: 23 updates installed.]`.
 */
export function taskCardText(card: Pick<TaskCard, 'title' | 'state' | 'result'>): string {
  return `[task: ${card.title}, ${card.state}${card.result ? ` — ${card.result}` : ''}]`;
}
