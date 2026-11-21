/**
 * Small signs that an agent is at work, on the phone (docs/decisions/card-settle.md AP-734, AP-735): a thread's reply
 * row in a channel says who works in it and how far along (`Banjo is working · 38%`, `Banjo needs you`, `Banjo is
 * thinking`). The rule is the shared `threadWork`; this adds the agent's name and face. Pure, unit-tested.
 */
import { agentNowFor, T3_CODE_NAME, threadWork, workingLabel } from '@whombat/client';
import type { AgentNowEntry, TypingEntry } from '@whombat/client/query';
import type { Handoff, Principal, Run } from '@whombat/core';
import type { People } from './people';

/** What a thread's reply row shows about work in it. */
export interface ThreadWorkView {
  agent: Principal | undefined;
  name: string;
  /** `is working · 38%`, `needs you`, `is thinking`: after the name. */
  text: string;
  /** The small bar's width (0–100) for a live run; null without one. */
  progress: number | null;
  /** `calm`: T3 Code waits for checks, nothing to do (t3code-handoff.md AP-6611). */
  tone: 'live' | 'warn' | 'calm';
  /** Work the agent handed to T3 Code: its mark and name in place of the agent's (AP-6611). */
  by?: 't3code';
  /** The clock's start (`· 6m`) for work handed over. */
  since?: number | null;
  /** The whole line in place of the name and `text` (Chat's “Looking into it”, AP-2458), and what TalkBack hears. */
  line?: string;
  spoken?: string;
}

export function threadWorkView(
  rootId: string,
  runs: readonly Pick<Run, 'agentId' | 'status' | 'progress' | 'attention' | 'threadRootId'>[],
  typing: readonly Pick<TypingEntry, 'principalId' | 'threadRootId'>[],
  people: People,
  handoffs: readonly Handoff[] = [],
): ThreadWorkView | null {
  const work = threadWork(rootId, runs, typing, handoffs);
  if (!work) return null;
  return {
    agent: people.get(work.agentId),
    name: work.by === 't3code' ? T3_CODE_NAME : people.name(work.agentId),
    text: work.text,
    progress: work.progress,
    tone: work.tone,
    ...(work.by ? { by: work.by, since: work.since ?? null } : {}),
  };
}

/** Typing entries still showing at `nowMs` (each expires unless refreshed, contracts TYPING_TTL_MS). */
export function liveTyping<T extends Pick<TypingEntry, 'expiresAt'>>(
  entries: readonly T[],
  nowMs: number,
): T[] {
  return entries.filter((e) => e.expiresAt > nowMs);
}

/**
 * The thinking row's words (AP-734): `Banjo · Editing format.ts · 1m 12s` from the agent's latest action in this
 * conversation and thread, `Banjo is thinking` without a recent one; `spoken` leaves out the ticking clock, so TalkBack
 * doesn't announce the row every second. `ticks`: whether it needs a clock each second. Nobody else types here (one
 * person per Whombat, one-person-android.md AP-5731).
 */
export function thinkingLabels(
  name: string,
  agentNow: readonly AgentNowEntry[],
  principalId: string,
  threadRootId: string | null,
  nowMs: number,
): { label: string; spoken: string; ticks: boolean } {
  const ticks = agentNow.some((e) => e.principalId === principalId && e.threadRootId === threadRootId);
  const entry = agentNowFor(agentNow, principalId, threadRootId, nowMs);
  return {
    label: workingLabel(name, entry, nowMs),
    spoken: workingLabel(name, entry, entry?.since ?? nowMs),
    ticks,
  };
}
