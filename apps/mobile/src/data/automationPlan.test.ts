/**
 * A plan for an automation in Chat on the phone (Whombat automation-chat.md; automation-chat-mobile.md): the card while
 * it waits — state, name, what changes, Whombat's rows, the agent's thinking, what the agent is asked — and the line it
 * folds into once decided, in the conversation and the thread alike; and what Try it says and sends.
 */
import type {
  AutomationPlanCard,
  AutomationPlanView,
  AutomationSample,
  Message,
  MessageCard,
} from '@whombat/core';
import { DM_DUSTY_MESSAGES } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import {
  AUTOMATION_PLAN_TEXT,
  newestSample,
  planCardView,
  planDisplay,
  planSettledLine,
  runNowBody,
  tryItLabel,
} from './automationPlan';
import { cardSummary, chatItems, settledLine } from './messages';

const base = DM_DUSTY_MESSAGES[1] as Message;
const MADE = '2026-09-24T09:01:00.000Z';

function plan(over: Partial<AutomationPlanView> = {}): AutomationPlanView {
  return {
    planId: 'apl_fusebox1' as AutomationPlanView['planId'],
    automationId: 'aut_fusebox' as AutomationPlanView['automationId'],
    name: 'New Fusebox issues',
    description:
      'When someone opens an issue on LumioHQ/fusebox, Dusty reads it and tells you whether it’s worth fixing.',
    state: 'waiting',
    change: false,
    sections: [
      {
        id: 'when',
        label: 'WHEN',
        lines: [{ text: 'A new issue on LumioHQ/fusebox', detail: 'Not from bots' }],
      },
      { id: 'does', label: 'DUSTY', lines: [{ text: 'Reads the issue and the code', detail: null }] },
      {
        id: 'asks',
        label: 'ASKS YOU',
        lines: [{ text: 'Nothing: it only reads and tells you', detail: null }],
      },
      { id: 'posts', label: 'POSTS', lines: [{ text: 'One thread per issue in Chat', detail: null }] },
      { id: 'limits', label: 'LIMIT', lines: [{ text: 'At most 20 runs a day', detail: null }] },
    ],
    changes: [],
    thinking: ['I react to new issues as they come in.', 'I left out issues from bots.'],
    prompts: [{ step: 'Assess the issue', text: 'Read the issue and the code, then say what it is.' }],
    tryIt: 'sample',
    decidedById: null,
    decidedAt: null,
    version: null,
    createdAt: MADE,
    ...over,
  };
}

const card = (p: AutomationPlanView | null): AutomationPlanCard => ({
  kind: 'automation_plan',
  planId: 'apl_fusebox1' as AutomationPlanCard['planId'],
  plan: p,
});

const msg = (id: string, c: MessageCard): Message => ({
  ...base,
  id: id as Message['id'],
  card: c,
  text: 'Here’s how I’d set it up.',
});

