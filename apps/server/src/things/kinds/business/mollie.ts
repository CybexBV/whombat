/**
 * Mollie's page (service-dashboards.md SD-60, SD-S18), in slots (service-slots.md): today's payments in Live, this month
 * in Inventory (paid, refunded, chargebacks, the next payout when the key may read it), paid per day this week, who paid
 * most when payers come back; today by the hour and the refunds and chargebacks below; a
 * chargeback or many failed payments in Worth a look. Read with the connection's key through Mollie API v2: the
 * payments newest first, paged back to the start of the month or 30 days (kept 5 minutes; the newest 50 every read),
 * `/v2/refunds`, `/v2/chargebacks`, and `/v2/settlements/next` (an access token or OAuth only: with a plain API key the
 * figure is left out), with descriptions and payers' names. Read only. Signed in with Mollie, the same page is read
 * through its MCP server's tools that only read, without refunds and chargebacks (`mollie-mcp.ts`).
 */
import type { ThingLine, ThingPageItem, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import { cap, clip, dayMonth, line, list, plural, rec, span, str, thousands, when } from '../../words';
import { cachedRead, latestRead } from '../read';
import type { KindModule } from '../registry';
import {
  countLine,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveList,
  type PeoplePanel,
  people,
  lastDays as slotDays,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import { fixed, itemLines, type KindNotice, lookInto, period } from '../storage/lines';
import type { ChartPanel, KindCtx, KindView } from '../types';
import {
  addTo,
  amount,
  amountOf,
  lastDays,
  loader,
  localDay,
  mainCurrency,
  money,
  monthStart,
  nextMidnight,
  optional,
  readJson,
  type Sums,
  seenOfView,
  startOfDay,
  statusFrom,
  todayStart,
  viewOrProblem,
  webUrl,
} from './common';
import { mollieMcpLatest, mollieMcpPage, mollieMcpSeen } from './mollie-mcp';

const NAME = 'Mollie';
const DAY = 86_400_000;
/** The payments back to the month's start or 30 days are Mollie's heaviest read: kept 5 minutes. */
export const HISTORY_CACHE_MS = 5 * 60_000;
/** At most this many pages of 250 (2,000 payments); past it the month's figures say “at least”. */
export const HISTORY_PAGES = 8;
const PAGE_SIZE = 250;
/** The history's pages must end before the whole read's deadline: the newest 50 still show. */
const HISTORY_DEADLINE_MS = 12_000;
export const DASHBOARD = 'https://my.mollie.com/dashboard';

/* Reading ------------------------------------------------------------------------------------------------------------ */

type Money = { value: number; currency: string };

export interface MolliePayment {
  id: string;
  mode: 'live' | 'test' | null;
  createdAt: Date;
  paidAt: Date | null;
  failedAt: Date | null;
  status: string;
  amount: Money;
  /** What it brings in the account's currency (another currency converted), when Mollie says. */
  settlement: Money | null;
  refunded: number;
  method: string | null;
  description: string | null;
  /** The payer's name (an iDEAL or bank account's holder, a card's). */
  customer: string | null;
  dashboard: string | null;
}

export interface MollieRefund {
  id: string;
  amount: Money;
  status: string;
  createdAt: Date;
  paymentId: string | null;
  description: string | null;
}

export interface MollieChargeback {
  id: string;
  amount: Money;
  createdAt: Date;
  reversedAt: Date | null;
  paymentId: string | null;
  reason: string | null;
}

export interface MollieSnapshot {
  readAt: Date;
  /** Newest first, back to `since` (or as far as `HISTORY_PAGES` reached). */
  payments: MolliePayment[];
  /** The pages stopped before `since`: the month's figures are at least what they say. */
  partial: boolean;
  refunds: MollieRefund[] | null;
  chargebacks: MollieChargeback[] | null;
  /** The next settlement's amount (an access token or OAuth only). */
  nextPayout: Money | null;
}

const dateOf = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
};

/** One payment of `/v2/payments`, the fields shown; null when it isn't one. */
export function molliePayment(raw: unknown): MolliePayment | null {
  const p = rec(raw);
  const id = str(p.id);
  const createdAt = dateOf(p.createdAt);
  const value = amountOf(p.amount);
  if (!id || !createdAt || !value) return null;
  const details = rec(p.details);
  const mode = str(p.mode);
  return {
    id: id.slice(0, 60),
    mode: mode === 'live' || mode === 'test' ? mode : null,
    createdAt,
    paidAt: dateOf(p.paidAt),
    failedAt: dateOf(p.failedAt),
    status: str(p.status) ?? 'open',
    amount: value,
    settlement: amountOf(p.settlementAmount),
    refunded: amountOf(p.amountRefunded)?.value ?? 0,
    method: str(p.method),
    description: str(p.description)?.slice(0, 200) ?? null,
    customer: (str(details.consumerName) ?? str(details.cardHolder))?.slice(0, 120) ?? null,
    dashboard: webUrl(rec(rec(p._links).dashboard).href),
  };
}

/** A list answer's `_embedded[key]`. */
const embedded = (body: unknown, key: string) => list(rec(rec(body)._embedded)[key]);

/** `/v2/payments`: the payments and the next page's `from`. */
export function parsePayments(body: unknown): { payments: MolliePayment[]; next: string | null } {
  const payments = embedded(body, 'payments')
    .map(molliePayment)
    .filter((p): p is MolliePayment => p !== null);
  const href = str(rec(rec(rec(body)._links).next).href);
  let next: string | null = null;
  if (href)
    try {
      next = new URL(href).searchParams.get('from');
    } catch {
      next = null;
    }
  return { payments, next };
}

export function parseRefunds(body: unknown): MollieRefund[] {
  return embedded(body, 'refunds')
    .map((raw) => {
      const r = rec(raw);
      const id = str(r.id);
      const value = amountOf(r.amount);
      const createdAt = dateOf(r.createdAt);
      if (!id || !value || !createdAt) return null;
      return {
        id: id.slice(0, 60),
        amount: value,
        status: str(r.status) ?? 'pending',
        createdAt,
        paymentId: str(r.paymentId),
        description: str(r.description)?.slice(0, 200) ?? null,
      };
    })
    .filter((r): r is MollieRefund => r !== null);
}

export function parseChargebacks(body: unknown): MollieChargeback[] {
  return embedded(body, 'chargebacks')
    .map((raw) => {
      const c = rec(raw);
      const id = str(c.id);
      const value = amountOf(c.amount);
      const createdAt = dateOf(c.createdAt);
      if (!id || !value || !createdAt) return null;
      const reason = rec(c.reason);
      return {
        id: id.slice(0, 60),
        amount: value,
        createdAt,
        reversedAt: dateOf(c.reversedAt),
        paymentId: str(c.paymentId),
        reason: (str(reason.description) ?? str(reason.code))?.slice(0, 120) ?? null,
      };
    })
    .filter((c): c is MollieChargeback => c !== null);
}

/** How far back the payments are read: the month's start or 30 days, whichever is earlier. */
export function sinceOf(now: Date, timeZone: string): Date {
  const days = lastDays(now, timeZone, 30)[0] as string;
  return new Date(Math.min(monthStart(now, timeZone).getTime(), startOfDay(days, timeZone).getTime()));
}

interface History {
  payments: MolliePayment[];
  partial: boolean;
  nextPayout: Money | null;
}

async function readHistory(services: Services, row: CatalogConnectionRow, since: Date): Promise<History> {
  const payments: MolliePayment[] = [];
  let from: string | null = null;
  let partial = true;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const body = await readJson(services, row, NAME, '/v2/payments', {
      query: { limit: String(PAGE_SIZE), ...(from ? { from } : {}) },
    });
    const parsed = parsePayments(body);
    payments.push(...parsed.payments);
    const oldest = parsed.payments.at(-1);
    if (!parsed.next || !oldest || oldest.createdAt < since) {
      partial = false;
      break;
    }
    from = parsed.next;
  }
  // An access token or OAuth may read the next settlement; a plain API key may not (no notice, the brief).
  const next = await optional(readJson(services, row, NAME, '/v2/settlements/next'));
  return {
    payments: payments.filter((p) => p.createdAt >= since),
    partial,
    nextPayout: next ? amountOf(rec(next).amount) : null,
  };
}

