/** Where each card's links go (burrow-less app paths from `appPath()`, AP-364; ARCHITECTURE "Web app"). */

import { appPath } from '@whombat/client';
import type { AnswerCard, Plan, Receipt, Run } from '@whombat/core/domain';

/** "Open plan canvas" → `/canvases/:slug`; null when the plan has no canvas. */
export function planCanvasHref(plan: Plan): string | null {
  return plan.canvasSlug ? appPath({ type: 'canvas', slug: plan.canvasSlug }) : null;
}

/** "Watch run" → `/runs/:number`. */
export function runHref(run: Run): string {
  return appPath({ type: 'run', number: run.number });
}

/** "Branch room" → `/pr/:number`; null for runs without a pull request. */
export function runBranchHref(run: Run): string | null {
  return run.prNumber === null ? null : appPath({ type: 'pr', number: run.prNumber });
}

/** "Open in search" → `/search?q=…`; null when the answer did not come from a search. */
export function answerSearchHref(card: AnswerCard): string | null {
  return card.query ? appPath({ type: 'search', q: card.query }) : null;
}

/** Receipts that always open their own object rather than the search they came from. */
const EXACT_RECEIPTS = new Set(['plan', 'approval', 'automation_run']);

/**
 * A receipt row. An answer that came from a search opens that search (as in the mock, where every
 * receipt goes to the Search screen with the query and the cited result is marked "receipt n");
 * otherwise the receipt deep-links to its source; a receipt without a link searches for its source.
 */
export function receiptHref(card: AnswerCard, receipt: Receipt): string {
  // A decision, a plan step or an automation outcome opens itself, even from a search answer (WS-25).
  if (receipt.link && EXACT_RECEIPTS.has(receipt.link.type)) return appPath(receipt.link);
  if (card.query) return appPath({ type: 'search', q: card.query });
  if (receipt.link) return appPath(receipt.link);
  return appPath({ type: 'search', q: receipt.source });
}
