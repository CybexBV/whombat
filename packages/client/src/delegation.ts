/**
 * The delegation card's words and view (Whombat docs/decisions/delegate.md), shared by web and the phone so both say the
 * same: the checklist while it waits (each task ticked or not, Hand over N), then the handed-over tasks: the ones that
 * work, wait or need a look each on a row (its state in words, what it does now, how long it has worked, its pull request
 * and whether it is merged), the ones that finished well folded into one line (DLG-28), and which buttons show.
 */
import {
  type CouncilShot,
  type DelegationCard,
  type DelegationCardTask,
  type DelegationTaskMerge,
  type DelegationTaskState,
  formatTaskDuration,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { DELEGATION_AI_WORDS, delegationAiLine, delegationAiWords } from './delegationAi';
import { clientTree } from './i18n/catalog';
import { CARDS_AREA_WORDS } from './i18n/messages/chatWork/cards';

/** The delegation card's words, in a locale (English when none). */
export function delegationWords(locale?: string | null) {
  const w = clientTree(locale, CARDS_AREA_WORDS).delegation;
  return {
    /** The card's name in front of what it is for: “Tasks · Polish the Settings page” (as its head says). */
    name: w.name,
    /** The checklist's line while it waits for the person. */
    offer: w.offer,
    /** A council in the thread is looking at the offered list: Hand over waits for its answer. */
    checkingWord: w.checkingWord,
    checking: w.checking,
    ticked: (n: number, of: number) => interpolate(w.ticked, { n, of }),
    /** After the checklist's line when Whombat merges each one's pull request. */
    merges: w.merges,
    states: {
      offered: w.states.offered,
      skipped: w.states.skipped,
      queued: w.states.queued,
      working: w.states.working,
      done: w.states.done,
      failed: w.states.failed,
      stopped: w.states.stopped,
      timed_out: w.states.timed_out,
    } satisfies Record<DelegationTaskState, string>,
    /** A done task's pull request when Whombat merges them. */
    merge: {
      waiting: w.merge.waiting,
      merging: w.merge.merging,
      merged: w.merge.merged,
      not_merged: w.merge.not_merged,
    } satisfies Record<DelegationTaskMerge, string>,
    /** A queued task that starts after another: “After 1”. */
    after: (n: number) => interpolate(w.after, { n }),
    /** A task done in another's thread, on its branch and in its pull request (DLG-42): “With 1”. */
    with: (n: number) => interpolate(w.with, { n }),
    /** One thread doing several tasks: one row for them, “4 of 9 done”, its items under it. */
    together: {
      title: (n: number) => interpolate(w.together.title, { n }),
      done: (n: number, of: number) => interpolate(w.together.done, { n, of }),
      itemDone: w.together.itemDone,
      itemWorking: w.together.itemWorking,
    },
    /** A queued task whose task before it didn't finish. */
    blocked: (n: number) => interpolate(w.blocked, { n }),
    pending: {
      /** A question the assistant answers itself (T3-17): nothing for the person to do. */
      question: (lead: string | null) => (lead ? interpolate(w.pending.asked, { lead }) : w.pending.question),
      approval: w.pending.approval,
    },
    /** Its pull request's checks (DLG-20, DLG-21). */
    checks: { running: w.checks.running, failing: w.checks.failing },
    /** The head line: “4 of 10 merged · 3 working · 1 needs a look”. */
    progress: {
      merged: (n: number, of: number) => interpolate(w.progress.merged, { n, of }),
      done: (n: number, of: number) => interpolate(w.progress.done, { n, of }),
      working: (n: number) => interpolate(w.progress.working, { n }),
      look: (n: number) => w.progress.look(n),
    },
    /** The line the finished tasks fold into (DLG-28): “4 merged”, “1 done”. */
    folded: (n: number, merged: boolean) => interpolate(merged ? w.foldedMerged : w.foldedDone, { n }),
    showFolded: w.showFolded,
    hideFolded: w.hideFolded,
    /** A task's menu (⋯), and its pictures. */
    more: (title: string) => interpolate(w.more, { title }),
    pictures: (n: number) => w.pictures(n),
    picturesHint: w.picturesHint,
    done: w.done,
    stopped: w.stopped,
    notHanded: w.notHanded,
    /** The final line when some tasks didn't finish: “Done, 1 didn’t finish”. */
    doneSome: (n: number) => interpolate(w.doneSome, { n }),
    /** The final line when some pull requests weren't merged: “Done, 1 not merged”. */
    doneUnmerged: (n: number) => interpolate(w.doneUnmerged, { n }),
    handOver: (n: number) => (n ? interpolate(w.handOverN, { n }) : w.handOver),
    change: w.change,
    notNow: w.notNow,
    stop: w.stop,
    stopTask: w.stopTask,
    openThread: w.openThread,
    pullRequest: w.pullRequest,
    /** Stop asks first: it stops work on the person's computer. */
    stopAsk: { title: w.stopAsk.title, body: w.stopAsk.body, keep: w.stopAsk.keep },
    stopTaskAsk: { title: w.stopTaskAsk.title, body: w.stopTaskAsk.body, keep: w.stopTaskAsk.keep },
    /** A press that didn't go through (the server's own words come first when it has some). */
    failed: { pick: w.failed.pick, start: w.failed.start, stop: w.failed.stop },
    /** For screen readers on a checkbox. */
    tick: (title: string) => interpolate(w.tick, { title }),
    /** A checklist row's state for screen readers. */
    tickedWord: w.ticked1,
    notTicked: w.notTicked,
  };
}

/** The delegation card's words, in English. */
export const DELEGATION_WORDS = delegationWords();

type DelegationWords = ReturnType<typeof delegationWords>;
const wordsIn = (locale?: string | null): DelegationWords =>
  locale ? delegationWords(locale) : DELEGATION_WORDS;

/** An item of a thread doing several tasks, under that thread's row. */
export interface DelegationItemView {
  id: string;
  n: number;
  title: string;
  /** Its thread said it finished it. */
  done: boolean;
  /** What its thread said about it, once it did. */
  note: string | null;
  /** For screen readers: “3. Keep the cause of internal errors: done”. */
  label: string;
}

/** One task's row as both apps draw it. */
export interface DelegationTaskView {
  id: string;
  n: number;
  title: string;
  /** What its round slot shows: its number, or how many items one thread does together. */
  slot: string;
  /** One thread doing several tasks: its items, each ticked once the thread said it finished it; null: one task. */
  items: DelegationItemView[] | null;
  why: string | null;
  /** The checklist shows: a checkbox, ticked or not. */
  checkbox: boolean;
  picked: boolean;
  /** At work now: the working animation shows. */
  working: boolean;
  /** Done: a check mark. */
  done: boolean;
  /** Stopped or not handed over: the row is muted (a failed one isn't: it needs a look, `attention`). */
  muted: boolean;
  /** Something in it needs a look (a problem, an OK only the person gives in T3 Code, checks still failing). */
  attention: boolean;
  /** What shows at the row's end: its state in words (“Working”, “After 1”, “Done”). */
  status: string;
  /** What it does now (“Running the tests”), or what it waits for. */
  detail: string | null;
  /** How long it worked (ticking while it works). */
  elapsed: string | null;
  /** The AI working on it (“Codex”). */
  program: string | null;
  /** On the checklist: the AI chosen for this task alone (“Claude Opus 5.5 · Extra high”); null: the default. */
  ai: string | null;
  /** The agent's line about how it went. */
  note: string | null;
  url: string | null;
  pr: string | null;
  /** A Stop for this task shows (it works or waits its turn, while the card is live). */
  stoppable: boolean;
  /** Its pictures of what changed (DLG-27), shown under its row. */
  shots: CouncilShot[];
  /** Finished well (done, and merged when Whombat merges): folded away with the others once handed over (DLG-28). */
  folds: boolean;
  /** For screen readers: “2. Fix the empty Inbox: working, running the tests”. */
  label: string;
}

/** “Asked Dusty” → “asked Dusty”: the sentence goes on, names keep their capital (a screen reader says them right). */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Whether a task finished well: done, its checks not failing, and merged when Whombat merges it. */
function finishedWell(t: DelegationCardTask): boolean {
  return t.state === 'done' && t.checks !== 'failing' && (!t.merge || t.merge === 'merged');
}

/** Whether a task's thread is at work now: waiting for its checks holds no place and does nothing itself (DLG-21). */
function atWork(t: DelegationCardTask): boolean {
  return t.state === 'working' && !(t.checks === 'running' && !t.pending && t.merge !== 'merging');
}

/** Whether a task needs the person or the assistant to look (a problem, an OK in T3 Code, checks still red). */
function needsLook(t: DelegationCardTask): boolean {
  return (
    t.state === 'failed' ||
    t.state === 'timed_out' ||
    t.merge === 'not_merged' ||
    (t.state === 'done' && t.checks === 'failing' && t.merge !== 'merged') ||
    (t.state === 'working' && t.pending === 'approval')
  );
}

/** The task it is done with, in that one's thread (DLG-42): both wait to start, or both work in one thread. */
function doneWith(t: DelegationCardTask, tasks: readonly DelegationCardTask[]): DelegationCardTask | null {
  if (t.after === null) return null;
  const before = tasks.find((x) => x.n === t.after);
  if (!before) return null;
  if (t.state === 'queued' && before.state === 'queued') return before;
  return t.state === 'working' && t.url && t.url === before.url ? before : null;
}

function statusOf(
  t: DelegationCardTask,
  tasks: readonly DelegationCardTask[],
  lead: string | null,
  DELEGATION_WORDS: DelegationWords,
): string {
  const mate = doneWith(t, tasks);
  if (mate && !t.merge) return DELEGATION_WORDS.with(mate.n);
  if (t.state === 'queued' && t.after !== null) {
    const before = tasks.find((x) => x.n === t.after);
    if (
      before &&
      ((before.state !== 'done' && before.state !== 'working' && before.state !== 'queued') ||
        before.merge === 'not_merged')
    )
      return DELEGATION_WORDS.blocked(t.after);
    return DELEGATION_WORDS.after(t.after);
  }
  if (t.state === 'working' && t.pending === 'question') return DELEGATION_WORDS.pending.question(lead);
  if (t.state === 'working' && t.pending === 'approval') return DELEGATION_WORDS.pending.approval;
  if (t.merge) return DELEGATION_WORDS.merge[t.merge];
  if (t.state === 'working' && t.checks === 'running') return DELEGATION_WORDS.checks.running;
  if (t.state === 'done' && t.checks === 'failing') return DELEGATION_WORDS.checks.failing;
  return DELEGATION_WORDS.states[t.state];
}

export function delegationTaskView(
  t: DelegationCardTask,
  card: Pick<DelegationCard, 'stage' | 'live' | 'tasks'>,
  nowMs: number,
  lead: string | null = null,
  locale?: string | null,
): DelegationTaskView {
  const DELEGATION_WORDS = wordsIn(locale);
  const working = atWork(t);
  const start = t.since ? Date.parse(t.since) : null;
  const end = t.endedAt ? Date.parse(t.endedAt) : nowMs;
  const elapsed =
    start !== null && Number.isFinite(start) && (t.state === 'working' || t.endedAt)
      ? formatTaskDuration(end - start)
      : null;
  const status = statusOf(t, card.tasks, lead, DELEGATION_WORDS);
  // Done with another task in its thread: that one's row says what the thread does now.
  const detail = working && !t.pending && !doneWith(t, card.tasks) ? t.step : null;
  const handed = card.stage !== 'offer';
  return {
    id: t.id,
    n: t.n,
    title: t.title,
    slot: String(t.n),
    items: null,
    why: t.why,
    checkbox: card.stage === 'offer' && t.state === 'offered',
    picked: t.picked,
    working,
    // A pull request waiting to be merged, or not merged, isn't finished yet.
    done: finishedWell(t),
    muted: t.state === 'stopped' || t.state === 'skipped',
    attention: needsLook(t),
    status,
    detail,
    elapsed,
    program: t.program,
    ai: delegationAiLine(t.ai, locale),
    note: t.note,
    url: t.url,
    pr: t.pr,
    stoppable: card.live && card.stage === 'working' && (t.state === 'working' || t.state === 'queued'),
    shots: t.shots ?? [],
    folds: handed && finishedWell(t),
    label: `${t.n}. ${t.title}: ${
      card.stage === 'offer' && t.state === 'offered'
        ? t.picked
          ? DELEGATION_WORDS.tickedWord
          : DELEGATION_WORDS.notTicked
        : `${lowerFirst(status)}${detail ? `, ${lowerFirst(detail)}` : ''}`
    }`,
  };
}

export interface DelegationCardView {
  /** “T3 Code · Polish the Settings page”. */
  heading: string;
  /** The project they run in, or null. */
  project: string | null;
  /** What it does now: “Pick what to hand over · 3 of 4 ticked”, “4 of 10 merged · 3 working · 1 needs a look”, “Done”. */
  stage: string;
  /** The rows that show: every task on the checklist; once handed over, those that work, wait or need a look. */
  tasks: DelegationTaskView[];
  /** Once handed over, the tasks that finished well, folded into one line (`label`) that opens to them; null: none. */
  folded: { label: string; tasks: DelegationTaskView[] } | null;
  /** The checklist waits: Hand over, Change something and Not now show. */
  offer: boolean;
  /** How many are ticked (for Hand over N). */
  picked: number;
  /** A council in the thread is looking at the list: Hand over waits for its answer (it shows, but can't be pressed). */
  held: boolean;
  /** The words on the hand-over button. */
  handOver: string;
  /**
   * The AI can be chosen on the checklist (each task's chip, and every task's on Hand over's arrow); false on an older
   * box's card.
   */
  aiChoosable: boolean;
  /** The AI chosen for every task, in words (“GPT 6.1 Sol · High · Fast”); null: T3 Code's default. */
  ai: string | null;
  /**
   * The line beside Hand over: every task's AI (“Others: …” when some ticked tasks chose their own); null: nothing
   * chosen for every task.
   */
  aiSummary: string | null;
  /** How many ticked tasks take the AI chosen for every task. */
  aiShared: number;
  /** Stop shows (tasks work or wait). */
  stoppable: boolean;
  /** How it ended, for the final card, or null while live. */
  ended: string | null;
  /** For screen readers: the heading and what it does now. */
  label: string;
}

/**
 * “4 of 10 merged · 3 working · 1 needs a look”: how far the handed-over tasks are, then what works and what needs a
 * look. A thread doing several tasks works as one (`along` are the others in it), and the items it said it finished
 * count as done until something is merged.
 */
function progressLine(
  tasks: readonly DelegationCardTask[],
  merging: boolean,
  along: ReadonlySet<string> = new Set(),
  DELEGATION_WORDS: DelegationWords = wordsIn(),
): string {
  const reported = merging ? 0 : tasks.filter((t) => t.state === 'working' && t.reported).length;
  const finished = tasks.filter(finishedWell).length + reported;
  const working = tasks.filter((t) => atWork(t) && !along.has(t.id)).length;
  const look = tasks.filter(needsLook).length;
  const words = DELEGATION_WORDS.progress;
  return [
    merging ? words.merged(finished, tasks.length) : words.done(finished, tasks.length),
    working ? words.working(working) : null,
    look ? words.look(look) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The threads doing several tasks while they work: each one's first task by id, with all of its tasks in card
 * order. A task works in its first task's thread when it is “With” it (`doneWith`) and both work.
 */
function togetherOf(tasks: readonly DelegationCardTask[]): Map<string, DelegationCardTask[]> {
  const out = new Map<string, DelegationCardTask[]>();
  for (const t of tasks) {
    if (t.state !== 'working') continue;
    const first = doneWith(t, tasks);
    if (first?.state !== 'working') continue;
    out.set(first.id, [...(out.get(first.id) ?? [first]), t]);
  }
  return out;
}

/** The row of a thread doing several tasks: its count, how many it said it finished, its latest words, its items. */
function togetherView(
  first: DelegationTaskView,
  lead: DelegationCardTask,
  tasks: readonly DelegationCardTask[],
  DELEGATION_WORDS: DelegationWords = wordsIn(),
): DelegationTaskView {
  const words = DELEGATION_WORDS.together;
  const title = words.title(tasks.length);
  const reported = tasks.filter((t) => t.reported).length;
  const status =
    first.status === DELEGATION_WORDS.states.working && reported
      ? words.done(reported, tasks.length)
      : first.status;
  const detail = first.working && !lead.pending ? (lead.said ?? first.detail) : first.detail;
  const items = tasks.map(
    (t): DelegationItemView => ({
      id: t.id,
      n: t.n,
      title: t.title,
      done: !!t.reported,
      note: t.reported ? t.note : null,
      label: `${t.n}. ${t.title}: ${lowerFirst(t.reported ? words.itemDone : words.itemWorking)}`,
    }),
  );
  return {
    ...first,
    title,
    slot: String(tasks.length),
    items,
    status,
    detail,
    // The first task's own line and pictures are its item's, not the thread's.
    note: null,
    shots: [],
    label: `${title}: ${lowerFirst(status)}${detail ? `, ${lowerFirst(detail)}` : ''}`,
  };
}

/**
 * The card as both apps draw it. `lead` is the assistant's name (“Dusty”), for a question it answers itself (“Asked
 * Dusty”).
 */
export function delegationCardView(
  card: DelegationCard,
  nowMs: number,
  lead: string | null = null,
  locale?: string | null,
): DelegationCardView {
  const DELEGATION_WORDS = wordsIn(locale);
  const heading = `${DELEGATION_WORDS.name} · ${card.title}`;
  const offer = card.live && card.stage === 'offer';
  // Once handed over, the tasks not handed over leave the card (DLG-04).
  const listed = card.tasks.filter((t) => offer || (t.state !== 'offered' && t.state !== 'skipped'));
  const together = offer ? new Map<string, DelegationCardTask[]>() : togetherOf(card.tasks);
  const along = new Set([...together.values()].flatMap((ts) => ts.slice(1).map((t) => t.id)));
  const views = listed
    .filter((t) => !along.has(t.id))
    .map((t) => {
      const view = delegationTaskView(t, card, nowMs, lead, locale);
      const members = together.get(t.id);
      return members ? togetherView(view, t, members, DELEGATION_WORDS) : view;
    });
  const offered = card.tasks.filter((t) => t.state === 'offered');
  const picked = offered.filter((t) => t.picked).length;
  const unfinished = card.tasks.filter(
    (t) => t.state === 'failed' || t.state === 'timed_out' || t.state === 'stopped',
  ).length;
  const unmerged = card.tasks.filter((t) => t.state === 'done' && t.merge === 'not_merged').length;
  const ended = card.live
    ? null
    : card.outcome === 'stopped'
      ? card.handedAt
        ? DELEGATION_WORDS.stopped
        : DELEGATION_WORDS.notHanded
      : unfinished
        ? DELEGATION_WORDS.doneSome(unfinished)
        : unmerged
          ? DELEGATION_WORDS.doneUnmerged(unmerged)
          : DELEGATION_WORDS.done;
  const handedOver = card.tasks.filter((t) => t.state !== 'offered' && t.state !== 'skipped');
  const aiLine = delegationAiLine(card.ai, locale);
  const pickedOwn = offered.filter((t) => t.picked && t.ai).length;
  const progress = progressLine(handedOver, !!card.merge, along, DELEGATION_WORDS);
  const stage = offer
    ? `${DELEGATION_WORDS.offer} · ${DELEGATION_WORDS.ticked(picked, offered.length)}${card.merge ? ` · ${DELEGATION_WORDS.merges}` : ''}`
    : (ended ?? progress);
  const foldedTasks = views.filter((t) => t.folds);
  const merging = !!card.merge && card.pullRequests;
  return {
    heading,
    project: card.project,
    stage,
    tasks: views.filter((t) => !t.folds),
    folded: foldedTasks.length
      ? { label: DELEGATION_WORDS.folded(foldedTasks.length, merging), tasks: foldedTasks }
      : null,
    offer,
    picked,
    held: offer && !!card.checking,
    handOver: DELEGATION_WORDS.handOver(picked),
    aiChoosable: offer && card.ai !== undefined,
    ai: aiLine,
    aiSummary: aiLine
      ? pickedOwn
        ? (locale ? delegationAiWords(locale) : DELEGATION_AI_WORDS).others(aiLine)
        : aiLine
      : null,
    aiShared: picked - pickedOwn,
    stoppable:
      card.live &&
      card.stage === 'working' &&
      card.tasks.some(
        (t) => t.state === 'working' || t.state === 'queued' || (t.state === 'done' && t.merge === 'waiting'),
      ),
    ended,
    label: `${heading}: ${stage}`,
  };
}