async function readMollie(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<MollieSnapshot> {
  const since = sinceOf(now, timeZone);
  const get = (path: string, limit: number) =>
    readJson(services, row, NAME, path, { query: { limit: String(limit) } });
  const [latest, history, refunds, chargebacks] = await Promise.all([
    get('/v2/payments', 50),
    optional(
      cachedRead(
        services,
        `mollie-history:${row.id}:${timeZone}`,
        row,
        loader(NAME, () => readHistory(services, row, since), HISTORY_DEADLINE_MS),
        HISTORY_CACHE_MS,
      ),
    ),
    optional(get('/v2/refunds', 10)),
    optional(get('/v2/chargebacks', 10)),
  ]);
  // The newest 50 as they are now over the kept history.
  const fresh = parsePayments(latest).payments;
  const seen = new Set(fresh.map((p) => p.id));
  const payments = [...fresh, ...(history?.payments ?? []).filter((p) => !seen.has(p.id))]
    .filter((p) => p.createdAt >= since)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    readAt: now,
    payments,
    partial: history ? history.partial : fresh.length >= 50,
    refunds: refunds ? parseRefunds(refunds) : null,
    chargebacks: chargebacks ? parseChargebacks(chargebacks) : null,
    nextPayout: history?.nextPayout ?? null,
  };
}

