/**
 * What a turn on a tracker report may do in T3 Code (docs/decisions/outsiders-turns.md). The report's text
 * comes from a stranger and T3 Code's threads run with full access on the person's computer, so such a turn gets the
 * few calls its job needs and nothing of the person's own work there:
 *
 * - list projects and AI programs, to find where to start;
 * - start a thread, always in a new worktree, never in the project folder itself or an existing worktree;
 * - wait for, read, message, answer or stop only the threads started from this report's thread;
 * - find and read the reviews those threads hand to another model (their `subagent` children): a fix's review is how
 *   the run knows it may merge, so the report turn reads the reviewer's own words.
 *
 * Everything else (other threads, schedules, environments, projects, moving threads) is refused before anything is
 * signed, and isn't listed by `connection_tools`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { automationRunSteps, automationRuns, t3Watches } from '../db/schema/index';

type Rule = 'any' | 'launch' | 'list_own' | 'own_or_child' | 'own_thread';

/** The T3 Code tools a report turn may call, and how each is checked. */
const REPORT_TURN_TOOLS: Readonly<Record<string, Rule>> = {
  t3_project_list: 'any',
  orchestrator_capabilities: 'any',
  t3_thread_launch: 'launch',
  // The list answers only with this report's threads and their reviews (`ownThreadList`).
  t3_thread_list: 'list_own',
  t3_thread_wait: 'own_or_child',
  t3_thread_read: 'own_or_child',
  t3_thread_send: 'own_thread',
  t3_thread_interrupt: 'own_thread',
  t3_pending_request: 'own_thread',
};

/** Whether `connection_tools` lists a T3 Code tool in a report turn. */
export function reportTurnLists(tool: string): boolean {
  return Object.hasOwn(REPORT_TURN_TOOLS, tool);
}

export type ReportTurnCheck = { ok: true; args: Record<string, unknown> } | { ok: false; message: string };

const REFUSED =
  'A turn on a report can only find a project, start a new thread in a new worktree and follow the threads it started and their reviews.';

/**
 * A launch's arguments in a report turn: no place given means a new worktree from the project's current branch; a new
 * worktree is kept as asked; any other place (the project folder, an existing worktree, no project) is refused.
 */
export function reportTurnLaunchArgs(args: Record<string, unknown>): ReportTurnCheck {
  if (args.scratch === true) return { ok: false, message: `${REFUSED} Name the project with projectId.` };
  const strategy = args.workspaceStrategy;
  if (strategy === undefined || strategy === null)
    return { ok: true, args: { ...args, workspaceStrategy: { type: 'worktree', baseRef: 'HEAD' } } };
  if (typeof strategy === 'object' && (strategy as Record<string, unknown>).type === 'worktree')
    return { ok: true, args };
  return { ok: false, message: `${REFUSED} Start it with workspaceStrategy {"type": "worktree"}.` };
}

/** Where the report turn works: its conversation and thread, where its own launches are watched (`followT3Call`). */
export interface ReportTurnPlace {
  agentId: string;
  connectionId: string;
  conversationId: string;
  threadRootId: string | null;
}

/** Whether a T3 Code thread was started (or handed work) from this report turn's thread. */
async function startedHere(db: Db | Tx, place: ReportTurnPlace, threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ threadId: t3Watches.threadId })
    .from(t3Watches)
    .where(
      and(
        eq(t3Watches.connectionId, place.connectionId),
        eq(t3Watches.threadId, threadId),
        eq(t3Watches.agentId, place.agentId),
        eq(t3Watches.conversationId, place.conversationId),
        place.threadRootId ? eq(t3Watches.threadRootId, place.threadRootId) : isNull(t3Watches.threadRootId),
      ),
    )
    .limit(1);
  return !!row;
}

/** The T3 Code threads started (or handed work) from this report turn's thread. */
async function threadsStartedHere(db: Db | Tx, place: ReportTurnPlace): Promise<Set<string>> {
  const rows = await db
    .select({ threadId: t3Watches.threadId })
    .from(t3Watches)
    .where(
      and(
        eq(t3Watches.connectionId, place.connectionId),
        eq(t3Watches.agentId, place.agentId),
        eq(t3Watches.conversationId, place.conversationId),
        place.threadRootId ? eq(t3Watches.threadRootId, place.threadRootId) : isNull(t3Watches.threadRootId),
      ),
    );
  return new Set(rows.map((r) => r.threadId));
}

/** A T3 Code thread's parent, as T3 Code says it: null when it has none or isn't a review handed out (`subagent`). */
export type ParentOf = (threadId: string) => Promise<string | null>;

/** Whether `parent` and `relationship`, as a thread listing or read gives them, make it a review handed out. */
function subagentParent(thread: Record<string, unknown>): string | null {
  return thread.relationshipToParent === 'subagent' && typeof thread.parentThreadId === 'string'
    ? thread.parentThreadId
    : null;
}

/** The parent of a thread from a `t3_thread_read` answer (`{thread: {parentThreadId, relationshipToParent}}`). */
export function subagentParentOfRead(body: unknown): string | null {
  const thread = (body as { thread?: unknown } | null)?.thread;
  return thread && typeof thread === 'object' ? subagentParent(thread as Record<string, unknown>) : null;
}

