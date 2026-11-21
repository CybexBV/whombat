import type { MailSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  CANNED_REPLY,
  calendarReply,
  chooseScript,
  DECLINED_REPLY,
  inboxReply,
  NOT_CONNECTED_REPLY,
  readTurn,
  SEND_ASKED_REPLY,
  sendReply,
  tomorrowBounds,
} from './scripted-turn';

const SOUL = 'You are Dusty, Mara’s agent in Whombat: for their servers, home, network, code and services.';
const NOW = 'It is Wednesday 23 Sep 2026, 23:30 in Europe/Amsterdam; times in messages are in that zone.';

/** A turn's prompt as the runner renders it: the facts the scripted Hermes reads, with filler around them. */
function prompt(...lines: string[]): string {
  return [NOW, 'Mara Okafor (mara@burrowhq.example) asked for this turn.', ...lines].join('\n');
}

const asking = (text: string, room = 'Conversation: Mara’s Chat with you (conversationId cnv_dm-dusty)') =>
  prompt(
    room,
    '',
    'Recent messages (oldest first):',
    '[23:28] Dusty: Morning! (id msg_0)',
    `[23:29] Mara: ${text} (id msg_1)`,
    '',
    'Mara is asking you in the message above (id msg_1).',
  );

const mail = (subject: string, from: string, unread: boolean): MailSummary => ({
  id: subject,
  threadId: subject,
  from,
  to: [],
  subject,
  snippet: '',
  date: '2026-09-23T08:00:00.000Z',
  unread,
  labels: [],
});

describe('what the scripted Hermes reads in a turn', () => {
  it('the request, the room, the time and its own name', () => {
    const facts = readTurn(asking('Can you look at the PDF cache?'), SOUL);
    expect(facts).toMatchObject({
      agentName: 'Dusty',
      conversationId: 'cnv_dm-dusty',
      prNumber: null,
      timeZone: 'Europe/Amsterdam',
      request: { author: 'Mara', text: 'Can you look at the PDF cache?' },
      search: null,
      run: null,
    });
    expect(facts.now?.toISOString()).toBe('2026-09-23T21:30:00.000Z');
    expect(chooseScript(facts)).toEqual({ kind: 'canned', text: CANNED_REPLY });
  });

  it('a message of several lines, and a request not shown above', () => {
    const multi = prompt(
      'Conversation: #billing-v2 (conversationId cnv_billing-v2)',
      '[23:29] Mara: Send an email to priya@example.com about lunch saying:',
      'see you at noon (2 replies in thread) (id msg_9)',
      'Mara is asking you in the message above (id msg_9).',
    );
    expect(readTurn(multi).request?.text).toBe(
      'Send an email to priya@example.com about lunch saying:\nsee you at noon',
    );
    expect(
      readTurn(prompt('Conversation: x (conversationId cnv_x)', 'Tom is asking you: what’s new?')).request,
    ).toEqual({ author: 'Tom', text: 'what’s new?' });
    // Several messages wait: no single request, the canned reply.
    const several = readTurn(prompt('2 new messages for you since you were asked: answer them together.'));
    expect(several.request).toBeNull();
    expect(chooseScript(several).kind).toBe('canned');
  });

  it('a search question: its query, its results and the answer’s id', () => {
    const facts = readTurn(
      prompt(
        'Conversation: #general (conversationId cnv_general)',
        '',
        'Search question from Mara: “have we seen this invoice rounding error before?”',
        'Results you may cite (id · type · where · snippet):',
        '- hist_thread-credit-note · THREAD · #incidents · 3 Mar 2026 · Credit notes rounded after formatting',
        '- hist_pr-311 · PATCH · PR #311 · merged 4 Mar · Round VAT first',
        'Answer with post_answer (answerId ans_42): a short answer citing results inline as [1], [2] …',
      ),
    );
    expect(facts.search).toMatchObject({
      query: 'have we seen this invoice rounding error before?',
      answerId: 'ans_42',
      results: [
        { id: 'hist_thread-credit-note', type: 'THREAD', where: '#incidents' },
        { id: 'hist_pr-311', type: 'PATCH', where: 'PR #311' },
      ],
    });
    expect(chooseScript(facts).kind).toBe('answer');
  });

  it('a run turn: the run, its steps and where it stands', () => {
    const facts = readTurn(
      prompt(
        'Conversation: #billing-v2 (conversationId cnv_billing-v2)',
        '',
        'Your run #1907 “Address review on PR #482” on feat/invoice-pdf is live: pick up where it stands.',
        'Steps: 0. Read Joris’s review (done); 1. Round VAT (before formatting) (active); 2. Rename (queued)',
        'Latest: Editing billing/pdf/format.ts',
      ),
    );
    expect(facts.run).toEqual({
      number: 1907,
      title: 'Address review on PR #482',
      branch: 'feat/invoice-pdf',
      steps: [
        { title: 'Read Joris’s review', state: 'done' },
        { title: 'Round VAT (before formatting)', state: 'active' },
        { title: 'Rename', state: 'queued' },
      ],
      activity: 'Editing billing/pdf/format.ts',
    });
    expect(chooseScript(facts)).toMatchObject({ kind: 'run', run: { number: 1907 } });
  });

  it('reviews a fix someone else pushed in a pull request’s room, not its own', () => {
    const room = 'Conversation: feat/invoice-pdf (conversationId cnv_pr482) — PR #482 · Invoice PDF export';
    const pushed = (who: string) =>
      readTurn(
        prompt(
          room,
          `[11:36] ${who}: Pushed 7be20f. Rounding happens first now. (id msg_p)`,
          `${who} is asking you in the message above (id msg_p).`,
        ),
        SOUL,
      );
    expect(chooseScript(pushed('Joris'))).toEqual({
      kind: 'review_approve',
      prNumber: 482,
      conversationId: 'cnv_pr482',
    });
    expect(chooseScript(pushed('Dusty')).kind).toBe('canned');
  });

  it('a no and a Feedback assessment', () => {
    expect(chooseScript(readTurn(prompt('A person declined your request: don’t do it.')))).toEqual({
      kind: 'canned',
      text: DECLINED_REPLY,
    });
    const assessment = readTurn(
      'Assess the report, then call submit_assessment once.\n[10:00] Visitor: my email is broken (id msg_r)\nVisitor is asking you in the message above (id msg_r).',
    );
    expect(chooseScript(assessment)).toEqual({ kind: 'canned', text: CANNED_REPLY });
  });
});