/** Mollie's read for its page (PS-01). */
export function mollieLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return latestRead(
    services,
    `mollie:${row.id}:${timeZone}`,
    row,
    loader(NAME, () => readMollie(services, row, now, timeZone)),
  );
}

/* Words -------------------------------------------------------------------------------------------------------------- */

const METHODS: Record<string, string> = {
  ideal: 'iDEAL',
  creditcard: 'Card',
  bancontact: 'Bancontact',
  paypal: 'PayPal',
  banktransfer: 'Bank transfer',
  directdebit: 'Direct debit',
  applepay: 'Apple Pay',
  googlepay: 'Google Pay',
  klarna: 'Klarna',
  klarnapaylater: 'Klarna',
  klarnasliceit: 'Klarna',
  sofort: 'Sofort',
  giropay: 'giropay',
  eps: 'EPS',
  kbc: 'KBC',
  belfius: 'Belfius',
  przelewy24: 'Przelewy24',
  in3: 'in3',
  riverty: 'Riverty',
  twint: 'TWINT',
  billie: 'Billie',
  trustly: 'Trustly',
  paybybank: 'Pay by bank',
  blik: 'BLIK',
  mybank: 'MyBank',
  voucher: 'Voucher',
  giftcard: 'Gift card',
  pointofsale: 'Point of sale',
};

/** “iDEAL”, “Card”; Mollie's own word with a capital otherwise. */
export function methodWords(method: string | null): string {
  if (!method) return '—';
  return METHODS[method] ?? cap(method.replace(/[_-]+/g, ' '));
}

/** What a payment brings in: its settlement amount when Mollie converted it, else its amount. */
const inMoney = (p: MolliePayment): Money => p.settlement ?? p.amount;

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface MollieInput {
  snapshot: MollieSnapshot;
  now: Date;
  timeZone: string;
}

