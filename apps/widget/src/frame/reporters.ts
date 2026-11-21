/**
 * Reporter sign-in from the frame (CT-162, AP-429 … AP-433): ask for a code, exchange it for a session, list the
 * reporter's reports, sign out. The same shapes on a self-hosted Whombat (`/embed/v1/sites/:site/reporter/…`,
 * same-origin) and on control in drop mode (`/v1/feedback/sites/:site/reporter/…`, CORS). Answers are checked by hand
 * (the frame bundle stays free of Zod); every call maps its answer to what the visitor can do next and never throws.
 */
import {
  FEEDBACK_REPORTER_STATUSES,
  FEEDBACK_REPORTER_TOKEN_PATTERN,
  type ReporterStatus,
} from '@whombat/core/feedback/reporters';
import { REFERENCE, type ReportType, TIMESTAMP } from '../shared/protocol';
import type { SentReport } from './reporter-store';
import { SUMMARY_MAX } from './reporter-store';
import { type FetchLike, SUBMIT_TIMEOUT_MS } from './submit';

/** Where this frame's reporter routes are, and how to reach them. */
export interface ReporterEndpoints {
  code: string;
  session: string;
  reports: string;
  /** `same-origin` for the runtime's own routes, `cors` for control's. */
  mode: RequestMode;
}

export interface ReporterSessionAnswer {
  token: string;
  email: string;
  expiresAt: string;
}

export interface ReporterReportAnswer {
  reference: string;
  type: ReportType;
  status: ReporterStatus;
  receivedAt: string;
  updatedAt: string;
  summary: string | null;
}

