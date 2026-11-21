import { ApiError } from '@whombat/client';
import type { Plan } from '@whombat/core';
import { bootstrap, plan as seedPlan } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { whereOf } from './people';
import {
  addStepBody,
  addStepDoneText,
  addStepLabel,
  addStepProblem,
  addStepRefusal,
  canAddStep,
} from './planAdd';
import { planListRow, planListRows } from './planList';

const where = (id: string) => whereOf(bootstrap(), id);

describe('the plans list', () => {
  it('shows progress, due date, where it lives and the step that needs someone first', () => {
    const row = planListRow(seedPlan, where(seedPlan.conversationId) ?? null);
    expect(row).toMatchObject({
      id: 'pln_invoice-pdf',
      title: 'Invoice PDF export',
      meta: '1 of 4 done · Due 14 Oct',
      where: 'Chat',
      next: { title: 'Deploy to staging', marker: 'gate', stateLabel: 'Needs you', tone: 'warn' },
      done: false,
    });
    expect(row.accessibilityLabel).toBe(
      'Invoice PDF export. Chat. 1 of 4 done · Due 14 Oct. Next: Deploy to staging, Needs you',
    );
  });

  it('leads with the first open step when nothing needs anyone, and says when there are no steps', () => {
    const noGate: Plan = {
      ...seedPlan,
      steps: seedPlan.steps.map((s) =>
        s.state === 'gate' ? { ...s, state: 'queued', stateLabel: 'Queued' } : s,
      ),
    };
    expect(planListRow(noGate, null).next?.title).toBe('Build the export endpoint');
    const empty = planListRow({ ...seedPlan, steps: [], due: null }, null);
    expect(empty).toMatchObject({ meta: 'No steps yet', next: null, done: false, where: null });
  });

  it('lists finished plans after the open ones', () => {
    const finished: Plan = {
      ...seedPlan,
      id: 'pln_done',
      steps: seedPlan.steps.map((s) => ({ ...s, state: 'done', stateLabel: 'Done' })),
    };
    const rows = planListRows([finished, seedPlan], where);
    expect(rows.map((r) => [r.id, r.done, r.next])).toEqual([
      ['pln_invoice-pdf', false, expect.anything()],
      ['pln_done', true, null],
    ]);
  });
});

describe('adding a step (the agent’s own work: no owner, AP-4990)', () => {
  it('holds Add until there is a title within 160 characters', () => {
    expect(addStepProblem('  ')).toBe('Give the step a title.');
    expect(addStepProblem('x'.repeat(161))).toBe('Keep the title to 160 characters.');
    expect(addStepProblem('Write the tests')).toBeNull();
  });

  it('adds a queued step with its title and nothing else', () => {
    expect(addStepBody(' Write the tests ')).toEqual({ title: 'Write the tests' });
  });

  it('says what the button does and what went through', () => {
    expect([addStepLabel(false), addStepLabel(true)]).toEqual(['Add step', 'Adding…']);
    expect(addStepDoneText(' Write the tests ')).toContain('“Write the tests”');
  });

  it('stops at 30 steps', () => {
    expect(canAddStep(seedPlan)).toBe(true);
    const full = { steps: Array.from({ length: 30 }, () => seedPlan.steps[0]) } as Pick<Plan, 'steps'>;
    expect(canAddStep(full)).toBe(false);
  });

  it('shows a refusal in the server’s words', () => {
    expect(addStepRefusal(new ApiError(404, 'not_found', 'Not found', {}, 'plans.addStep'))).toBe(
      'This plan isn’t here any more.',
    );
    expect(addStepRefusal(new ApiError(403, 'forbidden', 'No', {}, 'plans.addStep'))).toBe(
      'You can’t change this plan.',
    );
    expect(addStepRefusal(new ApiError(409, 'conflict', 'Too many steps', {}, 'plans.addStep'))).toBe(
      'Too many steps',
    );
    expect(addStepRefusal(new Error('boom'))).toBeNull();
  });
});
