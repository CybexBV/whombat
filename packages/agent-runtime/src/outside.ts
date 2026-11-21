/**
 * Turns that outsiders' input starts (docs/decisions/one-person.md OP-17): a website visitor's report, a tracker's
 * customer, someone who mails the person. They run apart from the person's own turns — in Hermes's outsiders' profile
 * (`profiles/_feedback`), never the person's pod, memory, skills, Vault or logins. Every other turn is the person's. The
 * server says which (contracts 3.0 `DispatchContext.outside`); a Feedback assessment always is one.
 */
import type { DispatchContext } from '@whombat/core/contracts';

export function isOutsideTurn(ctx: Pick<DispatchContext, 'outside' | 'dispatch'>): boolean {
  return ctx.outside || ctx.dispatch.trigger === 'feedback';
}
