/**
 * Moneybird's page (service-dashboards.md SD-61, SD-S18), in slots (service-slots.md): the overdue invoices in Live,
 * what is to do (outstanding, bills to process, bank lines to match), money in per day this week, who owes most; the
 * bills waiting and the bank lines below; an invoice over 30
 * days late or many unmatched bank lines in Worth a look. Read with the connection's token in its administration
 * (`fields.administration`) through Moneybird API v2 — sales invoices open, late or reminded, purchase invoices new,
 * saved, open or late, and unprocessed financial mutations — each with a `period:` (any filter replaces Moneybird's
 * defaults), kept 5 minutes (Moneybird allows 150 requests in 5 minutes), with customers' and suppliers' names and
 * bank descriptions; every bank line of the last 14 days for money in, kept 10 minutes. Read only: sending reaches
 * customers (SD-02).
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck } from '../../quiet/types';
import { clip, dayMonth, line, list, num, plural, rec, str, thousands } from '../../words';
import { cachedRead, latestRead } from '../read';
import type { KindModule } from '../registry';
import {
  countLine,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveRows,
  type PeoplePanel,
  people,
  lastDays as slotDays,
  slotPanels,
  type TrendPanel,
  trend,
  weekChange,
} from '../slots';
import { fixed, itemLines, type KindNotice } from '../storage/lines';
import type { KindCtx, KindView } from '../types';
import {
  addTo,
  amount,
  cannotRead,
  daysBetween,
  dayWords,
  lastDays,
  loader,
  localDay,
  mainCurrency,
  money,
  optional,
  readJson,
  type Sums,
  seenOfView,
  shortBadge,
  startOfDay,
  statusFrom,
  viewOrProblem,
} from './common';

const NAME = 'Moneybird';
/** Moneybird allows 150 requests in 5 minutes: the page's read is kept 5 minutes. */
export const MONEYBIRD_CACHE_MS = 5 * 60_000;
const PER_PAGE = 100;
/** Pages per list at most (300 invoices, 200 bank lines). */
const PAGES = { sales: 3, purchases: 2, bank: 2 } as const;
/** Late for longer than this is worth a look, one line per invoice (SD-61, quiet-notices.md QN-S*). */
export const LATE_BAD_DAYS = 30;
/** More unmatched bank lines than this is worth a look (SD-61). */
export const BANK_WARN = 50;
const ROWS = 10;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface MoneybirdInvoice {
  id: string;
  number: string | null;
  state: string;
  customer: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  total: number;
  unpaid: number;
}

export interface MoneybirdBill {
  id: string;
  supplier: string | null;
  reference: string | null;
  state: string;
  date: string | null;
  dueDate: string | null;
  currency: string;
  total: number;
}

export interface MoneybirdBankLine {
  id: string;
  date: string | null;
  amount: number;
  open: number;
  currency: string;
  message: string | null;
  counterparty: string | null;
}

export interface MoneybirdSnapshot {
  readAt: Date;
  administration: string;
  invoices: MoneybirdInvoice[];
  /** Null when the token may not read them. */
  bills: MoneybirdBill[] | null;
  bank: MoneybirdBankLine[] | null;
  /** A list reached its last page Whombat reads: its counts are at least what they say. */
  more: { invoices: boolean; bills: boolean; bank: boolean };
  /** Every bank line of the last 14 days (money in and out), for money in per day; null when not read. */
  recent?: MoneybirdBankLine[] | null;
  /** How many days `recent` reaches back: 14, or 7 when the 14 days held more lines than Moneybird answers at once. */
  recentDays?: number;
}

/** A local date (“2026-09-15”) as Moneybird writes it; null otherwise. */
const ymd = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const money0 = (v: unknown): number => num(v) ?? 0;

/** A contact's name: its company, else the person's. */
function contactName(v: unknown): string | null {
  const c = rec(v);
  const company = str(c.company_name);
  if (company) return company.slice(0, 120);
  const person = [str(c.firstname), str(c.lastname)].filter(Boolean).join(' ');
  return person ? person.slice(0, 120) : null;
}

