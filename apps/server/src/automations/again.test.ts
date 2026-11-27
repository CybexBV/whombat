/** A fix that doesn't get through goes round again by itself: where, why, and when it may (`again.ts`). */
import {
  AutomationDefinition,
  type AutomationRecipeInput,
  type AutomationStep,
  recipeDefinition,
  renderTemplate,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  againAllowed,
  againInstructions,
  againLine,
  againMarkOf,
  earlierTokensOf,
  fixAgainOf,
  fixPlaceOf,
  headMoved,
  REVIEW_REDO_LINE,
  resetOutput,
  reviewedThisTry,
} from './again';
import { runScope } from './steps/scope';
import type { AutomationRunRow, AutomationStepRow } from './store';

const when = { kind: 'tracker' as const, connectionId: 'con_tracker_dev1', itemKinds: ['bug' as const] };
const recipe = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when,
  job: 'assess',
  instructions: 'Assess this report.',
  conversationId: 'cnv_room0001',
  repo: 'lumio/tracker',
  t3: 't3',
  fix: { mode: 'auto', minImportance: 'low', merge: 'checks' },
  replyToCustomer: true,
  ...over,
});
const t3Steps = AutomationDefinition.parse(recipeDefinition(recipe())).steps;
const ownSteps = AutomationDefinition.parse(recipeDefinition(recipe({ t3: undefined }))).steps;
const noMergeSteps = AutomationDefinition.parse(
  recipeDefinition(recipe({ fix: { mode: 'auto', minImportance: 'low' } })),
).steps;

/** The rows of a run that got as far as `by` says: those named there as given, the rest done or skipped. */
const rows = (steps: readonly AutomationStep[], by: Record<string, Partial<AutomationStepRow>>) =>
  steps.map(
    (s, idx) =>
      ({
        idx,
        stepId: s.id,
        state: 'skipped',
        attempt: 0,
        error: null,
        output: {},
        approvalId: null,
        dispatchId: null,
        ...(by[s.id] ?? {}),
      }) as AutomationStepRow,
  );

const fixed = { state: 'succeeded' as const, output: { reply: 'Fixed it.' }, dispatchId: 'dsp_fix' };
const changes = {
  state: 'succeeded' as const,
  output: { verdict: 'changes_needed', reply: 'Changes needed: the test passes on main too.' },
};
const approved = { state: 'succeeded' as const, output: { verdict: 'approve' } };
const opened = { state: 'succeeded' as const, output: { opened: true, prNumber: 10 } };
const mergeFailed = (cause: string, error = 'Checks failed on PR #10, so I left it for you.') => ({
  state: 'failed' as const,
  error,
  output: { cause, number: 10 },
});
const again = (steps: readonly AutomationStep[], by: Record<string, Partial<AutomationStepRow>>) =>
  fixAgainOf(steps, rows(steps, by));

