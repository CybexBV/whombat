/**
 * The frame's only storage (AP-429; lifts Whombat FD-28 (7) for exactly this key): a signed-in reporter's session in
 * `localStorage` under `whombat-feedback:<site>`. The browser partitions a third-party frame's storage by the
 * embedding site, so the key is per website and per Whombat site. It holds the session token, the address, the name
 * the visitor gave and the last 50 reports sent while signed in (reference, type, summary, time), nothing else.
 *
 * This is the one module of the frame that may name `localStorage` (the build and a unit test check every other
 * module, `scripts/build.ts` `frameSourceViolations`); cookies, `sessionStorage`, IndexedDB and the rest stay banned
 * everywhere. Storage that is missing, blocked or full is not an error: the session then lasts while the frame is
 * open (the app keeps it in memory).
 */
import { FEEDBACK_REPORTER_TOKEN_PATTERN } from '@whombat/core/feedback/reporters';
import { REFERENCE, type ReportType, TIMESTAMP } from '../shared/protocol';

export const REPORTER_KEY_PREFIX = 'whombat-feedback:';
/** Reports sent while signed in that the frame remembers (their summary; control keeps no text). */
export const SENT_MAX = 50;
/** `FeedbackReporterReport.summary` max. */
export const SUMMARY_MAX = 140;
const EMAIL_MAX = 254;
const NAME_MAX = 120;

export interface SentReport {
  reference: string;
  type: ReportType;
  /** `reporterSummaryOf(description)`. */
  summary: string;
  /** When it was received (the receipt's `receivedAt`). */
  at: string;
}

export interface ReporterSession {
  token: string;
  email: string;
  /** The name the visitor last sent with (prefilled). */
  name: string;
  expiresAt: string;
  sent: SentReport[];
}

export const reporterKey = (site: string): string => `${REPORTER_KEY_PREFIX}${site}`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const time = (v: unknown): v is string => str(v, 40) && TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v));

function sentOf(value: unknown): SentReport | null {
  if (!isObj(value)) return null;
  const { reference, type, summary, at } = value;
  if (!str(reference, 20) || !REFERENCE.test(reference)) return null;
  if (type !== 'bug' && type !== 'feature') return null;
  if (!str(summary, SUMMARY_MAX) || !time(at)) return null;
  return { reference, type, summary, at };
}

/** A stored session that is well formed and not expired at `now`, copied; else null. */
export function parseStoredSession(value: unknown, now: number): ReporterSession | null {
  if (!isObj(value)) return null;
  const { token, email, name, expiresAt, sent } = value;
  if (!str(token, 64) || !FEEDBACK_REPORTER_TOKEN_PATTERN.test(token)) return null;
  if (!str(email, EMAIL_MAX) || !email || !str(name, NAME_MAX) || !time(expiresAt)) return null;
  if (Date.parse(expiresAt) <= now) return null;
  const list = Array.isArray(sent) ? sent : [];
  const outSent = list.map(sentOf).filter((s): s is SentReport => s !== null);
  return { token, email, name, expiresAt, sent: outSent.slice(0, SENT_MAX) };
}

/** `window.localStorage`, or null where reading it throws (blocked storage, opaque origins). */
function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored session of this site, or null (none, expired, malformed — a bad one is removed — or no storage). */
export function loadSession(site: string, now = Date.now()): ReporterSession | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(reporterKey(site));
    if (raw === null) return null;
    const session = parseStoredSession(JSON.parse(raw), now);
    if (!session) s.removeItem(reporterKey(site));
    return session;
  } catch {
    return null;
  }
}

/** Stores the session; false when storage is unavailable (it then lives in memory only). */
export function saveSession(site: string, session: ReporterSession): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(reporterKey(site), JSON.stringify({ ...session, sent: session.sent.slice(0, SENT_MAX) }));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the session of this site (sign-out, an ended session). */
export function clearSession(site: string): void {
  try {
    storage()?.removeItem(reporterKey(site));
  } catch {
    // Nothing stored that could be removed.
  }
}
