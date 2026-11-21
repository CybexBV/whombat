import { describe, expect, it } from 'vitest';
import { plan } from '../__fixtures__/world.js';
import {
  type Activity,
  collapseActivity,
  describeActivity,
  LinkRef,
  linkPath,
  Plan,
  type PlanStep,
  planProgress,
  planStepActions,
  planStepControls,
  planStepRemovable,
  projectPlanStep,
  SearchResult,
  searchFilterOf,
  shouldApplyProjection,
  stepGoesAhead,
  workHealth,
} from './index.js';

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  id: 'stp_a',
  title: 'Build the export endpoint',
  state: 'active',
  stateLabel: 'In progress',
  runId: null,
  approvalId: null,
  automationRunId: null,
  dispatchId: null,
  note: null,
  updatedAt: null,
  refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
  ...over,
});
const names = (id: string) => (id === 'prn_mara' ? 'Mara' : 'Someone');

describe('plans (WS-02, WS-05, WS-07)', () => {
  it('parses a plan from before 0.12 with the new fields defaulted', () => {
    const { createdById, createdAt, source, messageId, ...old } = plan;
    const oldSteps = old.steps.map(({ automationRunId, dispatchId, note, updatedAt, refs, ...s }) => s);
    const parsed = Plan.parse({ ...old, steps: oldSteps });
    expect(parsed.source).toBeNull();
    expect(parsed.steps[0]?.note).toBeNull();
    expect(parsed.steps[0]?.automationRunId).toBeNull();
  });

  it('counts progress without cancelled steps', () => {
    expect(planProgress({ steps: [step({ state: 'done' }), step({ state: 'cancelled' }), step()] })).toEqual({
      done: 1,
      total: 2,
    });
  });

  it('a failed run blocks the step, never completes it or leaves it active', () => {
    const p = projectPlanStep(step(), {
      run: { id: 'run_1', number: 7, status: 'failed', takenOverById: null },
    });
    expect(p).toMatchObject({ state: 'blocked', stateLabel: 'Run failed', followKey: 'run:run_1:failed' });
    expect(p?.note).toMatch(/^Run #7 failed\./);
  });

  it('a takeover is not completion and names the person', () => {
    const p = projectPlanStep(
      step(),
      {
        run: { id: 'run_1', number: 7, status: 'taken_over', takenOverById: 'prn_mara' },
      },
      names,
    );
    expect(p).toMatchObject({ state: 'active', stateLabel: 'Taken over' });
    expect(p).not.toHaveProperty('ownerId');
    expect(p?.note).toBe('Mara took over Run #7.');
  });

  it('a paused run blocks, a live run is in progress, a done run is done', () => {
    const r = (status: 'live' | 'paused' | 'done') => ({
      id: 'run_1',
      number: 7,
      status,
      takenOverById: null,
    });
    expect(projectPlanStep(step(), { run: r('live') })?.state).toBe('active');
    expect(projectPlanStep(step(), { run: r('paused') })?.state).toBe('blocked');
    expect(projectPlanStep(step(), { run: r('done') })?.state).toBe('done');
  });

  it('an unfinished run wins over an approval; a finished one lets the approval gate the step', () => {
    const approval = { id: 'apr_1', number: 12, step: { state: 'gate' as const, label: 'Needs a person' } };
    const live = { id: 'run_1', number: 7, status: 'live' as const, takenOverById: null };
    expect(projectPlanStep(step(), { run: live, approval })?.stateLabel).toBe('In progress');
    expect(projectPlanStep(step(), { run: { ...live, status: 'done' }, approval })).toMatchObject({
      state: 'gate',
      stateLabel: 'Needs a person',
    });
    expect(
      projectPlanStep(step(), { approval: { ...approval, step: { state: 'blocked', label: 'Declined' } } }),
    ).toMatchObject({ state: 'blocked', note: 'Approval #12 was declined. Ask again.' });
  });

  it('follows automation runs and dispatches', () => {
    const a = (status: 'running' | 'succeeded' | 'failed' | 'needs_review') => ({
      id: 'arn_1',
      number: 3,
      status,
    });
    expect(projectPlanStep(step(), { automationRun: a('running') })?.stateLabel).toBe('Running');
    expect(projectPlanStep(step(), { automationRun: a('succeeded') })?.state).toBe('done');
    expect(projectPlanStep(step(), { automationRun: a('failed') })?.state).toBe('blocked');
    expect(projectPlanStep(step(), { automationRun: a('needs_review') })?.state).toBe('gate');
    const d = (state: 'queued' | 'running' | 'done' | 'failed') => ({ id: 'dsp_1', state, hasRun: false });
    expect(projectPlanStep(step(), { dispatch: d('queued') })?.stateLabel).toBe('Asked');
    expect(projectPlanStep(step(), { dispatch: d('running') })?.stateLabel).toBe('Working');
    expect(projectPlanStep(step(), { dispatch: d('done') })).toMatchObject({
      state: 'gate',
      stateLabel: 'Check result',
    });
    // The agent marked its step done in the turn: the finished turn doesn't reopen it.
    expect(projectPlanStep(step({ state: 'done' }), { dispatch: d('done') })).toBeNull();
    expect(projectPlanStep(step(), { dispatch: d('failed') })?.state).toBe('blocked');
    // A turn that started a run defers to the run.
    expect(projectPlanStep(step(), { dispatch: { id: 'dsp_1', state: 'done', hasRun: true } })).toBeNull();
  });

  it('applies each projection once and keeps a manual done for the same work', () => {
    const failed = projectPlanStep(step(), {
      run: { id: 'run_1', number: 7, status: 'failed', takenOverById: null },
    });
    if (!failed) throw new Error('no projection');
    expect(shouldApplyProjection({ state: 'active', followKey: 'run:run_1:live' }, failed)).toBe(true);
    // The same event again (or out of order after it was applied): nothing to do.
    expect(shouldApplyProjection({ state: 'blocked', followKey: 'run:run_1:failed' }, failed)).toBe(false);
    // Someone marked the step done while the run was live; the run failing later doesn't undo that.
    expect(shouldApplyProjection({ state: 'done', followKey: 'run:run_1:live' }, failed)).toBe(false);
    // A new run (another link) applies again.
    expect(shouldApplyProjection({ state: 'done', followKey: 'run:run_0:done' }, failed)).toBe(true);
  });

  it('removes only steps that never started', () => {
    expect(planStepRemovable(step({ state: 'queued' }))).toBe(true);
    expect(planStepRemovable(step({ state: 'queued', runId: 'run_1' }))).toBe(false);
    expect(planStepRemovable({ ...step({ state: 'queued' }), followKey: 'dispatch:dsp_1:failed' })).toBe(
      false,
    );
    expect(planStepRemovable(step({ state: 'done' }))).toBe(false);
  });

  it('offers next actions by state', () => {
    expect(planStepActions(step({ state: 'queued' }))).toContain('start');
    expect(planStepActions(step({ state: 'blocked', runId: 'run_1' }))).toEqual([
      'retry',
      'open_work',
      'cancel',
    ]);
    expect(planStepActions(step({ state: 'done' }))).toEqual([]);
  });

  it('shows buttons only where the person is needed; the rest is in the step’s menu', () => {
    expect(planStepControls(step({ state: 'queued' }))).toEqual({
      buttons: [],
      more: ['start', 'mark_done', 'cancel'],
    });
    expect(planStepControls(step({ state: 'active', runId: 'run_1' }))).toEqual({
      buttons: ['open_work'],
      more: ['mark_done', 'cancel'],
    });
    expect(planStepControls(step({ state: 'gate' }))).toEqual({
      buttons: ['retry'],
      more: ['mark_done', 'cancel'],
    });
    expect(planStepControls(step({ state: 'blocked', runId: 'run_1' }))).toEqual({
      buttons: ['retry', 'open_work'],
      more: ['cancel'],
    });
  });

  it('a step waiting only for a person’s word goes ahead first', () => {
    expect(stepGoesAhead(step({ state: 'gate' }))).toBe(true);
    expect(planStepActions(step({ state: 'gate' }))[0]).toBe('retry');
    expect(stepGoesAhead(step({ state: 'gate', approvalId: 'apr_1' }))).toBe(false);
    expect(planStepActions(step({ state: 'gate', approvalId: 'apr_1' }))[0]).toBe('open_work');
    expect(stepGoesAhead(step({ state: 'blocked' }))).toBe(false);
  });
});

describe('links and search types (WS-09, WS-21)', () => {
  it('links to a plan step in its conversation and to automation runs', () => {
    const link = LinkRef.parse({
      type: 'plan',
      planId: 'pln_invoice-pdf',
      stepId: 'stp_pdf-2',
      in: { type: 'dm' },
    });
    expect(linkPath('burrow-hq', link)).toBe('/burrow-hq/chat?plan=pln_invoice-pdf&step=stp_pdf-2');
    expect(
      linkPath('burrow-hq', { type: 'plan', planId: 'pln_x', in: { type: 'pr', number: 482, tab: 'files' } }),
    ).toBe('/burrow-hq/pr/482?plan=pln_x');
    expect(linkPath('burrow-hq', { type: 'automation_run', number: 4 })).toBe('/burrow-hq/automation-runs/4');
    expect(linkPath('burrow-hq', { type: 'work' })).toBe('/burrow-hq/work');
  });

  it('files the new result types under their chips and defaults status', () => {
    expect(searchFilterOf('PLAN')).toBe('plans');
    expect(searchFilterOf('DECISION')).toBe('decisions');
    expect(searchFilterOf('AUTOMATION')).toBe('automations');
    const r = SearchResult.parse({
      id: 'apr_1',
      type: 'DECISION',
      where: 'Chat · approval #12',
      authorId: 'prn_dusty',
      snippet: 'Deploy feat/invoice-pdf to staging',
      citedAs: null,
      link: { type: 'approval', number: 12 },
      createdAt: '2026-09-23T09:30:00.000Z',
    });
    expect(r.status).toBeNull();
  });
});

const row = (over: Partial<Activity>): Activity => ({
  id: 'act_1',
  burrowId: 'bur_x',
  dispatchId: 'dsp_1',
  runId: null,
  agentId: 'prn_dusty',
  conversationId: 'cnv_x',
  threadRootId: null,
  key: '1:toolu_1',
  attempt: 1,
  seq: 0,
  kind: 'read',
  tool: 'Read',
  status: 'done',
  title: 'Read a.ts',
  object: 'src/a.ts',
  detail: null,
  important: false,
  approvalId: null,
  link: null,
  evidence: null,
  startedAt: '2026-09-23T09:30:00.000Z',
  updatedAt: '2026-09-23T09:30:00.000Z',
  finishedAt: '2026-09-23T09:30:01.000Z',
  ...over,
});

describe('activity copy and collapsing (WS-13, WS-17)', () => {
  const base = {
    tool: 'Edit',
    object: 'billing/pdf/invoice.ts',
    exitCode: null,
    failure: null,
    keyNeeded: null,
  };
  it('says only what the provider reported', () => {
    expect(describeActivity({ ...base, kind: 'edit', status: 'running' }).title).toBe('Editing invoice.ts');
    expect(describeActivity({ ...base, kind: 'edit', status: 'done' })).toEqual({
      title: 'Edited invoice.ts',
      detail: null,
      important: true,
    });
    expect(describeActivity({ ...base, kind: 'edit', status: 'failed', failure: 'error' }).title).toBe(
      'Couldn’t edit invoice.ts',
    );
    const cmd = { ...base, kind: 'command' as const, tool: 'Bash', object: 'pnpm test billing/pdf' };
    expect(describeActivity({ ...cmd, status: 'done', exitCode: 0 }).title).toBe('Ran pnpm test billing/pdf');
    expect(describeActivity({ ...cmd, status: 'failed', exitCode: 1 })).toMatchObject({
      title: 'Command failed',
      detail: 'exit 1',
    });
    expect(describeActivity({ ...cmd, status: 'interrupted' }).title).toBe(
      'Ran pnpm test billing/pdf · interrupted',
    );
    expect(
      describeActivity({ ...base, kind: 'whombat', tool: 'whombat.request_approval', status: 'waiting' })
        .title,
    ).toBe('Waiting for approval');
    expect(
      describeActivity({ ...base, kind: 'whombat', tool: 'whombat.connection_call', status: 'running' })
        .title,
    ).not.toContain('connection_call');
    expect(
      describeActivity({
        ...base,
        kind: 'whombat',
        tool: 'whombat.merge_pull_request',
        status: 'failed',
        failure: 'blocked',
        keyNeeded: 'Merge into main',
      }).title,
    ).toBe('Blocked · needs Merge into main');
    expect(describeActivity({ ...base, kind: 'read', tool: 'Read', status: 'done' }).important).toBe(false);
  });

  it('collapses consecutive routine reads of one turn and keeps important rows', () => {
    const entries = collapseActivity([
      row({ id: 'act_1' }),
      row({ id: 'act_2', kind: 'search', tool: 'Grep' }),
      row({ id: 'act_3' }),
      row({ id: 'act_4', kind: 'edit', important: true, title: 'Edited a.ts' }),
      row({ id: 'act_5' }),
      row({ id: 'act_6', dispatchId: 'dsp_2' }),
    ]);
    expect(entries.map((e) => (e.type === 'group' ? e.title : e.activity.id))).toEqual([
      'Read 2 files and ran 1 search',
      'act_4',
      'act_5',
      'act_6',
    ]);
  });
});

describe('bookkeeping and connector copy (0.12.1)', () => {
  it('folds a run’s routine updates, keeps its failures and decisions', () => {
    const w = (tool: string, over: Partial<Activity> = {}) =>
      row({ kind: 'whombat', tool: `whombat.${tool}`, important: false, ...over });
    const entries = collapseActivity([
      w('run_step'),
      w('run_log'),
      w('run_files'),
      row({ id: 'act_r' }),
      w('finish_run', { id: 'act_f', important: true }),
      w('set_status', { id: 'act_s' }),
    ]);
    expect(entries.map((e) => (e.type === 'group' ? e.title : e.activity.id))).toEqual([
      'Read 1 file and made 3 routine updates',
      'act_f',
      'act_s',
    ]);
    const base = { object: null, exitCode: null, failure: null, keyNeeded: null } as const;
    expect(
      describeActivity({ ...base, kind: 'whombat', tool: 'whombat.run_log', status: 'done' }).important,
    ).toBe(false);
    expect(
      describeActivity({
        ...base,
        kind: 'whombat',
        tool: 'whombat.run_log',
        status: 'failed',
        failure: 'error',
      }).important,
    ).toBe(true);
    expect(
      describeActivity({ ...base, kind: 'whombat', tool: 'whombat.finish_run', status: 'done' }).important,
    ).toBe(true);
  });

  it('names connector tools in plain words', () => {
    const base = { kind: 'whombat' as const, object: null, exitCode: null, failure: null, keyNeeded: null };
    expect(describeActivity({ ...base, tool: 'whombat.mail_search', status: 'done' }).title).toBe(
      'Searched mail',
    );
    expect(describeActivity({ ...base, tool: 'whombat.mail_send', status: 'running' }).title).toBe(
      'Sending an email',
    );
    expect(describeActivity({ ...base, tool: 'whombat.mail_send', status: 'waiting' }).title).toBe(
      'Waiting for approval',
    );
  });
});

describe('work health (WS-19)', () => {
  const now = new Date('2026-09-23T10:00:00.000Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  it('tells progress, quiet, waiting and stalled apart', () => {
    expect(workHealth({ now, heartbeatAt: ago(0), lastProgressAt: ago(1), leaseMs: 60_000 }).state).toBe(
      'progressing',
    );
    const quiet = workHealth({ now, heartbeatAt: ago(0), lastProgressAt: ago(6), leaseMs: 60_000 });
    expect(quiet).toMatchObject({ state: 'quiet', text: 'Working quietly · last step 6 min ago' });
    expect(
      workHealth({ now, heartbeatAt: ago(0), lastProgressAt: null, leaseMs: 60_000, waiting: 'approval' })
        .text,
    ).toBe('Waiting for approval');
    expect(workHealth({ now, heartbeatAt: ago(3), lastProgressAt: ago(3), leaseMs: 60_000 })).toMatchObject({
      state: 'stalled',
      text: 'No word from the runner for 3 min',
    });
  });
});
