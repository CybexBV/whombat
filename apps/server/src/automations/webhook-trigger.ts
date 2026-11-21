/**
 * Webhook triggers can't start anything on a Whombat: a box has no public address of its own for a sender to call
 * (the managed dispatcher refuses `automations.webhook`, and an automation's `webhookUrl` is always null), while the
 * contract still names the trigger. So no draft, new automation or published version may have one: refused in plain
 * words when it is saved, rather than kept as an automation that never runs.
 */
import { badRequest } from '../lib/errors';

export const NO_WEBHOOK_TRIGGER_TEXT =
  'A webhook can’t start an automation on this Whombat. Start it on a schedule, from a message or with Run now instead.';

/** Whether a definition (checked or not) has a webhook trigger. */
export function hasWebhookTrigger(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const triggers = (definition as { triggers?: unknown }).triggers;
  return (
    Array.isArray(triggers) &&
    triggers.some((t) => !!t && typeof t === 'object' && (t as { kind?: unknown }).kind === 'webhook')
  );
}

/** Refuses saving a definition with a webhook trigger. */
export function refuseWebhookTrigger(definition: unknown): void {
  if (hasWebhookTrigger(definition)) throw badRequest(NO_WEBHOOK_TRIGGER_TEXT);
}
