/** Feedback intake on a managed appliance (feedback-drop FD-25): available through the drop unless it can't deliver. */
import { FEEDBACK_DROP_TEXT } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { DropSupport } from '../feedback/drop/index';
import { FEEDBACK_OFF_TEXT, feedbackIntakeGuard, feedbackIntakePolicy, managedPolicy } from './policy';

function services(feedback: 'on' | 'off', support: DropSupport | null) {
  return {
    config: { WHOMBAT_FEEDBACK: feedback },
    feedback: { drop: support === null ? null : { support } },
  } as unknown as Parameters<typeof feedbackIntakePolicy>[0];
}

describe('feedback intake policy', () => {
  it('is available through the drop until the manager or control says it can’t deliver', () => {
    for (const support of ['unknown', 'supported', null] as const)
      expect(feedbackIntakePolicy(services('on', support))).toEqual({
        available: true,
        reason: FEEDBACK_DROP_TEXT.policy,
      });
    expect(feedbackIntakePolicy(services('on', 'unsupported'))).toEqual({
      available: false,
      reason: FEEDBACK_DROP_TEXT.unsupported,
    });
    expect(feedbackIntakePolicy(services('off', 'supported'))).toEqual({
      available: false,
      reason: FEEDBACK_OFF_TEXT,
    });
  });

  it('refuses switching intake on and creating sites only while unavailable', () => {
    const on = services('on', 'supported');
    const unsupported = services('on', 'unsupported');
    expect(feedbackIntakeGuard(on, 'feedback.setIntake', { enabled: true })).toBeNull();
    expect(feedbackIntakeGuard(on, 'feedback.createIntegration', {})).toBeNull();
    const refused = feedbackIntakeGuard(unsupported, 'feedback.setIntake', { enabled: true });
    expect(refused?.message).toBe(FEEDBACK_DROP_TEXT.unsupported);
    expect(refused?.extra.details).toMatchObject({ code: 'managed.feedback_intake' });
    expect(feedbackIntakeGuard(unsupported, 'feedback.createIntegration', {})).not.toBeNull();
    // Switching off, and everything else, is never refused.
    expect(feedbackIntakeGuard(unsupported, 'feedback.setIntake', { enabled: false })).toBeNull();
    expect(feedbackIntakeGuard(unsupported, 'feedback.updateIntegration', {})).toBeNull();
    expect(feedbackIntakeGuard(services('off', null), 'feedback.setIntake', { enabled: true })?.message).toBe(
      FEEDBACK_OFF_TEXT,
    );
  });
});

describe('the policy on a community box (HE-S224)', () => {
  it('offers no phone push or website feedback, and never points at Whombat’s cloud', () => {
    const community = {
      config: { WHOMBAT_FEEDBACK: 'on', WHOMBAT_EDITION: 'community' },
      feedback: { drop: { support: 'unknown' } },
    } as unknown as Parameters<typeof managedPolicy>[0];
    const policy = managedPolicy(community);
    expect(policy.nativePush?.available).toBe(false);
    expect(policy.feedbackIntake?.available).toBe(false);
    expect(JSON.stringify(policy)).not.toMatch(/cloud|relay|billing/i);
    expect(feedbackIntakeGuard(community, 'feedback.createIntegration', {})).not.toBeNull();
    // A commercial box keeps them.
    const commercial = managedPolicy({
      ...community,
      config: { WHOMBAT_FEEDBACK: 'on', WHOMBAT_EDITION: 'commercial' },
    } as never);
    expect(commercial.nativePush?.available).toBe(true);
  });
});
