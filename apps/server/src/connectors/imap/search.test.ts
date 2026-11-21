import { describe, expect, it } from 'vitest';
import { and, parseMailQuery } from './search';

const now = new Date('2026-10-19T12:00:00Z');
const q = (query: string) => parseMailQuery(query, now);

describe('Gmail words as IMAP SEARCH (CM-25)', () => {
  it('lists the inbox for an empty query', () => {
    expect(q('')).toEqual({ folder: { role: 'inbox' }, criteria: { all: true } });
  });

  it('maps the address and subject operators', () => {
    expect(q('from:mara@example.com to:bo cc:jo subject:invoice').criteria).toEqual({
      from: 'mara@example.com',
      to: 'bo',
      cc: 'jo',
      subject: 'invoice',
    });
  });

  it('maps is: to flags', () => {
    expect(q('is:unread').criteria).toEqual({ seen: false });
    expect(q('is:read').criteria).toEqual({ seen: true });
    expect(q('is:starred').criteria).toEqual({ flagged: true });
  });

  it('turns relative and absolute dates into days', () => {
    expect(q('newer_than:7d').criteria).toEqual({ since: '2026-10-12' });
    expect(q('older_than:2m').criteria).toEqual({ before: '2026-08-19' });
    expect(q('newer_than:1y').criteria).toEqual({ since: '2025-10-19' });
    expect(q('after:2026/10/01 before:2026-10-15').criteria).toEqual({
      since: '2026-10-01',
      before: '2026-10-15',
    });
  });

  it('picks the folder with in: and label:, by role or by name', () => {
    expect(q('in:sent').folder).toEqual({ role: 'sent' });
    expect(q('in:spam').folder).toEqual({ role: 'junk' });
    expect(q('in:anywhere').folder).toEqual({ role: 'all' });
    expect(q('label:Receipts from:shop').folder).toEqual({ name: 'Receipts' });
    expect(q('in:"Client work" x').folder).toEqual({ name: 'Client work' });
    // IMAP searches one folder: a negated one is left out.
    expect(q('-in:spam hello').folder).toEqual({ role: 'inbox' });
  });

  it('searches quoted and plain words as text, and negates with -', () => {
    expect(q('"quarterly report"').criteria).toEqual({ text: 'quarterly report' });
    expect(q('-from:noreply budget').criteria).toEqual({ not: { from: 'noreply' }, text: 'budget' });
    expect(q('subject:"Q3 plan"').criteria).toEqual({ subject: 'Q3 plan' });
  });

  it('ors two terms around OR', () => {
    expect(q('from:a OR from:b').criteria).toEqual({ or: [{ from: 'a' }, { from: 'b' }] });
  });

  it('sends unknown operators as words, and has:attachment as the nearest header', () => {
    expect(q('is:important').criteria).toEqual({ text: 'is:important' });
    expect(q('https://example.com/x').criteria).toEqual({ text: 'https://example.com/x' });
    expect(q('has:attachment').criteria).toEqual({ header: { 'content-type': 'multipart/mixed' } });
    expect(q('newer_than:soon').criteria).toEqual({ text: 'newer_than:soon' });
  });

  it('keeps every repeated key by nesting it', () => {
    const c = q('budget plan review').criteria;
    expect(c).toEqual({ text: 'budget', or: [{ text: 'plan', or: [{ text: 'review' }] }] });
    const nested = and([
      { not: { seen: true } },
      { not: { flagged: true } },
      { or: [{ from: 'a' }] },
      { or: [{ to: 'c' }] },
    ]);
    // `or` and `not` both taken: the first part goes under a one-element OR, the rest under a double NOT.
    expect(nested).toEqual({
      or: [{ not: { seen: true }, or: [{ from: 'a' }] }],
      not: { not: { not: { flagged: true }, or: [{ to: 'c' }] } },
    });
  });
});
