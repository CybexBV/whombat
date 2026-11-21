/**
 * What a council member's answer says in Whombat's fixed lines (docs/decisions/council.md CNL-11): `Score: n/10` and
 * `Verdict: agree` or `Verdict: changes needed`. Pure. The last such line counts (a member may quote the format earlier);
 * none is no score, never a guess.
 */
import type { CouncilVerdict } from '@whombat/core';

const SCORE = /^[\s>*_#-]*score[\s*_]*[:=]\s*\**\s*(\d{1,2}(?:[.,]\d+)?)\s*\**\s*(?:\/|out of)\s*10\b/gim;
const VERDICT =
  /^[\s>*_#-]*verdict[\s*_]*[:=]\s*\**\s*(agree[sd]?|approved?|lgtm|changes(?:\s+(?:needed|requested))?|needs?\s+changes|disagree[sd]?|must[-\s]fix)\b/gim;

/** The score in halves from 0 to 10, or null. */
export function scoreOf(answer: string): number | null {
  const found = [...answer.matchAll(SCORE)].at(-1)?.[1];
  if (!found) return null;
  const n = Number(found.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10) return null;
  return Math.round(n * 2) / 2;
}

/** `agree`, `changes`, or null when the answer says neither. */
export function verdictOf(answer: string): CouncilVerdict | null {
  const found = [...answer.matchAll(VERDICT)].at(-1)?.[1]?.toLowerCase();
  if (!found) return null;
  return /^(agree|approve|lgtm)/.test(found) ? 'agree' : 'changes';
}