/** How many of the customer's words in a row make a quote (TA-57). */
const QUOTE_WORDS = 8;

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/**
 * A stretch of the customer's own words — `QUOTE_WORDS` in a row, spelling and punctuation aside — that `message`
 * repeats from `stranger`, or null. Pure.
 */
export function quotedStranger(message: string, stranger: string): string | null {
  const theirs = wordsOf(stranger);
  if (theirs.length < QUOTE_WORDS) return null;
  const runs = new Set<string>();
  for (let i = 0; i + QUOTE_WORDS <= theirs.length; i++) runs.add(theirs.slice(i, i + QUOTE_WORDS).join(' '));
  const ours = wordsOf(message);
  for (let i = 0; i + QUOTE_WORDS <= ours.length; i++) {
    const run = ours.slice(i, i + QUOTE_WORDS).join(' ');
    if (runs.has(run)) return run;
  }
  return null;
}

/**
 * What the customer wrote, as a report turn's run has it (TA-57): the report's title, description and expected text,
 * and for an answer of theirs their words too. Empty when the dispatch isn't an automation step's.
 */
export async function strangerTextOf(db: Db | Tx, dispatchId: string): Promise<string> {
  const [row] = await db
    .select({ scope: automationRuns.scope })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(eq(automationRunSteps.dispatchId, dispatchId))
    .limit(1);
  const scope = (row?.scope ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof scope[k] === 'string' ? (scope[k] as string) : '');
  return [
    text('title'),
    text('description'),
    text('expected'),
    scope.event === 'reporter_replied' ? text('text') : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The words a launch or message hands a thread: every text argument (its title, prompt, message). */
function handedWords(args: Record<string, unknown>): string {
  return Object.values(args)
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
}

/**
 * Checks one T3 Code call of a report turn, before anything is signed; a launch's arguments may be completed. A read or
 * wait may name a review one of its threads handed out: `parentOf` asks T3 Code whose child it is. A launch or message
 * that repeats the customer's own words (`stranger`) is refused: the thread works with full access, so it hears the
 * report in the agent's words (TA-57).
 */
export async function checkReportTurnCall(
  db: Db | Tx,
  place: ReportTurnPlace,
  tool: string,
  args: Record<string, unknown>,
  parentOf?: ParentOf,
  stranger = '',
): Promise<ReportTurnCheck> {
  const rule = Object.hasOwn(REPORT_TURN_TOOLS, tool) ? REPORT_TURN_TOOLS[tool] : undefined;
  if (!rule) return { ok: false, message: `${REFUSED} ${tool} isn’t one of those.` };
  if (rule === 'any') return { ok: true, args };
  if (rule === 'launch' || tool === 't3_thread_send') {
    const quote = stranger ? quotedStranger(handedWords(args), stranger) : null;
    if (quote)
      return {
        ok: false,
        message: `Tell T3 Code about the report in your own words, not the customer’s (“${quote}…” is theirs): the thread works with full access.`,
      };
  }
  if (rule === 'launch') return reportTurnLaunchArgs(args);
  // Every project's threads are listed, reviews included, and the answer is cut to this report's (`ownThreadList`).
  if (rule === 'list_own') return { ok: true, args: { ...args, includeSubagents: true } };
  const threadId = typeof args.threadId === 'string' ? args.threadId : null;
  if (!threadId) return { ok: false, message: `${REFUSED} Name the thread it started with threadId.` };
  if (await startedHere(db, place, threadId)) return { ok: true, args };
  if (rule === 'own_or_child' && parentOf) {
    const parent = await parentOf(threadId).catch(() => null);
    if (parent && (await startedHere(db, place, parent))) return { ok: true, args };
  }
  return { ok: false, message: `${REFUSED} That thread wasn’t started from this report.` };
}

/**
 * A `t3_thread_list` answer cut to this report turn's own threads and the reviews they handed out (OT-12): the list
 * shows every project's threads, the person's own work among them, which a stranger's report never sees. Null when the
 * answer isn't a list Whombat can read (the call then says so instead of passing it on).
 */
export async function ownThreadList(
  db: Db | Tx,
  place: ReportTurnPlace,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  return filterOwnThreads(body, await threadsStartedHere(db, place));
}

/** `ownThreadList`'s cut, given the threads started here. */
export function filterOwnThreads(body: unknown, own: ReadonlySet<string>): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { threads?: unknown }).threads))
    return null;
  const threads = (body as { threads: unknown[] }).threads.filter((t): t is Record<string, unknown> => {
    if (!t || typeof t !== 'object') return false;
    const thread = t as Record<string, unknown>;
    if (typeof thread.threadId === 'string' && own.has(thread.threadId)) return true;
    const parent = subagentParent(thread);
    return !!parent && own.has(parent);
  });
  // Only the threads and where the list goes on: nothing that names another thread (`currentThreadId`, a total).
  const { nextCursor } = body as { nextCursor?: unknown };
  return { threads, nextCursor: nextCursor ?? null };
}
