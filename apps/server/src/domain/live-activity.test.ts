import type { Approval, ChecksPassCondition, PushPayload, ReviewApprovedCondition, Run } from '@whombat/core';
import { IDLE_EXECUTION } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { PushDevice } from '../push/types';
import { LiveActivityBroadcaster, THROTTLE_MS } from './live-activity';

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1907',
    number: 1907,
    burrowId: 'burrow_1',
    agentId: 'prn_dusty',
    title: 'Fix invoice PDF export',
    branch: 'feat/invoice-pdf',
    repoId: null,
    prNumber: null,
    status: 'live',
    askedById: 'prn_dusty',
    conversationId: 'conv_1',
    messageId: 'msg_1',
    startedAt: '2026-09-23T09:00:00.000Z',
    finishedAt: null,
    progress: 40,
    activity: 'Running tests',
    summary: null,
    steps: [],
    tests: null,
    files: [],
    diff: { add: 0, del: 0, files: 0 },
    keysUsed: [],
    logCount: 0,
    pausedById: null,
    takenOverById: null,
    ...overrides,
  };
}

function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval_12',
    number: 12,
    burrowId: 'burrow_1',
    requesterId: 'prn_dusty',
    keyId: 'deploy.staging',
    action: {
      type: 'deploy',
      params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
    },
    title: 'Deploy feat/invoice-pdf to staging',
    question: 'Deploy feat/invoice-pdf to staging?',
    target: 'staging · billing-api',
    whatHappens: ['Deploys to staging.'],
    explainer: '',
    summary: '',
    conditions: [
      {
        id: 'person',
        kind: 'person_approves',
        label: 'A person says yes',
        met: false,
        approverIds: ['prn_dusty', 'prn_mara'],
      },
    ],
    state: 'pending',
    decidedById: null,
    decidedAt: null,
    execution: IDLE_EXECUTION,
    executedAt: null,
    conversationId: 'conv_1',
    messageId: 'msg_2',
    involvedIds: [],
    eventId: 'event_1',
    createdAt: '2026-09-23T09:00:00.000Z',
    ...overrides,
  };
}

const device: PushDevice = { id: 'device_1', provider: 'fcm', token: 'tok', webPush: null };

const checks: ChecksPassCondition = {
  id: 'checks',
  kind: 'checks_pass',
  label: 'Checks pass on the latest commit',
  met: false,
  prNumber: 482,
  headSha: '7be20f',
  state: 'passed',
  passed: 41,
  total: 41,
  fixing: false,
};
const review: ReviewApprovedCondition = {
  id: 'review',
  kind: 'review_approved',
  label: 'Dusty approves the PR',
  met: false,
  prNumber: 482,
  reviewerId: 'prn_dusty',
  reviewState: 'approved',
  reviewedAt: '2026-09-23T09:38:00.000Z',
};

function fakePush(sent: { devices: PushDevice[]; payload: PushPayload }[]) {
  return {
    sendAll: async (devices: PushDevice[], payload: PushPayload) => {
      sent.push({ devices, payload });
      return devices.map(() => 'sent' as const);
    },
  } as never;
}

/** Always returns `devices` regardless of activity kind / ref / recipients — the db lookups aren’t under test. */
function fakeDeviceLookup(devices: PushDevice[], audience: string[][] = []) {
  return {
    devices: async (_db: unknown, _kind: unknown, _ref: unknown, recipients: readonly string[]) => {
      audience.push([...recipients]);
      return devices;
    },
    name: async () => 'Dusty',
    runAudience: async (_db: unknown, run: Run) => [run.askedById],
  };
}

