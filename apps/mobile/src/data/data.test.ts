import { continuesMessage } from '@whombat/client';
import { linkPath } from '@whombat/core';
import {
  assessmentCardOf,
  bootstrap,
  DM_DUSTY_MESSAGES,
  deployApproval,
  dusty,
  MESSAGES_BY_CONVERSATION,
  reportCardOf,
  reportFailed,
  reportFeature,
  reportLikelyBug,
  reportQueued,
  reportRemoved,
  SEED_NOW,
} from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createClock, isUsableTimeZone, resolveTimeZone } from '../lib/time';
import {
  appUrlForPath,
  parseNotificationUrl,
  routeForLink,
  stripLinkedActionParams,
  urlFromPushData,
} from '../navigation/routes';
import { minutesAfterSeed, worldContext } from '../test/world';
import { approvalScreen } from './approval';
import { pickBurrow } from './config';
import { cardSummary, chatItems, flattenPages } from './messages';

describe('config', () => {
  it('keeps the saved burrow while it is still there', () => {
    const m = (slug: string) => ({
      burrowId: `bur_${slug}`,
      burrowSlug: slug,
      burrowName: slug,
      principalId: 'prn_x',
    });
    expect(pickBurrow([m('a'), m('b')], 'b')?.burrowSlug).toBe('b');
    expect(pickBurrow([m('a'), m('b')], 'gone')?.burrowSlug).toBe('a');
    expect(pickBurrow([], 'a')).toBeNull();
  });
});

describe('routes', () => {
  const sidebar = bootstrap().sidebar;
  it('opens approvals, Chat and its threads, Feedback, branch rooms and the agent', () => {
    expect(
      routeForLink({ type: 'approval', number: 12, in: { type: 'pr', number: 482 } }, sidebar, 'Inbox'),
    ).toEqual({
      name: 'Approval',
      params: { number: 12, back: 'Inbox' },
    });
    // A message in Chat is a thread of its own (CHT-02): it opens there (AP-4962).
    expect(routeForLink({ type: 'message', in: { type: 'dm' }, messageId: 'msg_x' }, sidebar)).toEqual({
      name: 'Thread',
      params: { messageId: 'msg_x' },
    });
    expect(routeForLink({ type: 'dm' }, sidebar)).toEqual({ name: 'Tabs', params: { screen: 'ChatRoom' } });
    expect(routeForLink({ type: 'dm', room: 'feedback' }, sidebar)?.name).toBe('Feedback');
    expect(routeForLink({ type: 'pr', number: 482 }, sidebar)).toEqual({
      name: 'Conversation',
      params: { conversationId: 'cnv_pr482' },
    });
    expect(routeForLink({ type: 'agent' }, sidebar)?.name).toBe('SettingsAgent');
  });

  it('opens a canvas read-only (mobile-parity.md MQ-05), and asks the server for an unknown branch room', () => {
    expect(routeForLink({ type: 'canvas', slug: 'invoice-pdf-export-plan' }, sidebar)).toEqual({
      name: 'Canvas',
      params: { slug: 'invoice-pdf-export-plan' },
    });
    // A branch room the sidebar doesn't know opens the screen that asks the server (essentials AP-514).
    expect(routeForLink({ type: 'pr', number: 999 }, sidebar)).toEqual({
      name: 'Conversation',
      params: { prNumber: 999 },
    });
  });

  it('strips `decide` from a linked approval’s params so a crafted link can only open the screen, never approve it', () => {
    // whombat://approvals/12?decide=approve — a link from anywhere (a web page, a chat message, a QR
    // code, another app) — parses to this shape (getStateFromPath merges query params into route params).
    const linked = {
      routes: [{ name: 'Approval', params: { number: 12, decide: 'approve', back: 'Inbox' } }],
    };
    expect(stripLinkedActionParams(linked)).toEqual({
      routes: [{ name: 'Approval', params: { number: 12, back: 'Inbox' } }],
    });
    // Nested (e.g. under a stack's own state) and repeated across sibling routes.
    const nested = {
      routes: [
        { name: 'Tabs', state: { routes: [{ name: 'Inbox', params: { decide: 'approve' } }] } },
        { name: 'Approval', params: { number: 12, decide: 'approve' } },
      ],
    };
    expect(stripLinkedActionParams(nested)).toEqual({
      routes: [
        { name: 'Tabs', state: { routes: [{ name: 'Inbox', params: {} }] } },
        { name: 'Approval', params: { number: 12 } },
      ],
    });
    // A route with no params, and no routes at all, pass through unchanged.
    expect(stripLinkedActionParams({ routes: [{ name: 'Run', params: { number: 1907 } }] })).toEqual({
      routes: [{ name: 'Run', params: { number: 1907 } }],
    });
    expect(stripLinkedActionParams(undefined)).toBeUndefined();
  });

  it('maps a push’s web path to the app screen (needs-you rows open the approval)', () => {
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'approval', number: 12 }))).toBe(
      'whombat://approvals/12',
    );
    expect(
      appUrlForPath(
        linkPath('burrow-hq', {
          type: 'approval',
          number: 12,
          in: { type: 'pr', number: 482 },
        }),
      ),
    ).toBe('whombat://approvals/12');
    expect(appUrlForPath('/burrow-hq/runs/1907')).toBe('whombat://runs/1907');
    // A thread opens the thread screen.
    expect(appUrlForPath('/burrow-hq/chat?thread=msg_2')).toBe('whombat://threads/msg_2');
    expect(appUrlForPath('/burrow-hq/settings/agent')).toBe('whombat://settings/agent');
    // Search, with what it looks for (phone-shell-final.md).
    expect(appUrlForPath('/burrow-hq/search?q=vat%20rounding')).toBe('whombat://search?q=vat%20rounding');
    expect(appUrlForPath('/burrow-hq/canvases/invoice-pdf-export-plan')).toBe(
      'whombat://canvases/invoice-pdf-export-plan',
    );
    expect(appUrlForPath('/burrow-hq/canvases')).toBe('whombat://inbox');
    expect(appUrlForPath('')).toBe('whombat://inbox');
  });

  it('turns a tapped iOS push’s data into the same URL', () => {
    const url = urlFromPushData({
      path: '/burrow-hq/pr/482?approval=12',
      burrow: 'burrow-hq',
      notificationId: 'ntf_9',
    });
    expect(parseNotificationUrl(url)).toEqual({
      url: 'whombat://approvals/12',
      burrow: 'burrow-hq',
      notificationId: 'ntf_9',
    });
    expect(urlFromPushData({ aps: {} })).toBeNull();
    expect(urlFromPushData(null)).toBeNull();
  });
});

