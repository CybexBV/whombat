/**
 * Moneybird's page from documented answers (service-dashboards.md SD-61): invoices, bills and bank lines read
 * defensively, outstanding and overdue, the notices, and that names stay off the lines.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { list } from '../../words';
import { slotProblems } from '../slots';
import {
  daysLate,
  MONEYBIRD_CHECKS,
  MONEYBIRD_KIND,
  type MoneybirdBankLine,
  type MoneybirdInput,
  type MoneybirdInvoice,
  type MoneybirdSnapshot,
  moneybirdBankLine,
  moneybirdBill,
  moneybirdFigures,
  moneybirdInvoice,
  moneybirdSeen,
  moneybirdSkipped,
  moneybirdTotals,
  moneybirdView,
  periodOf,
  recentPeriod,
} from './moneybird';

const fixture = (name: string): unknown[] =>
  list(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'moneybird', name), 'utf8')));

const TZ = 'Europe/Amsterdam';
const now = new Date('2026-10-21T15:00:00Z');

const invoices = () =>
  fixture('sales-invoices.json')
    .map(moneybirdInvoice)
    .filter((i): i is MoneybirdInvoice => i !== null);

function snapshot(over: Partial<MoneybirdSnapshot> = {}): MoneybirdSnapshot {
  return {
    readAt: now,
    administration: '123',
    invoices: invoices(),
    bills: fixture('purchase-invoices.json')
      .map(moneybirdBill)
      .filter((b) => b !== null),
    bank: fixture('financial-mutations.json')
      .map(moneybirdBankLine)
      .filter((m): m is MoneybirdBankLine => m !== null),
    more: { invoices: false, bills: false, bank: false },
    ...over,
  };
}

const input = (over: Partial<MoneybirdInput> = {}): MoneybirdInput => ({
  snapshot: snapshot(),
  now,
  timeZone: TZ,
  ...over,
});

describe('Moneybird’s answers', () => {
  it('reads invoices, their customer and what is unpaid', () => {
    const all = invoices();
    expect(all.map((i) => i.number)).toEqual(['2026-0012', '2026-0019', '2026-0024']);
    expect(all[0]).toMatchObject({ customer: 'Foobar Holding B.V.', unpaid: 1240, dueDate: '2026-08-15' });
    expect(all[1]?.customer).toBe('Anna Jansen');
    expect(all[1]?.unpaid).toBe(250.5);
  });

  it('asks for every open item, whenever it was made', () => {
    expect(periodOf(now, TZ)).toBe('20100101..20271231');
  });

  it('counts days late from the due date in the burrow’s day', () => {
    const [late, reminded, open] = invoices();
    expect(daysLate(late as MoneybirdInvoice, now, TZ)).toBe(67);
    expect(daysLate(reminded as MoneybirdInvoice, now, TZ)).toBe(17);
    expect(daysLate(open as MoneybirdInvoice, now, TZ)).toBe(0);
  });
});

describe('Moneybird’s figures (SD-61)', () => {
  it('adds what is outstanding and what is overdue', () => {
    const t = moneybirdTotals(input());
    expect(t.outstanding.get('EUR')).toBeCloseTo(2350.5);
    expect(t.overdue.get('EUR')).toBeCloseTo(1490.5);
    expect(t.late.map((i) => i.number)).toEqual(['2026-0012', '2026-0019']);
    expect(t.veryLate.map((i) => i.number)).toEqual(['2026-0012']);
  });

  it('gives the card outstanding, overdue, bills and bank', () => {
    const figures = moneybirdFigures(input());
    expect(figures.map((k) => [k.key, k.value])).toEqual([
      ['outstanding', '€ 2,351'],
      ['overdue', '2'],
      ['bills', '2'],
      ['bank', '2'],
    ]);
    expect(figures[1]).toMatchObject({ rest: '· € 1,491', tone: 'bad' });
    expect(figures[2]?.sub).toContain('€ 121');
    for (const k of figures) expect(ThingPageKpi.safeParse(k).success).toBe(true);
    expect(moneybirdSeen(input()).glance.facts?.map((f) => f.label)).toEqual(['Outstanding', 'Overdue']);
  });

  it('leaves out bills and bank when the token may not read them', () => {
    const view = moneybirdView(input({ snapshot: snapshot({ bills: null, bank: null }) }));
    expect(
      moneybirdFigures(input({ snapshot: snapshot({ bills: null, bank: null }) })).map((k) => k.key),
    ).toEqual(['outstanding', 'overdue']);
    expect(view.panels.map((p) => p.id)).toEqual(['overdue', 'todo', 'people']);
  });
});

describe('Moneybird’s page in slots', () => {
  const recent = (): MoneybirdBankLine[] => [
    {
      id: 'r1',
      date: '2026-10-21',
      amount: 1240,
      open: 0,
      currency: 'EUR',
      message: null,
      counterparty: null,
    },
    {
      id: 'r2',
      date: '2026-10-20',
      amount: 350,
      open: 0,
      currency: 'EUR',
      message: null,
      counterparty: null,
    },
    {
      id: 'r3',
      date: '2026-10-20',
      amount: -45.95,
      open: 0,
      currency: 'EUR',
      message: null,
      counterparty: null,
    },
    {
      id: 'r4',
      date: '2026-10-12',
      amount: 800,
      open: 0,
      currency: 'EUR',
      message: null,
      counterparty: null,
    },
  ];

  it('follows the slots, without a row of figures', () => {
    const view = moneybirdView(input({ snapshot: snapshot({ recent: recent() }) }));
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['overdue', 'todo', 'week', 'people', 'bills', 'bank']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('puts what is overdue in Live, the latest first, linked to the invoice in Moneybird', () => {
    const live = moneybirdView(input()).panels.find((p) => p.id === 'overdue');
    if (live?.kind !== 'gallery') throw new Error('no live rows');
    expect(live.meta).toBe('2 overdue · € 1,491');
    expect(live.items.map((i) => [i.sub, i.badge?.text, i.badge?.tone])).toEqual([
      ['Invoice 2026-0012', '67 days late', 'bad'],
      ['Invoice 2026-0019', '17 days late', 'warn'],
    ]);
    expect(live.items[0]).toMatchObject({ title: 'Foobar Holding B.V.', noteEnd: '€ 1,240.00 unpaid' });
    expect(live.items[0]?.url).toBe('https://moneybird.com/123/sales_invoices/397225640427882428');
  });

  it('counts what is to do: outstanding with the invoices sent this week, bills, bank lines', () => {
    const todo = moneybirdView(input()).panels.find((p) => p.id === 'todo');
    if (todo?.kind !== 'list') throw new Error('no inventory');
    expect(todo.items.map((i) => [i.id, i.figure?.value])).toEqual([
      ['outstanding', '€ 2,351'],
      ['bills', '2'],
      ['bank', '2'],
    ]);
    expect(todo.items[0]?.figure?.note).toBeUndefined();
    const later = moneybirdView(input({ now: new Date('2026-10-18T10:00:00Z') })).panels.find(
      (p) => p.id === 'todo',
    );
    expect(later?.kind === 'list' && later.items[0]?.figure?.note).toBe('+1 sent this week');
  });

  it('ranks who owes most', () => {
    const who = moneybirdView(input()).panels.find((p) => p.id === 'people');
    if (who?.kind !== 'bars') throw new Error('no people');
    expect(who.items.map((i) => [i.label, i.value, i.note])).toEqual([
      ['Foobar Holding B.V.', '€ 1,240', '1 invoice · 1 late'],
      ['Acme B.V.', '€ 860', '1 invoice'],
      ['Anna Jansen', '€ 251', '1 invoice · 1 late'],
    ]);
  });

  it('draws money in per day this week from the bank lines, with the change on the week before', () => {
    const week = moneybirdView(input({ snapshot: snapshot({ recent: recent() }) })).panels.find(
      (p) => p.id === 'week',
    );
    if (week?.kind !== 'chart') throw new Error('no trend');
    expect(week.series[0]?.values.slice(-2)).toEqual([350, 1240]);
    expect(week.figure?.value).toBe('€ 1,590');
    expect(week.stats?.[0]?.[0]?.text).toBe('+99 %');
    expect(moneybirdView(input()).panels.find((p) => p.id === 'week')).toBeUndefined();
    // Only this week came back (the 14 days held more than Moneybird answers at once): no change on the week before.
    const short = moneybirdView(
      input({ snapshot: snapshot({ recent: recent(), recentDays: 7 }) }),
    ).panels.find((p) => p.id === 'week');
    if (short?.kind !== 'chart') throw new Error('no trend');
    expect(short.figure?.value).toBe('€ 1,590');
    expect(short.stats?.[0]?.[0]?.text).not.toBe('+99 %');
  });

  it('asks the bank lines of the last 14 days, today last', () => {
    expect(recentPeriod(now, TZ)).toBe('20261008..20261021');
    expect(recentPeriod(now, TZ, 7)).toBe('20261015..20261021');
  });
});

describe('Moneybird’s Worth a look (SD-61)', () => {
  it('gives each invoice over 30 days late its own amber line, only you, until it’s paid', () => {
    const view = moneybirdView(input());
    expect(view.notices.map((n) => [n.tone, n.nature, n.check, n.subject?.id])).toEqual([
      ['warn', 'you', MONEYBIRD_CHECKS.late, 'invoice:397225640427882428'],
    ]);
    const line = view.notices[0];
    expect(line?.subject?.name).toContain('2026-0012');
    expect(line?.ignore?.lifts).toBe('fixed');
    expect(line?.episode).toBeUndefined();
    expect(line?.link && 'url' in line.link ? line.link.url : '').toContain('397225640427882428');
    expect(view.status?.status).toBe('warn');
    for (const n of view.notices) expect(ThingPageNotice.safeParse(n).success).toBe(true);
  });

  it('keeps customers off the lines', () => {
    expect(JSON.stringify(moneybirdView(input()).notices)).not.toContain('Foobar');
  });

  it('warns past 50 unmatched bank lines, and says when there may be more', () => {
    const line = snapshot().bank?.[0] as MoneybirdBankLine;
    const bank = Array.from({ length: 51 }, (_, i) => ({ ...line, id: `m${i}` }));
    const view = moneybirdView(
      input({
        snapshot: snapshot({ invoices: [], bank, more: { invoices: false, bills: false, bank: true } }),
      }),
    );
    expect(view.notices.map((n) => [n.id, n.nature, n.band])).toEqual([['bank', 'fyi', 1]]);
    expect(view.notices[0]?.title).toContain('51+');
    // A heads-up: the head stays calm.
    expect(view.status?.status).toBe('ok');
    expect(moneybirdSkipped(snapshot({ bank, more: { invoices: false, bills: false, bank: true } }))).toEqual(
      [MONEYBIRD_CHECKS.bank],
    );
    const more = moneybirdView(
      input({
        snapshot: snapshot({ invoices: [], bank: [...bank, ...bank.map((m) => ({ ...m, id: `x${m.id}` }))] }),
      }),
    );
    expect(more.notices[0]?.band).toBe(2);
    const todo = view.panels.find((p) => p.id === 'todo');
    expect(todo?.kind === 'list' && todo.items.find((i) => i.id === 'bank')).toMatchObject({
      right: '51+',
      tone: 'warn',
    });
  });

  it('is calm with nothing late', () => {
    const view = moneybirdView(input({ snapshot: snapshot({ invoices: invoices().slice(2) }) }));
    expect(view.notices).toEqual([]);
    expect(view.status?.status).toBe('ok');
  });

  it('watches late invoices and bank lines, skipping what it couldn’t read whole', () => {
    expect(MONEYBIRD_KIND.checks?.map((c) => c.check)).toEqual(Object.values(MONEYBIRD_CHECKS));
    expect(moneybirdSkipped(snapshot())).toEqual([]);
    expect(
      moneybirdSkipped(snapshot({ bank: null, more: { invoices: true, bills: false, bank: false } })),
    ).toEqual([MONEYBIRD_CHECKS.late, MONEYBIRD_CHECKS.bank]);
  });
});

describe('what the page shows', () => {
  it('names suppliers and bank lines below the slots', () => {
    const view = moneybirdView(input());
    expect(JSON.stringify(view.panels.find((p) => p.id === 'bills'))).toContain('Hosting Co');
    expect(view.panels.find((p) => p.id === 'bank')?.place).toBe('main');
    expect(JSON.stringify(view)).not.toContain('sales_invoices/abcdef');
  });
});
