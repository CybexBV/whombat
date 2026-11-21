/**
 * Claim attempt limits on the appliance (CC-07, CT-60). A failed `enroll.claim` confirmation is one wrong guess.
 * Under `code` the letters rotate at once; under both methods the failure counts toward a backoff: the first
 * `CLAIM_FREE_FAILURES` failures in a rolling `CLAIM_FAILURE_WINDOW_S` are free, then `enroll.claim.begin` is refused
 * (`claim_backoff`, `details.retryAt`) for 1, 2, 4 … minutes after the latest failure, capped at 60 minutes. A begin
 * without a following `enroll.claim` costs nothing. Success clears the counters.
 */

export const CLAIM_FREE_FAILURES = 3;
export const CLAIM_FAILURE_WINDOW_S = 86_400;
export const CLAIM_BACKOFF_BASE_S = 60;
export const CLAIM_BACKOFF_MAX_S = 3_600;

/**
 * Seconds `enroll.claim.begin` stays refused after the latest failure, given the failures in the rolling window
 * (including that one): 0 for the first three, then 60, 120, 240, … capped at 3,600.
 */
export function claimBackoffSeconds(failuresInWindow: number): number {
  if (!Number.isInteger(failuresInWindow) || failuresInWindow <= CLAIM_FREE_FAILURES) return 0;
  const doublings = failuresInWindow - CLAIM_FREE_FAILURES - 1;
  if (doublings >= 6) return CLAIM_BACKOFF_MAX_S;
  return Math.min(CLAIM_BACKOFF_MAX_S, CLAIM_BACKOFF_BASE_S * 2 ** doublings);
}

/**
 * New letters asked for at the box's own screen (Whombat whombat-link.md): the person there opens a short window with
 * fresh letters, for when others on the network used up the tries. While it runs the wait after wrong tries and the
 * hourly count of begun claims don't apply, and the letters stay whatever others try, so nobody changes them under the
 * person's fingers. A device has `CLAIM_WINDOW_WRONG_PER_KEY` wrong tries on those letters, and the window ends early
 * (new letters, the usual rules again) after `CLAIM_WINDOW_WRONG` wrong tries from all devices: at most that many
 * guesses in 160,000 for each time someone at the box asks.
 */
export const CLAIM_WINDOW_S = 600;
export const CLAIM_WINDOW_WRONG = 5;
export const CLAIM_WINDOW_WRONG_PER_KEY = 2;
