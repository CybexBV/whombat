/**
 * What people see of the appliance licence (LC-13, LC-14; contracts CT-77): the Subscription section of This Whombat,
 * the grace and lapsed strips, and the words of a refusal. Pure, shared by the web and the phone. The state itself is
 * the runtime's (`licence.status`, `appliance.status`'s `licence`); an older runtime has none and nothing is shown.
 */
import { formatLocaleOf } from '@whombat/core/i18n';
import { LicenceLimitDetails } from '@whombat/protocol/session';
import { clientTranslator } from '../i18n/catalog';
import type { LicenceView } from '../session/managed-ops';
import { appErrorOf } from '../signins/errors';

/** “12 October 2026” / “12 oktober 2026” (day, month, year; the device's time zone). */
export function licenceDay(iso: string, timeZone?: string, locale?: string | null): string {
  return new Intl.DateTimeFormat(formatLocaleOf(locale), {
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

export function licenceSummary(v: LicenceView, timeZone?: string, locale?: string | null): LicenceSummary {
  const tr = clientTranslator(locale);
  const day = (iso: string) => licenceDay(iso, timeZone, locale);
  const planName = v.plan ? `${v.plan.charAt(0).toUpperCase()}${v.plan.slice(1).replace(/-/g, ' ')}` : null;
  const plan = planName ? tr.t('managed.licence.plan', { plan: planName }) : null;
  const meta = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  if (v.state === 'lapsed')
    return {
      dot: 'bad',
      title: tr.t('managed.billing.ended'),
      meta: meta(plan, tr.t('managed.licence.endedNote')),
    };
  const until = v.expiresAt ? tr.t('managed.licence.validUntil', { date: day(v.expiresAt) }) : null;
  if (v.state === 'grace') {
    const keep = v.graceEndsAt ? tr.t('managed.licence.keepWorking', { date: day(v.graceEndsAt) }) : null;
    const title =
      v.reason === 'payment'
        ? tr.t('managed.billing.paymentProblem')
        : v.renewedAt
          ? tr.t('managed.licence.notConfirmedSince', { date: day(v.renewedAt) })
          : tr.t('managed.licence.notConfirmedYet');
    return { dot: 'warn', title, meta: meta(plan, keep) };
  }
  if (v.reason === 'past_due')
    return {
      dot: 'warn',
      title: tr.t('managed.billing.paymentProblem'),
      meta: meta(plan, until, tr.t('managed.licence.pastDue')),
    };
  return {
    dot: 'ok',
    title: v.reason === 'trial' ? tr.t('managed.billing.trial') : tr.t('managed.billing.active'),
    meta: meta(plan, until),
  };
}

/** Usage against the plan's limits, only where there is one (“Connectors 3 of 5”). */
export function licenceUsage(
  v: LicenceView,
  locale?: string | null,
): { key: 'connectors'; text: string; full: boolean }[] {
  if (!v.limits) return [];
  const tr = clientTranslator(locale);
  return (['connectors'] as const).flatMap((key) => {
    const allowed = v.limits?.[key];
    if (allowed === null || allowed === undefined) return [];
    const used = v.usage[key];
    return [
      {
        key,
        text: tr.t('managed.licence.usageOf', {
          label: tr.t('managed.licence.connectors'),
          used,
          allowed,
        }),
        full: used >= allowed,
      },
    ];
  });
}

/** The strip over the app (LC-14): grace and lapsed. */
export function licenceBanner(
  v: LicenceView | null | undefined,
  timeZone?: string,
  locale?: string | null,
): { tone: 'warn' | 'bad'; text: string } | null {
  if (!v) return null;
  const tr = clientTranslator(locale);
  if (v.state === 'lapsed') return { tone: 'bad', text: tr.t('managed.licence.lapsedBanner') };
  if (v.state !== 'grace') return null;
  const date = v.graceEndsAt ? licenceDay(v.graceEndsAt, timeZone, locale) : null;
  if (!date) return null;
  return {
    tone: 'warn',
    text:
      v.reason === 'payment'
        ? tr.t('managed.licence.paymentBanner', { date })
        : tr.t('managed.licence.graceBanner', { date }),
  };
}

/**
 * The words for an action the licence refused (LC-10, LC-14): `licence.lapsed` and `licence.limit` on any transport
 * (REST puts the code in `details.code`, the session lifts it into `error.code`). Null for any other error.
 */
export function licenceRefusalText(error: unknown, locale?: string | null): string | null {
  const tr = clientTranslator(locale);
  const e = appErrorOf(error);
  if (e.code === 'licence.lapsed') return tr.t('managed.licence.lapsed');
  if (e.code !== 'licence.limit') return null;
  const d = LicenceLimitDetails.safeParse({ ...e.details, code: 'licence.limit' });
  return d.success ? tr.tp('managed.licence.limit', d.data.allowed) : tr.t('managed.licence.limitReached');
}

/** Why “Check again” didn't give a new answer. */
export function licenceRefreshErrorText(error: unknown, locale?: string | null): string {
  const tr = clientTranslator(locale);
  const code = appErrorOf(error).code;
  if (code === 'licence.renew_failed') return tr.t('managed.licence.renewFailed');
  if (code === 'rate_limited' || code === 'too_many') return tr.t('managed.licence.tooSoon');
  return tr.t('managed.licence.failed');
}

/** `licence.status` isn't known to this runtime (older than contracts 0.10): show nothing. */
export function isUnknownOp(error: unknown): boolean {
  const code = appErrorOf(error).code;
  return code === 'unknown_op' || code === 'not_found';
}