describe('a plan for an automation on the phone', () => {
  it('shows a new plan whole while it waits, with its state, rows and buttons', () => {
    const view = planCardView(plan(), 'Dusty');
    expect(view.status).toBe('NEW AUTOMATION · WAITING FOR YOU');
    expect(view).toMatchObject({ waiting: true, tone: 'warn', change: false, tryIt: 'sample' });
    expect(view.accept).toBe(AUTOMATION_PLAN_TEXT.accept.new);
    expect(view.decline).toBe(AUTOMATION_PLAN_TEXT.decline.new);
    expect(view.sections.map((s) => s.label)).toEqual(['WHEN', 'DUSTY', 'ASKS YOU', 'POSTS', 'LIMIT']);
    expect(view.sections[0]?.lines[0]).toMatchObject({
      text: 'A new issue on LumioHQ/fusebox',
      detail: 'Not from bots',
    });
    expect(view.sections[0]?.accessibilityLabel).toContain('Not from bots');
    expect(view.thinking).toHaveLength(2);
    expect(view.asked.title).toContain('Dusty');
    expect(view.asked.prompts[0]).toMatchObject({ step: 'Assess the issue' });
    expect(view.changes).toEqual([]);
    expect(view.accessibilityLabel).toContain('New Fusebox issues');
  });

  it('lists what a change adds, removes and rewords, with the change’s buttons', () => {
    const view = planCardView(
      plan({
        change: true,
        changes: [
          { change: 'added', section: 'posts', text: 'Opens a pull request on LumioHQ/fusebox' },
          { change: 'removed', section: 'asks', text: 'Nothing: it only reads and tells you' },
          { change: 'changed', section: 'does', text: 'What Dusty is asked in “Assess the issue”' },
        ],
      }),
      'Dusty',
    );
    expect(view.status).toBe('CHANGE · WAITING FOR YOU');
    expect(view.changes.map((c) => [c.sign, c.tone])).toEqual([
      ['+', 'ok'],
      ['\u2212', 'bad'],
      ['~', 'mut'],
    ]);
    expect(view.changes[1]?.accessibilityLabel).toContain(AUTOMATION_PLAN_TEXT.changeWords.removed);
    expect(view.accept).toBe(AUTOMATION_PLAN_TEXT.accept.change);
    expect(view.decline).toBe(AUTOMATION_PLAN_TEXT.decline.change);
  });

  it('is a chat item of its own, the card while it waits', () => {
    const [item] = chatItems([msg('msg_p1', card(plan()))], worldContext(), { authors: true });
    expect(item?.automationPlan?.planId).toBe('apl_fusebox1');
    expect(item?.display).toBe('full');
    expect(item?.line).toBeNull();
    expect(item?.card).toBeNull();
    // The agent's words above the card stay.
    expect(item?.text).toBe('Here’s how I’d set it up.');
    expect(cardSummary(card(plan()), worldContext())).toBeNull();
  });

  it('folds into one line once decided, which opens the card without buttons', () => {
    const ctx = worldContext();
    const decidedAt = new Date(ctx.now.getTime() - 5 * 60_000).toISOString();
    const accepted = plan({ state: 'accepted', decidedById: ctx.viewer.id as never, decidedAt, version: 1 });
    const [item] = chatItems([msg('msg_p2', card(accepted))], ctx, { authors: true });
    expect(item?.display).toBe('line');
    expect(item?.line).toMatchObject({ tone: 'ok', lead: 'You turned on “New Fusebox issues”' });
    expect(item?.line?.detail).toMatch(/\d\d:\d\d/);
    expect(item?.automationPlan).toMatchObject({
      waiting: false,
      tone: 'ok',
      status: 'NEW AUTOMATION · TURNED ON',
    });
    // In a thread too.
    const [inThread] = chatItems([msg('msg_p2', card(accepted))], ctx, { authors: true, threads: false });
    expect(inThread?.display).toBe('line');
  });

  it('says not now, replaced and deleted in a few words', () => {
    const ctx = worldContext();
    const line = (state: AutomationPlanView['state']) =>
      settledLine(card(plan({ state })), ctx, base.authorId);
    expect(line('declined')).toEqual({ lead: 'Not now: “New Fusebox issues”', detail: null, tone: 'mut' });
    expect(line('replaced')).toEqual({ lead: AUTOMATION_PLAN_TEXT.replaced, detail: null, tone: 'mut' });
    expect(line('gone')).toEqual({ lead: '“New Fusebox issues” was deleted', detail: null, tone: 'mut' });
    expect(line('waiting')).toBeNull();
    expect(settledLine(card(null), ctx, base.authorId)).toBeNull();
  });

  it('names who turned it on when it wasn’t you, with the day once it isn’t today', () => {
    const now = new Date('2026-10-29T09:00:00.000Z');
    const line = planSettledLine(
      {
        state: 'accepted',
        name: 'Morning briefing',
        decidedById: 'prn_other',
        decidedAt: '2026-10-26T13:02:00.000Z',
      },
      { viewerId: 'prn_mara', name: () => 'Mara', now, timeZone: 'Europe/Amsterdam' },
    );
    expect(line?.lead).toBe('Mara turned on “Morning briefing”');
    expect(line?.detail).toBe('Mon 14:02');
  });

  it('shows nothing of a plan that isn’t resolved, and the card for one waiting', () => {
    const [item] = chatItems([msg('msg_p3', card(null))], worldContext(), { authors: true });
    expect(item?.automationPlan).toBeNull();
    expect(planDisplay(card(null))).toBe('full');
    expect(planDisplay(card(plan()))).toBe('full');
    expect(planDisplay(card(plan({ state: 'replaced' })))).toBe('line');
  });
});

describe('Try it', () => {
  const issue: AutomationSample = {
    kind: 'issue',
    repo: 'LumioHQ/fusebox',
    number: 12,
    title: 'Fuse trips at night',
    author: 'mara',
    url: 'https://github.com/LumioHQ/fusebox/issues/12',
    draft: false,
    openedAt: MADE,
  };
  const report: AutomationSample = {
    kind: 'report',
    connectionId: 'con_tracker' as never,
    reportId: 'trp_31' as never,
    number: 31,
    title: 'Login loops',
    type: 'bug',
    organization: null,
    openedAt: MADE,
  };

  it('names the newest issue, else runs once now', () => {
    expect(tryItLabel('sample', [issue])).toBe(AUTOMATION_PLAN_TEXT.tryOn(12));
    expect(tryItLabel('sample', [])).toBe(AUTOMATION_PLAN_TEXT.tryNow);
    expect(tryItLabel('sample', undefined)).toBe(AUTOMATION_PLAN_TEXT.tryIt);
    expect(tryItLabel('now', [issue])).toBe(AUTOMATION_PLAN_TEXT.tryNow);
    expect(newestSample([issue, report])).toBe(issue);
    expect(newestSample(undefined)).toBeNull();
  });

  it('sends a test run on the issue or the report, and a run now as it is', () => {
    expect(runNowBody(true, issue)).toEqual({ test: true, sample: { number: 12 } });
    expect(runNowBody(true, report)).toEqual({ test: true, sample: { reportId: 'trp_31' } });
    expect(runNowBody(true, null)).toEqual({ test: true });
    expect(runNowBody(false, issue)).toEqual({ test: false });
    expect(AUTOMATION_PLAN_TEXT.trying('New Fusebox issues', 12)).toContain('#12');
  });
});