const currencyOf = (v: unknown) => {
  const c = str(v);
  return c && /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : 'EUR';
};

export function moneybirdInvoice(raw: unknown): MoneybirdInvoice | null {
  const i = rec(raw);
  const id = str(i.id) ?? (typeof i.id === 'number' ? String(i.id) : null);
  if (!id) return null;
  return {
    id: id.slice(0, 40),
    number: str(i.invoice_id)?.slice(0, 40) ?? null,
    state: str(i.state) ?? 'open',
    customer: contactName(i.contact),
    invoiceDate: ymd(i.invoice_date),
    dueDate: ymd(i.due_date),
    currency: currencyOf(i.currency),
    total: money0(i.total_price_incl_tax),
    unpaid: num(i.total_unpaid) ?? money0(i.total_price_incl_tax) - money0(i.total_paid),
  };
}

export function moneybirdBill(raw: unknown): MoneybirdBill | null {
  const b = rec(raw);
  const id = str(b.id) ?? (typeof b.id === 'number' ? String(b.id) : null);
  if (!id) return null;
  return {
    id: id.slice(0, 40),
    supplier: contactName(b.contact),
    reference: str(b.reference)?.slice(0, 80) ?? null,
    state: str(b.state) ?? 'new',
    date: ymd(b.date),
    dueDate: ymd(b.due_date),
    currency: currencyOf(b.currency),
    total: money0(b.total_price_incl_tax),
  };
}

export function moneybirdBankLine(raw: unknown): MoneybirdBankLine | null {
  const m = rec(raw);
  const id = str(m.id) ?? (typeof m.id === 'number' ? String(m.id) : null);
  if (!id) return null;
  return {
    id: id.slice(0, 40),
    date: ymd(m.date),
    amount: money0(m.amount),
    open: num(m.amount_open) ?? money0(m.amount),
    currency: currencyOf(m.currency),
    message: str(m.message)?.slice(0, 200) ?? null,
    counterparty: str(m.contra_account_name)?.slice(0, 120) ?? null,
  };
}

/** `period:` from 2010 to the end of next year: every open item, whenever it was made. */
export function periodOf(now: Date, timeZone: string): string {
  const year = Number(localDay(now, timeZone).slice(0, 4));
  return `20100101..${year + 1}1231`;
}

async function readPages<T>(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
  filter: string,
  pages: number,
  parse: (raw: unknown) => T | null,
): Promise<{ items: T[]; more: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= pages; page++) {
    const body = await readJson(services, row, NAME, path, {
      query: { filter, per_page: String(PER_PAGE), page: String(page) },
    });
    const got = list(body);
    items.push(...got.map(parse).filter((x): x is T => x !== null));
    if (got.length < PER_PAGE) return { items, more: false };
  }
  return { items, more: true };
}

/** The bank lines of the last 14 days are kept 10 minutes: they are only for the week's money in. */
export const RECENT_CACHE_MS = 10 * 60_000;
export const RECENT_DAYS = 14;

/** `period:` over the last `days` days, today last (`20261022..20261104` for 14). */
export function recentPeriod(now: Date, timeZone: string, days = RECENT_DAYS): string {
  const keys = lastDays(now, timeZone, days);
  const compact = (d: string) => d.replace(/-/g, '');
  return `${compact(keys[0] as string)}..${compact(keys.at(-1) as string)}`;
}

/**
 * The money that came in on the bank over the last 14 days (`mutation_type:credit`). Moneybird answers at most 100
 * lines and refuses a period with more, so a busy account asks again for this week alone: its Trend then has no change
 * on the week before rather than a wrong one, and none at all when even a week has more than 100.
 */
async function readRecent(
  services: Services,
  row: CatalogConnectionRow,
  base: string,
  now: Date,
  timeZone: string,
): Promise<{ lines: MoneybirdBankLine[]; days: number }> {
  const read = async (days: number) => ({
    days,
    lines: list(
      await readJson(services, row, NAME, `${base}/financial_mutations.json`, {
        query: { filter: `period:${recentPeriod(now, timeZone, days)},mutation_type:credit` },
      }),
    )
      .map(moneybirdBankLine)
      .filter((x): x is MoneybirdBankLine => x !== null),
  });
  return read(RECENT_DAYS).catch(() => read(7));
}

