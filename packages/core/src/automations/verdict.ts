/**
 * Verdicts of `dispatch_agent` steps with `verdict: true` (docs/decisions/bp-automations.md BP-C27): the agent's
 * reply starts with “Approve” or “Changes needed”. Forgiving about what surrounds the words (markdown emphasis, a
 * leading quote or bullet, any case), strict about the words themselves: “Approved with changes” and “I approve”
 * are not verdicts.
 */
import { type AutomationVerdict, VERDICT_APPROVE, VERDICT_CHANGES } from '../domain/automation.js';

/** The verdict a reply starts with, or null when it starts with neither. */
export function parseVerdict(text: string): AutomationVerdict | null {
  const start = text
    .replace(/^[\s>*_#`\-–—•"“'‘]+/u, '')
    .slice(0, 40)
    .toLowerCase();
  const word = (w: string) => {
    if (!start.startsWith(w.toLowerCase())) return false;
    const next = start.charAt(w.length);
    return next === '' || !/[\p{L}\p{N}]/u.test(next);
  };
  if (word(VERDICT_CHANGES)) return 'changes_needed';
  if (word(VERDICT_APPROVE)) return 'approve';
  return null;
}
