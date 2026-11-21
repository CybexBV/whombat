/**
 * What a T3 Code thread the agent handed work to is doing, in the watcher's words (docs/decisions/t3code.md). Pure: T3 Code's answers in, a thread's state, what it needs from the agent and its key out; `readThread` pages through a thread with the read it is given.
 *
 * Each thing a thread does that the agent should hear of has a key: `done:<run>` (that run ended), `asks:<hash>` (those
 * questions wait for an answer), `approval:<run>:<n>` (that permission request waits). The watcher wakes the agent for
 * a key it hasn't told or seen; what the agent's own calls showed it (`seenOfCall`) counts as seen, so a thread it
 * waited for in its turn isn't told again. A thread the agent starts carries its name first (`launchTitle`), and one
 * whose work completed is settled once the agent heard of it (`settlesWhenTold`).
 */
import { createHash } from 'node:crypto';
import { T3_ANSWER_MAX, T3_WATCHED_PRS_MAX } from '@whombat/core';
import {
  activityOf,
  FINISHED,
  statusOf,
  type T3Activity,
  type T3Status,
} from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';

/** A thread as one `t3_thread_read` shows it. */
export interface T3ThreadState {
  threadId: string;
  title: string | null;
  status: T3Status;
  latestRunId: string | null;
  activeRunId: string | null;
  /** How many runs it had (none: it was made without work). */
  runs: number;
  /** Its timeline's length, to read its latest items next time. */
  items: number;
  activity: T3Activity;
}

/** What a thread needs now: nothing, no watching (it never got work), a look at its questions, or its end told. */
export type T3Needs =
  | { kind: 'nothing' }
  | { kind: 'no_work' }
  | { kind: 'pending' }
  | { kind: 'ended'; runId: string | null };

const MAX_ID = 300;
const MAX_TITLE = 160;
const MAX_PR_URL = 500;

export function threadStateOf(body: unknown): T3ThreadState | null {
  const r = rec(body);
  const t = rec(r.thread);
  const threadId = str(t.threadId);
  const status = statusOf(t.status);
  const activity = activityOf(body);
  if (!threadId || threadId.length > MAX_ID || !status || !activity) return null;
  const runs = list(r.recentRuns);
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    threadId,
    title: str(t.title)?.slice(0, MAX_TITLE) ?? null,
    status,
    latestRunId: str(t.latestRunId) ?? str(rec(runs[0]).runId),
    activeRunId: str(t.activeRunId),
    runs: Math.max(count(t.runCount), runs.length),
    items: count(t.itemCount),
    activity,
  };
}

/**
 * What a thread needs: a question or a permission request waits (`pending`), its run ended (`ended`, T3 Code's
 * `waiting` is a finished turn whose after-work still runs, so not yet), or a thread that never had work (`no_work`).
 */
export function needsOf(s: T3ThreadState): T3Needs {
  if (s.activity.pending > 0 && s.status !== 'idle' && !FINISHED.includes(s.status))
    return { kind: 'pending' };
  if (FINISHED.includes(s.status)) return { kind: 'ended', runId: s.latestRunId };
  if (s.status === 'idle') return s.runs > 0 ? { kind: 'ended', runId: s.latestRunId } : { kind: 'no_work' };
  return { kind: 'nothing' };
}

export const endedKey = (runId: string | null) => `done:${runId ?? '-'}`;

/** The questions waiting, whatever order T3 Code lists them in (request ids are ~400 characters: a short hash). */
export function asksKey(requestIds: readonly string[]): string {
  const hash = createHash('sha256')
    .update([...requestIds].sort().join('\n'))
    .digest('base64url')
    .slice(0, 22);
  return `asks:${hash}`;
}

export const approvalKey = (runId: string | null, pending: number) => `approval:${runId ?? '-'}:${pending}`;

/** How many of a thread's latest items show its state (a request that waits is among them). */
const LATEST = 4;
/** A pass reads a thread's new items this many at a time (T3 Code takes up to 100), at most this many pages. */
export const ITEMS_PAGE = 50;
export const ITEMS_PAGES = 4;

/** `t3_thread_read`'s arguments for a thread's state and its latest items (the length it had last time). */
export function stateArgs(threadId: string, items: number): Record<string, unknown> {
  return {
    threadId,
    view: 'activity',
    limit: LATEST,
    runLimit: 1,
    maxCharsPerItem: 300,
    // Items are numbered from 0; this reads the last few.
    ...(items > LATEST ? { afterPosition: items - LATEST - 1 } : {}),
  };
}

