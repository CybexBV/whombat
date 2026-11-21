import { describe, expect, it } from 'vitest';
import { at, deployApproval, dusty, mara, run } from '../__fixtures__/world.js';
import { IDLE_EXECUTION } from '../domain/approval.js';
import { LiveActivityPush } from '../domain/notification.js';
import {
  approvalLiveActivity,
  approvalLiveActivityAudience,
  isApprovalActivityEnded,
  isRunActivityEnded,
  liveActivityPush,
  runLiveActivity,
  runLiveActivityAudience,
} from './live-activity.js';
import { PushPayload } from './notifications.js';

const checksGreen = (a = deployApproval()) =>
  deployApproval({
    conditions: a.conditions.map((c) =>
      c.kind === 'checks_pass'
        ? { ...c, met: true, state: 'passed', passed: 41, total: 41, fixing: false, headSha: '7be20f' }
        : c.kind === 'review_approved'
          ? { ...c, met: true, reviewState: 'approved', reviewedAt: at('11:38') }
          : c,
    ),
  });

describe('run live activity', () => {
  it('pauses, and ends once the agent has stopped (done, failed, taken over)', () => {
    expect(runLiveActivity({ ...run, status: 'paused' }, 'Dusty').display).toMatchObject({
      label: 'RUN · PAUSED',
      tone: 'warn',
      text: 'Dusty · Paused: Read Mara’s review · 38 of 41 passing',
      ongoing: true,
    });
    const done = runLiveActivity(
      {
        ...run,
        status: 'done',
        progress: 96,
        tests: { passed: 41, total: 41 },
        steps: run.steps.map((s) => ({ ...s, state: 'done' as const })),
      },
      'Dusty',
    );
    expect(done.ended).toBe(true);
    expect(done.display).toMatchObject({
      label: 'RUN · DONE',
      text: 'Dusty · Done · 41 of 41 passing',
      progress: 100,
      chip: null,
      ongoing: false,
    });
    expect(isRunActivityEnded({ status: 'failed' })).toBe(true);
    expect(isRunActivityEnded({ status: 'taken_over' })).toBe(true);
    expect(isRunActivityEnded({ status: 'paused' })).toBe(false);
    const noSteps = runLiveActivity({ ...run, steps: [], tests: null }, 'Dusty');
    expect(noSteps.display.text).toBe('Dusty · Working');
  });

  it('goes to the person who asked, or to the conversation’s people when an agent asked', () => {
    expect(
      runLiveActivityAudience({ askedById: mara.id, askedByAgent: false, conversationPeople: [] }),
    ).toEqual([mara.id]);
    expect(
      runLiveActivityAudience({
        askedById: dusty.id,
        askedByAgent: true,
        conversationPeople: [mara.id, mara.id],
      }),
    ).toEqual([mara.id]);
  });
});

describe('approval live activity', () => {
  it('stays up while approved and deploying, and ends once deployed or declined', () => {
    const decided = {
      state: 'approved' as const,
      decidedById: mara.id,
      decidedAt: at('11:40'),
      conditions: checksGreen().conditions.map((c) => ({ ...c, met: true })),
    };
    const deploying = approvalLiveActivity(
      deployApproval({
        ...decided,
        execution: { ...IDLE_EXECUTION, state: 'running', startedAt: at('11:40') },
      }),
      'Dusty',
    );
    expect(deploying.ended).toBe(false);
    expect(deploying.display).toMatchObject({
      label: 'APPROVED · DEPLOYING',
      tone: 'ok',
      text: 'Dusty · 3 of 3 conditions met',
      progress: 100,
      actions: ['details'],
      ongoing: true,
    });
    const deployed = deployApproval({
      ...decided,
      execution: { ...IDLE_EXECUTION, state: 'succeeded', startedAt: at('11:40') },
      executedAt: at('11:42'),
    });
    expect(isApprovalActivityEnded(deployed)).toBe(true);
    expect(approvalLiveActivity(deployed, 'Dusty').display).toMatchObject({
      label: 'DEPLOYED',
      chip: null,
      ongoing: false,
    });
    const declined = approvalLiveActivity(
      deployApproval({ state: 'declined', decidedById: mara.id, decidedAt: at('11:40') }),
      'Dusty',
    );
    expect(declined).toMatchObject({ ended: true, display: { label: 'DECLINED', tone: 'bad' } });
    const failed = deployApproval({
      ...decided,
      execution: { ...IDLE_EXECUTION, state: 'failed', startedAt: at('11:40'), error: 'Pods crashed.' },
    });
    expect(approvalLiveActivity(failed, 'Dusty')).toMatchObject({
      ended: true,
      display: { label: 'DEPLOY FAILED', tone: 'bad' },
    });
  });

  it('goes to the person_approves condition’s approvers', () => {
    expect(approvalLiveActivityAudience(deployApproval())).toEqual([mara.id]);
    expect(approvalLiveActivityAudience(deployApproval({ conditions: [] }))).toEqual([]);
  });
});

describe('live activity push', () => {
  it('carries the event, the contract object and the display, with a slug deep link', () => {
    const push = liveActivityPush(runLiveActivity(run, 'Dusty'), 'start', 'burrow-hq');
    expect(PushPayload.parse(push)).toEqual(push);
    expect(push).toMatchObject({
      burrow: 'burrow-hq',
      kind: 'run_progress',
      title: 'Dusty · Run #1907',
      path: '/burrow-hq/runs/1907',
      run: { number: 1907, status: 'live' },
      liveActivity: { event: 'start', activity: { runId: run.id }, display: { key: `run:${run.id}` } },
    });
    const approval = liveActivityPush(approvalLiveActivity(deployApproval(), 'Dusty'), 'update', 'burrow-hq');
    expect(PushPayload.parse(approval)).toEqual(approval);
    expect(approval).toMatchObject({
      kind: 'approval_updated',
      path: '/burrow-hq/log?approval=12',
      approval: { number: 12, state: 'pending', label: '0 of 3' },
    });
    expect(
      LiveActivityPush.safeParse({ event: 'end', activity: approval.liveActivity?.activity }).success,
    ).toBe(false);
  });
});
