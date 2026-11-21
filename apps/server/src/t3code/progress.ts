/**
 * A job's progress (docs/decisions/t3code.md T3-30…T3-41): where a T3 Code thread the agent handed work to is on the
 * stage track, its plan, what it changed, its pull request's checks, the question it waits on and, once it ended, its
 * receipt and its answer. Pure: T3 Code's and GitHub's answers and the watch's kept progress in, the next progress and the `Handoff`'s
 * parts out. The watcher (`watch.ts`) does the reads.
 */
import {
  HANDOFF_ANSWER_MAX,
  HANDOFF_CHECKS_MAX,
  HANDOFF_FILES_MAX,
  HANDOFF_PLAN_MAX,
  HANDOFF_STAGES,
  type Handoff,
  type HandoffChanges,
  type HandoffCheck,
  type HandoffCheckState,
  type HandoffPlanStep,
  type HandoffPullRequest,
  type HandoffQuestion,
  type HandoffReceipt,
  type HandoffStageTime,
  type HandoffTrackStage,
  T3_PERSON_SAID_COUNT,
  T3_PERSON_SAID_MAX,
} from '@whombat/core';
import type { GhCheckRun, GhCommitStatus, GhFile, GhPullRequest } from '../github/adapter';
import type { T3Request } from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';

/** What the watch keeps of a job's progress (`t3_watches.progress`, migration 0055). */
export interface T3Progress {
  /** The furthest stage reached (the track only moves forward); null before anything happened. */
  stage: HandoffTrackStage | null;
  stages: HandoffStageTime[];
  plan: HandoffPlanStep[];
  /** The plan item read last (its id and when it changed), so a plan is read in full once per change. */
  planKey: string | null;
  /** How the latest tests T3 Code ran went. */
  tests: 'passed' | 'failed' | null;
  question: HandoffQuestion | null;
  pullRequest: (HandoffPullRequest & { repo: string }) | null;
  /** GitHub's side, read at most once a minute while the job is live. */
  github: {
    at: string;
    head: string | null;
    changes: HandoffChanges | null;
    checks: HandoffCheck[] | null;
  } | null;
  /** The check that failed first and the commit it failed on; how many fixes were pushed since. */
  failing: { name: string; head: string } | null;
  attempts: number;
  receipt: HandoffReceipt | null;
  /** The run the receipt and the answer are of. */
  receiptRun: string | null;
  /** What the thread answered when that run ended, for the person to read in the thread (`jobAnswerOf`). */
  answer: string | null;
  /**
   * A delegation thread leading several tasks: its latest words, the items it said it finished
   * (`Item 3 done: …`, by their number on the card, with the line), and the timeline position its messages were read to.
   */
  said: string | null;
  reported: Record<string, string>;
  saidAt: number | null;
  /** Independent verification of this completed run failed to read GitHub; retry without another review. */
  verificationRetry: { key: string; attempts: number; nextAt: string } | null;
  /** The branch the thread works on, as T3 Code says: a pull request an automation opens from it is the job's. */
  branch: string | null;
  /** The last timeline position the watcher read, so the next pass reads every item after it. */
  readTo: number | null;
  /**
   * A run's end the watcher holds back (its key, and since when): work the thread waits for still goes on (T3 Code's
   * wait for its delegated and background work hasn't settled), so the end isn't the job's end yet and nobody is told.
   * Null otherwise.
   */
  held: { key: string; since: string } | null;
  /**
   * The thread waits to be settled in T3 Code once it has been quiet since `from` (`watch.ts` `#settleQuiet`); `at` is
   * when that was last looked at. Null: nothing to settle.
   */
  settle: { from: string; at: string } | null;
  /**
   * Someone sent the thread a message since its last end was told: the person in T3 Code, the agent, or the person's
   * answers on the job's result. The run that ends next was asked for, so its report doesn't take the place of the
   * earlier one (`result.ts`); a run T3 Code started by itself (a command the thread left running ended) goes on with it.
   */
  asked: boolean;
  /**
   * What the person wrote to the thread in T3 Code itself since its last end was told, oldest first, the latest
   * `T3_PERSON_SAID_COUNT`: the agent is told them with the end, so its next message doesn't overrule them.
   */
  personSaid: string[];
}

