/**
 * The delegation card on the phone (Whombat docs/decisions/delegate.md): what a row needs to draw it whole — the shared
 * view (`delegationCardView`, so the web says the same), which tasks start after another, each task's pictures of what
 * changed and its ⋯ menu, the ticks and the AIs the person chose that the server hasn't sent back yet, the AI menu's
 * heading and model rows, and when the working tasks' times next change. Pure.
 */
import {
  type ChatModelRow,
  type DelegationAiMenuView,
  type DelegationCardView,
  type DelegationTaskView,
  delegationAiWords,
  delegationCardView,
  delegationWords,
  problemText,
  problemWords,
} from '@whombat/client';
import type { Attachment, DelegationAi, DelegationCard } from '@whombat/core';
import { nextElapsedTick, TASK_SECONDS_BELOW_MS } from '../lib/elapsed';
import { type CardPicture, cardPictures } from './cardPictures';
import { olderWhombat } from './council';
import { type NativeMenuItem, type NativeMenuSpec, plainMenu } from './nativeMenu';

/** A `delegation` card as its row draws it. */
export interface DelegationItem {
  delegationId: string;
  /** The card itself, for the ticks not sent back yet and the times that tick while a task works. */
  card: DelegationCard;
  /** The card's words at the moment the list was built. */
  view: DelegationCardView;
  /** The assistant's name, for a question it answers itself (“Asked Dusty”); null: “Asked a question”. */
  lead: string | null;
  /** Each task's pictures of what changed, by task id; a task without any has none here. */
  pictures: Readonly<Record<string, CardPicture[]>>;
  /** A task works: its time ticks. */
  ticking: boolean;
}

export function delegationItem(
  card: DelegationCard,
  attachments: readonly Attachment[],
  nowMs: number,
  lead: string | null = null,
  locale?: string,
): DelegationItem {
  const pictures: Record<string, CardPicture[]> = {};
  const hint = delegationWords(locale).picturesHint;
  for (const t of card.tasks) if (t.shots?.length) pictures[t.id] = cardPictures(t.shots, attachments, hint);
  return {
    delegationId: card.delegationId,
    card,
    view: delegationCardView(card, nowMs, lead, locale),
    lead,
    pictures,
    ticking: card.live && card.tasks.some((t) => t.state === 'working'),
  };
}

/** What a task's ⋯ menu does. */
export type DelegationTaskPick = 'open' | 'stop';

/**
 * A task's ⋯ menu, under its title: Open in T3 Code where it has a thread, then Stop this task while it works or waits
 * (the screen asks first); null when there is neither, so no ⋯ shows. `stopping`: its Stop is on its way.
 */
export function delegationTaskMenu(
  task: Pick<DelegationTaskView, 'title' | 'url' | 'stoppable'>,
  stopping = false,
  locale?: string,
): NativeMenuSpec | null {
  const words = delegationWords(locale);
  const open: NativeMenuItem[] = task.url
    ? [{ id: 'open', title: words.openThread, icon: 'arrow.up.forward.app' }]
    : [];
  const stop: NativeMenuItem[] = task.stoppable
    ? [
        {
          id: 'stop',
          title: words.stopTask,
          icon: 'stop.circle',
          destructive: true,
          disabled: stopping,
        },
      ]
    : [];
  return open.length || stop.length ? plainMenu([open, stop], task.title) : null;
}

export function parseDelegationTaskPick(id: string): DelegationTaskPick | null {
  return id === 'open' || id === 'stop' ? id : null;
}

/** “After 1” for each task on the checklist that starts after another, by task id. */
export function delegationAfter(card: DelegationCard, locale?: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const words = delegationWords(locale);
  for (const t of card.tasks) if (t.after !== null) out[t.id] = words.after(t.after);
  return out;
}

/** The ticks the person made, by task id, over the card as the server last sent it. */
export type DelegationPicks = ReadonlyMap<string, boolean>;

/** The card with the person's ticks on it, while the checklist waits: the tick shows before the server answers. */
export function withPicks(card: DelegationCard, picks: DelegationPicks): DelegationCard {
  if (!picks.size || card.stage !== 'offer') return card;
  return {
    ...card,
    tasks: card.tasks.map((t) => {
      const picked = picks.get(t.id);
      return picked === undefined || t.state !== 'offered' || picked === t.picked ? t : { ...t, picked };
    }),
  };
}