describe('LiveActivityBroadcaster', () => {
  it('writes the activity in the burrow owner’s language, read when it is sent', async () => {
    const sent: { devices: PushDevice[]; payload: PushPayload }[] = [];
    const asked: string[] = [];
    const broadcaster = new LiveActivityBroadcaster(null as never, fakePush(sent), () => new Date(0), {
      ...fakeDeviceLookup([device]),
      locale: async (_db, burrowId) => {
        asked.push(burrowId);
        return 'nl-NL';
      },
    });
    const run = baseRun({
      status: 'live',
      steps: [{ title: 'Tests draaien', detail: '', at: '2026-09-23T09:01:00.000Z', state: 'active' }],
    });
    await broadcaster.onRunChanged(run, 'Dusty', 'burrow-hq');
    const runPush = sent[0]?.payload;
    expect(runPush?.title).toContain('Uitvoering #1907');
    expect(runPush?.liveActivity?.display.text).toContain('Nu: Tests draaien');

    const conditions = [...baseApproval().conditions, { ...checks, met: true }];
    await broadcaster.onApprovalChanged(baseApproval({ conditions }), 'burrow-hq');
    const approvalPush = sent[1]?.payload;
    expect(approvalPush?.title).toContain('Goedkeuring #12');
    expect(approvalPush?.approval?.label).toBe('1 van 2');
    expect(approvalPush?.liveActivity?.display.text).toContain('1 van 2');
    expect(asked).toEqual(['burrow_1', 'burrow_1']);
  });

  it('stays English when the owner has no language set', async () => {
    const sent: { devices: PushDevice[]; payload: PushPayload }[] = [];
    const broadcaster = new LiveActivityBroadcaster(
      null as never,
      fakePush(sent),
      () => new Date(0),
      fakeDeviceLookup([device]),
    );
    await broadcaster.onApprovalChanged(baseApproval(), 'burrow-hq');
    expect(sent[0]?.payload.title).toContain('Approval #12');
    expect(sent[0]?.payload.approval?.label).toBe('0 of 1');
  });

  it('managed: never wakes the phone through control (NT-13)', async () => {
    const control = vi.fn(async () => {});
    const push = { sendAll: async () => [], control } as never;
    const broadcaster = new LiveActivityBroadcaster(
      null as never,
      push,
      () => new Date(0),
      fakeDeviceLookup([]),
    );
    await broadcaster.onRunChanged(baseRun({ status: 'live' }), 'Dusty', 'burrow-hq');
    await broadcaster.onRunChanged(baseRun({ status: 'done' }), 'Dusty', 'burrow-hq');
    await broadcaster.onApprovalChanged(baseApproval(), 'burrow-hq');
    expect(control).not.toHaveBeenCalled();
  });

  it('run: start on first sight, throttles updates within 2s, always ends immediately (demo: run → done)', async () => {
    const sent: { devices: PushDevice[]; payload: PushPayload }[] = [];
    let now = 0;
    const broadcaster = new LiveActivityBroadcaster(
      null as never,
      fakePush(sent),
      () => new Date(now),
      fakeDeviceLookup([device]),
    );

    await broadcaster.onRunChanged(baseRun({ status: 'live', progress: 10 }), 'Dusty', 'burrow-hq');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.liveActivity?.event).toBe('start');

    // An update 500ms later waits (inside the 2s throttle window).
    now += 500;
    await broadcaster.onRunChanged(baseRun({ status: 'live', progress: 40 }), 'Dusty', 'burrow-hq');
    expect(sent).toHaveLength(1);

    // An update after the throttle window goes through.
    now += THROTTLE_MS;
    await broadcaster.onRunChanged(baseRun({ status: 'live', progress: 70 }), 'Dusty', 'burrow-hq');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload.liveActivity?.event).toBe('update');

    // Done ends the activity immediately, even mid-throttle-window.
    now += 100;
    await broadcaster.onRunChanged(baseRun({ status: 'done', progress: 100 }), 'Dusty', 'burrow-hq');
    expect(sent).toHaveLength(3);
    expect(sent[2]?.payload.liveActivity?.event).toBe('end');

    // Nothing further to end: a second "done" event for the same run is a no-op (already ended).
    now += 100;
    await broadcaster.onRunChanged(baseRun({ status: 'done', progress: 100 }), 'Dusty', 'burrow-hq');
    expect(sent).toHaveLength(3);
  });

  it('a declined approval that was never seen pending is not broadcast at all', async () => {
    const sent: { devices: PushDevice[]; payload: PushPayload }[] = [];
    const broadcaster = new LiveActivityBroadcaster(
      null as never,
      fakePush(sent),
      () => new Date(0),
      fakeDeviceLookup([device]),
    );
    await broadcaster.onApprovalChanged(baseApproval({ state: 'declined' }), 'burrow-hq');
    expect(sent).toHaveLength(0);
  });

  it('sends the last throttled update when the window closes, and never after the end', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const sent: { devices: PushDevice[]; payload: PushPayload }[] = [];
      const broadcaster = new LiveActivityBroadcaster(
        null as never,
        fakePush(sent),
        () => new Date(),
        fakeDeviceLookup([device]),
      );
      const conditions = baseApproval().conditions;
      await broadcaster.onApprovalChanged(baseApproval(), 'burrow-hq');
      // Two changes inside the window (checks green, then the review): neither goes out yet…
      await vi.advanceTimersByTimeAsync(300);
      await broadcaster.onApprovalChanged(
        baseApproval({ conditions: [...conditions, { ...checks, met: true }] }),
        'burrow-hq',
      );
      await vi.advanceTimersByTimeAsync(300);
      await broadcaster.onApprovalChanged(
        baseApproval({ conditions: [...conditions, { ...checks, met: true }, { ...review, met: true }] }),
        'burrow-hq',
      );
      expect(sent).toHaveLength(1);
      // …the latest goes out when the window closes.
      await vi.advanceTimersByTimeAsync(THROTTLE_MS);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.payload.liveActivity).toMatchObject({
        event: 'update',
        display: { text: 'Dusty · 2 of 3 conditions met' },
      });
      // A pending update is dropped when the activity ends first.
      await broadcaster.onApprovalChanged(baseApproval({ state: 'pending' }), 'burrow-hq');
      await broadcaster.onApprovalChanged(baseApproval({ state: 'declined' }), 'burrow-hq');
      await vi.advanceTimersByTimeAsync(THROTTLE_MS * 2);
      expect(sent.map((s) => s.payload.liveActivity?.event)).toEqual(['start', 'update', 'end']);
    } finally {
      vi.useRealTimers();
    }
  });
});
