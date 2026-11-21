/**
 * The delegation card from its rows (docs/decisions/delegate.md), and Whombat's own words under it before the agent
 * writes its own. Pure: rows in, the `delegation` card out. A task's number is its place on the card; what a working
 * task does now and what it waits for come from its thread's watch.
 */
import {
  DELEGATION_CARD_TASKS_MAX,
  DELEGATION_CHANGE_WORDS_MAX,
  DELEGATION_CHANGES_MAX,
  DELEGATION_SAID_MAX,
  DELEGATION_SUMMARY_MAX,
  DELEGATION_TASK_NOTE_MAX,
  DELEGATION_TASK_SHOTS_MAX,
  DELEGATION_TASK_TITLE_MAX,
  DELEGATION_TITLE_MAX,
  DELEGATION_WHY_MAX,
  type DelegationCard,
  type DelegationCardTask,
  type DelegationTaskMerge,
} from '@whombat/core';
import { delegationAiOf } from '../council/members';
import type { DelegationRow, DelegationShotRow, DelegationTaskRow } from '../db/schema/delegations';
import type { T3WatchRow } from '../db/schema/t3code';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** What the card reads of a task's thread: what it waits for, its steps, its AI program. */
export type TaskWatch = Pick<T3WatchRow, 'threadId' | 'pending' | 'steps' | 'program' | 'state'> &
  Partial<Pick<T3WatchRow, 'status' | 'progress'>>;