export const EMPTY_PROGRESS: T3Progress = {
  stage: null,
  stages: [],
  plan: [],
  planKey: null,
  tests: null,
  question: null,
  pullRequest: null,
  github: null,
  failing: null,
  attempts: 0,
  receipt: null,
  receiptRun: null,
  answer: null,
  said: null,
  reported: {},
  saidAt: null,
  verificationRetry: null,
  branch: null,
  readTo: null,
  held: null,
  settle: null,
  asked: false,
  personSaid: [],
};

/** GitHub is read at most this often per job. */
export const GITHUB_EVERY_MS = 60_000;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const order = (s: HandoffTrackStage) => HANDOFF_STAGES.indexOf(s);
const isStage = (v: unknown): v is HandoffTrackStage =>
  typeof v === 'string' && (HANDOFF_STAGES as readonly string[]).includes(v);
const isoOf = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The kept progress, whatever the column holds (an older row has none). */
export function progressOf(v: unknown): T3Progress {
  const r = rec(v);
  if (!Object.keys(r).length) return { ...EMPTY_PROGRESS, stages: [], plan: [], reported: {} };
  const stages = list(r.stages).flatMap((raw): HandoffStageTime[] => {
    const s = rec(raw);
    const startedAt = isoOf(s.startedAt);
    return isStage(s.stage) && startedAt ? [{ stage: s.stage, startedAt, endedAt: isoOf(s.endedAt) }] : [];
  });
  const plan = list(r.plan).flatMap((raw): HandoffPlanStep[] => {
    const p = rec(raw);
    const text = str(p.text);
    const state = str(p.state);
    return text && (state === 'done' || state === 'now' || state === 'next') ? [{ text, state }] : [];
  });
  const tests = r.tests === 'passed' || r.tests === 'failed' ? r.tests : null;
  const failing = rec(r.failing);
  const retry = rec(r.verificationRetry);
  const held = rec(r.held);
  const settle = rec(r.settle);
  return {
    stage: isStage(r.stage) ? r.stage : null,
    stages,
    plan,
    planKey: str(r.planKey),
    tests,
    question: (r.question as HandoffQuestion | null) ?? null,
    pullRequest: (r.pullRequest as T3Progress['pullRequest']) ?? null,
    github: (r.github as T3Progress['github']) ?? null,
    failing:
      str(failing.name) && str(failing.head)
        ? { name: str(failing.name) as string, head: str(failing.head) as string }
        : null,
    attempts: typeof r.attempts === 'number' && r.attempts >= 0 ? Math.floor(r.attempts) : 0,
    receipt: (r.receipt as HandoffReceipt | null) ?? null,
    receiptRun: str(r.receiptRun),
    answer: jobAnswerOf(str(r.answer)),
    said: str(r.said),
    reported: reportedOf(r.reported),
    saidAt: typeof r.saidAt === 'number' && r.saidAt >= 0 ? Math.floor(r.saidAt) : null,
    verificationRetry:
      str(retry.key) && isoOf(retry.nextAt) && Number.isInteger(retry.attempts) && Number(retry.attempts) > 0
        ? {
            key: str(retry.key) as string,
            attempts: Number(retry.attempts),
            nextAt: isoOf(retry.nextAt) as string,
          }
        : null,
    branch: str(r.branch),
    readTo: typeof r.readTo === 'number' && r.readTo >= 0 ? Math.floor(r.readTo) : null,
    held:
      str(held.key) && isoOf(held.since)
        ? { key: str(held.key) as string, since: isoOf(held.since) as string }
        : null,
    settle:
      isoOf(settle.from) && isoOf(settle.at)
        ? { from: isoOf(settle.from) as string, at: isoOf(settle.at) as string }
        : null,
    asked: r.asked === true,
    personSaid: list(r.personSaid)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
      .slice(-T3_PERSON_SAID_COUNT)
      .map((t) => cut(t, T3_PERSON_SAID_MAX)),
  };
}

