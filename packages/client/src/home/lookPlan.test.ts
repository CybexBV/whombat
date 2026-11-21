import type { LookPlanView, LookResearch } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { handingResearch, LOOK_PLAN_WORDS, lookPlanCardView, researchPlanView } from './lookPlan';

const at = '2026-10-30T09:00:00.000Z';
const steps = ['Add the 6 machines to a nightly backup at 02:00, keeping a week', 'Restart nginx'];
const research: LookResearch = {
  key: 'server:pve-01',
  state: 'found',
  title: 'pve-01 isn’t backed up',
  summary: 'Six machines have no backup.',
  plan: steps,
  threadRootId: 'msg_000000000001',
  at,
};
const card = (more: Partial<LookPlanView> = {}): LookPlanView => ({
  name: 'pve-01',
  state: 'waiting',
  steps,
  title: research.title ?? null,
  summary: research.summary ?? null,
  research,
  at,
  ...more,
});

describe('the assistant’s plan for a thing (handle-it.md)', () => {
  it('waits with its steps, Go ahead and Change something', () => {
    const v = lookPlanCardView(card());
    expect(v).toMatchObject({
      head: 'Here’s what I’ll do on pve-01:',
      goAhead: 'Go ahead',
      change: 'Change something',
    });
    expect(v?.steps).toEqual(steps);
    expect(v?.text).toBe('Six machines have no backup.');
  });

  it('is on it after Go ahead, then says what it did, green', () => {
    expect(lookPlanCardView(card({ state: 'doing' }))).toMatchObject({
      busy: true,
      goAhead: null,
      text: LOOK_PLAN_WORDS.doing,
    });
    const done = lookPlanCardView(card({ state: 'done', title: 'pve-01 is backed up' }));
    expect(done).toMatchObject({
      done: true,
      head: 'Here’s what I did on pve-01:',
      title: 'pve-01 is backed up',
    });
  });

  it('says how it will look after a new server, then how it does (care-plan.md)', () => {
    const care = card({ care: true, research: { ...research, key: 'care:server:pve-01' } });
    expect(lookPlanCardView(care)).toMatchObject({
      head: 'Here’s how I’ll look after pve-01:',
      goAhead: 'Go ahead',
      change: 'Change something',
    });
    expect(lookPlanCardView({ ...care, state: 'done' })?.head).toBe('Here’s how I’m looking after pve-01:');
  });

  it('says it is no longer needed once the problem went, and offers nothing', () => {
    expect(lookPlanCardView(card({ state: 'gone', research: null }))).toMatchObject({
      text: 'No longer needed.',
      goAhead: null,
      title: null,
    });
    // Waiting but its research went: nothing to say go ahead to.
    expect(lookPlanCardView(card({ research: null }))?.state).toBe('gone');
    expect(lookPlanCardView(null)).toBeNull();
  });

  it('draws a page’s research as the same plan, and nothing for one step', () => {
    expect(researchPlanView(research, 'pve-01')?.state).toBe('waiting');
    expect(researchPlanView({ ...research, state: 'fixing' }, 'pve-01')?.busy).toBe(true);
    expect(researchPlanView({ ...research, state: 'fixed' }, 'pve-01')?.done).toBe(true);
    expect(researchPlanView({ ...research, plan: undefined, fix: 'Restart nginx' }, 'pve-01')).toBeNull();
    expect(researchPlanView({ ...research, state: 'looking' }, 'pve-01')).toBeNull();
    expect(handingResearch('server:pve-01', Date.parse(at))).toEqual({
      key: 'server:pve-01',
      state: 'looking',
      at,
    });
  });
});