/** The tasks in their order on the card; the check of everything together (DLG-41) always last. */
export function inOrder<T extends Pick<DelegationTaskRow, 'position' | 'createdAt'> & { kind?: string }>(
  tasks: readonly T[],
): T[] {
  const last = (t: T) => (t.kind === 'final' ? 1 : 0);
  return [...tasks].sort(
    (a, b) => last(a) - last(b) || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/** Each task's number on the card, by id. */
export function numbersOf(
  tasks: readonly (Pick<DelegationTaskRow, 'id' | 'position' | 'createdAt'> & { kind?: string })[],
): Map<string, number> {
  return new Map(inOrder(tasks).map((t, i) => [t.id, i + 1]));
}

/**
 * The number each task's thread knows it by: the one it had on the card when its thread got it (the card may have
 * been reordered or shortened since), else its number now.
 */
export function itemNumbersOf(
  tasks: readonly (Pick<DelegationTaskRow, 'id' | 'position' | 'createdAt' | 'item'> & { kind?: string })[],
): Map<string, number> {
  const now = numbersOf(tasks);
  return new Map(tasks.map((t) => [t.id, t.item ?? now.get(t.id) ?? 1]));
}

/**
 * What a working task does now, from its watch's steps (in plain words, `t3code/handoff.ts`): the latest not done, else
 * the latest. Read here rather than through the hand-over's helpers, which bring T3 Code's whole connection with them.
 */
function stepNow(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;
  const texts = steps.filter(
    (s): s is { text: string; done?: unknown } => !!s && typeof s === 'object' && typeof s.text === 'string',
  );
  return (texts.filter((s) => s.done !== true).at(-1) ?? texts.at(-1))?.text ?? null;
}

/**
 * What a lead thread said while it works (`t3code/progress.ts`'s `readSaid`, kept on its watch): its latest words and
 * the items it said it finished, by their number on the card. Read here for the same reason as `stepNow`.
 */
function saidOf(progress: unknown): { said: string | null; reported: Record<string, string> } {
  const p = progress && typeof progress === 'object' ? (progress as Record<string, unknown>) : {};
  const reported: Record<string, string> = {};
  if (p.reported && typeof p.reported === 'object')
    for (const [n, line] of Object.entries(p.reported as Record<string, unknown>))
      if (typeof line === 'string') reported[n] = line;
  return { said: typeof p.said === 'string' && p.said.trim() ? p.said : null, reported };
}

/**
 * Where a task's pull request is on the card: merging while its thread merges it, else what became of it once its work
 * was done; one the person keeps shows none.
 */
export function mergeOnCard(t: Pick<DelegationTaskRow, 'state' | 'mergeState'>): DelegationTaskMerge | null {
  const m = t.mergeState;
  if (m === 'merging') return t.state === 'working' ? 'merging' : null;
  return (t.state === 'done' || (t.state === 'failed' && m === 'not_merged')) && m && m !== 'kept' ? m : null;
}

/** A screen's picture as the card shows it (as `council/card.ts`'s `shotsOnCard`, kept here to stay pure and light). */
function shotsOf(rows: readonly DelegationShotRow[]): DelegationCardTask['shots'] {
  return rows
    .filter((s) => s.compareId && s.width && s.height)
    .sort((a, b) => a.position - b.position)
    .slice(0, DELEGATION_TASK_SHOTS_MAX)
    .map((s) => ({
      view: cut(s.view, 80),
      attachmentId: s.compareId as NonNullable<DelegationCardTask['shots']>[number]['attachmentId'],
      width: s.width as number,
      height: s.height as number,
      areas: s.areas.length,
      notes: s.notes.filter((n) => s.areas.some((a) => a.n === n.n)),
    }));
}

/**
 * For each task working in another's thread, the number of the first task there: the apps show it as “With 1”,
 * and only that one's row says what the thread does now.
 */
export function ledBy(
  tasks: readonly DelegationTaskRow[],
  numbers: Map<string, number>,
): Map<string, number> {
  const first = new Map<string, number>();
  const out = new Map<string, number>();
  for (const t of inOrder(tasks)) {
    if (t.state !== 'working' || !t.threadId || t.kind === 'final') continue;
    const n = first.get(t.threadId);
    if (n === undefined) first.set(t.threadId, numbers.get(t.id) ?? 1);
    else out.set(t.id, n);
  }
  return out;
}

function taskOnCard(
  t: DelegationTaskRow,
  numbers: Map<string, number>,
  watch: TaskWatch | undefined,
  shots: readonly DelegationShotRow[],
  with_: number | null = null,
  /** Its thread leads other tasks too. */
  leads = false,
): DelegationCardTask {
  const working = t.state === 'working';
  const n = numbers.get(t.id) ?? 1;
  // Only a thread leading several tasks reports them one by one; its first row carries its words.
  const { said, reported } =
    working && watch && leads
      ? saidOf(watch.progress)
      : { said: null, reported: {} as Record<string, string> };
  const line = t.kind === 'final' ? undefined : reported[String(t.item ?? n)];
  const step = working
    ? ((t.kind === 'final' && t.checks === 'running'
        ? watch?.progress &&
          typeof watch.progress === 'object' &&
          'verificationRetry' in watch.progress &&
          watch.progress.verificationRetry
          ? 'Waiting for GitHub verification'
          : 'Waiting for checks'
        : watch
          ? stepNow(watch.steps)
          : null) ??
      (!t.threadId
        ? 'Preparing the work'
        : t.mergeState === 'merging'
          ? 'Merging the checked work'
          : t.checks === 'running'
            ? 'Waiting for checks'
            : t.kind === 'final'
              ? 'Checking everything together'
              : 'Working on the change'))
    : null;
  return {
    id: t.id as DelegationCardTask['id'],
    n,
    title: cut(t.title, DELEGATION_TASK_TITLE_MAX),
    why: t.why ? cut(t.why, DELEGATION_WHY_MAX) : null,
    picked: t.picked,
    after: with_ ?? (t.afterId ? (numbers.get(t.afterId) ?? null) : null),
    state: t.state,
    pending: working && watch?.pending ? watch.pending : null,
    step: step ? cut(step, 120) : null,
    ...(said && with_ === null ? { said: cut(said, DELEGATION_SAID_MAX) } : {}),
    ...(line !== undefined ? { reported: true } : {}),
    program: (watch?.program ?? t.modelLabel)?.slice(0, 60) ?? null,
    ai: delegationAiOf(t),
    since: iso(t.startedAt),
    endedAt: iso(t.endedAt),
    url: t.url,
    branch: t.branch,
    pr: t.pr,
    note: t.note ? cut(t.note, DELEGATION_TASK_NOTE_MAX) : line ? cut(line, DELEGATION_TASK_NOTE_MAX) : null,
    merge: mergeOnCard(t),
    checks: t.checks,
    ...(shots.length ? { shots: shotsOf(shots) } : {}),
  };
}

export function delegationCard(
  d: DelegationRow,
  tasks: readonly DelegationTaskRow[],
  watches: readonly TaskWatch[],
  shots: readonly DelegationShotRow[] = [],
): DelegationCard {
  const numbers = numbersOf(tasks);
  const led = ledBy(tasks, numbers);
  const leading = new Set(tasks.flatMap((t) => (led.has(t.id) && t.threadId ? [t.threadId] : [])));
  const byThread = new Map(watches.map((w) => [w.threadId, w]));
  const shotsOfTask = (id: string) => shots.filter((s) => s.taskId === id);
  const live = d.stage === 'offer' || d.stage === 'working';
  return {
    kind: 'delegation',
    delegationId: d.id as DelegationCard['delegationId'],
    title: cut(d.title, DELEGATION_TITLE_MAX),
    project: d.projectTitle?.slice(0, 200) || null,
    stage: d.stage,
    live,
    atOnce: d.atOnce,
    pullRequests: d.pullRequests,
    merge: d.merge,
    ...(d.delivery ? { delivery: d.delivery } : {}),
    ...(d.councilId ? { council: true } : {}),
    ai: delegationAiOf({
      provider: d.aiProvider,
      model: d.aiModel,
      modelLabel: d.aiModelLabel,
      options: d.aiOptions,
    }),
    tasks: inOrder(tasks)
      .slice(0, DELEGATION_CARD_TASKS_MAX)
      .map((t) =>
        taskOnCard(
          t,
          numbers,
          t.threadId ? byThread.get(t.threadId) : undefined,
          shotsOfTask(t.id),
          led.get(t.id) ?? null,
          !!t.threadId && leading.has(t.threadId),
        ),
      ),
    outcome: d.outcome,
    note:
      d.outcome === 'incomplete' &&
      (d.note === DELEGATION_TEXT.done || d.note === DELEGATION_TEXT.withCouncil)
        ? DELEGATION_TEXT.incomplete
        : d.note
          ? cut(d.note, DELEGATION_SUMMARY_MAX)
          : null,
    startedAt: d.createdAt.toISOString(),
    handedAt: iso(d.handedAt),
    endedAt: iso(d.endedAt),
  };
}

type ListTask = Pick<DelegationCardTask, 'id' | 'n' | 'title' | 'state'>;

/** The positions in `xs` of a longest increasing run of values, which keeps its order (the tasks that didn't move). */
function steady(xs: readonly number[]): Set<number> {
  const ends: number[] = [];
  const before: number[] = [];
  xs.forEach((x, i) => {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((xs[ends[mid] as number] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    before[i] = lo > 0 ? (ends[lo - 1] as number) : -1;
    ends[lo] = i;
  });
  const kept = new Set<number>();
  for (let i = ends.length ? (ends[ends.length - 1] as number) : -1; i >= 0; i = before[i] as number)
    kept.add(i);
  return kept;
}

/**
 * What changed between two versions of an offered list, in a few words each: the tasks taken off, added, renamed and
 * moved (“Moved “One line per item” to the top”), at most `DELEGATION_CHANGES_MAX` lines, the last saying how many more. Empty
 * when the list is the same; ticks don't count (the person's own presses, or what the list says already).
 */
export function listChanges(before: readonly ListTask[], after: readonly ListTask[]): string[] {
  const on = (ts: readonly ListTask[]) => ts.filter((t) => t.state !== 'skipped');
  const was = on(before);
  const now = on(after);
  const wasById = new Map(was.map((t, i) => [t.id, { t, i }]));
  const nowIds = new Set(now.map((t) => t.id));
  const q = (title: string) => `“${cut(title, 60)}”`;
  const said: string[] = [];
  for (const t of was) if (!nowIds.has(t.id)) said.push(`Took off ${q(t.title)}`);
  for (const t of now) if (!wasById.has(t.id)) said.push(`Added ${q(t.title)}`);
  for (const t of now) {
    const old = wasById.get(t.id)?.t;
    if (old && old.title !== t.title) said.push(`Renamed ${q(old.title)} to ${q(t.title)}`);
  }
  const both = now.filter((t) => wasById.has(t.id));
  const kept = steady(both.map((t) => wasById.get(t.id)?.i ?? 0));
  both.forEach((t, i) => {
    if (!kept.has(i)) said.push(`Moved ${q(t.title)} ${t.n === 1 ? 'to the top' : `to number ${t.n}`}`);
  });
  const lines = said.map((s) => cut(s, DELEGATION_CHANGE_WORDS_MAX));
  if (lines.length <= DELEGATION_CHANGES_MAX) return lines;
  const shown = lines.slice(0, DELEGATION_CHANGES_MAX - 1);
  return [...shown, `${lines.length - shown.length} more changes`];
}

/**
 * The offered list's last change for its card: what changed since the card on its message now (`prior`), else the change
 * that card already named (a tick or a clock doesn't clear it); none once it was handed over.
 */
export function changedOf(
  prior: DelegationCard | null,
  card: DelegationCard,
  at: Date,
): DelegationCard['changed'] {
  if (card.stage !== 'offer' || !prior || prior.delegationId !== card.delegationId) return null;
  const said = listChanges(prior.tasks, card.tasks);
  if (said.length) return { at: at.toISOString(), said };
  return prior.changed ?? null;
}

/** Whombat's words under the card at a step; the agent's own words are replies under it. */
export const DELEGATION_TEXT = {
  handed: 'Handed over to T3 Code.',
  done: 'Done.',
  incomplete: 'Some work is still incomplete.',
  stopped: 'Stopped.',
  notNow: 'Not handed over.',
  quiet: 'Stopped: nothing moved on for a week.',
  /** A council's checklist, when the council finishes (CNL-61): its card says how it went. */
  withCouncil: 'Done: the council’s card says how it went.',
  withCouncilStopped: 'Stopped with the council.',
} as const;

/** “1, 2 and 4”. */
export function listOf(items: readonly (string | number)[]): string {
  const s = items.map(String);
  if (s.length <= 1) return s[0] ?? '';
  return `${s.slice(0, -1).join(', ')} and ${s.at(-1)}`;
}
