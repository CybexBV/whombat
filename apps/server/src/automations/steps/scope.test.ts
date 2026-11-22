import { evaluateCondition, renderTemplate } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { AutomationRunRow, AutomationStepRow } from '../store';
import { outsidersStepFiles, runScope } from './scope';

const run = (kind: string) =>
  ({
    id: 'arun_1',
    number: 7,
    test: false,
    trigger: { kind },
    scope: { kind, number: 12 },
  }) as unknown as AutomationRunRow;

const step = (stepId: string, output: Record<string, unknown>, dispatchId: string | null = 'dsp_review') =>
  ({
    stepId,
    kind: 'dispatch_agent',
    state: 'succeeded',
    dispatchId,
    output,
  }) as unknown as AutomationStepRow;

/** What the previous release saved for a finished agent step: its result, without the turn it came from. */
const savedBefore = {
  agentId: 'agt_dusty',
  dispatchState: 'done',
  text: 'Approve — reviewed 8c94527\nThe fix holds.',
  reply: 'Approve — reviewed 8c94527\nThe fix holds.',
  verdict: 'approve',
  messageIds: ['msg_a'],
  attachmentIds: ['att_private'],
};

describe('a tracker run’s agent step stored by the previous release', () => {
  it('keeps its reply and verdict for later templates and conditions', () => {
    const scope = runScope(run('tracker'), [step('review', savedBefore)]);
    expect(evaluateCondition('steps.review.verdict == "approve"', scope)).toBe(true);
    expect(renderTemplate('What the review said: {{steps.review.reply}}', scope)).toContain(
      'reviewed 8c94527',
    );
    expect(renderTemplate('{{steps.review.text}}', scope)).toContain('The fix holds.');
    expect((scope.steps as Record<string, Record<string, unknown>>).review?.messageIds).toEqual(['msg_a']);
  });

  it('never carries its files onwards', () => {
    const scope = runScope(run('tracker'), [step('review', savedBefore)]);
    expect((scope.steps as Record<string, Record<string, unknown>>).review).not.toHaveProperty(
      'attachmentIds',
    );
    expect(outsidersStepFiles(run('tracker'), { kind: 'dispatch_agent' })).toBe(true);
    expect(outsidersStepFiles(run('mail'), { kind: 'dispatch_agent' })).toBe(true);
    expect(outsidersStepFiles(run('manual'), { kind: 'dispatch_agent' })).toBe(false);
    expect(outsidersStepFiles(run('tracker'), { kind: 'post_message' })).toBe(false);
  });
});

describe('a result this release collected', () => {
  it('is read when it names the step’s own turn', () => {
    const scope = runScope(run('mail'), [step('ask', { ...savedBefore, resultDispatchId: 'dsp_review' })]);
    expect(evaluateCondition('steps.ask.verdict == "approve"', scope)).toBe(true);
    expect(scope.steps).not.toHaveProperty('ask.resultDispatchId');
  });

  it('is dropped when it names another turn', () => {
    const scope = runScope(run('tracker'), [step('ask', { ...savedBefore, resultDispatchId: 'dsp_other' })]);
    const ask = (scope.steps as Record<string, Record<string, unknown>>).ask;
    expect(ask).not.toHaveProperty('reply');
    expect(ask).not.toHaveProperty('verdict');
    expect(ask).not.toHaveProperty('messageIds');
    expect(evaluateCondition('steps.ask.verdict == "approve"', scope)).toBe(false);
  });

  it('is the person’s own run’s as it was, files included', () => {
    const scope = runScope(run('manual'), [step('ask', { ...savedBefore, resultDispatchId: 'dsp_other' })]);
    expect((scope.steps as Record<string, Record<string, unknown>>).ask).toMatchObject({
      verdict: 'approve',
      attachmentIds: ['att_private'],
    });
  });
});