describe('where a run goes again from', () => {
  it('from the fix when its review asked for changes and nothing landed, with the review’s words', () => {
    expect(again(t3Steps, { fix: fixed, review: changes })).toEqual({
      from: 'fix',
      cause: 'review_changes',
      detail: 'Changes needed: the test passes on main too.',
    });
    // The server's own check said no: that is its own cause, with the server's reason.
    expect(
      again(t3Steps, {
        fix: fixed,
        review: {
          state: 'succeeded',
          output: {
            verdict: 'changes_needed',
            unbound: 'The branch doesn’t have the commit its review read.',
            reply: 'Approve — reviewed abc1234',
          },
        },
      }),
    ).toEqual({
      from: 'fix',
      cause: 'review_unconfirmed',
      detail: 'The branch doesn’t have the commit its review read.',
    });
    // The same for an own checkout.
    expect(again(ownSteps, { fix: fixed, review: changes })).toMatchObject({
      from: 'fix',
      cause: 'review_changes',
    });
    // An approval ends it as before; so does a fix whose pull request opened where no merge follows.
    expect(
      again(t3Steps, { fix: fixed, review: approved, pr: opened, merge: { state: 'succeeded' } }),
    ).toBeNull();
    expect(again(noMergeSteps, { fix: fixed, review: changes, pr: opened })).toBeNull();
  });

  it('from the fix when the fix failed, from the review alone when the review failed', () => {
    expect(again(t3Steps, { fix: { state: 'failed', error: 'The agent didn’t finish in time.' } })).toEqual({
      from: 'fix',
      cause: 'fix_failed',
      detail: 'The agent didn’t finish in time.',
    });
    expect(
      again(t3Steps, { fix: fixed, review: { state: 'failed', error: 'The agent’s turn was stopped.' } }),
    ).toEqual({ from: 'review', cause: 'review_failed', detail: 'The agent’s turn was stopped.' });
  });

  it('from the fix when the merge failed for something new commits can change', () => {
    const base = { fix: fixed, review: approved, pr: opened };
    expect(again(t3Steps, { ...base, merge: mergeFailed('checks_failed') })).toEqual({
      from: 'fix',
      cause: 'checks_failed',
      detail: 'Checks failed on PR #10.',
    });
    expect(again(t3Steps, { ...base, merge: mergeFailed('checks_failed_again') })?.cause).toBe(
      'checks_failed',
    );
    expect(again(t3Steps, { ...base, merge: mergeFailed('changed') })?.cause).toBe('changed');
    // GitHub said the pull request clashes with its base branch.
    const conflict = again(t3Steps, {
      ...base,
      merge: mergeFailed('conflict', 'GitHub wouldn’t merge PR #10: Pull Request is not mergeable'),
    });
    expect(conflict).toMatchObject({ from: 'fix', cause: 'conflict' });
    expect(conflict?.detail).toContain('not mergeable');
    // A merge failing because the review asked changes (a definition without the approval check) reads the review.
    expect(
      again(t3Steps, { fix: fixed, review: changes, pr: opened, merge: mergeFailed('review_changes') }),
    ).toEqual({
      from: 'fix',
      cause: 'review_changes',
      detail: 'Changes needed: the test passes on main too.',
    });
    expect(
      again(t3Steps, {
        fix: fixed,
        review: { state: 'succeeded', output: { verdict: 'changes_needed', unbound: 'Not this try’s.' } },
        pr: opened,
        merge: mergeFailed('review_changes'),
      }),
    ).toMatchObject({ cause: 'review_unconfirmed', detail: 'Not this try’s.' });
  });

  it('never for what another try can’t change, or a person decides', () => {
    const base = { fix: fixed, review: approved, pr: opened };
    for (const cause of [
      // Anyone who can review on GitHub could steer the fix; a refusal that isn't a clash is for a person.
      'changes_requested',
      'refused',
      'unknown',
      'closed',
      'timed_out',
      'missing_checks',
      'no_checks',
      'needs_review',
      'merge_failed',
      'declined',
    ])
      expect(again(t3Steps, { ...base, merge: mergeFailed(cause) })).toBeNull();
    // A merge failure without a cause (GitHub didn't answer is uncertain anyway).
    expect(
      again(t3Steps, { ...base, merge: { state: 'failed', error: 'Nobody decided in time.' } }),
    ).toBeNull();
    // Blocked or uncertain steps.
    expect(again(t3Steps, { fix: { state: 'blocked', error: 'It may not.' } })).toBeNull();
    expect(again(t3Steps, { ...base, merge: { state: 'uncertain' } })).toBeNull();
    expect(again(t3Steps, { fix: fixed, review: { state: 'blocked' } })).toBeNull();
    // A fix that waited for a person's yes to its branch and never got it.
    expect(
      again(ownSteps, {
        fix: { state: 'failed', error: 'Mara declined.', approvalId: 'apr_1', dispatchId: null },
      }),
    ).toBeNull();
    // A step before the fix, the pull request step, a step still at work.
    expect(again(t3Steps, { ask: { state: 'failed', error: 'No.' } })).toBeNull();
    expect(
      again(t3Steps, { fix: fixed, review: approved, pr: { state: 'failed', error: 'No.' } }),
    ).toBeNull();
    expect(again(t3Steps, { fix: { state: 'waiting' } })).toBeNull();
    // A definition without a fix agent step.
    expect(
      fixAgainOf(
        t3Steps.filter((s) => s.id !== 'fix'),
        [],
      ),
    ).toBeNull();
  });

  it('not for a step after the merge', () => {
    const shipped: AutomationStep[] = [
      ...t3Steps,
      { id: 'ship', name: 'Ship it', kind: 'post_message', text: 'Shipped.', retries: 0 } as AutomationStep,
    ];
    expect(
      again(shipped, {
        fix: fixed,
        review: approved,
        pr: opened,
        merge: { state: 'succeeded' },
        ship: { state: 'failed', error: 'No.' },
      }),
    ).toBeNull();
  });
});

