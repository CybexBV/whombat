/**
 * How a finished round of a pull request's checks reads, for people: which pull request and
 * whether they passed, naming only the checks that failed. Commits, counts and test totals stay on the pull request's
 * page and in the agent's brief.
 */
import type { CheckState } from '@whombat/core';

type NamedCheck = { name: string; state: CheckState };

/** Failing checks named; more are counted (“and 2 more”). */
const NAMED_FAILURES = 3;

/** “build”, “lint and unit”, “lint, unit, e2e and 2 more”; empty when nothing failed. */
export function failedNames(checks: readonly NamedCheck[]): string {
  const failed = checks.filter((c) => c.state === 'failed').map((c) => c.name);
  if (failed.length <= 1) return failed[0] ?? '';
  if (failed.length > NAMED_FAILURES)
    return `${failed.slice(0, NAMED_FAILURES).join(', ')} and ${failed.length - NAMED_FAILURES} more`;
  return `${failed.slice(0, -1).join(', ')} and ${failed.at(-1)}`;
}

/** “PR #1”, linked when its address is known. */
export function prMention(prNumber: number, url: string | null = null): string {
  return url ? `[PR #${prNumber}](${url})` : `PR #${prNumber}`;
}

/**
 * The round's result in one line: “The checks on PR #1 failed (build).”, “The checks on PR #1 passed.” Checks that
 * were skipped don't count as failing.
 */
export function checksResultLine(p: {
  prNumber: number;
  url?: string | null;
  checks: readonly NamedCheck[];
}): string {
  const pr = prMention(p.prNumber, p.url ?? null);
  const failed = failedNames(p.checks);
  return failed ? `The checks on ${pr} failed (${failed}).` : `The checks on ${pr} passed.`;
}

/** “3 passed, 1 failed (build)”, “1 passed, 4 failed (lint, unit, e2e and 1 more), 1 skipped”: the agent's detail. */
export function checksOutcome(checks: readonly NamedCheck[]): string {
  const failed = checks.filter((c) => c.state === 'failed');
  const passed = checks.filter((c) => c.state === 'passed').length;
  const skipped = checks.filter((c) => c.state === 'skipped').length;
  return [
    passed ? `${passed} passed` : '',
    failed.length ? `${failed.length} failed (${failedNames(checks)})` : '',
    skipped ? `${skipped} skipped` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The activity line of a finished round: “Checks failed on PR #483 (unit).”, “Checks passed on PR #482.” */
export function checksActivityLine(prNumber: number, checks: readonly NamedCheck[]): string {
  const failed = failedNames(checks);
  return failed ? `Checks failed on PR #${prNumber} (${failed}).` : `Checks passed on PR #${prNumber}.`;
}
