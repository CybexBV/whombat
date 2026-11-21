/**
 * What the phone adds to the shared screen sign-in machine (`@whombat/client/managed` `screen-signin.ts`;
 * signin-at-box-android.md AP-3531, AP-3532): which letters stay in the field after a step, and where Android's back
 * goes. Pure.
 */
import { COPY, type ScreenSignInStep, screenSignInStart } from '@whombat/client/managed';

/**
 * The field after `prev` became `next`: emptied when the box shows other letters than the ones typed — a new code (from
 * “Show a code” or “Show a new code”) or a wrong guess, which turns them — and kept otherwise (a typo the box never shows,
 * the connection, a backoff), so they can be sent again.
 */
export function lettersAfter(prev: ScreenSignInStep, next: ScreenSignInStep, typed: string): string {
  if (next.kind !== 'letters') return typed;
  if (prev.kind !== 'letters' || next.signinId !== prev.signinId) return '';
  if (next.error === COPY.screen.errors.screen_code_invalid) return '';
  return typed;
}

/** Android's back: from the letters to “Show a code”, from there (or a stop) out of the flow (null). */
export function backFrom(step: ScreenSignInStep): ScreenSignInStep | null {
  return step.kind === 'letters' ? screenSignInStart() : null;
}