/**
 * Where a pass's read of a thread starts (`afterPosition`; null: at its first item): a few items before the end the
 * last read saw (`items`, its length then), so an item that was still running and a request that still waits are read
 * again; or where the last read stopped (`readTo`), when more came than one pass reads. A job's first read starts at
 * the latest items known: a thread handed new work after its last job doesn't show that job's items again.
 */
export function readFrom(readTo: number | null, items: number): number | null {
  const latest = items > LATEST ? items - LATEST - 1 : null;
  if (readTo === null || latest === null) return latest;
  return Math.min(readTo, latest);
}

/** `t3_thread_read`'s arguments for one page of a thread's items after `after` (null: from its first). */
export function itemsArgs(threadId: string, after: number | null): Record<string, unknown> {
  return {
    threadId,
    view: 'activity',
    limit: ITEMS_PAGE,
    runLimit: 1,
    maxCharsPerItem: 300,
    ...(after !== null ? { afterPosition: after } : {}),
  };
}

/** One page as T3 Code answered it: where the next one starts (`nextPosition`) and whether there is one (`hasMore`). */
export function pageOf(body: unknown, after: number | null): { next: number | null; more: boolean } {
  const r = rec(body);
  const positions = list(r.items)
    .map((i) => rec(i).position)
    .filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 0);
  const next =
    typeof r.nextPosition === 'number' && Number.isInteger(r.nextPosition) && r.nextPosition >= 0
      ? r.nextPosition
      : positions.length
        ? Math.max(...positions)
        : after;
  // A page that didn't move on has nothing after it, whatever it says.
  return { next, more: r.hasMore === true && next !== null && next > (after ?? -1) };
}

/** A pass's pages as one read: the thread and its runs as the last page shows them, each item once, in order. */
export function joinPages(pages: readonly unknown[]): Record<string, unknown> {
  const seen = new Set<number>();
  const items: unknown[] = [];
  for (const page of pages)
    for (const item of list(rec(page).items)) {
      const at = rec(item).position;
      if (typeof at === 'number') {
        if (seen.has(at)) continue;
        seen.add(at);
      }
      items.push(item);
    }
  return { ...rec(pages.at(-1)), items };
}

/** A thread as one pass of the watcher reads it (`readThread`). */
export interface ThreadRead {
  /** Every item since the last read, with the thread and its runs as they are now: the job's track and steps. */
  body: Record<string, unknown>;
  /** What the thread's state is read from: the same read, or its latest items when more came than a pass reads. */
  latest: unknown;
  /** The last position read; the next pass goes on after it. */
  readTo: number | null;
  /** More came than a pass reads: the job's track isn't whole yet, so its end waits for the next pass. */
  backlog: boolean;
}

