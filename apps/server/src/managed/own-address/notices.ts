/**
 * What the person hears about the own address (docs/decisions/own-address.md), as Needs you items and one push. Every
 * check here starts on (watch-defaults.md): each is a security opening or the address broken now, and the person can
 * act.
 *
 * - `own_address.foreign`: a certificate for the address that the box didn't ask for is valid. The screen shows it too
 *   (the console's alert), and the person's devices get a push once per certificate.
 * - `own_address.unchecked`: no fresh certificate check for two days, with the date checking stopped.
 * - `own_address.expiring`: the certificate ends within 7 days and no newer one is served (once per certificate).
 * - `own_address.failing`: no certificate after a day of trying; a runtime that keeps restarting can't renew it either.
 * - `own_address.moved`: the address changed (the person renamed it, or the box moved to `whombat.app`); the old one
 *   works until its date. A calm heads-up while the old one works.
 * - `own_address.leaving`: 3 days before the old address stops, while some device has box passkeys only for it.
 *
 * The windows the watch couldn't check are on This Whombat's page, with their dates (`missedWindowsText`).
 */
import type { NeedsYouItem } from '@whombat/core';
import { OWN_ADDRESS_LEAVING_DAYS } from '@whombat/protocol/own-address';
import { registerNeedsYouSource, type SourceCtx, sourceLocale } from '../../home/registry';
import { isEnglish, type ServerMessageKey, tServer } from '../../i18n/catalog';
import { loadPrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { checkStartsOn, registerChecks } from '../../things/quiet/defaults';
import type { ControlPush } from '../push';
import { SECURITY_NOTICES } from '../security-push';
import type { ForeignCertificate } from './ct';
import { uncheckedSince } from './ct';
import type { OwnAddressService } from './state';

export const OWN_ADDRESS_CHECKS = [
  // A certificate for the box's address it didn't ask for: a security opening now; the person stops using the address
  // in browsers and looks into it.
  { check: 'own_address.foreign', startsOn: true },
  // The certificate watch hasn't had a fresh answer for two days: a foreign certificate could go unseen.
  { check: 'own_address.unchecked', startsOn: true },
  // The address's certificate ends within a week and no new one came: the address is about to break.
  { check: 'own_address.expiring', startsOn: true },
  // No certificate after a day of trying: the address doesn't work.
  { check: 'own_address.failing', startsOn: true },
  // The address changed: every page and passkey the person uses there has 30 days to move, so they need to know.
  { check: 'own_address.moved', startsOn: true },
  // The old address stops in 3 days and some device has passkeys only for it: without one at the new address it loses
  // that way in.
  { check: 'own_address.leaving', startsOn: true },
] as const;
registerChecks(OWN_ADDRESS_CHECKS);

const ABOUT_HREF = '/settings?tab=appliance&section=about';
const DAY_MS = 86_400_000;
export const EXPIRING_WITHIN_MS = 7 * DAY_MS;
export const FAILING_AFTER_MS = DAY_MS;

/** The words in a locale, one place each (CLAUDE.md: short and plain). */
export function ownAddressWords(locale?: string | null) {
  const t = (key: ServerMessageKey, vars?: Record<string, string>) => tServer(locale, key, vars);
  return {
    open: t('managed.ownAddress.open'),
    foreignTitle: t('managed.ownAddress.foreignTitle'),
    foreignBody: (address: string) => t('managed.ownAddress.foreignBody', { address }),
    uncheckedTitle: t('managed.ownAddress.uncheckedTitle'),
    uncheckedBody: (since: string) => t('managed.ownAddress.uncheckedBody', { since }),
    expiringTitle: t('managed.ownAddress.expiringTitle'),
    expiringBody: (date: string) => t('managed.ownAddress.expiringBody', { date }),
    failingTitle: t('managed.ownAddress.failingTitle'),
    failingBody: t('managed.ownAddress.failingBody'),
    missed: (from: string, to: string) => t('managed.ownAddress.missed', { from, to }),
    movedTitle: t('managed.ownAddress.movedTitle'),
    movedBody: (host: string, until: string) => t('managed.ownAddress.movedBody', { host, until }),
    leavingTitle: t('managed.ownAddress.leavingTitle'),
    leavingBody: (old: string, until: string, host: string) =>
      t('managed.ownAddress.leavingBody', { old, until, host }),
  };
}

export const OWN_ADDRESS_WORDS = ownAddressWords(null);

/** How long before the old address stops the person hears about passkeys that only work there. */
export const LEAVING_WARN_MS = 3 * DAY_MS;

/** English dates stay `en-GB` (day first); Dutch ones are `nl-NL`. */
function dateLocale(locale?: string | null): string {
  return isEnglish(locale) ? 'en-GB' : 'nl-NL';
}

/** A day as the person reads it (UTC, which the box's other notices use when no time zone is known). */
export function dayText(iso: string, locale?: string | null): string {
  return new Date(iso).toLocaleDateString(dateLocale(locale), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A day and month as the person reads them (“23 December”). */
export function dayMonthText(iso: string, locale?: string | null): string {
  return new Date(iso).toLocaleDateString(dateLocale(locale), {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** The missed windows as the person reads them. */
export function missedWindowsText(
  missed: readonly { from: string; to: string }[],
  locale?: string | null,
): string[] {
  const w = ownAddressWords(locale);
  return missed.map((m) => w.missed(dayText(m.from, locale), dayText(m.to, locale)));
}

/** When the box first saw itself without a certificate while it had a label (memory; a restart starts again). */
const waitingSince = new WeakMap<OwnAddressService, number>();

/** What the notices ask of the box passkeys: whether some device has them only for the leaving host. */
export interface OwnAddressPasskeys {
  onlyAt(leaving: string, current: string): Promise<boolean>;
}

/** The items for the own address now. Pure but for the service's and the passkeys' reads. */
export async function ownAddressItems(
  own: OwnAddressService,
  now: Date,
  passkeys?: OwnAddressPasskeys | null,
  locale?: string | null,
): Promise<NeedsYouItem[]> {
  const items: NeedsYouItem[] = [];
  const words = ownAddressWords(locale);
  const host = own.host();
  if (!host) return items;
  const item = (
    check: string,
    id: string,
    severity: 'bad' | 'warn' | 'info',
    title: string,
    body: string,
    at: string,
    nature: 'you' | 'fyi' = 'you',
  ): NeedsYouItem => ({
    id: `${check}:${id}`.slice(0, 200),
    ref: { kind: 'own_address', id: `${check}:${id}`.slice(0, 200) },
    kind: 'alert',
    severity,
    nature,
    title,
    body,
    at,
    actions: [{ id: 'open', label: words.open, style: 'primary', kind: 'open', href: ABOUT_HREF }],
    href: ABOUT_HREF,
  });
  const foreign = await own.validForeign();
  if (foreign.length && checkStartsOn('own_address.foreign')) {
    const first = foreign.map((f) => f.firstSeenAt).sort()[0] as string;
    items.push(item('own_address.foreign', first, 'bad', words.foreignTitle, words.foreignBody(host), first));
  }
  const watch = own.watch();
  const unchecked = watch ? uncheckedSince(watch, now) : null;
  if (unchecked && checkStartsOn('own_address.unchecked'))
    items.push(
      item(
        'own_address.unchecked',
        unchecked,
        'warn',
        words.uncheckedTitle,
        words.uncheckedBody(dayText(unchecked, locale)),
        unchecked,
      ),
    );
  const served = own.servedUntil();
  if (served && checkStartsOn('own_address.expiring')) {
    const left = served.notAfter.getTime() - now.getTime();
    if (left <= EXPIRING_WITHIN_MS)
      items.push(
        item(
          'own_address.expiring',
          served.serial,
          'warn',
          words.expiringTitle,
          words.expiringBody(dayText(served.notAfter.toISOString(), locale)),
          new Date(served.notAfter.getTime() - EXPIRING_WITHIN_MS).toISOString(),
        ),
      );
  }
  const leaving = own.leaving();
  if (leaving) {
    const until = leaving.until.toISOString();
    if (checkStartsOn('own_address.moved'))
      items.push(
        item(
          'own_address.moved',
          host,
          'info',
          words.movedTitle,
          words.movedBody(host, dayMonthText(until, locale)),
          // From when the address changed: the old one's date less the 30 days it works (never later than now).
          new Date(
            Math.min(leaving.until.getTime() - OWN_ADDRESS_LEAVING_DAYS * DAY_MS, now.getTime()),
          ).toISOString(),
          'fyi',
        ),
      );
    const warnAt = leaving.until.getTime() - LEAVING_WARN_MS;
    if (
      now.getTime() >= warnAt &&
      checkStartsOn('own_address.leaving') &&
      (await passkeys?.onlyAt(leaving.host, host))
    )
      items.push(
        item(
          'own_address.leaving',
          leaving.host,
          'warn',
          words.leavingTitle,
          words.leavingBody(leaving.host, dayMonthText(until, locale), host),
          new Date(warnAt).toISOString(),
        ),
      );
  }
  if (own.ready()) waitingSince.delete(own);
  else {
    const since = waitingSince.get(own) ?? now.getTime();
    waitingSince.set(own, since);
    if (now.getTime() - since >= FAILING_AFTER_MS && checkStartsOn('own_address.failing'))
      items.push(
        item(
          'own_address.failing',
          String(since),
          'bad',
          words.failingTitle,
          words.failingBody,
          new Date(since).toISOString(),
        ),
      );
  }
  return items;
}

/** Registers the Needs you source (the runtime does at its start). */
export function registerOwnAddressSource(
  own: () => OwnAddressService | null,
  passkeys?: () => OwnAddressPasskeys | null,
): void {
  registerNeedsYouSource('own-address', async (ctx: SourceCtx) => {
    const service = own();
    if (!service) return [];
    const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
    if (person?.kind !== 'person') return [];
    return ownAddressItems(service, ctx.now, passkeys?.() ?? null, await sourceLocale(ctx));
  });
}

/** A push to the person's devices for each newly found certificate (fixed words; the tap opens This Whombat). */
export async function pushForeign(
  services: Services,
  push: Pick<ControlPush, 'security'> | null,
  accountIds: readonly string[],
  found: readonly ForeignCertificate[],
): Promise<void> {
  for (const cert of found)
    await push
      ?.security(accountIds, `own-address-foreign:${cert.spkiSha256}`, SECURITY_NOTICES.ownAddressForeign)
      .catch((err) => services.log.warn({ err: String(err) }, 'own address: the notice was not pushed'));
}
