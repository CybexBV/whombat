/**
 * Failed turns (Whombat essentials item 4; contracts CT-167): the pure parts of the `turn_failed` card and a NEEDS YOU
 * row's Try again — what a refused retry says, and where a failure can be fixed.
 */
import { ApiError, problemText } from '@whombat/client';
import type { TurnFailureCode } from '@whombat/core';
import { currentLocale } from '../../i18n/provider';

/** What a retry that didn't happen says (the server's words when it gave some). */
export function retryFailureText(
  result: { status: 'blocked'; message: string } | { status: 'pending_approval' } | Error,
): string {
  if (result instanceof ApiError) return problemText(result, undefined, currentLocale());
  if (result instanceof Error) return 'Couldn’t reach Whombat. Nothing changed, try again.';
  if (result.status === 'blocked') return result.message;
  return 'That needs a person to approve it first.';
}

/**
 * A way to fix what failed, beside Try again (AP-482): a sign-in problem opens Settings → AI (SS-01), which the
 * sentence names. Every other code is fixed by waiting or trying again, so there is no link.
 */
export function turnFailureFix(code: TurnFailureCode): { href: string; label: string } | null {
  return code === 'signin' ? { href: '/settings?tab=agent&part=ai', label: 'See the AI sign-in' } : null;
}