describe('the scripted personal assistant (connectors-google-tools.md GT-12)', () => {
  const script = (text: string) => chooseScript(readTurn(asking(text), SOUL));

  it('mail, calendar, guides and commands by what the person asks', () => {
    expect(script('What’s in my inbox today?')).toEqual({ kind: 'assistant_inbox' });
    expect(script('Any new emails?')).toEqual({ kind: 'assistant_inbox' });
    expect(script('What’s on my calendar tomorrow?')).toEqual({ kind: 'assistant_calendar' });
    expect(script('Can you set up my email?')).toEqual({ kind: 'assistant_guide', topic: 'email' });
    expect(script('Send an email to a@b.com about lunch')).toEqual({
      kind: 'assistant_send',
      mail: { to: ['a@b.com'], subject: 'Lunch', body: 'Lunch' },
    });
    expect(script('Please run `uname -s` for me')).toEqual({ kind: 'command', command: 'uname -s' });
    expect(script('Hello')).toEqual({ kind: 'canned', text: CANNED_REPLY });
  });

  it('answers from the tools’ outcomes, or with the fix when nothing is connected', () => {
    expect(sendReply({ ok: true, body: { status: 'pending_approval', approvalNumber: 3 } })).toBe(
      SEND_ASKED_REPLY,
    );
    expect(
      sendReply({
        ok: false,
        body: { error: { code: 'not_allowed', message: 'Mara hasn’t connected Gmail.' } },
      }),
    ).toBe('Mara hasn’t connected Gmail.');
    expect(
      inboxReply({
        ok: true,
        body: { status: 'ok', messages: [mail('Invoice 1042', 'Priya Shah <p@x.com>', true)] },
      }),
    ).toBe(
      'You have 1 email from today, 1 unread:\n\n- “Invoice 1042” from Priya Shah\n\nWant me to draft a reply to any of these?',
    );
    expect(calendarReply({ ok: false, body: { error: { code: 'not_allowed' } } }, 'Europe/Amsterdam')).toBe(
      NOT_CONNECTED_REPLY,
    );
  });

  it('tomorrow in the burrow’s time zone, from the prompt’s time', () => {
    const facts = readTurn(asking('What’s on my calendar tomorrow?'));
    const { from, to } = tomorrowBounds(facts.now as Date, facts.timeZone as string);
    expect([from.toISOString(), to.toISOString()]).toEqual([
      '2026-09-23T22:00:00.000Z',
      '2026-09-24T22:00:00.000Z',
    ]);
  });
});
