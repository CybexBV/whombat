/**
 * What people see of the appliance licence (LC-13, LC-14; contracts CT-77): the Subscription section of This Whombat,
 * the grace and lapsed strips, and the words of a refusal. Pure, shared by the web and the phone. The state itself is
 * the runtime's (`licence.status`, `appliance.status`'s `licence`); an older runtime has none and nothing is shown.
 */
import { LicenceLimitDetails } from '@whombat/protocol/session';
import type { LicenceView } from '../session/managed-ops';
import { appErrorOf } from '../signins/errors';
import { COPY } from './copy';

const T = COPY.licence;

/** “12 October 2026” (day, month, year; the device's time zone). */
export function licenceDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(timeZone && { timeZone }),
  }).format(new Date(iso));
}

export interface LicenceSummary {
  dot: 'ok' | 'warn' | 'bad';
  /** “Active”, “Trial”, “Payment problem”, “Not confirmed since …”, “Ended”. */
  title: string;
  /** The plan, “Valid until …”, “Everything keeps working until …”, joined with ` · `. */
  meta: string;
}

export function licenceSummary(v: LicenceView, timeZone?: string): LicenceSummary {
  const day = (iso: string) => licenceDay(iso, timeZone);
  const plan = v.plan ? T.plan(v.plan) : null;
  const meta = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  if (v.state === 'lapsed') return { dot: 'bad', title: T.ended, meta: meta(plan, T.endedNote) };
  const until = v.expiresAt ? T.validUntil(day(v.expiresAt)) : null;
  if (v.state === 'grace') {
    const keep = v.graceEndsAt ? T.keepWorking(day(v.graceEndsAt)) : null;
    const title =
      v.reason === 'payment'
        ? T.paymentProblem
        : v.renewedAt
          ? T.notConfirmedSince(day(v.renewedAt))
          : T.notConfirmedYet;
    return { dot: 'warn', title, meta: meta(plan, keep) };
  }
  if (v.reason === 'past_due')
    return { dot: 'warn', title: T.paymentProblem, meta: meta(plan, until, T.pastDue) };
  return { dot: 'ok', title: v.reason === 'trial' ? T.trial : T.active, meta: meta(plan, until) };
}

/** Usage against the plan's limits, only where there is one (“Connectors 3 of 5”). */
export function licenceUsage(v: LicenceView): { key: 'connectors'; text: string; full: boolean }[] {
  if (!v.limits) return [];
  // No agent or people count: a Whombat has one agent and one person (one-agent.md OA-02; one-person.md OP-11).
  return (['connectors'] as const).flatMap((key) => {
    const allowed = v.limits?.[key];
    if (allowed === null || allowed === undefined) return [];
    const used = v.usage[key];
    return [{ key, text: T.usageOf(T.usage[key], used, allowed), full: used >= allowed }];
  });
}

/** The strip over the app (LC-14): grace and lapsed. */
export function licenceBanner(
  v: LicenceView | null | undefined,
  timeZone?: string,
): { tone: 'warn' | 'bad'; text: string } | null {
  if (!v) return null;
  if (v.state === 'lapsed') return { tone: 'bad', text: T.lapsedBanner };
  if (v.state !== 'grace') return null;
  const date = v.graceEndsAt ? licenceDay(v.graceEndsAt, timeZone) : null;
  if (!date) return null;
  return { tone: 'warn', text: v.reason === 'payment' ? T.paymentBanner(date) : T.graceBanner(date) };
}

/**
 * The words for an action the licence refused (LC-10, LC-14): `licence.lapsed` and `licence.limit` on any transport
 * (REST puts the code in `details.code`, the session lifts it into `error.code`). Null for any other error.
 */
export function licenceRefusalText(error: unknown): string | null {
  const e = appErrorOf(error);
  if (e.code === 'licence.lapsed') return T.lapsed;
  if (e.code !== 'licence.limit') return null;
  const d = LicenceLimitDetails.safeParse({ ...e.details, code: 'licence.limit' });
  return d.success ? T.limit(d.data.allowed) : T.limitReached;
}

/** Why “Check again” didn't give a new answer. */
export function licenceRefreshErrorText(error: unknown): string {
  const code = appErrorOf(error).code;
  if (code === 'licence.renew_failed') return T.renewFailed;
  if (code === 'rate_limited' || code === 'too_many') return T.tooSoon;
  return T.failed;
}

/** `licence.status` isn't known to this runtime (older than contracts 0.10): show nothing. */
export function isUnknownOp(error: unknown): boolean {
  const code = appErrorOf(error).code;
  return code === 'unknown_op' || code === 'not_found';
}