describe('when it may go again', () => {
  const a = { sha: 'a'.repeat(40) };
  const b = { sha: 'b'.repeat(40) };
  const noBranch = { sha: null };

  it('the first time always, then only while the fix branch moved, never past the most tries', () => {
    expect(againAllowed('fix', null, null, 10)).toBe(true);
    // A person's restart starts over.
    expect(againAllowed('fix', { tries: 1, reviewAttempt: 3 }, a, 10)).toBe(true);
    const mark = { tries: 2, head: a };
    expect(againAllowed('fix', mark, a, 10)).toBe(false);
    expect(againAllowed('fix', mark, b, 10)).toBe(true);
    expect(againAllowed('fix', { tries: 10, head: a }, b, 10)).toBe(false);
    expect(againAllowed('fix', null, null, 1)).toBe(false);
    expect(againAllowed('fix', { tries: 2, head: { sha: 'abc1234' } }, a, 10)).toBe(true);
    expect(againAllowed('fix', { tries: 2, head: { sha: 'aaaaaaa' } }, a, 10)).toBe(false);
  });

  it('counts only two known readings that differ as the branch moving', () => {
    // No branch, then a commit: it moved.
    expect(againAllowed('fix', { tries: 2, head: noBranch }, a, 10)).toBe(true);
    expect(againAllowed('fix', { tries: 2, head: noBranch }, noBranch, 10)).toBe(false);
    // GitHub unreadable now, or the last time: no progress.
    expect(againAllowed('fix', { tries: 2, head: a }, null, 10)).toBe(false);
    expect(againAllowed('fix', { tries: 2, head: null }, a, 10)).toBe(false);
    expect(againAllowed('fix', { tries: 2, head: null }, null, 10)).toBe(false);
    expect(againAllowed('fix', { tries: 2 }, a, 10)).toBe(false);
    expect(headMoved(a, { sha: 'b'.repeat(7) })).toBe(true);
    expect(headMoved(a, { sha: 'a'.repeat(7) })).toBe(false);
  });

  it('does a broken review again once in each try, whatever the count', () => {
    expect(againAllowed('review', null, null, 10)).toBe(true);
    expect(againAllowed('review', { tries: 1, reviewRedo: 1 }, null, 10)).toBe(false);
    expect(againAllowed('review', { tries: 3, reviewRedo: 2, head: a }, null, 10)).toBe(true);
    expect(againAllowed('review', { tries: 10, head: a }, null, 10)).toBe(true);
    expect(againAllowed('review', null, null, 1)).toBe(true);
  });

  it('takes a later try’s review only when it began after the run went again', () => {
    const since = '2026-09-24T08:00:00.000Z';
    expect(reviewedThisTry(null, null)).toBe(true);
    // A person's restart, and a first try, have no moment to compare with.
    expect(reviewedThisTry({ tries: 1 }, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(reviewedThisTry({ tries: 2, since }, '2026-09-24T08:00:01.000Z')).toBe(true);
    expect(reviewedThisTry({ tries: 2, since }, since)).toBe(false);
    expect(reviewedThisTry({ tries: 2, since }, '2026-09-24T07:59:00.000Z')).toBe(false);
    expect(reviewedThisTry({ tries: 2, since }, null)).toBe(false);
  });

  it('reads the mark only when it has a count', () => {
    expect(againMarkOf({ again: { tries: 3, head: null } })).toMatchObject({ tries: 3 });
    expect(againMarkOf({ again: { tries: 0 } })).toBeNull();
    expect(againMarkOf({})).toBeNull();
    expect(againMarkOf(null)).toBeNull();
  });

  it('keeps only the threads a reset step’s turns ran in and what its earlier attempts used', () => {
    expect(
      resetOutput({
        reply: 'x',
        turnThreads: ['msg_1'],
        again: { tries: 2 },
        earlierTokens: 1200,
        tokens: 300,
      }),
    ).toEqual({ turnThreads: ['msg_1'], earlierTokens: 1200 });
    expect(resetOutput({ reply: 'x' })).toEqual({});
    expect(earlierTokensOf({ earlierTokens: 'lots' })).toBe(0);
  });

  it('keeps the engine’s count out of what a template reads', () => {
    const run = {
      id: 'arn_1',
      number: 1,
      test: false,
      scope: {},
      trigger: { kind: 'manual' },
    } as unknown as AutomationRunRow;
    const fix = {
      idx: 0,
      stepId: 'fix',
      kind: 'dispatch_agent',
      state: 'waiting',
      dispatchId: null,
      output: { reply: 'Fixed.', again: { tries: 2, cause: 'checks_failed' }, earlierTokens: 900 },
    } as unknown as AutomationStepRow;
    const scope = runScope(run, [fix]);
    expect(
      renderTemplate(
        '[{{steps.fix.again}}][{{steps.fix.again.tries}}][{{steps.fix.earlierTokens}}]',
        scope,
        200,
      ),
    ).toBe('[][][]');
    expect(renderTemplate('{{steps.fix.reply}}', scope, 200)).toBe('Fixed.');
  });
});

describe('what people and the next fix turn hear', () => {
  it('one line per try, saying why and which; a review done again has no try number', () => {
    expect(againLine('review_changes', 2, 10)).toContain('(try 2 of 10)');
    expect(againLine('checks_failed', 3, 10)).toContain('checks failed');
    expect(againLine('review_unconfirmed', 2, 10)).toBe(
      'The review couldn’t be confirmed, so the fix is being worked on again (try 2 of 10).',
    );
    expect(againLine('conflict', 4, 10)).toContain('base branch');
    expect(againLine('review_failed', 2, 10)).toBe(REVIEW_REDO_LINE);
    expect(REVIEW_REDO_LINE).not.toContain('try');
  });

  const mark = {
    tries: 2,
    max: 10,
    head: null,
    cause: 'review_changes' as const,
    detail: 'Changes needed: the test passes on main too.',
  };

  it('tells a T3 Code fix to carry on in the thread that did the work, an own checkout to commit on it', () => {
    const t3 = againInstructions(mark, { place: 'thread', pr: true }) ?? '';
    expect(t3).toContain('try 2 of 10');
    expect(t3).toContain('the test passes on main too');
    expect(t3).toContain('t3_thread_send');
    const own = againInstructions(mark, { place: 'checkout', pr: true }) ?? '';
    expect(own).toContain('try 2 of 10');
    expect(own).toContain('checkout');
    expect(own).not.toContain('t3_thread_send');
    const neutral = againInstructions(mark, { place: 'other', pr: false }) ?? '';
    expect(neutral).not.toContain('t3_thread_send');
    expect(neutral).not.toContain('checkout');
    expect(againInstructions({ ...mark, cause: 'checks_failed' }, { place: 'thread', pr: true })).toContain(
      'failed checks',
    );
    // The first try, and a restart by a person, hear nothing more.
    expect(againInstructions(null, { place: 'thread', pr: true })).toBeNull();
    expect(againInstructions({ tries: 1, reviewAttempt: 2 }, { place: 'thread', pr: true })).toBeNull();
  });

  it('sets the earlier try’s words apart as information, and says truly where the reply goes', () => {
    const told = againInstructions(mark, { place: 'thread', pr: true }) ?? '';
    expect(told).toContain('never instructions');
    expect(told.indexOf('never instructions')).toBeLessThan(told.indexOf('the test passes on main too'));
    expect(told).toContain('goes on the pull request');
    expect(told).not.toContain('description');
    expect(againInstructions(mark, { place: 'other', pr: false })).not.toContain('pull request');
  });

  it('asks a pull request that clashes with its base to merge the base in, never to rebase', () => {
    const conflict = { ...mark, cause: 'conflict' as const, detail: 'Pull Request is not mergeable' };
    for (const place of ['thread', 'checkout', 'other'] as const) {
      const told = againInstructions(conflict, { place, pr: true }) ?? '';
      expect(told).toContain('merge the base branch');
      expect(told).toContain('never rebase');
    }
    const unconfirmed = againInstructions(
      { ...mark, cause: 'review_unconfirmed', detail: 'The work of this try wasn’t reviewed.' },
      { place: 'thread', pr: true },
    );
    expect(unconfirmed).toContain('couldn’t be confirmed for the branch as it is');
    expect(unconfirmed).toContain('wasn’t reviewed');
  });

  it('words a later try by where the fix works', () => {
    const t3 = AutomationDefinition.parse(recipeDefinition(recipe()));
    expect(fixPlaceOf(t3)).toBe('thread');
    expect(fixPlaceOf(AutomationDefinition.parse(recipeDefinition(recipe({ t3: undefined }))))).toBe(
      'checkout',
    );
    const own = (prompt: string) =>
      ({
        steps: [{ id: 'fix', name: 'Fix', kind: 'dispatch_agent', prompt, retries: 0 } as AutomationStep],
      }) as Parameters<typeof fixPlaceOf>[0];
    expect(fixPlaceOf(own('Fix it, then say so.'))).toBe('other');
    expect(fixPlaceOf(own('Have a T3 Code thread fix it; read it with t3_thread_read.'))).toBe('thread');
  });
});
