/**
 * What the person sees of work the agent handed to T3 Code (docs/decisions/t3code.md T3-24…T3-28): a watch's thread
 * as a `Handoff` for the Whombat thread it was handed over from, and T3 Code's latest items as steps in plain words.
 * Pure: T3 Code's answers and the watch's row in, words out.
 */
import { HANDOFF_STEPS_MAX, type Handoff, type HandoffOutcome, type HandoffStep } from '@whombat/core';
import { AT_WORK, FINISHED, type T3Status } from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';
import { commandOf, progressOf, progressParts, shellWriteOf } from './progress';

/** Ended work shows this long at most, until the agent answered after it. */
export const HANDOFF_ENDED_SHOWN_MS = 30 * 60_000;
/** A job that ended with a receipt is listed this long, so its job view keeps it (t3code.md T3-40). */
export const HANDOFF_RECEIPT_SHOWN_MS = 7 * 86_400_000;

const TEXT_MAX = 120;
const DETAIL_MAX = 200;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const baseName = (path: string) => path.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? path.trim();

/** A command's plain words, from what it runs. */
function commandWords(command: string): string {
  const c = command.toLowerCase();
  if (/\bgh\s+pr\s+create\b/.test(c)) return 'Opening a pull request';
  if (/\bgit\s+push\b/.test(c)) return 'Pushing the changes to GitHub';
  if (/\bgit\s+commit\b/.test(c)) return 'Saving the changes';
  if (/\b(vitest|jest|pytest|playwright|mocha)\b|\b(test|tests|e2e)\b|\bcargo\s+test\b|\bgo\s+test\b/.test(c))
    return 'Running the tests';
  if (/\b(tsc|typecheck|biome|eslint|lint|check)\b/.test(c)) return 'Checking the code';
  if (/\b(build|compile|make)\b/.test(c)) return 'Building it';
  if (/\b(install|add)\b/.test(c) && /\b(pnpm|npm|yarn|pip|cargo|bun|apt)\b/.test(c))
    return 'Installing what it needs';
  if (
    /^(\s*(cd\s+\S+\s*&&\s*)?)(rg|grep|find|ls|cat|sed|head|tail|wc|git\s+(log|show|diff|status|grep))\b/.test(
      c,
    )
  )
    return 'Reading the code';
  return 'Running a command';
}

/** A tool's plain words, from T3 Code's `dynamic_tool` item (its text is the call as JSON). */
function toolWords(text: string): string {
  const name = /"toolName"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
  if (/question/i.test(name)) return 'Asking a question';
  if (/^(task|agent|subagent)/i.test(name)) return 'Handing part of it to a helper';
  if (/web|fetch|search/i.test(name)) return 'Looking on the web';
  if (/todo|plan/i.test(name)) return 'Planning the work';
  if (/^(read|grep|glob|ls|view)/i.test(name)) return 'Reading the code';
  if (/^(edit|write|multiedit|patch)/i.test(name)) return 'Changing the code';
  return 'Using a tool';
}

/** A step as the watch keeps it: with T3 Code's item id, so the next read updates it in place. */
export interface StoredStep extends HandoffStep {
  id: string;
}

