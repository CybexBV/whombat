/**
 * Managed execution and integration policy (MA-10, docs/decisions/managed-runtime.md MR-13): what a managed
 * appliance refuses, always with the reason the person sees. The runner applies the same rules to every turn
 * (`apps/runner/src/managed.ts`); commands refuse to configure what could never run.
 */
import { FEEDBACK_DROP_TEXT } from '@whombat/core';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { registeredAtControl } from './link/origin';
import { linkOf } from './link/service';
import { MANAGED_EXPLANATIONS, type ManagedExplanation, type PolicyItem } from './ops';

/** App-level error code of a managed refusal (`error.details.code`, listed in MR-17). */
export function managedCode(key: ManagedExplanation): string {
  return `managed.${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}

export function managedRefusal(key: ManagedExplanation, message?: string): ApiError {
  return new ApiError('not_allowed', message ?? MANAGED_EXPLANATIONS[key], {
    details: { code: managedCode(key), managed: true, reason: key },
  });
}

/** Feedback's module is switched off on this appliance (`WHOMBAT_FEEDBACK=off`). */
export const FEEDBACK_OFF_TEXT = 'Whombat Feedback is turned off on this Whombat.';

/**
 * Whether the person may take website feedback (feedback-drop FD-25): through the encrypted drop, unless the module is off
 * or the manager or control said they can't deliver it (`unknown` counts as available until they answer).
 */
/**
 * What needs Whombat Link (whombat-link.md LNK-05, LNK-07; hermes-engine.md HE-S224): website feedback, phone
 * notifications and Whombat support's remote help go through Whombat's cloud, so a box without Link running says so.
 * Passkeys on a box claimed on its own pages work on its secure page.
 */
export const COMMUNITY_TEXT = {
  feedbackIntake: 'Feedback from your website needs Whombat Link.',
  nativePush:
    'Phone notifications need Whombat Link. Browser notifications work when you open this Whombat at its secure address.',
  remoteHelp: 'Remote help from Whombat support needs Whombat Link.',
  passkeys: 'Passkeys work only when you open this Whombat through Tailscale.',
} as const;

/** Website feedback without Whombat Link (HE-S203, LNK-05): its drop is control's. */
export const COMMUNITY_FEEDBACK_TEXT = COMMUNITY_TEXT.feedbackIntake;

/**
 * Whether Whombat Link runs now (starting, on, grace). Outside a managed runtime (a server without one, tests of a
 * part alone): whether control registered the box, as before Link.
 */
export function linkRuns(services: Pick<Services, 'config'>): boolean {
  const link = linkOf(services);
  return link ? link.active() : registeredAtControl(services.config);
}

export function feedbackIntakePolicy(services: Pick<Services, 'config' | 'feedback'>): PolicyItem {
  if (services.config.WHOMBAT_FEEDBACK === 'off') return { available: false, reason: FEEDBACK_OFF_TEXT };
  if (!linkRuns(services)) return { available: false, reason: COMMUNITY_FEEDBACK_TEXT };
  if (services.feedback.drop?.support === 'unsupported')
    return { available: false, reason: FEEDBACK_DROP_TEXT.unsupported };
  return { available: true, reason: FEEDBACK_DROP_TEXT.policy };
}

/**
 * Refuses what would take website feedback while the drop can't deliver it (FD-25): switching intake on and
 * creating an integration (which starts with intake on). Null when allowed.
 */
export function feedbackIntakeGuard(
  services: Pick<Services, 'config' | 'feedback'>,
  op: string,
  body: Record<string, unknown>,
): ApiError | null {
  const wantsIntake =
    (op === 'feedback.setIntake' && body.enabled === true) || op === 'feedback.createIntegration';
  if (!wantsIntake) return null;
  const policy = feedbackIntakePolicy(services);
  return policy.available ? null : managedRefusal('feedbackIntake', policy.reason ?? undefined);
}

/** The policy the person's settings show (the explanation next to each unavailable capability). */
export function managedPolicy(services: Pick<Services, 'config' | 'feedback'>): Record<string, PolicyItem> {
  const off = (key: ManagedExplanation): PolicyItem => ({
    available: false,
    reason: MANAGED_EXPLANATIONS[key],
  });
  const link = linkRuns(services);
  return {
    feedbackIntake: feedbackIntakePolicy(services),
    automationWebhooks: off('automationWebhooks'),
    // The customer's own OAuth client, redirected to the hosted UI, finished over the session (AG-14, MR-62).
    googleConnect: { available: true, reason: null },
    // Phones are told through control while Link runs (HE-61, LNK-36); every box has its own Web Push (HE-S224).
    nativePush: link
      ? { available: true, reason: 'Phone notifications go through Whombat’s cloud without their content.' }
      : { available: false, reason: COMMUNITY_TEXT.nativePush },
  };
}
