/**
 * What a write that didn't go through says (contracts CT-172; AP-465…AP-473): the server's own words where it has
 * some, or why the commit waits.
 */
import { ApiError, type CommitResult } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';

/** A refusal in the server's words where it has some, else `fallback`. */
export function refusalText(err: unknown, fallback: string): string {
  const licence = licenceRefusalText(err);
  if (licence) return licence;
  if (err instanceof ApiError) {
    if (err.status === 404 || err.status === 501) return 'That isn’t available on this Whombat yet.';
    return err.message || fallback;
  }
  return fallback;
}

/** A commit that didn't happen yet: waiting for a person, or a key the agent lacks. */
export function outcomeText(result: Exclude<CommitResult<unknown>, { status: 'ok' }>): string {
  if (result.status === 'pending_approval') return 'That needs a person to approve it first. We’ve asked.';
  return `Blocked: that needs the “${result.keyNeeded.label}” key.`;
}
