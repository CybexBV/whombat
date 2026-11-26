/** Why a tracker run's report needs the person (report-trackers.md TA-61). */
import { AutomationDefinition, type AutomationRecipeInput, recipeDefinition } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { AutomationStepRow } from '../automations/store';
import { nextContinueStepId, unlandedReason } from './unlanded';

const when = { kind: 'tracker' as const, connectionId: 'con_tracker_dev1', itemKinds: ['bug' as const] };
const recipe: AutomationRecipeInput = {
  when,
  job: 'assess',
  instructions: 'Assess this report.',
  conversationId: 'cnv_room0001',
  repo: 'lumio/tracker',
  t3: 't3',
  fix: { mode: 'auto', minImportance: 'low', merge: 'checks' },
  replyToCustomer: true,
};
const steps = AutomationDefinition.parse(recipeDefinition(recipe)).steps;

/** The run's rows: each step named here started, with what it says; the rest skipped. */
const rows = (by: Record<string, Partial<AutomationStepRow>>) =>
  steps.map(
    (s, idx) =>
      ({
        idx,
        stepId: s.id,
        state: 'skipped',
        error: null,
        output: {},
        startedAt: by[s.id] ? new Date() : null,
        ...(by[s.id] ?? {}),
      }) as AutomationStepRow,
  );
const reason = (
  by: Record<string, Partial<AutomationStepRow>>,
  status: 'succeeded' | 'failed' = 'succeeded',
) => unlandedReason(steps, rows(by), status)?.reason ?? null;

const approved = { state: 'succeeded' as const, output: { verdict: 'approve' } };

describe('a report that needs the person', () => {
  it('says why a fix didn’t land', () => {
    expect(reason({ fix: { state: 'failed' } })).toBe('The fix couldn’t be made.');
    expect(reason({ fix: { state: 'blocked', error: 'Dusty may not work on feat/tracker-23.' } })).toBe(
      'Dusty may not work on feat/tracker-23.',
    );
    // Still at work when the run ended.
    expect(reason({ fix: { state: 'waiting' } }, 'failed')).toBe('The fix didn’t finish in time.');
    // The review step's own words say why there was no approval.
    expect(
      reason({
        fix: { state: 'succeeded' },
        review: {
          state: 'succeeded',
          output: {
            verdict: 'changes_needed',
            reply:
              'Changes needed: the bug couldn’t be reproduced with a failing test, so nothing was pushed.',
          },
        },
      }),
    ).toBe('the bug couldn’t be reproduced with a failing test, so nothing was pushed.');
    // The commit the review names stays out of the person's notice.
    for (const reply of [
      'Changes needed (reviewed 15cb03fe9). Two things must change.',
      'Changes needed — reviewed 15cb03fe95a62a22: two things must change.',
    ])
      expect(
        reason({
          fix: { state: 'succeeded' },
          review: { state: 'succeeded', output: { verdict: 'changes_needed', reply } },
        }),
      ).toMatch(/^[Tt]wo things must change\.$/);
    expect(
      reason({
        fix: { state: 'succeeded' },
        review: {
          state: 'succeeded',
          output: { verdict: 'changes_needed', reply: 'Changes needed (reviewed 15cb03fe9)' },
        },
      }),
    ).toBe('No review approved the fix.');
    expect(
      reason({
        fix: { state: 'succeeded' },
        review: {
          state: 'succeeded',
          output: { verdict: 'changes_needed', unbound: 'The branch moved after its review.' },
        },
      }),
    ).toBe('The branch moved after its review.');
    expect(reason({ fix: { state: 'succeeded' }, review: { state: 'blocked', error: null } })).toBe(
      'Its review couldn’t be read.',
    );
    expect(
      reason({
        fix: { state: 'succeeded' },
        review: approved,
        pr: { state: 'succeeded', output: { opened: true } },
        merge: { state: 'failed', error: 'Checks failed on PR #12, so I left it for you.' },
      }),
    ).toBe('Checks failed on PR #12, so I left it for you.');
  });

  it('chooses the right step to continue an unlanded report run from', () => {
    expect(nextContinueStepId(steps, rows({ fix: { state: 'failed' } }))).toBe('fix');
    expect(
      nextContinueStepId(
        steps,
        rows({
          fix: { state: 'succeeded' },
          review: { state: 'succeeded', output: { verdict: 'changes_needed' } },
        }),
      ),
    ).toBe('review');
    expect(
      nextContinueStepId(
        steps,
        rows({
          fix: { state: 'succeeded' },
          review: approved,
          pr: { state: 'succeeded', output: { opened: false } },
        }),
      ),
    ).toBe('pr');
    expect(
      nextContinueStepId(
        steps,
        rows({
          fix: { state: 'succeeded' },
          review: approved,
          pr: { state: 'succeeded', output: { opened: true } },
          merge: { state: 'failed' },
        }),
      ),
    ).toBe('merge');
  });

  it('says a run that failed before the customer was answered needs the person too', () => {
    expect(reason({ ask: { state: 'failed', error: 'The agent didn’t finish in time.' } }, 'failed')).toBe(
      'The agent didn’t finish in time.',
    );
    // Answered, nothing to fix: nothing.
    expect(
      reason({ ask: { state: 'succeeded' }, reply: { state: 'succeeded', output: { sent: true } } }),
    ).toBeNull();
    // It finished without a word for the customer because the turn reported no assessment: the person.
    expect(
      reason({
        ask: { state: 'succeeded', output: { unassessed: true } },
        reply: { state: 'skipped', output: { sent: false } },
      }),
    ).toMatch(/assessment/);
    // An empty reply the agent chose: nothing.
    expect(
      reason({
        ask: { state: 'succeeded', output: {} },
        reply: { state: 'skipped', output: { sent: false } },
      }),
    ).toBeNull();
  });

  it('is nothing when it merged, or no fix was tried', () => {
    expect(
      reason({
        fix: { state: 'succeeded' },
        review: approved,
        pr: { state: 'succeeded', output: { opened: true } },
        merge: { state: 'succeeded' },
      }),
    ).toBeNull();
    expect(reason({})).toBeNull();
  });
});
