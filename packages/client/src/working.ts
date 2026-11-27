/**
 * Small signs that an agent is at work (docs/decisions/card-settle.md AP-734, AP-735): what it is doing beside
 * “{name} is thinking”, and a thread's reply row saying who works in it and how far along. Shared by web and mobile.
 * Pure, no DOM and no React Native.
 */
import type { Handoff, Run } from '@whombat/core';
import { formatDuration, typingLabel } from '@whombat/core/text';
import { ANSWERING_T3_CODE, handoffRow } from './handoff';
import { clientTranslator } from './i18n/catalog';
import type { AgentNowEntry, TypingEntry } from './query/keys';

/** An action older than this no longer says what the agent does now (a quiet tool, a long model call). */
export const AGENT_NOW_STALE_MS = 3 * 60_000;

/** The elapsed time shows from this long on: a quick answer doesn't need a clock. */
export const AGENT_NOW_CLOCK_FROM_MS = 10_000;

/** The agent's latest action in this conversation and thread, when it is recent enough to say what it does now. */
export function agentNowFor(
  entries: readonly AgentNowEntry[],
  principalId: string,
  threadRootId: string | null,
  nowMs: number,
): AgentNowEntry | null {
  const entry = entries.find((e) => e.principalId === principalId && e.threadRootId === threadRootId);
  return entry && nowMs - entry.at <= AGENT_NOW_STALE_MS ? entry : null;
}

/**
 * The thinking line: `Banjo · Editing Layout.astro · 1m 12s` while its turn reports actions (the clock from 10 s on),
 * else `Banjo is thinking`.
 */
export function workingLabel(name: string, now: AgentNowEntry | null, nowMs: number): string {
  const title = now?.title.trim();
  if (!now || !title) return typingLabel(name);
  const elapsed = nowMs - now.since;
  return elapsed >= AGENT_NOW_CLOCK_FROM_MS
    ? `${name} · ${title} · ${formatDuration(elapsed)}`
    : `${name} · ${title}`;
}

/** What a thread's reply row says about work in it (AP-735). */
export interface ThreadWork {
  agentId: string;
  /** `is working · 38%`, `is thinking`, `needs you`: after the agent's name (or T3 Code's, `by`). */
  text: string;
  /** The bar's width (0–100) for a live run; null without one. */
  progress: number | null;
  /** `calm`: work elsewhere that waits for nothing the person does (T3 Code waiting for checks). */
  tone: 'live' | 'warn' | 'calm';
  /** Work the agent handed to T3 Code (app t3code-handoff.md AP-6611): its mark and name in place of the agent's. */
  by?: 't3code';
  /** The clock's start (`· 6m` after the words), for work handed over; absent without one. */
  since?: number | null;
}

/**
 * Work in the thread under `rootId`: a live run whose card is in it (`Run.threadRootId`, contracts CT-261) — the one
 * that needs a person first, else the most advanced — or else an agent thinking there (“is answering T3 Code” while a
 * question of T3 Code's waits), or else work the agent handed to T3 Code from it (`handoffs`, the thread's own, shown
 * ones: `threadHandoffs`).
 */
export function threadWork(
  rootId: string,
  runs: readonly Pick<Run, 'agentId' | 'status' | 'progress' | 'attention' | 'threadRootId'>[],
  typing: readonly Pick<TypingEntry, 'principalId' | 'threadRootId'>[],
  handoffs: readonly Handoff[] = [],
  locale?: string | null,
): ThreadWork | null {
  const tr = clientTranslator(locale);
  const live = runs.filter((r) => r.status === 'live' && r.threadRootId === rootId);
  const stuck = live.find((r) => r.attention?.trim());
  if (stuck) return { agentId: stuck.agentId, text: tr.t('working.needsYou'), progress: null, tone: 'warn' };
  const run = [...live].sort((a, b) => b.progress - a.progress)[0];
  if (run)
    return {
      agentId: run.agentId,
      text: tr.t('working.isWorking', { pct: Math.round(run.progress) }),
      progress: run.progress,
      tone: 'live',
    };
  const thinking = typing.find((t) => t.threadRootId === rootId);
  if (thinking) {
    const answering = handoffs.some((h) => h.state === 'asked' && h.agentId === thinking.principalId);
    return {
      agentId: thinking.principalId,
      text: answering
        ? locale
          ? tr.t('working.answeringT3')
          : ANSWERING_T3_CODE
        : tr.t('working.isThinking'),
      progress: null,
      tone: 'live',
    };
  }
  const handed = handoffRow(handoffs);
  const by = handoffs[0];
  if (!handed || !by) return null;
  return {
    agentId: by.agentId,
    text: handed.text,
    progress: null,
    tone: handed.tone,
    by: 't3code',
    since: handed.since,
  };
}
