import { describe, expect, it } from 'vitest';
import { ONBOARDING_LAST_STEP, onboardingStepOf } from './tenancy';

describe('onboarding steps (one-person.md OP-S03: three steps)', () => {
  it('reads a stored step as one of the three', () => {
    expect([-1, 0, 1, 2, 3, 2.5].map((step) => onboardingStepOf({ step }))).toEqual([0, 0, 1, 2, 2, 2]);
    expect(ONBOARDING_LAST_STEP).toBe(2);
  });
});
