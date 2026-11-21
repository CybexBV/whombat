/**
 * What the business, developer and productivity kinds share (service-dashboards.md SD-60…SD-65, SD-S18): a read as the
 * connection that may be a POST that only reads (Plausible's query, HubSpot's search) and keeps the answer's headers
 * (GitLab's totals), money in the service's currency, the burrow's day and month, the page's status from Worth a look,
 * and a per-connection generation that a button bumps so the page reads again at once (buttons call through
 * `kinds/act.ts`).
 */
import type { IncomingHttpHeaders } from 'node:http';
import { type ThingPageButton, type ThingPageNotice, type ThingStatus, zonedInstant } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import { type ApiError, conflict } from '../../../lib/errors';
import type { Services } from '../../../services';
import { clip, thousands } from '../../words';
import { pageButton } from '../buttons';
import {
  cachedRead,
  KIND_DEADLINE_MS,
  KIND_KEEP_MS,
  KIND_MAX_BYTES,
  type Latest,
  problemOf,
  ReadProblem,
  withDeadline,
} from '../read';
import { type KindSeen, seenFromView } from '../registry';
import { counts, headWords } from '../storage/lines';
import type { KindCtx, KindView } from '../types';

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface ReadOptions {
  query?: Record<string, string>;
  /** `POST` only for the reads the catalog lists as reads (Plausible's query, HubSpot's search). */
  method?: 'GET' | 'POST';
  body?: unknown;
}

export interface Answer {
  json: unknown;
  headers: IncomingHttpHeaders;
}

/** The URL of `path` under the connection's base, with `query`. */
export function urlOf(
  row: Pick<CatalogConnectionRow, 'baseUrl'>,
  path: string,
  query: Record<string, string> = {},
) {
  const search = new URLSearchParams(query).toString();
  return `${row.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`;
}

/** A read as the connection (`getJson`'s rules): its JSON and headers; a refusal or an error status is a `ReadProblem`. */
export async function readAnswer(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  path: string,
  { query = {}, method = 'GET', body }: ReadOptions = {},
): Promise<Answer> {
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method,
            url: urlOf(row, path, query),
            headers: {
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          },
          { maxBytes: KIND_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, name);
  }
  if (res.status === 401 || res.status === 403)
    throw new ReadProblem(`${name} refused Whombat’s sign-in.`, res.status === 401);
  if (res.status >= 400) throw new ReadProblem(`${name} answered with an error.`);
  try {
    return { json: JSON.parse(res.body.toString('utf8')), headers: res.headers };
  } catch {
    throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
  }
}

/** The JSON of a read as the connection. */
export async function readJson(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  path: string,
  options: ReadOptions = {},
): Promise<unknown> {
  return (await readAnswer(services, row, name, path, options)).json;
}

/** A part the page can do without: null when this version, plan or key doesn't have it (SD-S05, the brief's 404 rule). */
export const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/**
 * How long what rarely changes is kept — an account, pipelines and stages, a version, project names: the longest the
 * kinds' cache keeps anything (`KIND_KEEP_MS`, 15 minutes).
 */
export const RARE_MS = KIND_KEEP_MS;

/**
 * A read kept `RARE_MS` (`cachedRead`); with `optional`, a failure is kept too (as null), so a key that may not read it
 * (a Stats API key and Plausible's sites) doesn't ask again on every page build.
 */
export function rarelyRead<T>(
  services: Services,
  key: string,
  row: CatalogConnectionRow,
  load: () => Promise<T>,
  { optional: canFail = false }: { optional?: boolean } = {},
): Promise<T | null> {
  return cachedRead(services, key, row, canFail ? () => load().catch(() => null) : load, RARE_MS);
}