/** One of T3 Code's items as a step; null for what isn't one (the person's message, a question it waits on). */
function stepOf(item: Record<string, unknown>): StoredStep | null {
  const type = str(item.type);
  const text = str(item.text)?.trim() ?? '';
  const title = str(item.title)?.trim() || null;
  const id = str(item.itemId) ?? (typeof item.position === 'number' ? `#${item.position}` : null);
  if (!id) return null;
  const done = str(item.status) !== 'running' && str(item.status) !== 'waiting';
  const step = (words: string, detail: string | null): StoredStep => ({
    id: id.slice(0, 400),
    text: cut(words, TEXT_MAX),
    detail: detail ? cut(detail, DETAIL_MAX) : null,
    done,
  });
  switch (type) {
    case 'command_execution': {
      const command =
        text
          .split('\n')[0]
          ?.replace(/^\$\s*/, '')
          .trim() ?? '';
      if (/^preparing workspace$/i.test(command) || /^workspace ready$/i.test(title ?? ''))
        return step('Getting the workspace ready', null);
      // What runs, without the shell Codex wraps it in; a file written from the shell is a change like any other.
      const run = commandOf(text);
      const file = shellWriteOf(run);
      if (file !== null)
        return step(file ? `Changing ${cut(baseName(file), 80)}` : 'Changing the code', command || title);
      return step(commandWords(run), command || title);
    }
    case 'file_change': {
      const file = text.split('\n')[0]?.trim();
      return step(file ? `Changing ${cut(baseName(file), 80)}` : 'Changing a file', null);
    }
    case 'dynamic_tool':
    case 'mcp_tool_call':
      return step(toolWords(text), title);
    case 'reasoning':
      return step('Thinking it through', null);
    case 'plan':
    case 'todo_list':
      return step('Planning the work', null);
    case 'web_search':
      return step('Looking on the web', title);
    case 'subagent':
      return step('Handing part of it to a helper', title);
    case 'assistant_message':
      return step('Writing its answer', null);
    case 'image_view':
      return step('Looking at an image', null);
    case 'context_compaction':
      return step('Tidying up its notes', null);
    default:
      return null;
  }
}

/** How many steps a watch keeps. */
const KEPT_STEPS = 12;

/**
 * The watch's steps after a `t3_thread_read` (activity view): the items it read update the steps it had (by T3 Code's
 * item id) or follow them, the latest `KEPT_STEPS` kept.
 */
export function mergeSteps(kept: unknown, body: unknown): StoredStep[] {
  const steps = keptSteps(kept);
  for (const s of list(rec(body).items).map(rec).map(stepOf)) {
    if (!s) continue;
    const at = steps.findIndex((k) => k.id === s.id);
    if (at >= 0) steps[at] = s;
    else steps.push(s);
  }
  return steps.slice(-KEPT_STEPS);
}

function keptSteps(v: unknown): StoredStep[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s): StoredStep[] => {
    const r = rec(s);
    const id = str(r.id);
    const text = str(r.text);
    return id && text ? [{ id, text, detail: str(r.detail) ?? null, done: r.done === true }] : [];
  });
}

/** The steps shown: the same words in a row once (five reads are one “Reading the code”), the latest few. */
export function shownSteps(kept: unknown): HandoffStep[] {
  const steps: HandoffStep[] = [];
  for (const { text, detail, done } of keptSteps(kept)) {
    const last = steps.at(-1);
    const step = { text, detail, done };
    if (last && last.text === text) steps[steps.length - 1] = step;
    else steps.push(step);
  }
  return steps.slice(-HANDOFF_STEPS_MAX);
}

/** `Codex · gpt-5.5` from the thread's AI program and model. */
export function programOf(body: unknown): string | null {
  const t = rec(rec(body).thread);
  const instance = str(t.providerInstanceId);
  const model = str(t.model);
  const names: Record<string, string> = {
    claudeAgent: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
  };
  const program = instance ? (names[instance] ?? instance) : null;
  return [program, model].filter(Boolean).join(' · ').slice(0, 80) || null;
}

/** When the thread's latest run ended, as T3 Code says. */
export function runEndedOf(body: unknown): Date | null {
  const v = str(rec(list(rec(body).recentRuns)[0]).completedAt);
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}

/** How a thread's run ended, as the person sees it. */
export const outcomeOf = (status: T3Status): HandoffOutcome =>
  status === 'failed' || status === 'rolled_back'
    ? 'failed'
    : status === 'interrupted' || status === 'cancelled'
      ? 'stopped'
      : 'completed';

/** The parts of a watch's row a hand-over is made of. */
export interface HandoffRow {
  threadId: string;
  title: string;
  conversationId: string;
  threadRootId: string | null;
  agentId: string;
  state: 'watching' | 'idle';
  armedAt: Date;
  status: string | null;
  pending: string | null;
  asks: string | null;
  steps: unknown;
  program: string | null;
  url: string | null;
  prs: unknown;
  runStartedAt: Date | null;
  runEndedAt: Date | null;
  /** The job's progress (`progress.ts`); null on a row from before it. */
  progress?: unknown;
  /** The job's result message in the thread, once Whombat posted one. */
  resultMessageId?: string | null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];

