/**
 * What the box refuses by policy, with the explanation the person sees (MA-10; docs/decisions/managed-runtime.md MR-13).
 * The session operations themselves (enrollment, recovery, endpoints, push handles, appliance status)
 * are `@whombat/protocol/session`'s (contracts 0.3.0, CT-16/CT-17).
 */

/** What the person sees as the appliance's execution and integration policy (MA-10), with the reasons. */
export interface PolicyItem {
  available: boolean;
  reason: string | null;
}

/** Capabilities the box refuses, with the explanation the settings UI shows (MA-10). */
export const MANAGED_EXPLANATIONS = {
  // The drop isn't offered by the manager or control (feedback-drop FD-25); `FEEDBACK_DROP_TEXT.unsupported`.
  feedbackIntake: 'Feedback needs an update of this Whombat’s cloud connection.',
  // No reason about addresses: a box on Whombat Link has its own, shown just above this in Settings.
  automationWebhooks: 'Incoming webhooks aren’t available on this Whombat yet. Use schedules or Run now.',
  googleConnect: 'Connecting a Google account is turned off on this Whombat.',
} as const;
export type ManagedExplanation = keyof typeof MANAGED_EXPLANATIONS;