async function readMoneybird(
  services: Services,
  row: CatalogConnectionRow,
  administration: string,
  now: Date,
  timeZone: string,
): Promise<MoneybirdSnapshot> {
  const period = `period:${periodOf(now, timeZone)}`;
  const base = `/${encodeURIComponent(administration)}`;
  const [sales, bills, bank, recent] = await Promise.all([
    readPages(
      services,
      row,
      `${base}/sales_invoices.json`,
      `state:open|late|reminded|pending_payment,${period}`,
      PAGES.sales,
      moneybirdInvoice,
    ),
    optional(
      readPages(
        services,
        row,
        `${base}/documents/purchase_invoices.json`,
        `state:new|saved|open|late,${period}`,
        PAGES.purchases,
        moneybirdBill,
      ),
    ),
    optional(
      readPages(
        services,
        row,
        `${base}/financial_mutations.json`,
        `state:unprocessed,${period}`,
        PAGES.bank,
        moneybirdBankLine,
      ),
    ),
    optional(
      cachedRead(
        services,
        `moneybird-recent:${row.id}:${administration}:${timeZone}`,
        row,
        loader(NAME, () => readRecent(services, row, base, now, timeZone)),
        RECENT_CACHE_MS,
      ),
    ),
  ]);
  return {
    readAt: now,
    administration,
    invoices: sales.items,
    bills: bills?.items ?? null,
    bank: bank?.items ?? null,
    more: { invoices: sales.more, bills: bills?.more ?? false, bank: bank?.more ?? false },
    recent: recent?.lines ?? null,
    ...(recent ? { recentDays: recent.days } : {}),
  };
}

const administrationOf = (row: CatalogConnectionRow) => str(row.fields.administration);

function moneybirdLoad(
  services: Services,
  row: CatalogConnectionRow,
  administration: string,
  now: Date,
  timeZone: string,
) {
  return loader(NAME, () => readMoneybird(services, row, administration, now, timeZone));
}