/** The ticks the card doesn't say yet: once the server sends a tick back (or the checklist is gone) it is dropped. */
export function pendingPicks(card: DelegationCard, picks: DelegationPicks): DelegationPicks {
  if (!picks.size) return picks;
  if (card.stage !== 'offer') return NO_PICKS;
  const left = new Map<string, boolean>();
  for (const [id, picked] of picks) {
    const task = card.tasks.find((t) => t.id === id);
    if (task && task.state === 'offered' && task.picked !== picked) left.set(id, picked);
  }
  return left.size === picks.size ? picks : left;
}

export const NO_PICKS: DelegationPicks = new Map();

/** The AI menu's target for every task at once (Hand over's arrow); a task's is its id. */
export const EVERY_TASK = '';

/** The AIs the person chose, by task id (`EVERY_TASK` for every task), until the server has the card that says them. */
export type DelegationAiHolds = ReadonlyMap<string, DelegationAi | null>;

export const NO_AI_HOLDS: DelegationAiHolds = new Map();

/** The card with the AIs the person chose on it, while the checklist waits: a chip shows the choice at once. */
export function withAiHolds(card: DelegationCard, holds: DelegationAiHolds): DelegationCard {
  if (!holds.size || card.stage !== 'offer') return card;
  const every = holds.get(EVERY_TASK);
  return {
    ...card,
    ...(every === undefined ? null : { ai: every }),
    tasks: card.tasks.map((t) => {
      const held = holds.get(t.id);
      return held === undefined ? t : { ...t, ai: held };
    }),
  };
}

/**
 * The AI menu's heading: “AI for task 2” over the task's title, or “AI for every task” over how many ticked tasks take
 * it (“2 of 3 use this”); and its first model, the default (“Same as the others”, or “T3 Code’s default”).
 */
export function delegationAiHeading(
  view: Pick<DelegationCardView, 'tasks' | 'aiShared' | 'picked'>,
  target: string,
  locale?: string,
): { title: string; subtitle: string | null; first: string } {
  const DELEGATION_AI_WORDS = delegationAiWords(locale);
  const task = target === EVERY_TASK ? null : view.tasks.find((t) => t.id === target);
  if (task)
    return {
      title: DELEGATION_AI_WORDS.taskTitle(task.n),
      subtitle: task.title,
      first: DELEGATION_AI_WORDS.sameAsOthers,
    };
  return {
    title: DELEGATION_AI_WORDS.allTitle,
    subtitle: view.picked ? DELEGATION_AI_WORDS.allCount(view.aiShared, view.picked) : null,
    first: DELEGATION_AI_WORDS.t3Default,
  };
}

/** The menu's models as the chat's model rows draw them: the default first (id null), then each with its company. */
export function delegationAiModelRows(menu: DelegationAiMenuView, first: string): ChatModelRow[] {
  return [
    { id: null, label: first, description: null, isDefault: false, picked: menu.selected === '' },
    ...menu.models.map((m) => ({
      id: m.key,
      label: m.label,
      description: m.provider,
      isDefault: false,
      picked: m.key === menu.selected,
    })),
  ];
}

/**
 * When the card's ticking times next change (ms from `nowMs`): every second while a working task's time shows seconds,
 * else at its next whole minute; null while nothing works.
 */
export function delegationNextTick(card: DelegationCard, nowMs: number): number | null {
  if (!card.live) return null;
  let next: number | null = null;
  for (const t of card.tasks) {
    if (t.state !== 'working' || !t.since) continue;
    const since = Date.parse(t.since);
    if (!Number.isFinite(since)) continue;
    const wait = nextElapsedTick(nowMs - since, TASK_SECONDS_BELOW_MS);
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}

/**
 * What a toast says when a press on the card didn't go through: a Whombat from before delegations (`unknown_op`) needs
 * an update; otherwise the server's own words, or the card's sentence for that press.
 */
export function delegationActionProblem(error: unknown, fallback: string, locale?: string): string {
  if (olderWhombat(error)) return problemWords(locale).whombatUpdate;
  return problemText(error, fallback, locale);
}
