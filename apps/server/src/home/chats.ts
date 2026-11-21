/**
 * Chats with the assistant on Home (docs/decisions/home-redesign.md HR-21, HR-40…HR-42; contracts CT-403): which of a
 * person's chats with their assistant show, in what state and order. Pure: `overview.ts` gathers the signals (the
 * chats `chats.list` reads, the assistant's turns, its plans, what Needs you shows for each chat) and this orders them.
 *
 * - `working`: a turn of the assistant is claimed or running in the chat (its status `working`, agent-status.md AS-03),
 *   newest turn first; then the chat of its newest unfinished plan (the old `working`, Working on), unless that chat
 *   waits for the person. Progress and the current step come from the chat's newest unfinished plan, when it has one.
 * - `waiting`: Needs you shows something of the chat for this person (an approval they may decide, a question of the
 *   assistant they haven't answered), newest first. A snoozed or ignored item doesn't make its chat wait.
 * - `recent`: the others, newest activity first.
 *
 * `at`: when the state began: the turn's start or the plan's last change, the newest ask, the chat's last message.
 */
import { HOME_CHATS_MAX, type HomeChat, type WorkingStep } from '@whombat/core';
import type { StoredPlanStep } from '../db/schema/index';

export { HOME_CHATS_MAX, type HomeChat };

const TITLE_MAX = 160;
const STEP_MAX = 160;

/** A chat as `chats.list` has it. */
export interface ChatLine {
  id: string;
  title: string;
  lastAt: Date;
  default: boolean;
}

/** A plan's progress and the step it is at. */
export interface PlanProgress {
  done: number;
  total: number;
  step?: string;
}

export interface ChatSignals {
  /** The chats a turn of the assistant is claimed or running in, with when it started. */
  turns: ReadonlyMap<string, Date>;
  /** The chat of the assistant's newest unfinished plan (Working on), and when that plan last changed. */
  planChat: { conversationId: string; at: Date } | null;
  /** Each chat's newest unfinished plan. */
  progress: ReadonlyMap<string, PlanProgress>;
  /** The chats Needs you shows something of for the person, with the newest item's time. */
  waiting: ReadonlyMap<string, Date>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Whether a plan still has steps to do (not every step done or cancelled). */
export function planIsOpen(steps: readonly Pick<StoredPlanStep, 'state'>[]): boolean {
  return steps.some((s) => s.state !== 'done' && s.state !== 'cancelled');
}

/** A plan's steps as Working on shows them: cancelled ones left out, `queued` to do, `gate` and `blocked` waiting. */
export function workingStepsOf(
  steps: readonly Pick<StoredPlanStep, 'title' | 'note' | 'state'>[],
): WorkingStep[] {
  return steps
    .filter((s) => s.state !== 'cancelled')
    .slice(0, 50)
    .map((s) => ({
      title: clip(s.title, 160),
      ...(s.note ? { detail: clip(s.note, 300) } : {}),
      state:
        s.state === 'done'
          ? ('done' as const)
          : s.state === 'active'
            ? ('active' as const)
            : s.state === 'queued'
              ? ('todo' as const)
              : ('waiting' as const),
    }));
}

/** How far a plan is: steps done of its steps, and the step it is at (the active one, else the first not done). */
export function planProgress(
  steps: readonly Pick<StoredPlanStep, 'title' | 'note' | 'state'>[],
): PlanProgress {
  const shown = workingStepsOf(steps);
  const current = shown.find((s) => s.state === 'active') ?? shown.find((s) => s.state !== 'done');
  return {
    done: shown.filter((s) => s.state === 'done').length,
    total: shown.length,
    ...(current ? { step: clip(current.title, STEP_MAX) } : {}),
  };
}

/** Home's chats with the assistant: working, then waiting, then the newest others; at most `max`. */
export function homeChats(
  chats: readonly ChatLine[],
  signals: ChatSignals,
  max = HOME_CHATS_MAX,
): HomeChat[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const out: HomeChat[] = [];
  const taken = new Set<string>();
  const add = (chat: ChatLine, state: HomeChat['state'], at: Date) => {
    taken.add(chat.id);
    const progress = state === 'working' ? signals.progress.get(chat.id) : undefined;
    out.push({
      conversationId: chat.id,
      title: clip(chat.title.trim() || 'New chat', TITLE_MAX),
      state,
      at: at.toISOString(),
      ...(progress ? { progress: { done: progress.done, total: progress.total } } : {}),
      ...(progress?.step ? { step: progress.step } : {}),
      ...(chat.default ? { default: true } : {}),
    });
  };
  const newestFirst = (m: ReadonlyMap<string, Date>) =>
    [...m.entries()].sort((a, b) => b[1].getTime() - a[1].getTime() || a[0].localeCompare(b[0]));

  for (const [id, at] of newestFirst(signals.turns)) {
    const chat = byId.get(id);
    if (chat) add(chat, 'working', at);
  }
  const plan = signals.planChat;
  const planLine = plan ? byId.get(plan.conversationId) : undefined;
  if (plan && planLine && !taken.has(planLine.id) && !signals.waiting.has(planLine.id))
    add(planLine, 'working', plan.at);
  for (const [id, at] of newestFirst(signals.waiting)) {
    const chat = byId.get(id);
    if (chat && !taken.has(id)) add(chat, 'waiting', at);
  }
  const rest = chats
    .filter((c) => !taken.has(c.id))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.lastAt.getTime() - a.c.lastAt.getTime() || a.i - b.i);
  for (const { c } of rest) {
    if (out.length >= max) break;
    add(c, 'recent', c.lastAt);
  }
  return out.slice(0, max);
}
