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
 *
 * The windows the watch couldn't check are on This Whombat's page, with their dates (`missedWindowsText`).
 */
import type { NeedsYouItem } from '@whombat/core';
import { registerNeedsYouSource, type SourceCtx } from '../../home/registry';
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
] as const;
registerChecks(OWN_ADDRESS_CHECKS);

const ABOUT_HREF = '/settings?tab=appliance&section=about';
const DAY_MS = 86_400_000;
export const EXPIRING_WITHIN_MS = 7 * DAY_MS;
export const FAILING_AFTER_MS = DAY_MS;

/** The words, one place each (CLAUDE.md: short and plain). */
export const OWN_ADDRESS_WORDS = {
  foreignTitle: 'A certificate you didn’t ask for',
  foreignBody: (address: string) =>
    `Someone got a security certificate for your Whombat’s address that your Whombat didn’t ask for. Until you know why, don’t use ${address}. Use the app on your phone or your home network.`,
  uncheckedTitle: 'Certificates not checked',
  uncheckedBody: (since: string) =>
    `Whombat couldn’t check certificates for its address since ${since}. It keeps trying.`,
  expiringTitle: 'Your Whombat’s address ends soon',
  expiringBody: (date: string) =>
    `The certificate for your Whombat’s address ends on ${date} and no new one came yet. Keep your Whombat on so it can renew it.`,
  failingTitle: 'Your Whombat’s address isn’t working',
  failingBody:
    'Your Whombat couldn’t get a certificate for its address for a day. It keeps trying, but it can’t while it keeps restarting.',
  missed: (from: string, to: string) => `Whombat couldn’t check certificates from ${from} to ${to}.`,
} as const;

/** A day as the person reads it (UTC, which the box's other notices use when no time zone is known). */
export function dayText(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The missed windows as the person reads them. */
export function missedWindowsText(missed: readonly { from: string; to: string }[]): string[] {
  return missed.map((m) => OWN_ADDRESS_WORDS.missed(dayText(m.from), dayText(m.to)));
}

/** When the box first saw itself without a certificate while it had a label (memory; a restart starts again). */
const waitingSince = new WeakMap<OwnAddressService, number>();

/** The items for the own address now. Pure but for the service's reads. */
export async function ownAddressItems(own: OwnAddressService, now: Date): Promise<NeedsYouItem[]> {
  const items: NeedsYouItem[] = [];
  const host = own.host();
  if (!host) return items;
  const item = (
    check: string,
    id: string,
    severity: 'bad' | 'warn',
    title: string,
    body: string,
    at: string,
  ): NeedsYouItem => ({
    id: `${check}:${id}`.slice(0, 200),
    ref: { kind: 'own_address', id: `${check}:${id}`.slice(0, 200) },
    kind: 'alert',
    severity,
    nature: 'you',
    title,
    body,
    at,
    actions: [{ id: 'open', label: 'Open', style: 'primary', kind: 'open', href: ABOUT_HREF }],
    href: ABOUT_HREF,
  });
  const foreign = await own.validForeign();
  if (foreign.length && checkStartsOn('own_address.foreign')) {
    const first = foreign.map((f) => f.firstSeenAt).sort()[0] as string;
    items.push(
      item(
        'own_address.foreign',
        first,
        'bad',
        OWN_ADDRESS_WORDS.foreignTitle,
        OWN_ADDRESS_WORDS.foreignBody(host),
        first,
      ),
    );
  }
  const watch = own.watch();
  const unchecked = watch ? uncheckedSince(watch, now) : null;
  if (unchecked && checkStartsOn('own_address.unchecked'))
    items.push(
      item(
        'own_address.unchecked',
        unchecked,
        'warn',
        OWN_ADDRESS_WORDS.uncheckedTitle,
        OWN_ADDRESS_WORDS.uncheckedBody(dayText(unchecked)),
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
          OWN_ADDRESS_WORDS.expiringTitle,
          OWN_ADDRESS_WORDS.expiringBody(dayText(served.notAfter.toISOString())),
          new Date(served.notAfter.getTime() - EXPIRING_WITHIN_MS).toISOString(),
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
          OWN_ADDRESS_WORDS.failingTitle,
          OWN_ADDRESS_WORDS.failingBody,
          new Date(since).toISOString(),
        ),
      );
  }
  return items;
}

/** Registers the Needs you source (the runtime does at its start). */
export function registerOwnAddressSource(own: () => OwnAddressService | null): void {
  registerNeedsYouSource('own-address', async (ctx: SourceCtx) => {
    const service = own();
    if (!service) return [];
    const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
    if (person?.kind !== 'person') return [];
    return ownAddressItems(service, ctx.now);
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
