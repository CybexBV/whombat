/**
 * Which pane and modal the URL asks for. Panes: `?thread=`, `?plan=&step=`, `?plans=1` or `?pins=1` on a branch room, a
 * task chat, Chat and Feedback, and `?settled=1` (the settled threads) on Chat and Feedback. Modal:
 * `?approval=<n>` anywhere in a burrow. The branch room's own side pane is part of that screen, not the shell's.
 */
import type { ShellLocation } from './location';

export type PaneState =
  /** `focus`: the thread full width instead of the conversation (`&focus=1`, ui-improvements.md AP-304). */
  | { kind: 'thread'; threadId: string; focus: boolean; room?: 'chat' | 'feedback' }
  | { kind: 'plan'; planId: string; stepId?: string }
  | { kind: 'plans' }
  /** The conversation's pinned messages (`?pins=1`, essentials-messages.md AP-445). */
  | { kind: 'pins' }
  /** A room's settled threads (`?settled=1` on Chat or Feedback; chat-settle.md). */
  | { kind: 'settled'; room: 'chat' | 'feedback' }
  | null;
export type ModalState = { kind: 'approval'; number: number } | null;

const flagged = (v: unknown) => v === true || v === 1 || v === '1';

type Search = Record<string, unknown>;

export function paneFor(location: ShellLocation, search: Search): PaneState {
  if (
    location.kind === 'pr' ||
    // A task chat's threads: website feedback lands there as a report with its thread (feedback-chat.md AP-1833).
    location.kind === 'chat' ||
    // Chat and Feedback: every thread opens full width over its room (chat-channel.md AP-2404, AP-2415).
    location.kind === 'room'
  ) {
    // The plan pane (WS-09); it wins over a thread (`validateConversationSearch` keeps only one).
    const plan = search.plan;
    if (typeof plan === 'string' && plan) {
      const step = search.step;
      return typeof step === 'string' && step
        ? { kind: 'plan', planId: plan, stepId: step }
        : { kind: 'plan', planId: plan };
    }
    if (flagged(search.plans)) return { kind: 'plans' };
    if (flagged(search.pins)) return { kind: 'pins' };
    if (location.kind === 'room' && flagged(search.settled)) return { kind: 'settled', room: location.room };
    const thread = search.thread;
    if (typeof thread === 'string' && thread) {
      const focus = search.focus;
      // A thread of Chat or Feedback is always full width; it has no split view (AP-2415).
      if (location.kind === 'room')
        return { kind: 'thread', threadId: thread, focus: true, room: location.room };
      return { kind: 'thread', threadId: thread, focus: focus === true || focus === 1 || focus === '1' };
    }
  }
  return null;
}

export function modalFor(search: Search): ModalState {
  const approval = Number(search.approval);
  if (Number.isInteger(approval) && approval > 0) return { kind: 'approval', number: approval };
  return null;
}
