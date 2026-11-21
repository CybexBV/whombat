/**
 * Replying to a tracker report's customer, pure (docs/decisions/report-trackers.md TA-27, TA-31, TA-36): the thread's
 * line for a reply, telling the customer's answers from the team's changes, and the thread's words about a fix.
 */
import { describe, expect, it } from 'vitest';
import { FIX_WORDS, prLink } from './fixes';
import { changed, customerAnswer, seenOf } from './replies';
import { replyLine } from './reply';

type Message = { id: string | null; author: 'reporter' | 'team'; body: string; at: string | null };
const base = {
  status: 'needs_information',
  updatedAt: '2026-10-10T09:00:00Z',
  messages: [
    { id: 'a', author: 'reporter', body: 'It stops at 40%.', at: '2026-10-10T07:00:00Z' },
    { id: 'b', author: 'team', body: 'Which devices?', at: '2026-10-10T09:00:00Z' },
  ] as Message[],
};
const report = (over: { status?: string; updated_at?: string; messages?: Message[] } = {}) => ({
  status: over.status ?? base.status,
  updatedAt: over.updated_at ?? base.updatedAt,
  messages: over.messages ?? base.messages,
});
/** A message by the reporter (anyone named) or the team (`Team`). */
const msg = (author: string, body: string, at: string): Message => ({
  id: at,
  author: author === 'Team' ? 'team' : 'reporter',
  body,
  at,
});

describe('the line a reply adds to the thread (TA-27)', () => {
  it('quotes exactly what the customer got, signature included', () => {
    expect(replyLine(16, 'investigating', 'Thanks, we are on it.\n\nDusty - AI Developer')).toBe(
      'Replied to the customer and set #16 to “Investigating”:\n\n> Thanks, we are on it.\n>\n> Dusty - AI Developer',
    );
    expect(replyLine(16, null, 'Thanks.\n\nDusty - AI Developer')).toBe(
      'Replied to the customer:\n\n> Thanks.\n>\n> Dusty - AI Developer',
    );
  });
});

describe('the customer’s answers (TA-31)', () => {
  const before = seenOf(report());

  it('counts only the reporter’s messages, never the team’s (Whombat’s own replies arrive as the team)', () => {
    expect(before).toMatchObject({ status: 'needs_information', reporterMessages: 1 });
    const team = report({
      status: 'investigating',
      updated_at: '2026-10-10T10:00:00Z',
      messages: [...base.messages, msg('Team', 'Thanks, we are looking into it.', '2026-10-10T10:00:00Z')],
    });
    expect(changed(before, seenOf(team))).toBe(true);
    expect(customerAnswer(before, team)).toBeNull();
  });

  it('tells a reply, a reopening and “It works” apart', () => {
    const wrote = report({
      updated_at: '2026-10-10T11:00:00Z',
      messages: [...base.messages, msg('Anna de Vries', 'Lab PC 1 and 2.', '2026-10-10T11:00:00Z')],
    });
    expect(customerAnswer(before, wrote)).toEqual({ event: 'wrote', text: 'Lab PC 1 and 2.' });

    const available = { ...before, status: 'available' };
    const reopened = report({
      status: 'new',
      updated_at: '2026-10-11T08:00:00Z',
      messages: [
        ...base.messages,
        msg('Anna de Vries', 'This still happens. Please investigate again.', '2026-10-11T08:00:00Z'),
      ],
    });
    expect(customerAnswer(available, reopened)).toEqual({
      event: 'reopened',
      text: 'This still happens. Please investigate again.',
    });
    // The team reopening it has no message of the customer's: nothing to answer.
    const teamReopen = report({
      status: 'new',
      updated_at: '2026-10-11T08:00:00Z',
      messages: [
        ...base.messages,
        msg('Team', 'This report was reopened by the team.', '2026-10-11T08:00:00Z'),
      ],
    });
    expect(customerAnswer(available, teamReopen)).toBeNull();

    const works = report({
      status: 'confirmed',
      updated_at: '2026-10-11T09:00:00Z',
      messages: [...base.messages, msg('Anna de Vries', 'The fix works. Thank you.', '2026-10-11T09:00:00Z')],
    });
    expect(customerAnswer(available, works)).toMatchObject({ event: 'confirmed' });
    expect(changed(seenOf(works), seenOf(works))).toBe(false);
  });
});

describe('what the thread says about a fix (TA-36, RN-S4, RN-S5)', () => {
  const link = prLink(52, 'https://github.com/lumio/tracker/pull/52');

  it('says when the customer hears, in plain words', () => {
    expect(link).toBe('[PR #52](https://github.com/lumio/tracker/pull/52)');
    expect(prLink(52, null)).toBe('PR #52');
    expect(FIX_WORDS.opened(link, false, 'dev.tracker.example')).toBe(
      `Opened ${link}. The customer hears once the fix is live on dev.tracker.example.`,
    );
    expect(FIX_WORDS.merged(link, 'dev.tracker.example')).toBe(
      `${link} was merged. The customer hears once it’s live on dev.tracker.example.`,
    );
    expect(FIX_WORDS.mergedQuiet(link, 16, 'Acme Desk')).toBe(
      `${link} was merged. If the customer should hear, set Acme Desk #16 to “Fixed, waiting for a release” on the run page.`,
    );
    const dev = { host: 'dev.tracker.example', version: '0.1.176', product: 'Acme Desk' };
    expect(FIX_WORDS.live(dev, 'try')).toBe(
      'The fix is live on dev.tracker.example (Acme Desk 0.1.176), so the customer was told and asked to try it.',
    );
    expect(FIX_WORDS.live(dev, 'coming')).toBe(
      'The fix is live on dev.tracker.example (Acme Desk 0.1.176), so the customer was told it’s fixed and comes with the next update.',
    );
    expect(
      FIX_WORDS.live({ host: 'desk.acme.example', version: '0.1.180', product: 'Acme Desk' }, 'try'),
    ).toBe(
      'The fix is live on desk.acme.example (Acme Desk 0.1.180), so the customer was told and asked to try it.',
    );
    expect(FIX_WORDS.live(dev, { why: 'asks' })).toBe(
      'The fix is live on dev.tracker.example (Acme Desk 0.1.176). The customer wasn’t told: this automation asks before replying to customers, so tell them on the run page.',
    );
    expect(FIX_WORDS.live(dev, { why: 'off' })).toBe(
      'The fix is live on dev.tracker.example (Acme Desk 0.1.176). The customer wasn’t told: this automation doesn’t reply to customers, so tell them on the run page.',
    );
    expect(FIX_WORDS.live({ merged: link }, 'coming')).toBe(
      `${link} was merged, so the customer was told it’s fixed and comes with the next update.`,
    );
    expect(FIX_WORDS.closed(link, true)).toBe(
      `${link} was closed without merging, so the customer isn’t told it’s fixed.`,
    );
    expect(FIX_WORDS.stopped('Acme Desk dev', 16)).toBe(
      'Stopped waiting for the fix of Acme Desk dev #16 to go live after 90 days: tell the customer on the run page once it is.',
    );
    expect(FIX_WORDS.deviceAgent(link, 'told')).toBe(
      `${link} changes what reaches customers with a release of its own, so the customer was told it’s fixed and comes with a coming update.`,
    );
    expect(FIX_WORDS.deviceAgent(link, { why: 'asks' })).toContain(
      'changes what reaches customers with a release of its own',
    );
  });
});