export type ReporterOutcome<T> =
  | { kind: 'ok'; value: T }
  /** 400 on `…/session`: every failed sign-in (wrong, expired or used code). */
  | { kind: 'code_refused' }
  /** 401: the session is unknown or has ended. */
  | { kind: 'signed_out' }
  /** 400 on `…/code`: the address wasn't accepted. */
  | { kind: 'invalid' }
  /** 404: sign-in isn't offered here (an older server, sign-in off, no mail). */
  | { kind: 'unavailable' }
  | { kind: 'rate_limited'; retryAfter: number | null }
  | { kind: 'server' }
  | { kind: 'network' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const time = (v: unknown): v is string => str(v, 40) && TIMESTAMP.test(v);

function retryAfterOf(body: unknown, header: string | null): number | null {
  const fromBody = (body as { error?: { retryAfter?: unknown } } | null)?.error?.retryAfter;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/** One request: no cookies, referrer, cache or redirects; the bearer token only when given. */
async function call(
  fetchImpl: FetchLike,
  url: string,
  mode: RequestMode,
  method: 'GET' | 'POST' | 'DELETE',
  options: { body?: unknown; token?: string | null; timeoutMs?: number } = {},
): Promise<{ status: number; json: unknown; retryAfter: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SUBMIT_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      credentials: 'omit',
      cache: 'no-store',
      mode,
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The answers every route shares: 404, 429, anything else. */
function common<T>(res: { status: number; json: unknown; retryAfter: string | null }): ReporterOutcome<T> {
  if (res.status === 404) return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'rate_limited', retryAfter: retryAfterOf(res.json, res.retryAfter) };
  return { kind: 'server' };
}

/** POST `…/reporter/code`: 202 whether or not a code was sent. */
export async function requestCode(
  fetchImpl: FetchLike,
  ep: ReporterEndpoints,
  body: { email: string; parent: string },
): Promise<ReporterOutcome<true>> {
  const res = await call(fetchImpl, ep.code, ep.mode, 'POST', { body });
  if (!res) return { kind: 'network' };
  if (res.status === 202 || res.status === 200) return { kind: 'ok', value: true };
  if (res.status === 400) return { kind: 'invalid' };
  return common(res);
}

/** A `FeedbackReporterSession` answer, or null. */
export function parseSessionAnswer(value: unknown): ReporterSessionAnswer | null {
  if (!isObj(value)) return null;
  const { token, email, expiresAt } = value;
  if (!str(token, 64) || !FEEDBACK_REPORTER_TOKEN_PATTERN.test(token)) return null;
  if (!str(email, 254) || !email || !time(expiresAt)) return null;
  return { token, email, expiresAt };
}

/** POST `…/reporter/session`: the code for a session. */
export async function startSession(
  fetchImpl: FetchLike,
  ep: ReporterEndpoints,
  body: { email: string; code: string; parent: string },
): Promise<ReporterOutcome<ReporterSessionAnswer>> {
  const res = await call(fetchImpl, ep.session, ep.mode, 'POST', { body });
  if (!res) return { kind: 'network' };
  if (res.status === 200 || res.status === 201) {
    const session = parseSessionAnswer(res.json);
    return session ? { kind: 'ok', value: session } : { kind: 'server' };
  }
  if (res.status === 400) return { kind: 'code_refused' };
  return common(res);
}

/** DELETE `…/reporter/session`: best effort (the frame forgets the session whatever the answer). */
export async function endSession(fetchImpl: FetchLike, ep: ReporterEndpoints, token: string): Promise<void> {
  await call(fetchImpl, ep.session, ep.mode, 'DELETE', { token });
}

const STATUSES: readonly string[] = FEEDBACK_REPORTER_STATUSES;

/**
 * A `FeedbackReporterReports` answer's reports, or null when it isn't one. Rows this widget can't show (a type or
 * status only a newer server knows) are left out rather than refusing the whole list (AP-262).
 */
export function parseReportsAnswer(value: unknown): ReporterReportAnswer[] | null {
  if (!isObj(value) || !Array.isArray(value.reports) || !str(value.email, 254)) return null;
  const out: ReporterReportAnswer[] = [];
  for (const row of value.reports.slice(0, 200)) {
    if (!isObj(row)) continue;
    const { reference, type, status, receivedAt, updatedAt, summary } = row;
    if (!str(reference, 20) || !REFERENCE.test(reference)) continue;
    if (type !== 'bug' && type !== 'feature') continue;
    if (typeof status !== 'string' || !STATUSES.includes(status)) continue;
    if (!time(receivedAt) || !time(updatedAt)) continue;
    if (summary !== null && !str(summary, SUMMARY_MAX)) continue;
    out.push({ reference, type, status: status as ReporterStatus, receivedAt, updatedAt, summary });
  }
  return out;
}

/** GET `…/reporter/reports` (Bearer): the reporter's reports on this site, newest first. */
export async function fetchReports(
  fetchImpl: FetchLike,
  ep: ReporterEndpoints,
  token: string,
): Promise<ReporterOutcome<ReporterReportAnswer[]>> {
  const res = await call(fetchImpl, ep.reports, ep.mode, 'GET', { token });
  if (!res) return { kind: 'network' };
  if (res.status === 200) {
    const reports = parseReportsAnswer(res.json);
    return reports ? { kind: 'ok', value: reports } : { kind: 'server' };
  }
  if (res.status === 401) return { kind: 'signed_out' };
  return common(res);
}

/** A row of “Your reports”. */
export interface ReportRow {
  reference: string;
  type: ReportType;
  status: ReporterStatus;
  receivedAt: string;
  summary: string | null;
}

/**
 * A report sent from here is listed as “Received” until the server lists it: in drop mode it reaches control's list
 * only once the site's Whombat collected it. After this long it is left out (a drop waits at most 7 days in control, FD-26).
 */
export const LOCAL_ONLY_MS = 7 * 86_400_000;

/**
 * “Your reports”: the server's rows with the server's summary, else the one this frame kept (control keeps no text),
 * plus reports sent from here that the server doesn't list yet; newest first.
 */
export function mergeReports(
  server: readonly ReporterReportAnswer[],
  sent: readonly SentReport[],
  now: number,
): ReportRow[] {
  const local = new Map(sent.map((s) => [s.reference, s]));
  const rows: ReportRow[] = server.map((r) => ({
    reference: r.reference,
    type: r.type,
    status: r.status,
    receivedAt: r.receivedAt,
    summary: r.summary ?? local.get(r.reference)?.summary ?? null,
  }));
  const listed = new Set(rows.map((r) => r.reference));
  for (const s of sent)
    if (!listed.has(s.reference) && now - Date.parse(s.at) < LOCAL_ONLY_MS)
      rows.push({
        reference: s.reference,
        type: s.type,
        status: 'received',
        receivedAt: s.at,
        summary: s.summary,
      });
  return rows.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** “29 Sep” in the visitor's time zone; “29 Sep 2025” in another year. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** “Try again in 2 minutes.” */
export function retryText(retryAfter: number | null): string {
  const minutes = retryAfter ? Math.max(1, Math.ceil(retryAfter / 60)) : null;
  return `Try again ${minutes === null ? 'later' : minutes === 1 ? 'in a minute' : `in ${minutes} minutes`}.`;
}

/**
 * `FEEDBACK_PUBLIC_MESSAGES.code_refused` and `.signed_out` of `@whombat/core` (repeated: that module pulls in Zod; a
 * test keeps them equal).
 */
export const SIGNIN_MESSAGES = {
  code_refused: 'That code didn’t work. Check it or ask for a new one.',
  signed_out: 'Your sign-in has ended. Sign in again.',
} as const;