/** A header's first value. */
export function header(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/* Buttons ------------------------------------------------------------------------------------------------------------ */

/** What a page asks for a button (CT-1001); who may press it is the page's to say. */
export type ButtonSpec = Omit<ThingPageButton, 'allowed' | 'reason'>;

/** Makes a page's buttons: allowed unless the connection is Look only, else disabled with the reason (`pageButton`). */
export type MakeButton = (spec: ButtonSpec) => ThingPageButton;

export function buttonsFor(ctx: Pick<KindCtx, 'row'>): MakeButton {
  return (spec) => {
    const { icon: _icon, ...button } = pageButton(ctx, spec);
    return { ...button, ...(spec.icon ? { icon: spec.icon } : {}) };
  };
}

/** The row a button names must be one the page offers now; else the page is out of date. */
export function stale(name: string): ApiError {
  return conflict(`That isn’t on ${name}’s page any more. Look again.`);
}

/** “Buy milk” in quotes for a change's title, cut to fit. */
export function quoted(text: string, n = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return `“${one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one}”`;
}

/**
 * Every connection's read generation: a button bumps it, so the next page build reads the service again instead of
 * the 5-minute cache (SD-07: the client reads the page again at once and must see the change).
 */
const generations = new Map<string, number>();

export function generationOf(connectionId: string): number {
  return generations.get(connectionId) ?? 0;
}

export function bumpGeneration(connectionId: string): void {
  generations.set(connectionId, generationOf(connectionId) + 1);
  if (generations.size > 2000) generations.delete(generations.keys().next().value as string);
}

/* Money -------------------------------------------------------------------------------------------------------------- */

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

/** Decimals of a currency (2 for most, 0 for yen). */
function decimalsOf(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function withSymbol(text: string, currency: string, negative: boolean): string {
  const code = currency.toUpperCase();
  const symbol = SYMBOLS[code];
  return `${negative ? '−' : ''}${symbol ? `${symbol} ${text}` : `${code} ${text}`}`;
}

/**
 * A sum as a figure (SD-S18): “€ 1,240”, “€ 86”, “€ 4.20”, “CHF 1,240” — the page's figures (thousands with commas, as
 * Hetzner's “€ 13.60” and Fusebox's “$ 1,906”), whole units from ten up.
 */
export function money(n: number, currency = 'EUR'): string {
  const a = Math.abs(n);
  const text =
    a >= 10 || Number.isInteger(a) || decimalsOf(currency) === 0
      ? thousands(Math.round(a))
      : a.toFixed(decimalsOf(currency));
  return withSymbol(text, currency, n < 0 && Math.round(a * 100) > 0);
}

/** An amount as it is (a payment, an invoice): “€ 1,240.50”, “€ 24.95”, “¥ 1,200”. */
export function amount(n: number, currency = 'EUR'): string {
  const d = decimalsOf(currency);
  const a = Math.abs(n);
  const text = a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return withSymbol(text, currency, n < 0 && a > 0);
}

/** Sums per currency. */
export type Sums = Map<string, number>;

export function addTo(sums: Sums, currency: string, n: number): void {
  sums.set(currency, (sums.get(currency) ?? 0) + n);
}

/** The currency with the largest sum (the one the figure shows), or `fallback`. */
export function mainCurrency(sums: Sums, fallback = 'EUR'): string {
  let best: string | null = null;
  for (const [c, n] of sums) if (best === null || Math.abs(n) > Math.abs(sums.get(best) ?? 0)) best = c;
  return best ?? fallback;
}

/** A Mollie- or Pipedrive-style amount (`{ value: "10.00", currency: "EUR" }` or a number); null when it isn't one. */
export function amountOf(v: unknown): { value: number; currency: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const value =
    typeof o.value === 'number' ? o.value : typeof o.value === 'string' ? Number(o.value) : Number.NaN;
  const currency =
    typeof o.currency === 'string' && /^[A-Za-z]{3}$/.test(o.currency) ? o.currency.toUpperCase() : null;
  return Number.isFinite(value) && currency ? { value, currency } : null;
}

/* Days -------------------------------------------------------------------------------------------------------------- */

const DAY = 86_400_000;

/** “2026-10-21” in a zone. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/** The first instant of a local day (“2026-10-21”) in a zone. */
export function startOfDay(day: string, timeZone: string): Date {
  const [year, month, d] = day.split('-').map(Number) as [number, number, number];
  return zonedInstant({ year, month, day: d }, '00:00', timeZone);
}

/** Today's first instant in the zone. */
export function todayStart(now: Date, timeZone: string): Date {
  return startOfDay(localDay(now, timeZone), timeZone);
}

/** The month's first instant in the zone. */
export function monthStart(now: Date, timeZone: string): Date {
  return startOfDay(`${localDay(now, timeZone).slice(0, 8)}01`, timeZone);
}

/** The local days from `days − 1` days ago to today, oldest first (“2026-09-22” … “2026-10-21”). */
export function lastDays(now: Date, timeZone: string, days: number): string[] {
  const out: string[] = [];
  // Noon steps keep a day's name right across a change of clocks.
  const noon = startOfDay(localDay(now, timeZone), timeZone).getTime() + 12 * 3600_000;
  for (let i = days - 1; i >= 0; i--) out.push(localDay(new Date(noon - i * DAY), timeZone));
  return [...new Set(out)];
}

/** The next local midnight in the zone (when a line about today ends, quiet-notices.md QN-11 `period`). */
export function nextMidnight(now: Date, timeZone: string): Date {
  // A step of 36 hours from today's start lands in tomorrow whatever the clocks do.
  return startOfDay(
    localDay(new Date(todayStart(now, timeZone).getTime() + 36 * 3600_000), timeZone),
    timeZone,
  );
}

/** Whole days from `from` to `to` (late, overdue), never below 0. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));
}

/** “1 day”, “12 days”. */
export function dayWords(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/* Status ------------------------------------------------------------------------------------------------------------- */

/**
 * The page's status and badge from Worth a look (SD-05): the worst line that isn't a heads-up (quiet-notices.md QN-02),
 * its badge or title, else `fine`. The health pass and the page work it out again without what is quiet (S0).
 */
export function statusFrom(
  notices: readonly ThingPageNotice[],
  fine: string,
): { status: Extract<ThingStatus, 'ok' | 'warn' | 'bad'>; badge: string } {
  const bad = notices.find((n) => n.tone === 'bad' && counts(n));
  if (bad) return { status: 'bad', badge: headWords(bad).slice(0, 60) };
  const warn = notices.find((n) => n.tone === 'warn' && counts(n));
  if (warn) return { status: 'warn', badge: headWords(warn).slice(0, 60) };
  return { status: 'ok', badge: fine.slice(0, 60) };
}

/**
 * A line's short words for the head and the card's reason (`badge`, at most 40 characters) when its title is longer
 * than that (quiet-notices.md QN-S*); nothing when the title fits.
 */
export function shortBadge(title: string, short: string): { badge?: string } {
  return title.length > 40 ? { badge: clip(short, 40) } : {};
}

/* The page ----------------------------------------------------------------------------------------------------------- */

/** A read with the kinds' deadline, its failure in words (`problemOf`). */
export function loader<T>(name: string, read: () => Promise<T>, ms = KIND_DEADLINE_MS): () => Promise<T> {
  return async () => {
    try {
      return await withDeadline(read(), ms, `${name} didn’t answer in time.`);
    } catch (err) {
      throw problemOf(err, name);
    }
  };
}

/**
 * A business kind's page part from its read (SD-01, SD-03): the view of the reading, or why there is none; its own
 * figures first and the machine's CPU and Memory after (`machine: 'after'`), never the response-time chart.
 */
export function viewOrProblem<S>(
  read: Latest<S>,
  name: string,
  open: KindView['open'],
  view: (s: S) => KindView,
): KindView {
  const problem = read.ok ? undefined : problemOf(read.error, name).message;
  if (!read.ok)
    return {
      kpis: [],
      charts: [],
      machine: 'after',
      notices: [],
      panels: [],
      tabs: [],
      facts: [],
      ...(open ? { open } : {}),
      actions: [],
      readAt: null,
      suggestions: [],
      ...(problem ? { problem } : {}),
      refreshing: read.refreshing,
    };
  return { ...view(read.value), refreshing: read.refreshing };
}

/** The view of a page that can't read anything with how the connection signed in (an MCP sign-in, SD-S18). */
export function cannotRead(problem: string, open: KindView['open']): KindView {
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    ...(open ? { open } : {}),
    actions: [],
    readAt: null,
    suggestions: [],
    problem,
  };
}

/**
 * The card and the dot from a page-less view (SD-05): its first `figures` figures (or those with these keys, in this
 * order), the worst Worth a look line that isn't a heads-up (QN-02); with the lines as this pass read them and the
 * checks it couldn't read (`skipped`, QN-11).
 */
export function seenOfView(
  view: KindView,
  figures: number | string[] = 2,
  line?: string,
  skipped: readonly string[] = [],
): KindSeen {
  const notices = view.notices.filter(counts).map((n) => ({ ...n, title: headWords(n) }));
  const kpis =
    typeof figures === 'number'
      ? (view.kpis ?? [])
      : figures
          .map((key) => view.kpis?.find((k) => k.key === key))
          .filter((k): k is NonNullable<typeof k> => k !== undefined);
  return {
    glance: seenFromView(
      { kpis, notices },
      { figures: typeof figures === 'number' ? figures : kpis.length, ...(line ? { line } : {}) },
    ),
    points: {},
    notices: [...view.notices],
    ...(skipped.length ? { skipped: [...skipped] } : {}),
  };
}

/** An `http(s)` address, or null (a link the page may open). */
export function webUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