describe('chat', () => {
  it('flattens newest-first pages into one oldest-first list without duplicates', () => {
    const [a, b, c, d] = DM_DUSTY_MESSAGES;
    if (!a || !b || !c || !d) throw new Error('fixture');
    const pages = [
      { messages: [c, d], before: 'x', hasMore: true },
      { messages: [a, b, c], before: null, hasMore: false },
    ];
    expect(flattenPages(pages).map((m) => m.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(flattenPages(undefined)).toEqual([]);
  });

  it('shows a report in the Feedback room as its row, with its thread of the agent’s look (AP-1836)', () => {
    const ctx = worldContext();
    const root = {
      ...(DM_DUSTY_MESSAGES[0] as (typeof DM_DUSTY_MESSAGES)[number]),
      id: 'msg_fbc-report',
      conversationId: 'cnv_chat-feedback-billing',
      authorId: 'prn_feedback',
      text: 'Bug report FB-7K3Q-9M2X · Burrow Billing',
      card: reportCardOf(reportLikelyBug),
      replyCount: 2,
      lastReplyAt: SEED_NOW.toISOString(),
      threadParticipantIds: [dusty.id],
    } as (typeof DM_DUSTY_MESSAGES)[number];
    const [row] = chatItems([root], ctx, { authors: true });
    // The header folds into the report's row (RR-04); its thread opens like any other.
    expect(row?.text).toBe('');
    expect(row?.report).not.toBeNull();
    expect(row?.replies).toBe('2 replies');
    // In the report's thread the root is the whole report (RR-07), the agent's answer its assessment card.
    const [whole] = chatItems([root], ctx, { authors: true, threads: false });
    expect(whole?.display).toBe('full');
  });

  it('passes a digest card through whole instead of summarising it', () => {
    const ctx = worldContext();
    const first = DM_DUSTY_MESSAGES[1] as (typeof DM_DUSTY_MESSAGES)[number];
    const digest = {
      kind: 'digest' as const,
      title: 'Inbox',
      summary: '7 unread',
      sections: [
        {
          label: 'Worth a look',
          collapsed: false,
          items: [{ time: '15:33', title: 'New sign-in', source: 'Lumio', note: null, url: null }],
        },
      ],
    };
    const [item] = chatItems([{ ...first, card: digest }], ctx, { authors: false });
    expect(item?.digest).toEqual(digest);
    expect(item?.card).toBeNull();
    expect(item?.receipts).toBeNull();
  });

  it('puts author lines on the first of consecutive messages in a branch room and summarises cards', () => {
    const ctx = worldContext();
    const items = chatItems(MESSAGES_BY_CONVERSATION.cnv_pr482 ?? [], ctx, { authors: true });
    const approval = items.find((i) => i.card?.kind === 'approval');
    expect(approval?.card).toMatchObject({ tone: 'warn' });
    expect(approval?.card?.approvalNumber).toBeGreaterThan(0);
    const byId = new Map((MESSAGES_BY_CONVERSATION.cnv_pr482 ?? []).map((m) => [m.id, m]));
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      const before = prev && byId.get(prev.id);
      const message = cur && byId.get(cur.id);
      if (!cur || !prev || !before || !message || cur.day) continue;
      // The same author moments later runs on; after a pause, or for someone else, the author line is back.
      expect(cur.showAuthor).toBe(!continuesMessage(before, message));
      // Rows are flat (AP-706): the viewer's own messages get their author line too.
      if (cur.authorId !== prev.authorId) expect(cur.showAuthor).toBe(true);
    }
    const [first] = MESSAGES_BY_CONVERSATION.cnv_pr482 ?? [];
    if (!first) throw new Error('fixture: PR #482 messages');
    const mine = { ...first, authorId: ctx.viewer.id };
    const own = chatItems([mine, { ...mine, id: `${first.id}-2` }], ctx, { authors: true });
    expect(own.map((i) => [i.mine, i.showAuthor])).toEqual([
      [true, true],
      [true, false],
    ]);
  });
});

describe('report cards (Whombat Feedback)', () => {
  const ctx = () => worldContext();

  it('queued, failed, blocked, removed and feature states', () => {
    const queued = cardSummary(reportCardOf(reportQueued), ctx());
    expect(queued).toMatchObject({
      meta: 'Burrow Billing · New · Assessment queued',
      detail: null,
      tone: null,
    });
    const failed = cardSummary(reportCardOf(reportFailed), ctx());
    expect(failed).toMatchObject({ meta: 'Burrow Billing · New · Assessment failed', tone: 'bad' });
    const blockedCard = reportCardOf(reportFailed);
    const blocked = cardSummary(
      { ...blockedCard, assessment: { ...blockedCard.assessment, state: 'blocked' } },
      ctx(),
    );
    expect(blocked).toMatchObject({ meta: 'Burrow Billing · New · Assessment blocked', tone: 'warn' });
    const removed = cardSummary(reportCardOf(reportRemoved), ctx());
    expect(removed).toMatchObject({
      title: 'Content removed',
      quiet: true,
      meta: 'Burrow Billing · Closed · Likely bug',
    });
    const feature = cardSummary(reportCardOf(reportFeature), ctx());
    expect(feature?.label).toBe('FEATURE REQUEST · FB-H8XM-5VKT');
  });

  it('the assessor’s card: verdict in its tone, the question, options until someone picks (Whombat FB-32)', () => {
    const card = assessmentCardOf(reportLikelyBug);
    if (!card) throw new Error('no assessment card');
    const summary = cardSummary(card, ctx());
    expect(summary).toMatchObject({
      label: 'ASSESSMENT · FB-7K3Q-9M2X',
      title: 'Bug',
      tone: 'bad',
      detail: 'Shall I fix it?',
      meta: 'Likely bug · medium confidence · severity medium',
      assessment: {
        options: [
          { label: 'Fix it', recommended: true },
          { label: 'Leave it for now', recommended: false },
        ],
      },
    });
    expect(summary?.assessment?.rows[0]).toEqual({ label: 'Summary', text: card.assessment.summary });
    const decided = cardSummary(
      {
        ...card,
        decided: {
          option: 1,
          label: 'Leave it for now',
          action: 'keep_open',
          decidedById: ctx().viewer.id,
          decidedAt: '2026-09-30T14:10:00.000Z',
        },
      },
      ctx(),
    );
    expect(decided?.assessment?.options).toBeNull();
    expect(decided?.meta).toMatch(/^You chose “Leave it for now” · kept open · \d\d:\d\d$/);
  });

  it('a report or an unknown card never breaks the chat list', () => {
    const first = DM_DUSTY_MESSAGES[1] as (typeof DM_DUSTY_MESSAGES)[number];
    const unknown = { kind: 'poll', question: 'Lunch?' } as unknown as typeof first.card;
    const items = chatItems(
      [
        {
          ...first,
          id: 'msg_report',
          card: reportCardOf(reportLikelyBug),
          text: 'Bug report FB-7K3Q-9M2X · Burrow Billing',
        },
        { ...first, id: 'msg_unknown', card: unknown },
      ],
      ctx(),
      { authors: true },
    );
    expect(items[0]?.card?.kind).toBe('report');
    // The server's header folds into the report's row (docs/decisions/report-rows.md RR-04).
    expect(items[0]?.text).toBe('');
    expect(items[0]?.display).toBe('line');
    expect(items[0]?.report).toMatchObject({
      lead: 'Likely bug',
      reference: 'FB-7K3Q-9M2X',
      meta: ['Burrow Billing', 'Triaged', '2 screenshots'],
      tone: 'warn',
    });
    expect(items[1]?.card).toBeNull();
    expect(items[1]?.text).toBe(first.text);
  });

  it('a report is its row in the conversation and the whole card at the root of its thread (RR-02, RR-07)', () => {
    const first = DM_DUSTY_MESSAGES[1] as (typeof DM_DUSTY_MESSAGES)[number];
    const report = {
      ...first,
      id: 'msg_report',
      card: reportCardOf(reportLikelyBug),
      text: 'Bug report FB-7K3Q-9M2X · Burrow Billing',
    };
    const [inThread] = chatItems([report], ctx(), { authors: true, threads: false });
    expect(inThread?.report).toBeNull();
    expect(inThread?.display).toBe('full');
    expect(inThread?.text).toBe('');
    expect(inThread?.card?.label).toBe('BUG REPORT · FB-7K3Q-9M2X');
    const [own] = chatItems([{ ...report, text: 'Have a look at this one' }], ctx(), { authors: true });
    expect(own?.text).toBe('Have a look at this one');
    expect(own?.report?.lead).toBe('Likely bug');
  });
});

describe('time, theme and layout', () => {
  it('runs the fixture clock forward from the seed moment', () => {
    const clock = createClock(SEED_NOW, 1_000);
    expect(clock().getTime()).toBeGreaterThanOrEqual(SEED_NOW.getTime());
    expect(createClock(null)().getFullYear()).toBeGreaterThan(2020);
    expect(minutesAfterSeed(1).getTime() - SEED_NOW.getTime()).toBe(60_000);
  });

  it('falls back to a usable time zone', () => {
    expect(isUsableTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isUsableTimeZone('Mars/Olympus')).toBe(false);
    expect(resolveTimeZone([null, 'Mars/Olympus', 'Europe/Amsterdam'])).toBe('Europe/Amsterdam');
    expect(resolveTimeZone([])).toBe('UTC');
  });
});

describe('approval screen copy', () => {
  it('asks from the action and says what actually runs when the stored wording disagrees', () => {
    const mislabelled = deployApproval({
      keyId: 'deploy.production',
      action: {
        type: 'deploy',
        params: {
          environment: 'production',
          service: 'billing-api',
          ref: 'main',
          sha: null,
          repo: 'whombat/billing',
        },
      },
    });
    const model = approvalScreen(mislabelled, worldContext(), 'PR #482');
    expect(model.question).toBe('Deploy main to production?');
    // What runs, from the action, then the stored wording (the agent's name in it).
    expect(model.message).toMatch(/^What actually runs: Build the latest commit on main in whombat\/billing/);
    expect(model.message).toContain('Dusty builds 7be20f');
    const mock = approvalScreen(deployApproval(), worldContext(), 'PR #482');
    expect(mock.question).toBe('Deploy feat/invoice-pdf to staging?');
    expect(mock.message.startsWith('What actually runs')).toBe(false);
    expect(mock.content).toBeNull();
  });
});