/** Back off unavailable GitHub reads from fifteen seconds to fifteen minutes, scoped to one completed run. */
export function retryVerification(p: T3Progress, key: string, now: Date): T3Progress {
  const attempts = (p.verificationRetry?.key === key ? p.verificationRetry.attempts : 0) + 1;
  const wait = Math.min(15_000 * 2 ** Math.min(attempts - 1, 10), 15 * 60_000);
  return { ...p, verificationRetry: { key, attempts, nextAt: new Date(now.getTime() + wait).toISOString() } };
}

function reportedOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, line] of Object.entries(rec(v)))
    if (/^\d{1,2}$/.test(n) && typeof line === 'string') out[n] = line;
  return out;
}

/* What a lead thread says while it works ------------------------------------------------------------------------- */

/** How long the latest words kept are. */
const SAID_MAX = 200;
/** How long a reported item's line is kept. */
const REPORTED_MAX = 300;

/** `Item 3 done: …`: the thread finished that item. */
const ITEM_DONE = /^[\s>*_`-]*item\s+(\d{1,2})\s+(?:is\s+)?done\b[*_`]*\s*[:.\u2013\u2014-]?[\s*_`]*(.*)$/gim;

/** A message's first sentence or two in plain text, for the card: no code marks, links or line breaks. */
export function saidOf(text: string): string | null {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  // Whole sentences up to the limit, else the first cut short.
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [plain];
  let out = '';
  for (const s of sentences) {
    const next = `${out} ${s.trim()}`.trim();
    if (next.length > SAID_MAX) break;
    out = next;
  }
  return out || cut(plain, SAID_MAX);
}

/**
 * The progress after reading a lead thread's messages (messages view, from `saidAt` on): its latest words and each
 * `Item N done:` line it wrote. A message to it (new work, an answer) starts the reported items again: what it said
 * before was about the work before.
 */
export function readSaid(p: T3Progress, body: unknown): T3Progress {
  let said = p.said;
  let reported = p.reported;
  let saidAt = p.saidAt;
  for (const item of list(rec(body).items).map(rec)) {
    if (typeof item.position === 'number') saidAt = Math.max(saidAt ?? 0, item.position);
    const type = str(item.type);
    const text = str(item.text) ?? '';
    if (type === 'user_message') {
      said = null;
      reported = {};
      continue;
    }
    if (type !== 'assistant_message' || !text.trim()) continue;
    said = saidOf(text) ?? said;
    for (const [, n, line] of text.matchAll(ITEM_DONE)) {
      if (!n) continue;
      const words = (line ?? '').replace(/[*_`]+$/g, '').trim();
      reported = {
        ...reported,
        [String(Number(n))]: cut(words && !words.startsWith('<') ? words : 'Done.', REPORTED_MAX),
      };
    }
  }
  return { ...p, said, reported, saidAt };
}

/* The stage track ---------------------------------------------------------------------------------------------------- */

/** The tool's name in a `dynamic_tool` or `mcp_tool_call` item (its text is the call as JSON). */
const toolNameOf = (text: string) => /"toolName"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';

const PLAN_TOOLS = /^(todowrite|todo_write|update_plan|exitplanmode|write_todos)$/i;
const READ_TOOLS = /^(read|grep|glob|ls|view|notebookread)$/i;
const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|str_replace_based_edit_tool)$/i;
const HELPER_TOOLS = /^(task|agent|subagent)$|delegate_task$/i;
const TEST_COMMAND =
  /\b(vitest|jest|pytest|playwright|mocha|tsc|typecheck|biome|eslint|lint)\b|\b(test|tests|e2e|check)\b|\bcargo\s+test\b|\bgo\s+test\b/;
const PR_COMMAND = /\bgh\s+pr\s+create\b/;
const READ_COMMAND =
  /^(\s*(cd\s+\S+\s*&&\s*)?)(rg|grep|find|ls|cat|sed|head|tail|wc|git\s+(log|show|diff|status|grep))\b/;