const itemCountOf = (body: unknown) => {
  const n = rec(rec(body).thread).itemCount;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Reads what a thread did since the last read (`readTo`, `items`: as the watch kept them), page after page
 * (`afterPosition` = `nextPosition`), at most `ITEMS_PAGES` a pass so one pass can't run long: what is left is read on
 * the next. Its state then comes from one more read of its latest items. A job's first read that finds more history
 * than a pass reads starts at its latest items: what came before was work handed over earlier.
 */
export async function readThread(
  read: (args: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
  readTo: number | null,
  items: number,
): Promise<ThreadRead> {
  let after = readFrom(readTo, items);
  const pages: unknown[] = [];
  let more = true;
  for (let n = 0; n < ITEMS_PAGES && more; n++) {
    const body = await read(itemsArgs(threadId, after));
    const page = pageOf(body, after);
    const total = itemCountOf(body);
    if (
      !pages.length &&
      readTo === null &&
      page.more &&
      total - 1 - (page.next ?? 0) > ITEMS_PAGE * ITEMS_PAGES
    ) {
      after = Math.max(0, total - LATEST - 1);
      continue;
    }
    pages.push(body);
    more = page.more;
    after = page.next;
  }
  const body = joinPages(pages);
  if (!more) return { body, latest: body, readTo: after, backlog: false };
  const latest = await read(stateArgs(threadId, itemCountOf(body)));
  const now = rec(latest);
  return {
    body: { ...body, thread: now.thread, recentRuns: now.recentRuns },
    latest,
    readTo: after,
    backlog: true,
  };
}

/**
 * `t3_thread_read`'s arguments for the thread's latest messages, where its last answer is (a council member's is read
 * longer, `max`).
 */
export function answerArgs(
  threadId: string,
  items: number,
  max: number = T3_ANSWER_MAX,
): Record<string, unknown> {
  const LATEST = 6;
  return {
    threadId,
    view: 'messages',
    limit: LATEST,
    runLimit: 1,
    maxCharsPerItem: max,
    ...(items > LATEST ? { afterPosition: items - LATEST - 1 } : {}),
  };
}

/** The thread's last answer: its latest assistant message, cut to `max` (`T3_ANSWER_MAX`); null when it has none. */
export function lastAnswerOf(body: unknown, max: number = T3_ANSWER_MAX): string | null {
  const said = lastAnswerItemOf(body)?.text.trim();
  return said ? fitAnswer(said, max) : null;
}

/**
 * The thread's latest assistant message as read: its item, its text and, when T3 Code cut it off, where the rest goes
 * on (`nextTextOffset`, read with `itemId` and `textOffset`). Null when it has none.
 */
export function lastAnswerItemOf(
  body: unknown,
): { itemId: string | null; text: string; more: number | null } | null {
  const item = list(rec(body).items)
    .map(rec)
    .filter((i) => str(i.type) === 'assistant_message' && str(i.text)?.trim())
    .at(-1);
  return item ? answerPartOf(item) : null;
}

/** One read of a message item: its text and where the rest goes on, if T3 Code cut it off. */
export function answerPartOf(item: Record<string, unknown>): {
  itemId: string | null;
  text: string;
  more: number | null;
} {
  const more =
    item.textTruncated === true && typeof item.nextTextOffset === 'number' ? item.nextTextOffset : null;
  return { itemId: str(item.itemId), text: str(item.text) ?? '', more };
}

/** `t3_thread_read`'s arguments for the rest of a cut-off message, from `offset`. */
export function answerRestArgs(threadId: string, itemId: string, offset: number): Record<string, unknown> {
  return {
    threadId,
    view: 'messages',
    itemId,
    textOffset: offset,
    limit: 1,
    maxCharsPerItem: ANSWER_REST_PAGE,
  };
}

/** How much of a cut-off answer's rest one read brings, and how many reads go after its end. */
export const ANSWER_REST_PAGE = 50_000;
export const ANSWER_REST_PAGES = 8;

const CUT = '\n…\n';

/**
 * An answer cut to `max`: its start and its end. The end is kept because the lines Whombat reads close every answer
 * (`Score:`, `Verdict:`, `Item N:`, `Checks:`, `Verification:`, `Merged:`), and it starts at a whole line when one
 * starts near the cut.
 */
export function fitAnswer(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - CUT.length;
  let tail = text.slice(text.length - Math.floor(room / 2));
  const line = tail.indexOf('\n');
  if (line >= 0 && line < 200) tail = tail.slice(line + 1);
  return `${text.slice(0, room - tail.length).trimEnd()}${CUT}${tail}`;
}

/**
 * `t3_thread_wait`'s answer: whether it timed out, and the run that ended — with `untilDelegatedWorkSettled`, the one
 * with the final answer (`resultRun`, a run id or a run).
 */
export function waitOf(body: unknown): { timedOut: boolean; runId: string | null; status: T3Status | null } {
  const r = rec(body);
  const result = str(r.resultRun) ?? str(rec(r.resultRun).runId);
  return { timedOut: r.timedOut === true, runId: result ?? str(r.runId), status: statusOf(r.status) };
}

/**
 * The pull requests T3 Code still watches for a thread (`list_thread_pull_requests`), by address. While it watches one,
 * a run that ended isn't the thread's end: T3 Code starts it again when the pull request's checks or reviews move.
 */
export function watchedPullRequestsOf(body: unknown): string[] {
  return list(rec(body).pullRequests)
    .map(rec)
    .filter((pr) => pr.watching === true)
    .flatMap((pr) => {
      const url = str(pr.url);
      const number = typeof pr.number === 'number' ? `#${pr.number}` : null;
      const name = url && url.length <= MAX_PR_URL ? url : number;
      return name ? [name] : [];
    })
    .slice(0, T3_WATCHED_PRS_MAX);
}

/** The pages of every pull request linked to a thread (watched or not), newest last as T3 Code lists them. */
export function pullRequestUrlsOf(body: unknown): string[] {
  return list(rec(body).pullRequests)
    .map(rec)
    .flatMap((pr) => {
      const url = str(pr.url);
      return url && url.length <= MAX_PR_URL ? [url] : [];
    })
    .slice(0, T3_WATCHED_PRS_MAX);
}

/** The branch a thread's newest pull request goes into (`baseBranch`, “main”), or null when T3 Code doesn't say. */
export function baseBranchOf(body: unknown): string | null {
  const base = str(list(rec(body).pullRequests).map(rec).at(-1)?.baseBranch)?.trim();
  return base && base.length <= 200 && /^[\w./-]+$/.test(base) ? base : null;
}

/**
 * Whether T3 Code says a thread's pull request (`url`, else its newest) is merged: true when merged, false when closed
 * without it, null when it is open or T3 Code doesn't say (its state is the last it saw, so it may lag).
 */
export function mergedOf(body: unknown, url: string | null): boolean | null {
  const prs = list(rec(body).pullRequests).map(rec);
  const want = url?.toLowerCase();
  const pr = (want ? prs.find((p) => str(p.url)?.toLowerCase() === want) : undefined) ?? prs.at(-1);
  const state = str(pr?.state)?.toLowerCase();
  return state === 'merged' ? true : state === 'closed' ? false : null;
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The title of a thread the agent starts, its name first (“Dusty - Fix the login bug”), so the person sees in T3 Code's
 * list who handed it over. A title that already starts with the name (“Dusty: …”, “Dusty – …”) gets it once.
 */
export function launchTitle(agent: string, title: string): string {
  const name = agent.trim();
  const rest = title
    .trim()
    .replace(new RegExp(`^${escaped(name)}\\s*[-–—:|]\\s*`, 'i'), '')
    .trim();
  if (!name || !rest) return title;
  return `${name} - ${rest}`.slice(0, MAX_TITLE);
}

/**
 * Whether a thread whose work ended is settled in T3 Code once the agent heard of it: one that completed. A failed run
 * stays in the person's list, and one somebody stopped was stopped on purpose.
 */
export const settlesWhenTold = (status: T3Status | null) => status === 'completed' || status === 'idle';

/** The title in a `[Title](t3-thread://…)` link T3 Code answers a launch with. */
function linkTitle(v: unknown): string | null {
  const m = /^\[(.+)\]\([^)]*\)$/s.exec(str(v) ?? '');
  return m?.[1]?.trim().slice(0, MAX_TITLE) || null;
}

/** What one of the agent's own calls means for the threads Whombat watches for it. */
export type T3CallMeaning =
  /** It handed the thread work: watch it from where the call was made. */
  | { how: 'arm'; threadId: string; title: string | null }
  /** It saw this of the thread already. */
  | { how: 'seen'; threadId: string; key: string }
  /** It stopped the thread itself: nothing to tell. */
  | { how: 'stop'; threadId: string };

const threadArg = (args: Record<string, unknown>) => {
  const id = str(args.threadId);
  return id && id.length <= MAX_ID ? id : null;
};

/**
 * What a call of the agent's to T3 Code means: starting a thread, sending one a message or answering
 * its question hands it work; stopping it ends the watch; a wait that saw it end, a read that shows it ended or waiting
 * for a permission, and a list of its questions are seen. Anything else, and a declined call, means nothing.
 */
export function seenOfCall(tool: string, args: Record<string, unknown>, body: unknown): T3CallMeaning | null {
  const r = rec(body);
  switch (tool) {
    case 't3_thread_launch': {
      const threadId = str(r.threadId);
      if (!threadId || threadId.length > MAX_ID) return null;
      return {
        how: 'arm',
        threadId,
        title: linkTitle(r.link) ?? str(args.title)?.slice(0, MAX_TITLE) ?? null,
      };
    }
    case 't3_thread_send': {
      const threadId = threadArg(args);
      return threadId ? { how: 'arm', threadId, title: null } : null;
    }
    case 't3_pending_request': {
      const threadId = threadArg(args);
      if (!threadId) return null;
      if (args.action === 'respond') return { how: 'arm', threadId, title: null };
      const ids = list(r.requestIds)
        .map(str)
        .filter((s): s is string => !!s);
      return args.action === 'list' && ids.length ? { how: 'seen', threadId, key: asksKey(ids) } : null;
    }
    case 't3_thread_interrupt': {
      const threadId = threadArg(args);
      return threadId ? { how: 'stop', threadId } : null;
    }
    case 't3_thread_wait': {
      const threadId = threadArg(args);
      const w = waitOf(body);
      if (!threadId || w.timedOut || !w.status || !FINISHED.includes(w.status)) return null;
      return { how: 'seen', threadId, key: endedKey(w.runId) };
    }
    case 't3_thread_read': {
      const s = threadStateOf(body);
      if (!s) return null;
      const needs = needsOf(s);
      if (needs.kind === 'ended') return { how: 'seen', threadId: s.threadId, key: endedKey(needs.runId) };
      // A question's key needs its ids (a list); a permission request's is here.
      if (needs.kind === 'pending' && !s.activity.asks)
        return { how: 'seen', threadId: s.threadId, key: approvalKey(s.activeRunId, s.activity.pending) };
      return null;
    }
    default:
      return null;
  }
}
