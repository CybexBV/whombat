import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS } from './onboardingCopy';

describe('onboarding’s steps (one-agent.md OA-13, AP-4954; one-person.md AP-5673)', () => {
  it('names the Whombat, sets up the AI and meets the one agent; nobody to invite', () => {
    expect(ONBOARDING_STEPS.map((s) => s.t)).toEqual([
      'Name your Whombat',
      'Set up your AI',
      'Meet your agent',
    ]);
    const words = ONBOARDING_STEPS.map((s) => `${s.d} ${s.sub} ${s.tip('Dusty')}`).join(' ');
    expect(words).not.toMatch(/\bagents\b|crew|hire|role|invite|team|everyone|member|owner/i);
    expect(ONBOARDING_STEPS[0]?.tip('Dusty')).toContain('Dusty');
  });
});
