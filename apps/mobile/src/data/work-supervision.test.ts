/**
 * Work supervision on Android (work-supervision WS-09, WS-13…WS-19, WS-21): the plan screen, the work overview's rows
 * (the Inbox's NEEDS YOU; the Work screen is gone, work-removal-android.md AP-856), the run's activity feed, search
 * chips and where the new links open. Against the shared work fixture world (the web's and the app's fixture mode).
 */
import { createWorkFixtures } from '@whombat/client/work-fixtures';
import { type Activity, linkPath, type Plan, type PlanStep } from '@whombat/core';
import { bootstrap, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { appUrlForPath, LINKING_SCREENS, routeForLink, stripLinkedActionParams } from '../navigation/routes';
import { worldContext } from '../test/world';
import { ACTIVITY_TRUNCATED_TEXT, activityRow, activitySection } from './activity';
import { cardSummary } from './messages';
import {
  openWorkRoute,
  planScreen,
  planStepButtons,
  planStepCommand,
  planStepMore,
  planStepView,
} from './plan';

const ctx = worldContext();
const fixtures = () => createWorkFixtures({ now: () => SEED_NOW });

async function get<T>(fx: ReturnType<typeof fixtures>, path: string): Promise<T> {
  const res = await fx.handle(new Request(`http://fixtures.local/api/v1/burrows/burrow-hq${path}`));
  if (!res) throw new Error(`no fixture for ${path}`);
  return (await res.json()) as T;
}

const seedPlan = (): Plan => {
  const plan = fixtures().plans()[0];
  if (!plan) throw new Error('no seeded plan');
  return plan;
};

function stepOf(over: Partial<PlanStep>): PlanStep {
  return {
    id: 'stp_x',
    title: 'Export the ledger',
    state: 'queued',
    stateLabel: 'Queued',
    runId: null,
    approvalId: null,
    automationRunId: null,
    dispatchId: null,
    note: null,
    updatedAt: null,
    refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    ...over,
  };
}

describe('plan screen', () => {
  it('shows the card’s header, and progress without cancelled steps', () => {
    const plan = seedPlan();
    const model = planScreen(plan);
    expect(model.label).toBe('PLAN · 4 STEPS');
    expect(model.due).toBe('Due 14 Oct');
    expect(model.title).toBe('Invoice PDF export');
    expect(model.progressText).toBe('1 of 4 done');
    expect(model.progress).toBe(25);

    const withCancelled: Plan = {
      ...plan,
      steps: plan.steps.map((s, i) => (i === 2 ? { ...s, state: 'cancelled', stateLabel: 'Cancelled' } : s)),
    };
    const cancelled = planScreen(withCancelled);
    expect(cancelled.progressText).toBe('1 of 3 done');
    expect(cancelled.label).toBe('PLAN · 4 STEPS');
  });

  it('draws each state’s marker, title and label tone like the web card', () => {
    const plan = seedPlan();
    const view = (over: Partial<PlanStep>) => planStepView(stepOf(over), plan);
    expect(view({ state: 'done' })).toMatchObject({ marker: 'done', stateTone: 'ok', titleStyle: 'muted' });
    expect(view({ state: 'active' })).toMatchObject({
      marker: 'active',
      stateTone: 'ink2',
      titleStyle: 'normal',
    });
    expect(view({ state: 'queued' })).toMatchObject({
      marker: 'queued',
      stateTone: 'mut',
      titleStyle: 'normal',
    });
    expect(view({ state: 'gate' })).toMatchObject({
      marker: 'gate',
      stateTone: 'warn',
      markerLabel: 'Needs a person',
    });
    expect(view({ state: 'blocked' })).toMatchObject({
      marker: 'blocked',
      stateTone: 'bad',
      markerLabel: 'Blocked',
    });
    expect(view({ state: 'cancelled' })).toMatchObject({
      marker: 'cancelled',
      stateTone: 'mut',
      titleStyle: 'struck',
    });
  });

  it('keeps the note under the step and names no owner (the agent’s own work, AP-4990)', () => {
    const plan = seedPlan();
    const v = planStepView(
      stepOf({ state: 'blocked', stateLabel: 'Run failed', note: 'Run #1907 failed. Retry it.' }),
      plan,
    );
    expect(v.note).toBe('Run #1907 failed. Retry it.');
    expect(v).not.toHaveProperty('ownerId');
    expect(v).not.toHaveProperty('handoff');
    expect(v.accessibilityLabel).toContain('Export the ledger');
    expect(v.accessibilityLabel).toContain('Run failed');
  });

  it('links to the run, approval and automation run by number', () => {
    const plan = seedPlan();
    const v = planStepView(
      stepOf({
        state: 'blocked',
        runId: 'run_1907',
        approvalId: 'apr_x',
        automationRunId: 'arn_x',
        refs: { runNumber: 1907, approvalNumber: 12, automationRunNumber: 41 },
      }),
      plan,
      'Plan',
    );
    expect(v.links.map((l) => l.label)).toEqual(['Run #1907', 'Approval #12', 'Automation run #41']);
    expect(v.links.map((l) => l.route)).toEqual([
      { name: 'Run', params: { number: 1907, back: 'Plan' } },
      { name: 'Approval', params: { number: 12, back: 'Plan' } },
      { name: 'AutomationRun', params: { number: 41, back: 'Plan' } },
    ]);
  });

  it('opens the approval of a gate step first, the run otherwise, the conversation for a turn without a run', () => {
    const refs = { runNumber: 1907, approvalNumber: 12, automationRunNumber: null };
    expect(
      openWorkRoute(stepOf({ state: 'gate', approvalId: 'a', runId: 'r', refs }), 'cnv_dm-dusty'),
    ).toEqual({
      name: 'Approval',
      params: { number: 12 },
    });
    expect(
      openWorkRoute(stepOf({ state: 'active', approvalId: 'a', runId: 'r', refs }), 'cnv_dm-dusty'),
    ).toEqual({
      name: 'Run',
      params: { number: 1907 },
    });
    expect(openWorkRoute(stepOf({ state: 'active', dispatchId: 'dsp_x' }), 'cnv_dm-dusty')).toEqual({
      name: 'Conversation',
      params: { conversationId: 'cnv_dm-dusty' },
    });
    expect(openWorkRoute(stepOf({ state: 'queued' }), 'cnv_dm-dusty')).toBeNull();
  });

  it('shows buttons only where the person is needed; Start, Mark done and Cancel are in the ⋯ menu', () => {
    const labels = (s: PlanStep) => planStepButtons(s, true).map((b) => `${b.action}:${b.variant}`);
    // A step the agent is getting to: no buttons, its menu has the rest.
    expect(labels(stepOf({ state: 'queued' }))).toEqual([]);
    expect(planStepMore(stepOf({ state: 'queued' })).map((b) => b.label)).toEqual([
      'Start',
      'Mark done',
      'Cancel step',
    ]);
    expect(labels(stepOf({ state: 'blocked', runId: 'r' }))).toEqual([
      'retry:primary',
      'open_work:secondary',
    ]);
    expect(labels(stepOf({ state: 'active', runId: 'r' }))).toEqual(['open_work:primary']);
    expect(planStepMore(stepOf({ state: 'active', runId: 'r' })).map((b) => b.action)).toEqual([
      'mark_done',
      'cancel',
    ]);
    expect(labels(stepOf({ state: 'done' }))).toEqual([]);
    expect(planStepMore(stepOf({ state: 'done' }))).toEqual([]);
    // Nothing to open: no “Open work”.
    expect(planStepButtons(stepOf({ state: 'blocked' }), false).map((b) => b.action)).toEqual(['retry']);
  });

  it('a step waiting only for the person’s word goes ahead first', () => {
    const waiting = stepOf({ state: 'gate', approvalId: null, runId: null, automationRunId: null });
    const [first] = planStepButtons(waiting, true);
    expect(first).toMatchObject({ action: 'retry', label: 'Go ahead', variant: 'primary' });
    expect(planStepButtons(stepOf({ state: 'blocked' }), false)[0]?.label).toBe('Retry');
  });

  it('leaves “Open work” to the link rows when there are some', () => {
    const plan = seedPlan();
    const linked = planStepView(
      stepOf({
        state: 'active',
        runId: 'run_1907',
        refs: { runNumber: 1907, approvalNumber: null, automationRunNumber: null },
      }),
      plan,
    );
    expect(linked.buttons).toEqual([]);
    expect(linked.more.map((b) => b.action)).toEqual(['mark_done', 'cancel']);
    const asked = planStepView(stepOf({ state: 'active', dispatchId: 'dsp_x' }), plan);
    expect(asked.links).toEqual([]);
    expect(asked.buttons.map((b) => b.action)).toEqual(['open_work']);
  });

  it('maps actions to plan writes', () => {
    const openWork = { name: 'Run', params: { number: 1907 } } as const;
    expect(planStepCommand('start', { openWork: null })).toEqual({ kind: 'start' });
    expect(planStepCommand('retry', { openWork: null })).toEqual({ kind: 'start' });
    expect(planStepCommand('mark_done', { openWork: null })).toEqual({ kind: 'update', state: 'done' });
    expect(planStepCommand('cancel', { openWork: null })).toEqual({ kind: 'update', state: 'cancelled' });
    expect(planStepCommand('open_work', { openWork })).toEqual({ kind: 'open', route: openWork });
    expect(planStepCommand('open_work', { openWork: null })).toBeNull();
  });

  it('the chat’s plan card counts done without cancelled steps and carries the plan id', () => {
    const plan = seedPlan();
    const card = cardSummary(
      {
        kind: 'plan',
        plan: { ...plan, steps: plan.steps.map((s, i) => (i === 1 ? { ...s, state: 'cancelled' } : s)) },
      },
      ctx,
    );
    expect(card).toMatchObject({ label: 'PLAN · 4 STEPS', detail: '1 of 3 done', planId: 'pln_invoice-pdf' });
  });

  it('the plan card’s head names the step it is on and folds every step under it', () => {
    const plan = seedPlan();
    const head = cardSummary({ kind: 'plan', plan }, ctx)?.head;
    // What waits for the person comes before the step at work.
    const focus = plan.steps.find((s) => s.state === 'gate');
    expect(head).toMatchObject({ title: plan.title, kind: 'Plan' });
    expect(head?.callout?.text).toBe(focus?.title);
    expect(head?.steps.map((s) => s.id)).toEqual(plan.steps.map((s) => s.id));
    expect(head?.time).toMatch(/^\d\d:\d\d$/);
  });
});

describe('run activity', () => {
  it('collapses routine reads and keeps important rows, oldest first', async () => {
    const res = await get<{ activities: Activity[] }>(fixtures(), '/activity?runNumber=1907');
    const model = activitySection(res, SEED_NOW, SEED_TIME_ZONE);
    expect(model.entries.map((e) => (e.type === 'row' ? e.row.title : `[${e.title}]`))).toEqual([
      'Read the conversation',
      '[Read 3 files and ran 1 search]',
      'Edited format.ts',
      'Command failed',
      'Edited vat.ts',
      'Running pnpm test billing/pdf',
    ]);
    const group = model.entries[1];
    expect(group?.type === 'group' ? group.rows.map((r) => r.title) : []).toEqual([
      'Read format.ts',
      'Read invoice.ts',
      'Searched for roundVat',
      'Read vat.ts',
    ]);
    const failed = model.entries[3];
    expect(failed?.type === 'row' ? failed.row : null).toMatchObject({
      dot: 'bad',
      statusLabel: 'Failed',
      detail: 'exit 1',
      object: 'pnpm test billing/pdf',
      time: 'just now',
      evidence: { input: 'pnpm test billing/pdf', truncated: true },
    });
    const running = model.entries[5];
    expect(running?.type === 'row' ? running.row.dot : null).toBe('live');
    expect(ACTIVITY_TRUNCATED_TEXT).toBe('Shortened to fit · the rest isn’t kept.');
  });

  it('shows nothing for a turn with no steps yet', async () => {
    const res = await get<{ activities: Activity[] }>(fixtures(), '/activity?runNumber=1882');
    expect(activitySection(res, SEED_NOW, SEED_TIME_ZONE)).toEqual({ entries: [] });
    expect(activitySection(undefined, SEED_NOW, SEED_TIME_ZONE)).toEqual({ entries: [] });
  });

  it('shows an interrupted row muted with the title as given, and waiting in warn', async () => {
    const res = await get<{ activities: Activity[] }>(fixtures(), '/activity?runNumber=1907');
    const base = res.activities[8] as Activity;
    const interrupted = activityRow(
      { ...base, status: 'interrupted', title: 'Interrupted · the turn stopped', evidence: null },
      SEED_NOW,
      SEED_TIME_ZONE,
    );
    expect(interrupted).toMatchObject({
      dot: 'mut',
      title: 'Interrupted · the turn stopped',
      statusLabel: 'Interrupted',
      evidence: null,
    });
    expect(activityRow({ ...base, status: 'waiting' }, SEED_NOW, SEED_TIME_ZONE).dot).toBe('warn');
    expect(activityRow({ ...base, status: 'done' }, SEED_NOW, SEED_TIME_ZONE).dot).toBe('ok');
    // Evidence with neither input nor output is no evidence.
    expect(
      activityRow(
        { ...base, evidence: { input: null, output: null, truncated: false } },
        SEED_NOW,
        SEED_TIME_ZONE,
      ).evidence,
    ).toBeNull();
  });
});

describe('links to plans, automation runs and what was the Work view', () => {
  const sidebar = bootstrap().sidebar;
  it('opens the plan screen (focused on a step), the automation run, and the Inbox for a Work link (AP-860)', () => {
    expect(
      routeForLink(
        {
          type: 'plan',
          planId: 'pln_invoice-pdf',
          stepId: 'stp_pdf-4',
          in: { type: 'dm' },
        },
        sidebar,
        'Inbox',
      ),
    ).toEqual({ name: 'Plan', params: { planId: 'pln_invoice-pdf', stepId: 'stp_pdf-4', back: 'Inbox' } });
    expect(routeForLink({ type: 'plan', planId: 'pln_invoice-pdf', in: { type: 'dm' } }, sidebar)).toEqual({
      name: 'Plan',
      params: { planId: 'pln_invoice-pdf' },
    });
    expect(routeForLink({ type: 'automation_run', number: 41 }, sidebar, 'Inbox')).toEqual({
      name: 'AutomationRun',
      params: { number: 41, back: 'Inbox' },
    });
    // No Work screen: what needs the viewer is on Connections (one-layout-android.md AP-2645).
    const inbox = { name: 'Tabs', params: { screen: 'NeedsYou' } };
    expect(routeForLink({ type: 'work' }, sidebar)).toEqual(inbox);
    expect(routeForLink({ type: 'work', section: 'failed' }, sidebar, 'Inbox')).toEqual(inbox);
  });

  it('deep-links plans, and a push’s web path opens them; Work’s path opens the Inbox', () => {
    expect(LINKING_SCREENS.Plan).toBe('plans/:planId');
    expect(LINKING_SCREENS).not.toHaveProperty('Work');
    const planPath = linkPath('burrow-hq', {
      type: 'plan',
      planId: 'pln_invoice-pdf',
      stepId: 'stp_pdf-4',
      in: { type: 'dm' },
    });
    expect(appUrlForPath(planPath)).toBe('whombat://plans/pln_invoice-pdf?stepId=stp_pdf-4');
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'automation_run', number: 41 }))).toBe(
      'whombat://automation-runs/41',
    );
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'work' }))).toBe('whombat://inbox');
    // A crafted plan id can't smuggle a path in.
    expect(appUrlForPath('/burrow-hq/pr/482?plan=..%2Fapprovals%2F12')).toBe('whombat://pr/482');
  });

  it('keeps a linked plan’s params plain (no action params)', () => {
    const linked = {
      routes: [{ name: 'Plan', params: { planId: 'pln_1', stepId: 'stp_1', decide: 'approve' } }],
    };
    expect(stripLinkedActionParams(linked)).toEqual({
      routes: [{ name: 'Plan', params: { planId: 'pln_1', stepId: 'stp_1' } }],
    });
  });
});

describe('a card only a newer Whombat sends (AP-255)', () => {
  it('reads as its placeholder: “This needs a newer version of the app.”', async () => {
    const { UNSUPPORTED_CARD } = await import('@whombat/client');
    expect(cardSummary({ ...UNSUPPORTED_CARD }, ctx)).toMatchObject({
      title: 'This needs a newer version of the app.',
      tone: 'neutral',
    });
  });
});
