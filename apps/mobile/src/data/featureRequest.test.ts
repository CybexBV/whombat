/**
 * A tracker's feature request on the phone: the card survives the tolerant decoding of a
 * page of messages, is the card while it waits and one line once decided, replaced or stopped (the decider by short
 * name),
 * says what the customer reads, sends what the person chose, and a field in a row scrolls into view above the
 * keyboard.
 */
import {
  api,
  FEATURE_REQUEST_WORDS,
  type FeatureRequestCard,
  type FeatureRequestView,
  type Message,
  type MessageCard,
  shortNameOf,
} from '@whombat/core';
import { DM_DUSTY_MESSAGES, mara } from '@whombat/fixtures';
import { decodeTolerant } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { REVEAL_MARGIN, revealBy } from './chatScroll';
import { featureRequestCardView } from './featureRequest';
import { cardSummary, chatItems } from './messages';

const base = DM_DUSTY_MESSAGES[1] as Message;
const CARD_TEXT =
  'Feature request from HollowMere College: “Export invoices to CSV” · 7 of 10. Approve it, decline it or ask the customer here.';

function request(over: Partial<FeatureRequestView> = {}): FeatureRequestView {
  return {
    id: 'tfr_hollowmere21' as FeatureRequestView['id'],
    runId: 'arn_tracker21' as FeatureRequestView['runId'],
    automationId: 'aut_tracker' as FeatureRequestView['automationId'],
    connection: 'Acme Desk dev',
    number: 21,
    title: 'Export invoices to CSV',
    organization: 'HollowMere College',
    agent: 'Dusty',
    value: 7,
    valueWhy: 'Several schools asked for it, and it is a small change.',
    summary: 'They want their invoices as a spreadsheet.',
    importance: 'medium',
    size: 'small',
    approvedMessage: 'We’re going to build this.\n\nDusty - AI Assistant',
    declinedMessage: 'We won’t build this for now.\n\nDusty - AI Assistant',
    declineReason: 'The new reports page covers it.',
    canBuild: true,
    state: 'waiting',
    choice: null,
    note: null,
    decidedById: null,
    decidedAt: null,
    createdAt: '2026-09-24T09:01:00.000Z',
    ...over,
  };
}

const card = (r: FeatureRequestView | null): FeatureRequestCard => ({
  kind: 'feature_request',
  requestId: 'tfr_hollowmere21' as FeatureRequestCard['requestId'],
  request: r,
});

const msg = (id: string, c: MessageCard): Message => ({
  ...base,
  id: id as Message['id'],
  card: c,
  text: CARD_TEXT,
});

const decided = (over: Partial<FeatureRequestView>) =>
  request({
    state: 'decided',
    decidedById: mara.id as never,
    decidedAt: '2026-09-24T09:30:00.000Z',
    ...over,
  });

describe('a feature request on the phone', () => {
  it('keeps its card through the tolerant decoding of a page of messages, where an unknown kind is left out', () => {
    const page = { messages: [msg('msg_f1', card(request()))], before: null, hasMore: false };
    const r = decodeTolerant(api.messages.list.response, JSON.parse(JSON.stringify(page)));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.skipped).toEqual([]);
    expect(r.data.messages[0]?.card).toMatchObject({
      kind: 'feature_request',
      requestId: 'tfr_hollowmere21',
      request: { state: 'waiting', value: 7, canBuild: true },
    });
    // A card kind the contracts don't know is what gets left out: this one is known.
    const newer = { ...page, messages: [{ ...page.messages[0], card: { kind: 'newer_card' } }] };
    const other = decodeTolerant(api.messages.list.response, JSON.parse(JSON.stringify(newer)));
    if (!other.ok) throw new Error(other.error.message);
    expect(other.data.messages[0]?.card).toBeNull();
  });

  it('is the whole card while it waits, its own words folded into it', () => {
    const [item] = chatItems([msg('msg_f2', card(request()))], worldContext(), { authors: true });
    expect(item?.display).toBe('full');
    expect(item?.line).toBeNull();
    expect(item?.card).toBeNull();
    // The words are for an app without the card: the card says it all.
    expect(item?.text).toBe('');
    expect(item?.featureRequest).toMatchObject({
      requestId: 'tfr_hollowmere21',
      waiting: true,
      label: FEATURE_REQUEST_WORDS.label,
      value: '7 of 10',
      valueLabel: 'Value 7 of 10',
      from: 'From HollowMere College · Acme Desk dev #21',
      canBuild: true,
      agent: 'Dusty',
      outcome: null,
    });
    expect(item?.featureRequest?.reads.map((r) => r.id)).toEqual(['approved', 'declined']);
    expect(cardSummary(card(request()), worldContext())).toBeNull();
  });

  it('folds into one line once decided, with who decided by short name, and opens with the outcome', () => {
    const ctx = worldContext();
    const shown = (r: FeatureRequestView) => chatItems([msg('msg_f3', card(r))], ctx, { authors: true })[0];
    const approved = shown(decided({ choice: 'approve' }));
    expect(approved?.display).toBe('line');
    expect(approved?.line).toMatchObject({ tone: 'ok', detail: 'Export invoices to CSV' });
    expect(approved?.line?.lead).toBe(`Approved by ${shortNameOf(mara)} · Planned`);
    expect(approved?.featureRequest).toMatchObject({ waiting: false, outcome: { tone: 'ok' } });
    expect(shown(decided({ choice: 'build' }))?.line?.lead).toContain('Being built');
    const declined = shown(decided({ choice: 'decline', note: 'Not this year.' }));
    expect(declined?.line?.tone).toBe('bad');
    expect(declined?.featureRequest?.outcome?.detail).toContain('Not this year.');
    expect(shown(decided({ choice: 'ask', note: 'Which format?' }))?.line?.tone).toBe('warn');
    expect(shown(request({ state: 'replaced' }))?.line?.tone).toBe('mut');
    expect(shown(request({ state: 'stopped' }))?.display).toBe('line');
  });

  it('shows only the server’s words while the card isn’t resolved', () => {
    const [item] = chatItems([msg('msg_f4', card(null))], worldContext(), { authors: true });
    expect(item?.featureRequest).toBeNull();
    expect(item?.line).toBeNull();
    expect(item?.text).toBe(CARD_TEXT);
  });

  it('says what the customer reads, leaving out a draft the agent hasn’t written', () => {
    const view = featureRequestCardView(
      request({ approvedMessage: ' ', value: null }),
      worldContext().people,
    );
    expect(view.reads.map((r) => r.label)).toEqual([FEATURE_REQUEST_WORDS.ifDeclined]);
    expect(view.value).toBe('Not scored');
    expect(view.valueLabel).toBe('Not scored');
  });
});

describe('a field in a row above the keyboard', () => {
  const list = { top: 100, bottom: 500 };

  it('scrolls only as far as the form needs, and not at all when it shows', () => {
    expect(revealBy({ top: 200, bottom: 400 }, list)).toBe(0);
    expect(revealBy({ top: 420, bottom: 560 }, list)).toBe(560 + REVEAL_MARGIN - 500);
  });

  it('keeps the top of a form taller than what is left in view, where the field is', () => {
    expect(revealBy({ top: 300, bottom: 900 }, list)).toBe(300 - REVEAL_MARGIN - 100);
    expect(revealBy({ top: 90, bottom: 600 }, list)).toBe(0);
  });
});