/**
 * A watch as the person sees it, or null when there is nothing to show: a watched thread is at work (`working`,
 * `finishing`), asks the agent (`asked`), waits for the person's OK (`needs_ok`), waits for a pull request's checks
 * (`checks`) or has just ended (`ended`, also once the watch went quiet, for `HANDOFF_ENDED_SHOWN_MS`). A watch that went
 * quiet any other way (the agent stopped it, a week without work) shows nothing.
 */
export function handoffOf(row: HandoffRow, now: Date): Handoff | null {
  const status = row.status as T3Status | null;
  const finished = !!status && (FINISHED.includes(status) || status === 'idle');
  const prs = strings(row.prs).slice(0, 5);
  const progress = progressOf(row.progress);
  const base = {
    id: row.threadId,
    to: 't3code' as const,
    conversationId: row.conversationId,
    rootId: row.threadRootId,
    agentId: row.agentId,
    title: row.title.slice(0, 160) || 'A T3 Code thread',
    since: (row.runStartedAt ?? row.armedAt).toISOString(),
    endedAt: null,
    outcome: null,
    steps: shownSteps(row.steps),
    asks: row.asks?.slice(0, 300) ?? null,
    pullRequests: [] as string[],
    program: row.program,
    url: row.url,
    ...progressParts(progress, null),
    // The question shows only while T3 Code waits on it.
    question: row.pending === 'question' ? progress.question : null,
    resultMessageId: row.resultMessageId ?? null,
  };
  const ended = (): Handoff | null =>
    status && finished
      ? {
          ...base,
          ...progressParts(progress, outcomeOf(status)),
          question: null,
          state: 'ended',
          endedAt: (row.runEndedAt ?? now).toISOString(),
          outcome: outcomeOf(status),
          asks: null,
        }
      : null;
  if (row.state === 'idle') {
    const at = row.runEndedAt?.getTime();
    const shown = progress.receipt ? HANDOFF_RECEIPT_SHOWN_MS : HANDOFF_ENDED_SHOWN_MS;
    if (at === undefined || now.getTime() - at > shown) return null;
    return ended();
  }
  // Just handed over, not read yet: at work.
  if (!status) return { ...base, state: 'working', asks: null };
  if (finished) {
    // Its run ended, but work it waits for still goes on (delegated work, a command it waits for): not over yet.
    if (progress.held) return { ...base, state: 'finishing', asks: null };
    if (prs.length)
      return {
        ...base,
        state: 'checks',
        endedAt: row.runEndedAt?.toISOString() ?? null,
        pullRequests: prs,
        asks: null,
      };
    return ended();
  }
  if (row.pending === 'approval') return { ...base, state: 'needs_ok' };
  if (row.pending === 'question') return { ...base, state: 'asked' };
  if (status === 'waiting') return { ...base, state: 'finishing', asks: null };
  return AT_WORK.includes(status) ? { ...base, state: 'working', asks: null } : null;
}

/**
 * How a watch's job ended, for its Whombat thread's row (`ChatThread.job`): its outcome and when, once T3 Code said its
 * run is over and nothing it waits for goes on (no pull request's checks, no work it is still finishing). Null while it
 * is at work, waits, or before T3 Code said.
 */
export function jobEndOf(
  row: Pick<HandoffRow, 'state' | 'status' | 'prs' | 'progress' | 'runEndedAt'>,
): { outcome: HandoffOutcome; endedAt: Date } | null {
  const status = row.status as T3Status | null;
  if (!status || !(FINISHED.includes(status) || status === 'idle') || !row.runEndedAt) return null;
  if (row.state === 'watching' && (progressOf(row.progress).held || strings(row.prs).length)) return null;
  return { outcome: outcomeOf(status), endedAt: row.runEndedAt };
}
