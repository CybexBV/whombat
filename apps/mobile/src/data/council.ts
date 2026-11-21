/**
 * The council card on the phone (Whombat docs/decisions/council.md): what a row needs to draw it
 * whole — the shared view (`councilCardView`, so the web says the same), the plan, the pictures of what changed with the
 * message's attachment each one is, and when its ticking times next change. Pure.
 */
import {
  ApiError,
  COUNCIL_WORDS,
  type CouncilCardView,
  councilCardView,
  PROBLEM_WORDS,
  problemText,
} from '@whombat/client';
import type { Attachment, CouncilCard } from '@whombat/core';
import { nextElapsedTick, TASK_SECONDS_BELOW_MS } from '../lib/elapsed';
import { type CardPicture, cardPictures } from './cardPictures';

/** A `council` card as its row draws it. */
export interface CouncilItem {
  councilId: string;
  /** The card itself, for the times that tick while a member works (`councilCardView` again on the row's clock). */
  card: CouncilCard;
  /** The card's words at the moment the list was built. */
  view: CouncilCardView;
  /** The plan the members agreed on, folded under “The plan” on the live card and the final one; null: none. */
  plan: string | null;
  pictures: CardPicture[];
  /** A member works: its time ticks. */
  ticking: boolean;
}

export function councilItem(
  card: CouncilCard,
  attachments: readonly Attachment[],
  nowMs: number,
): CouncilItem {
  return {
    councilId: card.councilId,
    card,
    view: councilCardView(card, nowMs),
    plan: card.plan?.trim() ? card.plan : null,
    // The pictures are the final card's: those its tasks sent.
    pictures: card.live ? [] : cardPictures(card.shots, attachments, COUNCIL_WORDS.picturesHint),
    ticking: card.live && card.members.some((m) => m.state === 'working'),
  };
}

/**
 * When the card's ticking times next change (ms from `nowMs`): every second while a working member's time shows
 * seconds, else at its next whole minute; null while nobody works.
 */
export function councilNextTick(card: CouncilCard, nowMs: number): number | null {
  let next: number | null = null;
  for (const m of card.members) {
    if (m.state !== 'working' || !m.since) continue;
    const since = Date.parse(m.since);
    if (!Number.isFinite(since)) continue;
    const wait = nextElapsedTick(nowMs - since, TASK_SECONDS_BELOW_MS);
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}

/**
 * What a toast says when Stop (or a council of Settings) didn't go through: a Whombat from before the council
 * (`unknown_op`) needs an update; otherwise the server's own words or the usual sentence.
 */
export function councilActionProblem(error: unknown): string {
  if (olderWhombat(error)) return PROBLEM_WORDS.whombatUpdate;
  return problemText(error);
}

/** The box answered that it has no such operation: a Whombat from before it, which needs an update. */
export function olderWhombat(error: unknown): boolean {
  return bodyCode(error) === 'unknown_op';
}

/** The error code the box answered with: `unknown_op` isn't in the contract's list, so `ApiError.code` says `unknown`. */
function bodyCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : error.code;
}