/** Moneybird's read for its page (PS-01), kept 5 minutes. */
export function moneybirdLatest(
  services: Services,
  row: CatalogConnectionRow,
  administration: string,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return latestRead(
    services,
    `moneybird:${row.id}:${administration}`,
    row,
    moneybirdLoad(services, row, administration, now, timeZone),
    { ttlMs: MONEYBIRD_CACHE_MS },
  );
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface MoneybirdInput {
  snapshot: MoneybirdSnapshot;
  now: Date;
  timeZone: string;
}

/** Moneybird's web page in the administration. */
export function moneybirdUrl(administration: string, path = ''): string {
  return `https://moneybird.com/${encodeURIComponent(administration)}${path}`;
}

/** How many days an invoice is late (its due date before today); 0 when it isn't. */
export function daysLate(inv: Pick<MoneybirdInvoice, 'dueDate'>, now: Date, timeZone: string): number {
  if (!inv.dueDate) return 0;
  return daysBetween(startOfDay(inv.dueDate, timeZone), startOfDay(localDay(now, timeZone), timeZone));
}

/** The figures' sums: outstanding, overdue (late or reminded past the due date), the bills, the bank. */
export function moneybirdTotals(input: Pick<MoneybirdInput, 'snapshot' | 'now' | 'timeZone'>) {
  const { snapshot, now, timeZone } = input;
  const outstanding: Sums = new Map();
  const overdue: Sums = new Map();
  const late: MoneybirdInvoice[] = [];
  for (const inv of snapshot.invoices) {
    if (inv.unpaid <= 0) continue;
    addTo(outstanding, inv.currency, inv.unpaid);
    if (daysLate(inv, now, timeZone) > 0 || inv.state === 'late' || inv.state === 'reminded') {
      addTo(overdue, inv.currency, inv.unpaid);
      late.push(inv);
    }
  }
  late.sort((a, b) => daysLate(b, now, timeZone) - daysLate(a, now, timeZone));
  const toPay: Sums = new Map();
  for (const b of snapshot.bills ?? [])
    if (b.state === 'open' || b.state === 'late') addTo(toPay, b.currency, b.total);
  const veryLate = late.filter((i) => daysLate(i, now, timeZone) > LATE_BAD_DAYS);
  return {
    outstanding,
    outstandingN: snapshot.invoices.filter((i) => i.unpaid > 0).length,
    overdue,
    late,
    veryLate,
    toPay,
    currency: mainCurrency(outstanding, snapshot.invoices[0]?.currency ?? 'EUR'),
  };
}

const atLeast = (n: number, more: boolean) => `${thousands(n)}${more ? '+' : ''}`;

function figures(input: MoneybirdInput, t: ReturnType<typeof moneybirdTotals>): ThingPageKpi[] {
  const { snapshot } = input;
  const c = t.currency;
  const out: ThingPageKpi[] = [
    {
      key: 'outstanding',
      label: 'Outstanding',
      value: money(t.outstanding.get(c) ?? 0, c),
      sub: `${atLeast(t.outstandingN, snapshot.more.invoices)} ${t.outstandingN === 1 ? 'invoice' : 'invoices'}`,
    },
    {
      key: 'overdue',
      label: 'Overdue',
      value: String(t.late.length),
      ...(t.late.length ? { rest: `· ${money(t.overdue.get(c) ?? 0, c)}` } : {}),
      sub: t.late.length
        ? `Oldest ${dayWords(daysLate(t.late[0] as MoneybirdInvoice, input.now, input.timeZone))} late`
        : 'Nothing late',
      ...(t.veryLate.length ? { tone: 'bad' as const } : t.late.length ? { tone: 'warn' as const } : {}),
    },
  ];
  if (snapshot.bills) {
    const fresh = snapshot.bills.filter((b) => b.state === 'new' || b.state === 'saved').length;
    const pay = t.toPay.get(c) ?? 0;
    out.push({
      key: 'bills',
      label: 'Bills to process',
      value: atLeast(snapshot.bills.length, snapshot.more.bills),
      sub: pay > 0 ? `${money(pay, c)} to pay` : fresh ? `${fresh} new` : 'Nothing waiting',
    });
  }
  if (snapshot.bank) {
    const n = snapshot.bank.length;
    out.push({
      key: 'bank',
      label: 'Bank to match',
      value: atLeast(n, snapshot.more.bank),
      sub: n === 1 ? 'bank line' : 'bank lines',
      ...(n > BANK_WARN ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

/** The checks (quiet-notices.md QN-03). */
export const MONEYBIRD_CHECKS = { late: 'moneybird.invoice_late', bank: 'moneybird.bank_to_match' } as const;

/** What Whombat watches (QN-15). */
export const MONEYBIRD_WATCH: readonly KindCheck[] = [
  {
    check: MONEYBIRD_CHECKS.late,
    name: 'Invoices over 30 days late',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  {
    check: MONEYBIRD_CHECKS.bank,
    name: 'Many bank lines to match',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

/** The checks this read couldn't see whole (QN-11): more invoices or bank lines than Whombat reads, bank lines not read. */
export function moneybirdSkipped(snapshot: MoneybirdSnapshot): string[] {
  const out: string[] = [];
  if (snapshot.more.invoices) out.push(MONEYBIRD_CHECKS.late);
  if (!snapshot.bank || snapshot.more.bank) out.push(MONEYBIRD_CHECKS.bank);
  return out;
}

/** “Invoice 2026-0042”, or its id when it has no number yet. */
const invoiceName = (inv: MoneybirdInvoice) => clip(`Invoice ${inv.number ?? inv.id}`, 80);

/**
 * Worth a look (SD-61; QN-S*): each invoice over 30 days late, amber and only you (chasing a customer or agreeing a
 * plan is a person's call; red was harsh for an invoice on a payment plan), quiet until it is paid; many unmatched
 * bank lines, a heads-up (a bookkeeping chore, nothing broken) that is back with every further 50 (`band`).
 */
export function moneybirdNotices(input: MoneybirdInput, t: ReturnType<typeof moneybirdTotals>): KindNotice[] {
  const { snapshot, now, timeZone } = input;
  const out: KindNotice[] = itemLines(
    t.veryLate,
    (inv) => {
      const title = `${invoiceName(inv)} is ${dayWords(daysLate(inv, now, timeZone))} late`;
      return {
        id: `late-${inv.id}`.slice(0, 120),
        tone: 'warn',
        icon: 'money',
        title: clip(title, 120),
        detail: `${amount(inv.unpaid, inv.currency)} still to come in.`,
        link: {
          kind: 'url',
          label: 'Open in Moneybird',
          url: moneybirdUrl(snapshot.administration, `/sales_invoices/${encodeURIComponent(inv.id)}`),
        },
        nature: 'you',
        check: MONEYBIRD_CHECKS.late,
        subject: { id: `invoice:${inv.id}`.slice(0, 160), name: invoiceName(inv) },
        ignore: fixed('Until it’s paid.'),
        ...shortBadge(title, `An invoice is over ${LATE_BAD_DAYS} days late`),
      };
    },
    (inv) => inv.id,
    (rest) => {
      const sums: Sums = new Map();
      for (const i of rest) addTo(sums, i.currency, i.unpaid);
      const c = mainCurrency(sums, t.currency);
      return {
        id: 'late-more',
        tone: 'warn',
        icon: 'money',
        title: `${plural(rest.length, 'more invoice')} over ${LATE_BAD_DAYS} days late`,
        detail: `${money(sums.get(c) ?? 0, c)} together.`,
        link: {
          kind: 'url',
          label: 'Open in Moneybird',
          url: moneybirdUrl(snapshot.administration, '/sales_invoices'),
        },
        nature: 'you',
        check: MONEYBIRD_CHECKS.late,
      };
    },
  );
  const bank = snapshot.bank?.length ?? 0;
  if (bank > BANK_WARN)
    out.push({
      id: 'bank',
      tone: 'warn',
      icon: 'info',
      title: `${atLeast(bank, snapshot.more.bank)} bank lines to match`,
      detail: 'The books are only as current as the matched bank lines.',
      link: { kind: 'url', label: 'Open Moneybird', url: moneybirdUrl(snapshot.administration) },
      nature: 'fyi',
      check: MONEYBIRD_CHECKS.bank,
      ignore: fixed(`Until ${BANK_WARN} more come in.`),
      band: Math.floor(bank / BANK_WARN),
    });
  return out;
}

/** “34 days late” in red past 30 days, else amber; “Reminded” for a reminded one not yet past its due date. */
function lateBadge(days: number): NonNullable<ThingGalleryItem['badge']> {
  if (!days) return { text: 'Reminded', tone: 'warn' };
  return { text: clip(`${dayWords(days)} late`, 30), tone: days > LATE_BAD_DAYS ? 'bad' : 'warn' };
}

/**
 * Live “Overdue”: each invoice past its due date or reminded, the latest first — what the person chases. The customer,
 * the invoice, when it was sent and what is still unpaid, how late as its tag, linked to the invoice in Moneybird. No
 * buttons: a reminder reaches the customer.
 */
export function overdueLive(input: MoneybirdInput, t: ReturnType<typeof moneybirdTotals>): LivePanel {
  const { snapshot, now, timeZone } = input;
  const adm = snapshot.administration;
  return liveRows({
    id: 'overdue',
    title: 'Overdue',
    ...(t.late.length
      ? { meta: `${thousands(t.late.length)} overdue · ${money(t.overdue.get(t.currency) ?? 0, t.currency)}` }
      : {}),
    shape: 'square',
    link: { kind: 'url', label: 'Open in Moneybird', url: moneybirdUrl(adm, '/sales_invoices') },
    items: t.late.slice(0, ROWS).map((inv): ThingGalleryItem => {
      const sent = inv.invoiceDate ? startOfDay(inv.invoiceDate, timeZone) : null;
      return {
        id: inv.id,
        title: clip(inv.customer ?? invoiceName(inv), 120),
        sub: invoiceName(inv),
        badge: lateBadge(daysLate(inv, now, timeZone)),
        ...(sent ? { note: clip(`Sent ${dayMonth(sent, timeZone)}`, 80) } : {}),
        noteEnd: clip(`${amount(inv.unpaid, inv.currency)} unpaid`, 60),
        url: moneybirdUrl(adm, `/sales_invoices/${encodeURIComponent(inv.id)}`),
      };
    }),
    empty: 'No invoice is late.',
  });
}

/**
 * Inventory “To do”: what customers still owe (with the invoices sent this week), the bills to process and the bank
 * lines to match, each opening its list in Moneybird. Overdue isn't repeated: Live counts it.
 */
export function todoInventory(input: MoneybirdInput, t: ReturnType<typeof moneybirdTotals>): InventoryPanel {
  const { snapshot, now, timeZone } = input;
  const adm = snapshot.administration;
  const c = t.currency;
  const weekStart = lastDays(now, timeZone, 7)[0] as string;
  const sentWeek = snapshot.invoices.filter(
    (i) => i.unpaid > 0 && i.invoiceDate && i.invoiceDate >= weekStart,
  ).length;
  const lines: ThingPageItem[] = [
    countLine({
      id: 'outstanding',
      title: 'Outstanding',
      icon: 'money',
      detail: `${atLeast(t.outstandingN, snapshot.more.invoices)} ${t.outstandingN === 1 ? 'invoice' : 'invoices'} open`,
      value: money(t.outstanding.get(c) ?? 0, c),
      ...(sentWeek ? { note: `+${thousands(sentWeek)} sent this week`, noteTone: 'ok' as const } : {}),
      url: moneybirdUrl(adm, '/sales_invoices'),
    }),
  ];
  if (snapshot.bills) {
    const fresh = snapshot.bills.filter((b) => b.state === 'new' || b.state === 'saved').length;
    const pay = t.toPay.get(c) ?? 0;
    lines.push(
      countLine({
        id: 'bills',
        title: 'Bills to process',
        icon: 'log',
        detail: pay > 0 ? `${money(pay, c)} to pay` : fresh ? `${fresh} new` : 'Nothing waiting',
        value: atLeast(snapshot.bills.length, snapshot.more.bills),
        url: moneybirdUrl(adm),
      }),
    );
  }
  if (snapshot.bank) {
    const n = snapshot.bank.length;
    lines.push(
      countLine({
        id: 'bank',
        title: 'Bank lines to match',
        icon: 'info',
        detail: n ? 'Not yet booked' : 'Every line is matched',
        value: atLeast(n, snapshot.more.bank),
        ...(n > BANK_WARN ? { tone: 'warn' as const } : {}),
        url: moneybirdUrl(adm),
      }),
    );
  }
  return inventory({ id: 'todo', title: 'To do', items: lines });
}

/** People “Who owes most”: customers by what they still owe, with how many invoices and how many are late. */
export function whoOwes(input: MoneybirdInput, t: ReturnType<typeof moneybirdTotals>): PeoplePanel | null {
  const { now, timeZone } = input;
  const by = new Map<string, { sum: number; n: number; late: number }>();
  for (const inv of input.snapshot.invoices) {
    if (inv.unpaid <= 0 || !inv.customer || inv.currency !== t.currency) continue;
    const w = by.get(inv.customer) ?? { sum: 0, n: 0, late: 0 };
    w.sum += inv.unpaid;
    w.n++;
    if (daysLate(inv, now, timeZone) > 0 || inv.state === 'late' || inv.state === 'reminded') w.late++;
    by.set(inv.customer, w);
  }
  // One customer is no ranking.
  if (by.size < 2) return null;
  const ranked = [...by.entries()]
    .sort((a, b) => b[1].sum - a[1].sum || a[0].localeCompare(b[0]))
    .slice(0, 5);
  return people({
    title: 'Who owes most',
    meta: 'Still open',
    items: ranked.map(([name, w]) => ({
      name,
      n: w.sum,
      value: money(w.sum, t.currency),
      note: [plural(w.n, 'invoice'), w.late ? `${w.late} late` : null].filter(Boolean).join(' · '),
      ...(w.late ? { tone: 'warn' as const } : {}),
    })),
  });
}

/**
 * Trend “Money in”: what came in on the bank per day this week (lines with a positive amount in the main currency),
 * with the change on the week before; left out when the 14 days' bank lines couldn't be read.
 */
export function moneyIn(input: MoneybirdInput, currency: string): TrendPanel | null {
  const { snapshot, now, timeZone } = input;
  if (!snapshot.recent) return null;
  const keys = lastDays(now, timeZone, RECENT_DAYS);
  const sums = new Map(keys.map((k) => [k, 0]));
  for (const m of snapshot.recent)
    if (m.amount > 0 && m.date && m.currency === currency && sums.has(m.date))
      sums.set(m.date, (sums.get(m.date) ?? 0) + m.amount);
  const values = keys.map((k) => Math.round((sums.get(k) ?? 0) * 100) / 100);
  const week = values.slice(-7).reduce((a, b) => a + b, 0);
  // Only this week was read when the 14 days held more than Moneybird answers at once.
  const before =
    (snapshot.recentDays ?? RECENT_DAYS) >= RECENT_DAYS
      ? values.slice(0, -7).reduce((a, b) => a + b, 0)
      : null;
  return trend({
    id: 'week',
    title: 'Money in',
    meta: 'On the bank, per day',
    days: slotDays(now, timeZone),
    values: values.slice(-7),
    label: 'In',
    figure: { value: money(week, currency), rest: 'came in this week' },
    ...(before !== null ? { change: weekChange(week, before) } : {}),
    color: 'green',
  });
}

const BILL_STATE: Record<string, string> = { new: 'New', saved: 'Saved', open: 'To pay', late: 'Late' };

/** Bills waiting (SD-61): the supplier, the amount, when it is due; new ones and late ones first. */
export function billRows(input: MoneybirdInput): ThingPageRow[] {
  const { snapshot, timeZone, now } = input;
  const order: Record<string, number> = { late: 0, new: 1, saved: 2, open: 3 };
  return [...(snapshot.bills ?? [])]
    .sort(
      (a, b) =>
        (order[a.state] ?? 9) - (order[b.state] ?? 9) || (a.dueDate ?? '').localeCompare(b.dueDate ?? ''),
    )
    .slice(0, ROWS)
    .map((b) => ({
      id: b.id,
      cells: {
        supplier: {
          text: clip(b.supplier ?? '—', 200),
          ...(b.reference ? { note: clip(b.reference, 80) } : {}),
        },
        amount: {
          text: amount(b.total, b.currency),
          mono: true,
          url: moneybirdUrl(snapshot.administration, `/documents/${encodeURIComponent(b.id)}`),
        },
        due: b.dueDate
          ? {
              text: dayMonth(startOfDay(b.dueDate, timeZone), timeZone),
              ...(daysLate(b, now, timeZone) > 0 ? { tone: 'warn' as const } : {}),
            }
          : { text: '—', tone: 'muted' as const },
        state: {
          text: BILL_STATE[b.state] ?? b.state,
          ...(b.state === 'late' ? { dot: 'warn' as const } : {}),
        },
      },
    }));
}

/** Bank lines to match (SD-61), newest first: the amount, the day, the description and who. */
export function bankItems(input: MoneybirdInput): ThingPageItem[] {
  const { snapshot, timeZone } = input;
  return [...(snapshot.bank ?? [])]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, ROWS)
    .map((m) => {
      const detail = [m.counterparty, m.message].filter(Boolean).join(' · ');
      return {
        id: m.id,
        title: `${m.amount > 0 ? '+' : ''}${amount(m.amount, m.currency)}`,
        ...(detail ? { detail: clip(detail, 300) } : {}),
        ...(m.date ? { at: startOfDay(m.date, timeZone).toISOString() } : {}),
        ...(m.open !== m.amount && m.open !== 0
          ? { right: `${amount(Math.abs(m.open), m.currency)} open` }
          : {}),
      };
    });
}

/** The page's Moneybird part (SD-61), in slots (service-slots.md), from what was read; pure. */
export function moneybirdView(input: MoneybirdInput): KindView {
  const { snapshot } = input;
  const t = moneybirdTotals(input);
  const notices = moneybirdNotices(input, t);
  const adm = snapshot.administration;
  const more: ThingPagePanel[] = [];
  if (snapshot.bills)
    more.push({
      kind: 'table',
      id: 'bills',
      title: 'Bills waiting',
      meta: plural(snapshot.bills.length, 'bill'),
      columns: [
        { key: 'supplier', label: 'Supplier' },
        { key: 'amount', label: 'Amount', numeric: true },
        { key: 'due', label: 'Due' },
        { key: 'state', label: 'State' },
      ],
      rows: billRows(input),
      empty: 'No bills waiting.',
    });
  if (snapshot.bank)
    more.push({
      kind: 'list',
      id: 'bank',
      title: 'Bank lines to match',
      meta: plural(snapshot.bank.length, 'line'),
      items: bankItems(input),
      empty: 'Every bank line is matched.',
    });
  const facts: ThingLine[] = [];
  if (t.outstandingN)
    facts.push(line(`**${money(t.outstanding.get(t.currency) ?? 0, t.currency)}** outstanding`));
  if (t.late.length) facts.push(line(`**${t.late.length}** overdue`));
  return {
    // Its figures are in Overdue and To do; the card keeps them (`moneybirdFigures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: overdueLive(input, t),
      inventory: todoInventory(input, t),
      trend: moneyIn(input, t.currency),
      people: whoOwes(input, t),
      more,
    }),
    tabs: [],
    facts,
    status: statusFrom(
      notices,
      t.late.length ? `${plural(t.late.length, 'invoice')} overdue` : 'Nothing overdue',
    ),
    open: { label: 'Open Moneybird', url: moneybirdUrl(adm) },
    actions: [],
    readAt: snapshot.readAt,
    suggestions: ['Revenue this quarter', 'Biggest customers this year', 'VAT to pay this quarter'],
  };
}

/** The card's figures: outstanding, overdue, bills and bank (as the page's row used to be). */
export function moneybirdFigures(input: MoneybirdInput): ThingPageKpi[] {
  return figures(input, moneybirdTotals(input));
}

/** The card from the page and the card's own figures (the page in slots has no row of figures). */
export function moneybirdSeen(input: MoneybirdInput) {
  return seenOfView(
    { ...moneybirdView(input), kpis: moneybirdFigures(input) },
    2,
    undefined,
    moneybirdSkipped(input.snapshot),
  );
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export const NO_ADMINISTRATION = 'Choose Moneybird’s administration in Settings first.';

export async function moneybirdPage(ctx: KindCtx): Promise<KindView> {
  const adm = administrationOf(ctx.row);
  const open = { label: 'Open Moneybird', url: adm ? moneybirdUrl(adm) : 'https://moneybird.com/' };
  if (!adm) return cannotRead(NO_ADMINISTRATION, open);
  const read = await moneybirdLatest(ctx.services, ctx.row, adm, ctx.now, ctx.timeZone);
  return viewOrProblem(read, NAME, open, (snapshot) =>
    moneybirdView({ snapshot, now: ctx.now, timeZone: ctx.timeZone }),
  );
}

export const MONEYBIRD_KIND: KindModule = {
  page: moneybirdPage,
  checks: MONEYBIRD_WATCH,
  asksFirst: 'sending invoices and payments ask first',
  prefetch: (services, row, now, timeZone) => {
    const adm = administrationOf(row);
    return adm ? moneybirdLatest(services, row, adm, now, timeZone) : Promise.resolve(null);
  },
  seen: async (services, row, now, timeZone) => {
    const adm = administrationOf(row);
    if (!adm)
      return { glance: { facts: [] }, points: {}, notices: [], skipped: MONEYBIRD_WATCH.map((c) => c.check) };
    const snapshot = await cachedRead(
      services,
      `moneybird:${row.id}:${adm}`,
      row,
      moneybirdLoad(services, row, adm, now, timeZone),
      MONEYBIRD_CACHE_MS,
    );
    return moneybirdSeen({ snapshot, now, timeZone });
  },
};