/**
 * A command as T3 Code shows it (its item's first line, the `$ ` dropped), without the `/bin/bash -lc '…'` Codex runs
 * every command in, so it reads as the person's own shell line would.
 */
export function commandOf(text: string): string {
  let command = (text.split('\n')[0] ?? '').replace(/^\$\s*/, '').trim();
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])(.*)$/.exec(command);
  if (wrapped) {
    const [, quote, rest = ''] = wrapped;
    command = quote && rest.endsWith(quote) ? rest.slice(0, -1) : rest;
  }
  return command.trim();
}

/** Where a write goes that doesn't change the code: nowhere, a temporary file, a cache. */
const SCRATCH = /^(?:\/dev\/|\/proc\/|\/tmp\/|\/var\/tmp\/|\$\{?tmpdir\b|~\/\.cache\/)/i;
/** The programs that only write what they are given: a redirect or a `tee` of theirs is a file written by hand. */
const WRITERS = /^(?:cat|echo|printf|tee)\b/;
const HEREDOC = /<<-?\s*['"]?\w/;
const IN_PLACE = /^(?:sed|perl)\s(?:[^|;&]*\s)?(?:-[a-z]*i|--in-place)/;
const PATCHES = /^(?:git\s+apply|patch)\b/;
const TARGET = `(['"]?)([^\\s'"|;&<>()]+)\\1`;

/**
 * The file a shell command writes in place of an editor: a heredoc, `cat`, `echo`, `printf` or `tee` into a file, or
 * `sed -i` / `perl -i` on one; '' when it changes files it doesn't name (`git apply`, `patch`); null when it writes no
 * file of the code (a test's log, `/dev/null`, a temporary file, or nothing at all). `command` as `commandOf` gives it.
 */
export function shellWriteOf(command: string): string | null {
  const c = command.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim();
  const first = c.split(/\s*(?:\||;|&&|\|\|)\s*/)[0] ?? '';
  const kept = (path: string | undefined) => (path && !SCRATCH.test(path) ? path : null);
  if (IN_PLACE.test(first))
    return kept(
      first
        .split(/\s+/)
        .at(-1)
        ?.replace(/^['"]|['"]$/g, ''),
    );
  if (PATCHES.test(first)) return '';
  if (!WRITERS.test(c) && !HEREDOC.test(c)) return null;
  // The last redirect into a file (`2>` and `&>` carry a program's errors, `>&2` goes to another stream).
  const redirect = [...c.matchAll(new RegExp(`(?:^|[^<>&\\d])>>?\\s*${TARGET}`, 'g'))].at(-1)?.[2];
  const teed = new RegExp(`\\btee\\s+(?:(?:-a|--append)\\s+)?${TARGET}`).exec(c)?.[2];
  return kept(redirect) ?? kept(teed);
}

/** Whether an item is T3 Code's plan (read in full for its steps). */
export function isPlanItem(item: Record<string, unknown>): boolean {
  const type = str(item.type);
  if (type === 'plan' || type === 'todo_list' || type === 'proposed_plan') return true;
  return (
    (type === 'dynamic_tool' || type === 'mcp_tool_call') && PLAN_TOOLS.test(toolNameOf(str(item.text) ?? ''))
  );
}

/** The stage one of T3 Code's items shows the job is at; null for what says nothing about it. */
export function stageOfItem(item: Record<string, unknown>): HandoffTrackStage | null {
  const type = str(item.type);
  const text = str(item.text) ?? '';
  const title = str(item.title) ?? '';
  if (isPlanItem(item)) return 'plan';
  switch (type) {
    case 'file_change':
      return 'editing';
    case 'subagent':
      return /review/i.test(`${title} ${text}`) ? 'review' : null;
    case 'command_execution': {
      const command = commandOf(text).toLowerCase();
      if (/^preparing workspace$/.test(command)) return null;
      if (PR_COMMAND.test(command)) return 'pull_request';
      // A file written from the shell is an edit, whatever program writes it (`cat > a.test.ts <<EOF` is no test).
      if (shellWriteOf(command) !== null) return 'editing';
      if (READ_COMMAND.test(command)) return 'reading';
      if (TEST_COMMAND.test(command)) return 'tests';
      return null;
    }
    case 'dynamic_tool':
    case 'mcp_tool_call': {
      const name = toolNameOf(text);
      if (EDIT_TOOLS.test(name)) return 'editing';
      if (READ_TOOLS.test(name)) return 'reading';
      if (HELPER_TOOLS.test(name)) return /review/i.test(`${title} ${text}`) ? 'review' : null;
      if (/link_pull_request/i.test(name)) return 'pull_request';
      return null;
    }
    case 'reasoning':
    case 'web_search':
      return 'reading';
    default:
      return null;
  }
}

/** How a test command went, from its item (T3 Code marks a command that exited badly `failed`). */
export function testOutcomeOf(item: Record<string, unknown>): 'passed' | 'failed' | null {
  if (stageOfItem(item) !== 'tests') return null;
  const status = str(item.status);
  if (status === 'failed' || status === 'error' || status === 'declined') return 'failed';
  return status === 'completed' ? 'passed' : null;
}

/**
 * The track after the job reached `stage` at `at`: forward only, so a fix after the tests or the pull request stays where
 * the job got to. Stages it skipped (a plan it never wrote) get no times; the stage it left is closed.
 */
export function advance(p: T3Progress, stage: HandoffTrackStage, at: string): T3Progress {
  if (p.stage && order(stage) <= order(p.stage)) return p;
  const stages = p.stages.map((s) => (s.endedAt ? s : { ...s, endedAt: at }));
  stages.push({ stage, startedAt: at, endedAt: stage === 'merged' ? at : null });
  return { ...p, stage, stages };
}

/**
 * The job's run ended: the stage it is at is closed (its time ran until then). A stage its pull request reached after
 * that (opened, its checks) goes on: the pull request outlives the run.
 */
export function closeStages(p: T3Progress, at: string): T3Progress {
  const end = Date.parse(at);
  const closes = (s: HandoffStageTime) => !s.endedAt && !(Date.parse(s.startedAt) > end);
  if (!p.stages.some(closes)) return p;
  return { ...p, stages: p.stages.map((s) => (closes(s) ? { ...s, endedAt: at } : s)) };
}

/**
 * The progress after one `t3_thread_read` (activity view): each item moves the track, the latest test command says how
 * the tests went, the thread's pull request is the one T3 Code links last, and a message to the thread marks it asked.
 * `now` stands in for an item without a time. `since`: when the work was handed over (the watch armed), before which a
 * job that has read nothing yet takes nothing the person wrote as new.
 */
export function readProgress(p: T3Progress, body: unknown, now: Date, since: Date | null = null): T3Progress {
  let next = p;
  const items = list(rec(body).items).map(rec);
  for (const item of items) {
    const at = isoOf(item.updatedAt) ?? now.toISOString();
    // A pass reads the last few items again: only a message after what was read before is new.
    const fresh = typeof item.position !== 'number' || p.readTo === null || item.position > p.readTo;
    if (str(item.type) === 'user_message' && fresh) {
      next = { ...next, asked: true };
      // T3 Code marks what the person typed in its app as theirs; the agent's own messages are marked as an agent's.
      // New work on an idle thread reads its last items again: what they wrote before it was handed over is old news.
      const said = item.createdBy === 'user' ? str(item.text) : null;
      const before = p.readTo === null && since !== null && Date.parse(at) < since.getTime();
      if (said && !before)
        next = {
          ...next,
          personSaid: [
            ...next.personSaid,
            cut(item.textTruncated === true ? `${said}…` : said, T3_PERSON_SAID_MAX),
          ].slice(-T3_PERSON_SAID_COUNT),
        };
    }
    // Any work at all starts with reading the code.
    if (!next.stage && str(item.type) && str(item.type) !== 'user_message')
      next = advance(next, 'reading', at);
    const stage = stageOfItem(item);
    if (stage) next = advance(next, stage, at);
    const tests = testOutcomeOf(item);
    if (tests) next = { ...next, tests };
  }
  const pr = pullRequestOf(body);
  if (pr) {
    next = { ...next, pullRequest: pr };
    next = advance(next, 'pull_request', now.toISOString());
    if (pr.state === 'merged') next = advance(next, 'merged', now.toISOString());
  }
  const branch = str(rec(rec(body).thread).branch)?.trim();
  if (branch && branch.length <= 255 && branch !== next.branch) next = { ...next, branch };
  return next;
}

/**
 * The job after a pull request its thread didn't open itself was linked to it (an automation's step opened it from the
 * branch the thread worked on): the job's pull request, and the track at it, as if T3 Code had linked it. A job that has
 * a pull request of its own keeps it.
 */
export function linkPullRequest(
  p: T3Progress,
  pr: { repo: string; number: number; url: string },
  now: Date,
): T3Progress {
  if (p.pullRequest || pr.number <= 0 || !pr.url || pr.url.length > 500) return p;
  return advance(
    { ...p, pullRequest: { number: pr.number, url: pr.url, repo: pr.repo, state: 'open' } },
    'pull_request',
    now.toISOString(),
  );
}

/** The thread's pull request (T3 Code's `linkedPullRequest`, else the last it lists), with its repository. */
export function pullRequestOf(body: unknown): T3Progress['pullRequest'] {
  const t = rec(rec(body).thread);
  const raw = [t.linkedPullRequest, ...list(t.pullRequests).slice().reverse()]
    .map(rec)
    .find((p) => str(p.url));
  if (!raw) return null;
  const url = str(raw.url) as string;
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(url);
  const number = typeof raw.number === 'number' && raw.number > 0 ? raw.number : m ? Number(m[2]) : 0;
  if (!number || url.length > 500) return null;
  const state = str(raw.state);
  return {
    number,
    url,
    repo: str(raw.repository) ?? m?.[1] ?? '',
    state: state === 'merged' || state === 'closed' || state === 'draft' ? state : 'open',
  };
}

/* The plan ----------------------------------------------------------------------------------------------------------- */

const planState = (status: string | null): HandoffPlanStep['state'] => {
  const s = (status ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'completed' || s === 'done' || s === 'complete') return 'done';
  if (s === 'inprogress' || s === 'active' || s === 'running' || s === 'now') return 'now';
  return 'next';
};

const steps = (rows: { text: string; status: string | null }[]): HandoffPlanStep[] =>
  rows
    .map((r) => ({ text: cut(r.text.replace(/\s+/g, ' ').trim(), 200), state: planState(r.status) }))
    .filter((r) => r.text.length > 0)
    .slice(0, HANDOFF_PLAN_MAX);

/**
 * T3 Code's plan from its plan item read in full: a to-do tool's call (`todos` of `content` and `status`), a plan's steps
 * (`plan` of `step` and `status`), or a checklist in text (`- [x] …`, `- [ ] …`). Nothing it can't read: no plan.
 */
export function planOf(item: Record<string, unknown>): HandoffPlanStep[] {
  const text = str(item.text) ?? '';
  const fromJson = (v: unknown): HandoffPlanStep[] => {
    const r = rec(v);
    const input = rec(r.input);
    const arr = [input.todos, input.plan, r.todos, r.plan, r.steps, r.items].find(Array.isArray) as
      | unknown[]
      | undefined;
    if (!arr) return [];
    return steps(
      arr.map(rec).map((s) => ({
        text: str(s.content) ?? str(s.step) ?? str(s.text) ?? str(s.title) ?? '',
        status: str(s.status),
      })),
    );
  };
  try {
    const parsed = fromJson(JSON.parse(text));
    if (parsed.length) return parsed;
  } catch {
    // Cut off or not JSON: the pairs below, or a checklist.
  }
  const pairs = [
    ...text.matchAll(/"(?:content|step)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"status"\s*:\s*"(\w+)"/g),
  ];
  if (pairs.length)
    return steps(pairs.map((m) => ({ text: JSON.parse(`"${m[1]}"`) as string, status: m[2] ?? null })));
  const lines = text.split('\n').flatMap((line) => {
    const m = /^\s*(?:[-*]|\d+[.)])?\s*(\[[ xX~>-]\]|[✓✔☑☐□○●◐→])\s+(.+)$/.exec(line);
    if (!m) return [];
    const mark = m[1] as string;
    const status = /[xX✓✔☑]/.test(mark) ? 'done' : /[~>●◐→-]/.test(mark) ? 'now' : 'next';
    return [{ text: m[2] as string, status }];
  });
  return steps(lines);
}

/* GitHub ------------------------------------------------------------------------------------------------------------- */

/** The pull request's changes: its files (the most changed first), totals, its title and its Files page. */
export function changesOf(pr: GhPullRequest, files: readonly GhFile[]): HandoffChanges {
  const sorted = [...files].sort((a, b) => b.add + b.del - (a.add + a.del));
  return {
    files: sorted.slice(0, HANDOFF_FILES_MAX).map((f) => ({
      path: cut(f.path, 300),
      additions: Math.max(0, f.add),
      deletions: Math.max(0, f.del),
    })),
    fileCount: pr.changedFiles ?? files.length,
    additions: pr.additions ?? files.reduce((n, f) => n + f.add, 0),
    deletions: pr.deletions ?? files.reduce((n, f) => n + f.del, 0),
    summary: pr.title ? cut(pr.title, 200) : null,
    url: `${pr.url.replace(/\/+$/, '')}/files`.slice(0, 2000),
  };
}

const runState = (status: string, conclusion: string | null): HandoffCheckState => {
  if (status === 'queued' || status === 'pending' || status === 'waiting' || status === 'requested')
    return 'queued';
  if (status !== 'completed') return 'running';
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'passed';
    case 'skipped':
    case 'stale':
      return 'skipped';
    default:
      return 'failed';
  }
};

const statusState = (state: string): HandoffCheckState =>
  state === 'success' ? 'passed' : state === 'pending' ? 'running' : 'failed';

/** The checks on the pull request's latest commit: each check's latest run, and the commit statuses beside them. */
export function checksOf(runs: readonly GhCheckRun[], statuses: readonly GhCommitStatus[]): HandoffCheck[] {
  const latest = new Map<string, GhCheckRun>();
  for (const r of runs) if ((latest.get(r.name)?.id ?? -1) < r.id) latest.set(r.name, r);
  const latestStatus = new Map<string, GhCommitStatus>();
  for (const s of statuses)
    if ((latestStatus.get(s.context)?.id ?? -1) < s.id) latestStatus.set(s.context, s);
  return [
    ...[...latest.values()].map((r) => ({
      name: cut(r.name, 200),
      state: runState(r.status, r.conclusion),
      url: r.url,
    })),
    ...[...latestStatus.values()]
      .filter((s) => !latest.has(s.context))
      .map((s) => ({ name: cut(s.context, 200), state: statusState(s.state), url: s.url })),
  ].slice(0, HANDOFF_CHECKS_MAX);
}

/**
 * The progress after GitHub was read: the changes and checks, the track at `checks` once there are any (and `merged`
 * once it merged), and the fix attempts — every new commit after a check failed is one.
 */
export function githubProgress(
  p: T3Progress,
  read: { pr: GhPullRequest; files: readonly GhFile[] | null; checks: HandoffCheck[] },
  now: Date,
): T3Progress {
  const at = now.toISOString();
  const head = read.pr.headSha || null;
  const changes = read.files ? changesOf(read.pr, read.files) : (p.github?.changes ?? null);
  let next: T3Progress = { ...p, github: { at, head, changes, checks: read.checks } };
  if (p.pullRequest)
    next.pullRequest = {
      ...p.pullRequest,
      state: read.pr.merged
        ? 'merged'
        : read.pr.state === 'closed'
          ? 'closed'
          : read.pr.draft
            ? 'draft'
            : 'open',
    };
  if (read.checks.length) next = advance(next, 'checks', at);
  if (read.pr.merged) next = advance(next, 'merged', at);
  const failed = read.checks.find((c) => c.state === 'failed');
  if (p.failing && head && head !== p.failing.head)
    next = { ...next, attempts: p.attempts + 1, failing: failed ? { name: failed.name, head } : null };
  else if (!p.failing && failed && head) next = { ...next, failing: { name: failed.name, head } };
  else if (p.failing && !failed && read.checks.every((c) => c.state !== 'running' && c.state !== 'queued'))
    next = { ...next, failing: null };
  return next;
}

/** Whether GitHub is due to be read for the job: it has a pull request, and the last read is a minute old. */
export function githubDue(p: T3Progress, now: Date): boolean {
  if (!p.pullRequest || p.pullRequest.state === 'merged' || p.pullRequest.state === 'closed') return false;
  const at = p.github ? Date.parse(p.github.at) : Number.NaN;
  return !Number.isFinite(at) || now.getTime() - at >= GITHUB_EVERY_MS;
}

/* The question and the receipt ---------------------------------------------------------------------------------------- */

/** The first question of a request T3 Code waits on, as the job shows it. */
export function questionOf(request: T3Request | null): HandoffQuestion | null {
  const q = request?.questions[0];
  if (!request || !q) return null;
  return {
    requestId: request.requestId.slice(0, 2000),
    questionId: q.id.slice(0, 200),
    text: cut(q.question, 300),
    options: q.options.slice(0, 10).map((o) => ({
      label: cut(o.label, 200),
      description: o.description ? cut(o.description, 300) : null,
    })),
    multiSelect: q.multiSelect,
  };
}

/** The first sentence of the job's last answer, without its markdown. */
export function summaryOf(answer: string | null): string | null {
  if (!answer) return null;
  const plain = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return cut(sentence, 300);
}

/**
 * The job's last answer is read this long (`fitAnswer` keeps the start and the end of a longer one), so the start the
 * thread keeps is the answer's own.
 */
export const JOB_ANSWER_READ_MAX = HANDOFF_ANSWER_MAX * 2;

/** The job's last answer as the thread keeps it to read: as written, its start when it is longer than the thread keeps. */
export function jobAnswerOf(answer: string | null): string | null {
  const said = answer?.trim();
  return said ? said.slice(0, HANDOFF_ANSWER_MAX) : null;
}

/** The job's receipt once its run ended: its answer's first sentence, how its tests went and how long it took. */
export function receiptOf(
  p: T3Progress,
  answer: string | null,
  startedAt: Date | null,
  endedAt: Date | null,
): HandoffReceipt {
  const from = p.stages[0] ? Date.parse(p.stages[0].startedAt) : (startedAt?.getTime() ?? Number.NaN);
  const to = endedAt?.getTime() ?? Number.NaN;
  return {
    summary: summaryOf(answer),
    tests: p.tests,
    durationMs: Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round(to - from) : null,
    screenshot: null,
  };
}

/* As the person sees it ---------------------------------------------------------------------------------------------- */

/** The progress parts of a `Handoff`. `ended`: how the job's work ended, when it did. */
export function progressParts(
  p: T3Progress,
  ended: 'completed' | 'failed' | 'stopped' | null,
): Pick<
  Handoff,
  'stage' | 'stages' | 'plan' | 'changes' | 'checks' | 'question' | 'pullRequest' | 'receipt' | 'answer'
> {
  const checks = p.github?.checks;
  return {
    stage: ended === 'failed' || ended === 'stopped' ? ended : p.stage,
    stages: p.stages,
    plan: p.plan,
    changes: p.github?.changes ?? null,
    checks: checks?.length ? { runs: checks, failing: p.failing?.name ?? null, attempts: p.attempts } : null,
    question: p.question,
    pullRequest: p.pullRequest
      ? { number: p.pullRequest.number, url: p.pullRequest.url, state: p.pullRequest.state }
      : null,
    receipt: ended ? p.receipt : null,
    // The answer of the run that ended; while a new run works there is none to read yet.
    answer: ended ? p.answer : null,
  };
}