/** The payments' figures: paid today and this month (per currency), failed today and how many were tried. */
export function mollieTotals(input: Pick<MollieInput, 'snapshot' | 'now' | 'timeZone'>) {
  const { snapshot, now, timeZone } = input;
  const today = todayStart(now, timeZone);
  const month = monthStart(now, timeZone);
  const paidToday: Sums = new Map();
  const paidMonth: Sums = new Map();
  let paidTodayN = 0;
  let paidMonthN = 0;
  let failedToday = 0;
  let triedToday = 0;
  const failedMethods = new Map<string, number>();
  for (const p of snapshot.payments) {
    const m = inMoney(p);
    if (p.paidAt && (p.status === 'paid' || p.refunded > 0)) {
      if (p.paidAt >= today) {
        addTo(paidToday, m.currency, m.value);
        paidTodayN++;
      }
      if (p.paidAt >= month) {
        addTo(paidMonth, m.currency, m.value);
        paidMonthN++;
      }
    }
    if (p.status === 'failed' && (p.failedAt ?? p.createdAt) >= today) {
      failedToday++;
      const k = methodWords(p.method);
      failedMethods.set(k, (failedMethods.get(k) ?? 0) + 1);
    }
    if (p.createdAt >= today && (p.status === 'paid' || p.status === 'failed')) triedToday++;
  }
  const commonFailed = [...failedMethods.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { paidToday, paidMonth, paidTodayN, paidMonthN, failedToday, triedToday, commonFailed };
}

/** Paid per local day over the last 30 days, in the main currency. */
export function paidPerDay(input: Pick<MollieInput, 'snapshot' | 'now' | 'timeZone'>, currency: string) {
  const { snapshot, now, timeZone } = input;
  const days = lastDays(now, timeZone, 30);
  const sums = new Map(days.map((d) => [d, 0]));
  for (const p of snapshot.payments) {
    if (!p.paidAt || !(p.status === 'paid' || p.refunded > 0)) continue;
    const m = inMoney(p);
    if (m.currency !== currency) continue;
    const day = localDay(p.paidAt, timeZone);
    if (sums.has(day)) sums.set(day, (sums.get(day) ?? 0) + m.value);
  }
  return { days, values: days.map((d) => Math.round((sums.get(d) ?? 0) * 100) / 100) };
}

/** “and $ 120” for what came in in other currencies; empty when there is none. */
function others(sums: Sums, main: string): string {
  const rest = [...sums.entries()].filter(([c, n]) => c !== main && n > 0);
  return rest.length ? ` · and ${rest.map(([c, n]) => money(n, c)).join(', ')}` : '';
}

function figures(
  input: MollieInput,
  totals: ReturnType<typeof mollieTotals>,
  currency: string,
): ThingPageKpi[] {
  const { snapshot } = input;
  const perDay = paidPerDay(input, currency);
  const today = totals.paidToday.get(currency) ?? 0;
  const month = totals.paidMonth.get(currency) ?? 0;
  const firstDay = localDay(monthStart(input.now, input.timeZone), input.timeZone);
  const thisMonth = perDay.values.filter((_, i) => (perDay.days[i] as string) >= firstDay);
  const out: ThingPageKpi[] = [
    {
      key: 'paid-today',
      label: 'Paid today',
      value: money(today, currency),
      sub: `${plural(totals.paidTodayN, 'payment')}${others(totals.paidToday, currency)}`.slice(0, 80),
      color: 'green',
    },
    {
      key: 'month',
      label: 'This month',
      value: money(month, currency),
      ...(snapshot.partial ? { rest: 'at least' } : {}),
      sub: `${plural(totals.paidMonthN, 'payment')}${others(totals.paidMonth, currency)}`.slice(0, 80),
      ...(thisMonth.length >= 2 ? { spark: thisMonth } : {}),
      color: 'green',
    },
    {
      key: 'failed-today',
      label: 'Failed today',
      value: String(totals.failedToday),
      sub: totals.triedToday ? `of ${thousands(totals.triedToday)} tried` : 'None tried yet',
      ...(failedTooMany(totals) ? { tone: 'warn' as const } : {}),
    },
  ];
  if (snapshot.nextPayout)
    out.push({
      key: 'payout',
      label: 'Next payout',
      value: money(snapshot.nextPayout.value, snapshot.nextPayout.currency),
      sub: 'Next settlement',
    });
  return out;
}

/** Many payments failing today: at least this many failed… */
export const FAILED_MIN = 5;
/** …of at least this many tried, and more than a quarter of them (quiet-notices.md QN-04: 3 of 9 was too eager). */
export const TRIED_MIN = 10;

/** More than a quarter of today's payments failed, at least five of at least ten. */
function failedTooMany(t: ReturnType<typeof mollieTotals>): boolean {
  return t.failedToday >= FAILED_MIN && t.triedToday >= TRIED_MIN && t.failedToday / t.triedToday > 0.25;
}

/**
 * Today by the hour against the same weekday last week (SD-60): what came in so far, added up hour by hour, in the main
 * currency; last week's figure is what it was at this time of day. Null when the payments read don't reach last week.
 */
export function todayChart(input: MollieInput, currency: string): ChartPanel | null {
  const { snapshot, now, timeZone } = input;
  if (!snapshot.payments.length) return null;
  const start = todayStart(now, timeZone).getTime();
  const lastWeek = startOfDay(localDay(new Date(now.getTime() - 7 * DAY), timeZone), timeZone).getTime();
  const oldest = snapshot.payments.at(-1)?.createdAt.getTime() ?? now.getTime();
  if (snapshot.partial && oldest > lastWeek) return null;
  const paid = snapshot.payments.flatMap((p) => {
    const m = inMoney(p);
    return p.paidAt && (p.status === 'paid' || p.refunded > 0) && m.currency === currency
      ? [{ at: p.paidAt.getTime(), value: m.value }]
      : [];
  });
  const upTo = (from: number, to: number) =>
    paid.filter((p) => p.at >= from && p.at < to).reduce((n, p) => n + p.value, 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const hourNow = Math.min(23, Math.floor((now.getTime() - start) / 3600_000));
  const today = upTo(start, now.getTime() + 1);
  const byNow = upTo(lastWeek, lastWeek + (now.getTime() - start) + 1);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(
    new Date(lastWeek + 12 * 3600_000),
  );
  const change = byNow > 0 ? Math.round(((today - byNow) / byNow) * 100) : null;
  const stats: ThingLine[] = [line(`**${money(byNow, currency)}** last ${weekday} by now`)];
  if (change !== null)
    stats.push(line(change === 0 ? 'The same' : `**${Math.abs(change)} %** ${change > 0 ? 'more' : 'less'}`));
  return {
    kind: 'chart',
    id: 'today',
    // Below the slots; its hours as words keep it out of the page's range, which it doesn't follow.
    place: 'main',
    title: 'Today by the hour',
    meta: `Against last ${weekday}`,
    timestamps: hours.map((h) => new Date(start + h * 3600_000).toISOString()),
    labels: hours.map((h) => `${String(h).padStart(2, '0')}:00`),
    series: [
      {
        key: 'today',
        label: 'Today',
        values: hours.map((h) => (h <= hourNow ? round(upTo(start, start + (h + 1) * 3600_000)) : null)),
        color: 'green',
        latest: money(today, currency),
      },
      {
        key: 'week',
        label: `Last ${weekday}`,
        values: hours.map((h) => round(upTo(lastWeek, lastWeek + (h + 1) * 3600_000))),
        color: 'grey',
        latest: money(byNow, currency),
      },
    ],
    figure: { value: money(today, currency), rest: 'so far today' },
    stats,
    axis: { min: 0 },
  };
}

/** The checks (quiet-notices.md QN-03). */
export const MOLLIE_CHECKS = {
  chargeback: 'mollie.chargeback',
  failing: 'mollie.payments_failing',
  test: 'mollie.test_mode',
} as const;

/** What Whombat watches (QN-15). */
export const MOLLIE_WATCH: readonly KindCheck[] = [
  { check: MOLLIE_CHECKS.chargeback, name: 'Chargebacks', nature: 'you', perItem: true, startsOn: true },
  {
    check: MOLLIE_CHECKS.failing,
    name: 'Many payments failing today',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  { check: MOLLIE_CHECKS.test, name: 'Only test payments', nature: 'fyi', perItem: false, startsOn: false },
];

/** Chargebacks Whombat reads at most (`/v2/chargebacks`, the newest). */
const CHARGEBACKS_READ = 10;

/** Chargebacks of the last 30 days that weren't reversed, the newest first. */
function openChargebacks(snapshot: MollieSnapshot, now: Date): MollieChargeback[] {
  return (snapshot.chargebacks ?? [])
    .filter((c) => !c.reversedAt && now.getTime() - c.createdAt.getTime() <= 30 * DAY)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * The checks this read couldn't see whole (QN-11): chargebacks not read, or as many read as Whombat asks for and all
 * recent (there may be more); today's payments not read back to midnight.
 */
export function mollieSkipped(snapshot: MollieSnapshot, now: Date, timeZone: string): string[] {
  const out: string[] = [];
  const cbs = snapshot.chargebacks;
  const oldest = cbs?.reduce<Date | null>((o, c) => (!o || c.createdAt < o ? c.createdAt : o), null);
  if (!cbs || (cbs.length >= CHARGEBACKS_READ && oldest && now.getTime() - oldest.getTime() <= 30 * DAY))
    out.push(MOLLIE_CHECKS.chargeback);
  const last = snapshot.payments.at(-1);
  if (snapshot.partial && !(last && last.createdAt < todayStart(now, timeZone)))
    out.push(MOLLIE_CHECKS.failing);
  return out;
}

/**
 * Worth a look (SD-60; QN-S*): each chargeback of the last 30 days (only you: accept or contest it, a money decision),
 * many failed payments today (a problem the assistant can look into, quiet until midnight), test mode (a heads-up).
 */
export function mollieNotices(input: MollieInput, totals: ReturnType<typeof mollieTotals>): KindNotice[] {
  const { snapshot, now, timeZone } = input;
  const out: KindNotice[] = itemLines(
    openChargebacks(snapshot, now),
    (c) => {
      const payment = c.paymentId ? snapshot.payments.find((p) => p.id === c.paymentId) : undefined;
      const sum = amount(c.amount.value, c.amount.currency);
      return {
        id: `chargeback-${c.id}`.slice(0, 120),
        tone: 'bad',
        icon: 'money',
        title: `Chargeback of ${sum}`,
        detail: clip(
          `The payer’s bank took it back on ${dayMonth(c.createdAt, timeZone)}${c.reason ? `: ${c.reason}` : ''}.`,
          200,
        ),
        link: { kind: 'url', label: 'Open in Mollie', url: payment?.dashboard ?? DASHBOARD },
        nature: 'you',
        check: MOLLIE_CHECKS.chargeback,
        subject: { id: `chargeback:${c.id}`, name: clip(`${sum} on ${dayMonth(c.createdAt, timeZone)}`, 80) },
        ignore: fixed('Until it’s reversed.'),
      };
    },
    (c) => c.id,
    (rest) => {
      const sums: Sums = new Map();
      for (const c of rest) addTo(sums, c.amount.currency, c.amount.value);
      const currency = mainCurrency(sums);
      return {
        id: 'chargeback-more',
        tone: 'bad',
        icon: 'money',
        title: `${plural(rest.length, 'more chargeback')} · ${money(sums.get(currency) ?? 0, currency)}`,
        link: { kind: 'url', label: 'Open in Mollie', url: DASHBOARD },
        nature: 'you',
        check: MOLLIE_CHECKS.chargeback,
      };
    },
  );
  if (failedTooMany(totals)) {
    const method = totals.commonFailed && totals.commonFailed !== '—' ? totals.commonFailed : null;
    out.push({
      id: 'failing',
      tone: 'warn',
      icon: 'money',
      title: `${totals.failedToday} of ${totals.triedToday} payments failed today`,
      ...(method ? { detail: `Most with ${method}.` } : {}),
      link: lookInto(
        `${totals.failedToday} of ${totals.triedToday} Mollie payments failed today${method ? `, most with ${method}` : ''}. Is a payment method or the checkout broken?`,
      ),
      nature: 'problem',
      check: MOLLIE_CHECKS.failing,
      ignore: period('Until tomorrow.', nextMidnight(now, timeZone)),
      episode: localDay(now, timeZone),
    });
  }
  const modes = new Set(snapshot.payments.map((p) => p.mode).filter((m) => m !== null));
  if (modes.size === 1 && modes.has('test'))
    out.push({
      id: 'test-mode',
      tone: 'info',
      icon: 'info',
      title: 'Test mode: these aren’t real payments',
      detail: 'Connect with a live key to see real ones.',
      nature: 'fyi',
      check: MOLLIE_CHECKS.test,
      ignore: fixed('Until a live payment comes in.'),
    });
  return out;
}

/** Payments Live shows at most. */
export const LIVE_MAX = 8;
/** Checkouts nobody finished (open, expired, canceled) aren't money coming in: Live leaves them out. */
const UNFINISHED = new Set(['open', 'expired', 'canceled']);

/** A payment's state in words when it isn't simply paid, and its line's colour. */
function stateOf(p: MolliePayment): { words: string; tone?: 'bad' | 'warn' } | null {
  if (p.status === 'failed') return { words: 'Failed', tone: 'bad' };
  if (p.refunded > 0)
    return { words: p.refunded >= p.amount.value ? 'Refunded' : 'Part refunded', tone: 'warn' };
  if (p.status === 'pending') return { words: 'Pending' };
  if (p.status === 'authorized') return { words: 'Authorized' };
  return null;
}

/**
 * Live: today's payments, the newest first, a line each — how much and what for, then its state when it isn't simply
 * paid (failed in red, refunded in amber), who paid and how, and when; yesterday's last ones while today has none yet.
 * The line over it: what came in today, how many paid and failed. Lines rather than rows: a payment has no picture.
 */
export function paymentsLive(
  input: MollieInput,
  totals: ReturnType<typeof mollieTotals>,
  currency: string,
): LivePanel {
  const { snapshot, now, timeZone } = input;
  const done = snapshot.payments.filter((p) => !UNFINISHED.has(p.status));
  const today = todayStart(now, timeZone);
  const todays = done.filter((p) => (p.paidAt ?? p.failedAt ?? p.createdAt) >= today);
  const shown = (todays.length ? todays : done).slice(0, LIVE_MAX);
  const meta = todays.length
    ? [
        `${money(totals.paidToday.get(currency) ?? 0, currency)} today`,
        `${thousands(totals.paidTodayN)} paid`,
        totals.failedToday ? `${thousands(totals.failedToday)} failed` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : shown.length
      ? 'Nothing yet today'
      : undefined;
  return liveList({
    id: 'payments',
    title: todays.length ? 'Payments today' : 'Latest payments',
    ...(meta ? { meta } : {}),
    link: { kind: 'url', label: 'Open Mollie', url: DASHBOARD },
    items: shown.map((p): ThingPageItem => {
      const at = p.paidAt ?? p.failedAt ?? p.createdAt;
      const ago = now.getTime() - at.getTime();
      const state = stateOf(p);
      const detail = [state?.words, p.customer, p.method ? methodWords(p.method) : null]
        .filter(Boolean)
        .join(' · ');
      return {
        id: p.id,
        title: clip(
          [amount(p.amount.value, p.amount.currency), p.description].filter(Boolean).join(' · '),
          160,
        ),
        ...(detail ? { detail: clip(detail, 300) } : {}),
        icon: 'money',
        ...(state?.tone ? { tone: state.tone } : {}),
        right: clip(ago < 12 * 3600_000 ? `${span(ago)} ago` : when(at, now, timeZone), 40),
        at: at.toISOString(),
        ...(p.dashboard ? { url: p.dashboard } : {}),
      };
    }),
    empty: 'No payments in the last 30 days.',
  });
}

/** Paid each of the last `days` days in the main currency, today last (`paidPerDay`'s 30 read). */
const lastOf = (values: number[], n: number, skip = 0) =>
  values.slice(values.length - n - skip, values.length - skip).reduce((a, b) => a + b, 0);

/** Whether the payments read reach back `days` whole days, so a sum over them is whole. */
function reaches(input: Pick<MollieInput, 'snapshot' | 'now' | 'timeZone'>, days: number): boolean {
  const { snapshot, now, timeZone } = input;
  if (!snapshot.partial) return true;
  const from = startOfDay(lastDays(now, timeZone, days)[0] as string, timeZone);
  return (snapshot.payments.at(-1)?.createdAt ?? now) < from;
}

/**
 * Inventory “This month”: what was paid (with what came in this week), refunded on this month's payments, the
 * chargebacks of the last 30 days and the next payout when the key may read it.
 */
export function monthInventory(
  input: MollieInput,
  totals: ReturnType<typeof mollieTotals>,
  currency: string,
): InventoryPanel {
  const { snapshot, now, timeZone } = input;
  const perDay = paidPerDay(input, currency);
  const week = lastOf(perDay.values, 7);
  const month = monthStart(now, timeZone);
  let refunded = 0;
  let refundedN = 0;
  for (const p of snapshot.payments)
    if (p.refunded > 0 && p.paidAt && p.paidAt >= month && inMoney(p).currency === currency) {
      refunded += p.refunded;
      refundedN++;
    }
  const lines: ThingPageItem[] = [
    countLine({
      id: 'paid',
      title: 'Paid',
      icon: 'money',
      detail: `${snapshot.partial ? 'At least ' : ''}${plural(totals.paidMonthN, 'payment')}${others(totals.paidMonth, currency)}`,
      value: money(totals.paidMonth.get(currency) ?? 0, currency),
      ...(reaches(input, 7)
        ? week > 0
          ? { note: `+${money(week, currency)} this week`, noteTone: 'ok' as const }
          : { note: 'Nothing this week' }
        : {}),
      url: DASHBOARD,
    }),
    countLine({
      id: 'refunded',
      title: 'Refunded',
      icon: 'info',
      detail: refundedN ? `On ${plural(refundedN, 'payment')} this month` : 'Nothing refunded',
      value: money(refunded, currency),
      url: DASHBOARD,
    }),
  ];
  if (snapshot.chargebacks !== null) {
    const open = openChargebacks(snapshot, now).length;
    const more = open >= CHARGEBACKS_READ;
    lines.push(
      countLine({
        id: 'chargebacks',
        title: 'Chargebacks',
        icon: 'warn',
        detail: 'Last 30 days',
        value: `${thousands(open)}${more ? '+' : ''}`,
        ...(open ? { tone: 'bad' as const } : {}),
        url: DASHBOARD,
      }),
    );
  }
  if (snapshot.nextPayout)
    lines.push(
      countLine({
        id: 'payout',
        title: 'Next payout',
        icon: 'clock',
        detail: 'Next settlement',
        value: money(snapshot.nextPayout.value, snapshot.nextPayout.currency),
        url: DASHBOARD,
      }),
    );
  return inventory({ id: 'month', title: 'This month', items: lines });
}

/** Trend: paid per day this week, today last, with the change on the 7 days before once the read reaches back. */
export function paidWeek(input: MollieInput, currency: string): TrendPanel | null {
  const perDay = paidPerDay(input, currency);
  const values = perDay.values.slice(-7);
  if (!reaches(input, 7)) return null;
  const week = lastOf(perDay.values, 7);
  const before = reaches(input, 14) ? lastOf(perDay.values, 7, 7) : 0;
  return trend({
    id: 'week',
    title: 'This week',
    meta: 'Paid per day',
    days: slotDays(input.now, input.timeZone),
    values,
    label: 'Paid',
    figure: { value: money(week, currency), rest: 'paid this week' },
    change: weekChange(week, before),
    color: 'green',
  });
}

/**
 * People “Who paid most” this month, by what they paid in the main currency. Only for a business with returning payers
 * (two or more who paid more than once): a ranking of one-off buyers says nothing. Payers without a name don't count.
 */
export function topPayers(input: MollieInput, currency: string): PeoplePanel | null {
  const month = monthStart(input.now, input.timeZone);
  const by = new Map<string, { sum: number; n: number }>();
  for (const p of input.snapshot.payments) {
    const m = inMoney(p);
    if (!p.customer || !p.paidAt || p.paidAt < month || m.currency !== currency) continue;
    if (!(p.status === 'paid' || p.refunded > 0)) continue;
    const w = by.get(p.customer) ?? { sum: 0, n: 0 };
    w.sum += m.value;
    w.n++;
    by.set(p.customer, w);
  }
  if ([...by.values()].filter((w) => w.n > 1).length < 2) return null;
  const ranked = [...by.entries()]
    .sort((a, b) => b[1].sum - a[1].sum || a[0].localeCompare(b[0]))
    .slice(0, 5);
  return people({
    title: 'Who paid most',
    meta: 'This month',
    items: ranked.map(([name, w]) => ({
      name,
      n: w.sum,
      value: money(w.sum, currency),
      note: plural(w.n, 'payment'),
    })),
  });
}

/** Refunds and chargebacks (SD-60), newest first. */
export function refundItems(input: MollieInput): ThingPageItem[] {
  const { snapshot } = input;
  const items: ThingPageItem[] = [];
  for (const c of snapshot.chargebacks ?? [])
    items.push({
      id: `cb-${c.id}`.slice(0, 200),
      title: `Chargeback ${amount(c.amount.value, c.amount.currency)}`,
      ...(c.reason ? { detail: clip(c.reason, 300) } : {}),
      at: c.createdAt.toISOString(),
      tone: c.reversedAt ? 'info' : 'bad',
      ...(c.reversedAt ? { right: 'Reversed' } : {}),
    });
  for (const r of snapshot.refunds ?? []) {
    const payment = r.paymentId ? snapshot.payments.find((p) => p.id === r.paymentId) : undefined;
    const what = r.description ?? payment?.description ?? null;
    items.push({
      id: `re-${r.id}`.slice(0, 200),
      title: `Refund ${amount(r.amount.value, r.amount.currency)}`,
      ...(what ? { detail: clip(what, 300) } : {}),
      at: r.createdAt.toISOString(),
      ...(r.status === 'failed' ? { tone: 'bad' as const } : {}),
      right: cap(r.status.replace(/_/g, ' ')).slice(0, 40),
    });
  }
  return items.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? '')).slice(0, 10);
}

/** The page's Mollie part (SD-60), in slots (service-slots.md), from what was read; pure. */
export function mollieView(input: MollieInput): KindView {
  const { snapshot, now } = input;
  const totals = mollieTotals(input);
  const currency = mollieCurrency(snapshot, totals);
  const notices = mollieNotices(input, totals);
  const byHour = todayChart(input, currency);
  const more: ThingPagePanel[] = byHour ? [byHour] : [];
  if (snapshot.refunds !== null || snapshot.chargebacks !== null)
    more.push({
      kind: 'list',
      id: 'refunds',
      title: 'Refunds and chargebacks',
      items: refundItems(input),
      empty: 'No refunds or chargebacks.',
    });
  const last = snapshot.payments.find((p) => p.paidAt)?.paidAt ?? null;
  const facts: ThingLine[] = [];
  const modes = new Set(snapshot.payments.map((p) => p.mode));
  if (modes.has('live')) facts.push(line('**Live** payments'));
  else if (modes.has('test')) facts.push(line('**Test** mode'));
  if (last) facts.push(line(`Last paid **${span(now.getTime() - last.getTime())}** ago`));
  return {
    // Its figures are in Live and This month; the card keeps them (`mollieFigures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: paymentsLive(input, totals, currency),
      inventory: monthInventory(input, totals, currency),
      trend: paidWeek(input, currency),
      people: topPayers(input, currency),
      more,
    }),
    tabs: [],
    facts,
    status: statusFrom(notices, snapshot.payments.length ? 'Taking payments' : 'No payments lately'),
    open: { label: 'Open Mollie', url: DASHBOARD },
    actions: [],
    readAt: snapshot.readAt,
    suggestions: ['Paid per method this month', 'Refunds this month', 'Biggest payments this week'],
  };
}

/** The currency the figures are in: the month's biggest, else the newest payment's. */
const mollieCurrency = (snapshot: MollieSnapshot, totals: ReturnType<typeof mollieTotals>) =>
  mainCurrency(totals.paidMonth, snapshot.payments[0]?.amount.currency ?? 'EUR');

/** The card's figures: paid today, this month, failed today and the next payout (as the page's row used to be). */
export function mollieFigures(input: MollieInput): ThingPageKpi[] {
  const totals = mollieTotals(input);
  return figures(input, totals, mollieCurrency(input.snapshot, totals));
}

/** The card from the page and the card's own figures (the page in slots has no row of figures). */
export function mollieSeen(input: MollieInput) {
  return seenOfView(
    { ...mollieView(input), kpis: mollieFigures(input) },
    2,
    undefined,
    mollieSkipped(input.snapshot, input.now, input.timeZone),
  );
}

/* The page ----------------------------------------------------------------------------------------------------------- */

/**
 * Signed in with Mollie (its MCP server), its token isn't for the API this page reads: the page reads its server's
 * tools instead (`mollie-mcp.ts`), and says this when the server offers no payments to read.
 */
export const MCP_ONLY = 'This page needs Mollie connected with an API key or access token.';

export async function molliePage(ctx: KindCtx): Promise<KindView> {
  const open = { label: 'Open Mollie', url: DASHBOARD };
  if (ctx.row.signIn === 'mcp_oauth') return mollieMcpPage(ctx);
  const read = await mollieLatest(ctx.services, ctx.row, ctx.now, ctx.timeZone);
  return viewOrProblem(read, NAME, open, (snapshot) =>
    mollieView({ snapshot, now: ctx.now, timeZone: ctx.timeZone }),
  );
}

export const MOLLIE_KIND: KindModule = {
  page: molliePage,
  asksFirst: 'anything that moves money asks first',
  prefetch: (services, row, now, timeZone) =>
    row.signIn === 'mcp_oauth'
      ? mollieMcpLatest(services, row, now, timeZone)
      : mollieLatest(services, row, now, timeZone),
  checks: MOLLIE_WATCH,
  seen: async (services, row, now, timeZone) => {
    if (row.signIn === 'mcp_oauth')
      return mollieMcpSeen(
        services,
        row,
        now,
        timeZone,
        MOLLIE_WATCH.map((c) => c.check),
      );
    const snapshot = await cachedRead(
      services,
      `mollie:${row.id}:${timeZone}`,
      row,
      loader(NAME, () => readMollie(services, row, now, timeZone)),
    );
    return mollieSeen({ snapshot, now, timeZone });
  },
};
