/**
 * Mollie's page from documented answers (service-dashboards.md SD-60): the payments read defensively, today's and the
 * month's figures in the settlement currency, the chart, the chargeback and failure notices, and who paid for what.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { amount, money } from './common';
import {
  MOLLIE_CHECKS,
  MOLLIE_KIND,
  type MollieInput,
  type MolliePayment,
  type MollieSnapshot,
  methodWords,
  mollieFigures,
  mollieSeen,
  mollieSkipped,
  mollieTotals,
  mollieView,
  paidPerDay,
  parseChargebacks,
  parsePayments,
  parseRefunds,
  sinceOf,
  todayChart,
} from './mollie';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'mollie', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam.
const now = new Date('2026-10-21T15:00:00Z');

function snapshot(over: Partial<MollieSnapshot> = {}): MollieSnapshot {
  return {
    readAt: now,
    payments: parsePayments(fixture('payments.json')).payments,
    partial: false,
    refunds: parseRefunds(fixture('refunds.json')),
    chargebacks: parseChargebacks(fixture('chargebacks.json')),
    nextPayout: { value: 2416.3, currency: 'EUR' },
    ...over,
  };
}

const input = (over: Partial<MollieInput> = {}): MollieInput => ({
  snapshot: snapshot(),
  now,
  timeZone: TZ,
  ...over,
});

const panel = (view: ReturnType<typeof mollieView>, id: string) => view.panels.find((p) => p.id === id);

describe('Mollie’s answers', () => {
  it('reads payments, the next page, descriptions and payers', () => {
    const { payments, next } = parsePayments(fixture('payments.json'));
    expect(payments.map((p) => p.id)).toEqual([
      'tr_7UhSN1zuXS',
      'tr_Fail0001',
      'tr_Open0001',
      'tr_UsdPaid1',
      'tr_Refund01',
      'tr_LastMon1',
    ]);
    expect(next).toBe('tr_Older0001');
    const first = payments[0] as MolliePayment;
    expect(first.amount).toEqual({ value: 1240.5, currency: 'EUR' });
    expect(first.customer).toBe('A. Jansen');
    expect(first.dashboard).toContain('tr_7UhSN1zuXS');
    expect(payments[1]?.customer).toBe('B. de Vries');
    expect(payments[3]?.settlement).toEqual({ value: 92.1, currency: 'EUR' });
  });

  it('takes nothing from an answer that isn’t one', () => {
    expect(parsePayments({ _embedded: { payments: [{ id: 'x' }, null, 'y'] } }).payments).toEqual([]);
    expect(parsePayments(null)).toEqual({ payments: [], next: null });
    expect(parseRefunds({ _embedded: { refunds: 'no' } })).toEqual([]);
    expect(parseChargebacks({})).toEqual([]);
  });

  it('reads back to the month’s start or 30 days, the earlier', () => {
    expect(sinceOf(now, TZ).toISOString()).toBe('2026-09-21T22:00:00.000Z');
  });
});

describe('Mollie’s figures (SD-60)', () => {
  it('adds today and the month in the settlement currency', () => {
    const t = mollieTotals(input());
    expect(t.paidToday.get('EUR')).toBeCloseTo(1240.5);
    expect(t.paidTodayN).toBe(1);
    // 1240.50 today, the dollar payment as 92.10, the refunded one still came in this month.
    expect(t.paidMonth.get('EUR')).toBeCloseTo(1392.6);
    expect(t.paidMonth.has('USD')).toBe(false);
    expect(t.failedToday).toBe(1);
    expect(t.triedToday).toBe(2);
  });

  it('gives the card four figures, the payout only when the key may read it', () => {
    const figures = mollieFigures(input());
    const kpi = (key: string) => figures.find((k) => k.key === key);
    expect(figures.map((k) => k.key)).toEqual(['paid-today', 'month', 'failed-today', 'payout']);
    expect(kpi('paid-today')?.value).toBe(money(1240.5, 'EUR'));
    expect(kpi('month')?.value).toBe('€ 1,393');
    expect(kpi('payout')?.value).toBe('€ 2,416');
    for (const k of figures) expect(ThingPageKpi.safeParse(k).success).toBe(true);
    const plain = mollieFigures(input({ snapshot: snapshot({ nextPayout: null, partial: true }) }));
    expect(plain.map((k) => k.key)).toEqual(['paid-today', 'month', 'failed-today']);
    expect(plain.find((k) => k.key === 'month')?.rest).toBe('at least');
  });

  it('keeps the card’s figures: paid today and this month', () => {
    const card = mollieSeen(input()).glance;
    expect(card.facts?.map((f) => [f.label, f.value])).toEqual([
      ['Paid today', money(1240.5, 'EUR')],
      ['This month', '€ 1,393'],
    ]);
  });

  it('adds up paid per day over 30 days', () => {
    const { days, values } = paidPerDay(input(), 'EUR');
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toBe('2026-10-21');
    expect(values.at(-1)).toBeCloseTo(1240.5);
    expect(values[days.indexOf('2026-09-25')]).toBe(300);
  });
});

describe('Mollie’s page in slots', () => {
  it('follows the slots, without a row of figures or a chart card', () => {
    const view = mollieView(input());
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['payments', 'month', 'week', 'today', 'refunds']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('shows today’s payments in Live: what, who, how much, failed ones marked, unfinished checkouts left out', () => {
    const live = panel(mollieView(input()), 'payments');
    if (live?.kind !== 'list') throw new Error('no live list');
    expect(live.title).toBe('Payments today');
    expect(live.meta).toBe('€ 1,241 today · 1 paid · 1 failed');
    expect(live.items.map((i) => i.id)).toEqual(['tr_7UhSN1zuXS', 'tr_Fail0001']);
    const [paid, failed] = live.items;
    expect(paid?.title).toMatch(/^€ 1,240\.50/);
    expect(paid?.detail).toContain('A. Jansen');
    expect(paid?.right).toBe('2 h ago');
    expect(paid?.url).toContain('/payments/tr_7UhSN1zuXS');
    expect(failed?.tone).toBe('bad');
    expect(failed?.detail).toMatch(/^Failed · .*Card/);
  });

  it('shows the latest payments while today has none yet', () => {
    const live = panel(mollieView(input({ now: new Date('2026-10-22T05:00:00Z') })), 'payments');
    if (live?.kind !== 'list') throw new Error('no live list');
    expect(live.title).toBe('Latest payments');
    expect(live.meta).toBe('Nothing yet today');
    expect(live.items[0]?.id).toBe('tr_7UhSN1zuXS');
  });

  it('counts this month in Inventory: paid with this week, refunded, chargebacks, the payout', () => {
    const month = panel(mollieView(input()), 'month');
    if (month?.kind !== 'list') throw new Error('no inventory');
    const byId = new Map(month.items.map((i) => [i.id, i]));
    expect([...byId.keys()]).toEqual(['paid', 'refunded', 'chargebacks', 'payout']);
    expect(byId.get('paid')?.figure).toEqual({ value: '€ 1,393', note: '+€ 1,333 this week', tone: 'ok' });
    expect(byId.get('refunded')?.figure?.value).toBe('€ 60');
    expect(byId.get('refunded')?.detail).toBe('On 1 payment this month');
    expect(byId.get('payout')?.figure?.value).toBe('€ 2,416');
    const partial = panel(mollieView(input({ snapshot: snapshot({ partial: true }) })), 'month');
    if (partial?.kind !== 'list') throw new Error('no inventory');
    expect(partial.items[0]?.detail).toMatch(/^At least /);
  });

  it('draws paid per day this week with the change on the week before', () => {
    const week = panel(mollieView(input()), 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    expect(week.labels?.at(-1)).toBe('Today');
    expect(week.series[0]?.values.at(-1)).toBeCloseTo(1240.5);
    expect(week.figure?.value).toBe('€ 1,333');
    expect(week.stats?.[0]?.[0]?.text).toMatch(/^\+/);
  });

  it('ranks who paid most only when payers come back', () => {
    expect(panel(mollieView(input()), 'people')).toBeUndefined();
    const again = (id: string, who: string, value: number, at: string): MolliePayment => ({
      ...(parsePayments(fixture('payments.json')).payments[0] as MolliePayment),
      id,
      customer: who,
      amount: { value, currency: 'EUR' },
      settlement: null,
      paidAt: new Date(at),
      createdAt: new Date(at),
    });
    const payments = [
      again('a1', 'A. Jansen', 100, '2026-10-20T10:00:00Z'),
      again('a2', 'A. Jansen', 50, '2026-10-19T10:00:00Z'),
      again('b1', 'B. de Vries', 30, '2026-10-18T10:00:00Z'),
      again('b2', 'B. de Vries', 30, '2026-10-17T10:00:00Z'),
    ];
    const who = panel(mollieView(input({ snapshot: snapshot({ payments }) })), 'people');
    if (who?.kind !== 'bars') throw new Error('no people');
    expect(who.items.map((i) => [i.label, i.value, i.note])).toEqual([
      ['A. Jansen', '€ 150', '2 payments'],
      ['B. de Vries', '€ 60', '2 payments'],
    ]);
  });

  it('keeps today by the hour below the slots, with its hours as words', () => {
    const chart = panel(mollieView(input()), 'today');
    if (chart?.kind !== 'chart') throw new Error('no chart');
    expect(chart.place).toBe('main');
    expect(chart.labels).toHaveLength(24);
    expect(chart.labels?.[9]).toBe('09:00');
  });
});

describe('Mollie’s today by the hour', () => {
  const paid = (id: string, at: string, value: number): MolliePayment => ({
    id,
    mode: 'live',
    createdAt: new Date(at),
    paidAt: new Date(at),
    failedAt: null,
    status: 'paid',
    amount: { value, currency: 'EUR' },
    settlement: null,
    refunded: 0,
    method: 'ideal',
    description: null,
    customer: null,
    dashboard: null,
  });
  // Today (Wednesday) and the Wednesday before; now is 17:00 in Amsterdam.
  const payments = [
    paid('t2', '2026-10-21T14:30:00Z', 40),
    paid('t1', '2026-10-21T08:00:00Z', 100),
    paid('w3', '2026-10-14T16:00:00Z', 500),
    paid('w2', '2026-10-14T14:00:00Z', 30),
    paid('w1', '2026-10-14T07:00:00Z', 50),
  ];

  it('adds up today hour by hour against the same weekday last week, by this time of day', () => {
    const chart = todayChart(input({ snapshot: snapshot({ payments }) }), 'EUR');
    expect(ThingPagePanel.safeParse(chart).success).toBe(true);
    expect(chart?.figure?.value).toBe('€ 140');
    expect(chart?.series.map((x) => [x.key, x.label, x.latest])).toEqual([
      ['today', 'Today', '€ 140'],
      ['week', 'Last Wednesday', '€ 80'],
    ]);
    const today = chart?.series[0]?.values ?? [];
    expect(today).toHaveLength(24);
    expect(today[16]).toBe(140);
    expect(today[17]).toBe(140);
    expect(today[18]).toBeNull();
    expect(chart?.series[1]?.values[23]).toBe(580);
    expect(chart?.stats?.[1]?.map((p) => p.text).join('')).toContain('75 %');
  });

  it('is left out when the payments read don’t reach last week', () => {
    const recent = payments.slice(0, 2);
    expect(todayChart(input({ snapshot: snapshot({ payments: recent, partial: true }) }), 'EUR')).toBeNull();
    expect(todayChart(input({ snapshot: snapshot({ payments: [] }) }), 'EUR')).toBeNull();
  });
});

describe('Mollie’s Worth a look (SD-60)', () => {
  it('puts a chargeback first, bad, with the payment’s page, one line for each', () => {
    const view = mollieView(input());
    const cb = view.notices.find((n) => n.check === MOLLIE_CHECKS.chargeback);
    expect(cb).toMatchObject({
      tone: 'bad',
      nature: 'you',
      subject: { id: 'chargeback:chb_n9z0tp' },
      ignore: { lifts: 'fixed' },
    });
    expect(cb?.title).toContain(amount(1240.5, 'EUR'));
    expect(cb?.link).toMatchObject({ kind: 'url' });
    expect(cb?.link && 'url' in cb.link ? cb.link.url : '').toContain('tr_7UhSN1zuXS');
    expect(view.status?.status).toBe('bad');
    for (const n of view.notices) expect(ThingPageNotice.safeParse(n).success).toBe(true);
  });

  it('warns when more than a quarter of today’s payments failed, at least five of ten, until midnight', () => {
    const today = (i: number, status: 'paid' | 'failed'): MolliePayment => ({
      id: `tr_${status}${i}`,
      mode: 'live',
      createdAt: new Date(now.getTime() - 3600_000),
      paidAt: status === 'paid' ? new Date(now.getTime() - 3600_000) : null,
      failedAt: status === 'failed' ? new Date(now.getTime() - 3600_000) : null,
      status,
      amount: { value: 10, currency: 'EUR' },
      settlement: null,
      refunded: 0,
      method: 'ideal',
      description: null,
      customer: null,
      dashboard: null,
    });
    const day = (paid: number, failed: number) =>
      snapshot({
        chargebacks: [],
        payments: [
          ...Array.from({ length: paid }, (_, i) => today(i, 'paid')),
          ...Array.from({ length: failed }, (_, i) => today(i, 'failed')),
        ],
      });
    const view = mollieView(input({ snapshot: day(6, 5) }));
    expect(view.notices.map((n) => [n.check, n.nature, n.tone])).toEqual([
      [MOLLIE_CHECKS.failing, 'problem', 'warn'],
    ]);
    const line = view.notices[0];
    expect(line?.detail).toContain('iDEAL');
    expect(line?.link?.kind).toBe('ask');
    // Quiet until midnight in Amsterdam; the day is the episode, not a count.
    expect(line?.ignore).toMatchObject({ lifts: 'period', until: '2026-10-21T22:00:00.000Z' });
    expect(line?.episode).toBe('2026-10-21');
    expect(mollieFigures(input({ snapshot: day(6, 5) })).find((k) => k.key === 'failed-today')).toMatchObject(
      {
        value: '5',
        tone: 'warn',
      },
    );
    // 4 of 9 on a quiet day isn't many.
    expect(mollieView(input({ snapshot: day(5, 4) })).notices).toEqual([]);
    expect(mollieView(input({ snapshot: snapshot({ chargebacks: [] }) })).notices).toEqual([]);
  });

  it('gives each chargeback its own line, the third and on together', () => {
    const cbs = Array.from({ length: 10 }, (_, i) => ({
      id: `chb_${i}`,
      amount: { value: 10 + i, currency: 'EUR' },
      createdAt: new Date(now.getTime() - (i + 1) * 3600_000),
      reversedAt: null,
      paymentId: null,
      reason: null,
    }));
    const view = mollieView(input({ snapshot: snapshot({ chargebacks: cbs }) }));
    const lines = view.notices.filter((n) => n.check === MOLLIE_CHECKS.chargeback);
    expect(lines.map((n) => n.subject?.id)).toEqual([
      ...cbs.slice(0, 2).map((c) => `chargeback:${c.id}`),
      '+more',
    ]);
    expect(lines[2]?.episode).not.toMatch(/€|\d{2}\.\d{2}/);
    // Ten read, all recent: there may be more, so an Ignore of one doesn’t end now.
    expect(mollieSkipped(snapshot({ chargebacks: cbs }), now, TZ)).toEqual([MOLLIE_CHECKS.chargeback]);
    expect(mollieSkipped(snapshot(), now, TZ)).toEqual([]);
    expect(mollieSkipped(snapshot({ chargebacks: null }), now, TZ)).toEqual([MOLLIE_CHECKS.chargeback]);
  });

  it('skips failing payments when today wasn’t read back to midnight', () => {
    const late = snapshot().payments.filter((p) => p.createdAt >= new Date('2026-10-21T10:00:00Z'));
    expect(mollieSkipped(snapshot({ payments: late, partial: true }), now, TZ)).toEqual([
      MOLLIE_CHECKS.failing,
    ]);
  });

  it('watches chargebacks, failing payments and test mode', () => {
    expect(MOLLIE_KIND.checks?.map((c) => c.check)).toEqual(Object.values(MOLLIE_CHECKS));
  });

  it('says when every payment is a test one', () => {
    const s = snapshot({
      chargebacks: [],
      payments: snapshot().payments.map((p) => ({ ...p, mode: 'test' as const })),
    });
    expect(mollieView(input({ snapshot: s })).notices.map((n) => [n.id, n.tone, n.nature])).toEqual([
      ['test-mode', 'info', 'fyi'],
    ]);
  });
});

describe('what the page shows', () => {
  it('lists refunds and chargebacks below the slots', () => {
    const refunds = panel(mollieView(input()), 'refunds');
    expect(JSON.stringify(refunds)).toContain('Returned order');
    expect(refunds?.place).toBe('main');
    expect(ThingPagePanel.safeParse(refunds).success).toBe(true);
  });
});

describe('Mollie’s words', () => {
  it('names payment methods', () => {
    expect(methodWords('ideal')).toBe('iDEAL');
    expect(methodWords('paybybank')).toBe('Pay by bank');
    expect(methodWords('newthing')).toBe('Newthing');
    expect(methodWords(null)).toBe('—');
  });

  it('writes money as the page’s figures do', () => {
    expect(money(1240.4, 'EUR')).toBe('€ 1,240');
    expect(money(4.2, 'EUR')).toBe('€ 4.20');
    expect(money(0, 'EUR')).toBe('€ 0');
    expect(money(1500, 'CHF')).toBe('CHF 1,500');
    expect(money(-12.5, 'USD')).toBe('−$ 13');
    expect(amount(1240.5, 'EUR')).toBe('€ 1,240.50');
    expect(amount(1200, 'JPY')).toBe('JPY 1,200');
  });
});
