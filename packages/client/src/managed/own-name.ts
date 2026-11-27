/**
 * Choosing and changing the name of a box's own address (`<name>.whombat.app`; Whombat docs/decisions/own-address.md,
 * the app's docs/app/decisions/own-address.md): the name field's live check, the lines under it, a rename's refusals in
 * plain words, the leaving address while it still works, the line about Cloudflare's certificates, the banner at the
 * old address and keeping the phone's copy of the address in step. Pure, apart from the checker's timer; the web and
 * the phone show the same words.
 */
import { interpolate, resolveLanguage } from '@whombat/core/i18n';
import { ownAddressNameProblem } from '@whombat/core/own-address';
import {
  OWN_ADDRESS_ZONE_CERTIFICATES,
  OWN_ADDRESS_ZONES,
  type OwnAddressNameVerdict,
  ownAddressLabelOf,
  ownAddressZoneOf,
} from '@whombat/protocol';
import { parseLocalLink } from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { OWN_NAME_WORDS } from '../i18n/messages/ownName';
import { OperationError, type OwnAddressSummary } from '../session/managed-ops';

/** The zone new names get; the field shows it after the name. Control's answer names the real host. */
export const OWN_NAME_ZONE = OWN_ADDRESS_ZONES.prod;

/** The last day Cloudflare's own certificates for `*.whombat.app` are valid (the later of the two). */
const ZONE_CERTIFICATES_END = Math.max(...OWN_ADDRESS_ZONE_CERTIFICATES.map((c) => Date.parse(c.notAfter)));

/** The own address's words, in a locale (English when none is given). */
export function ownNameText(locale?: string | null) {
  const w = clientTree(locale, OWN_NAME_WORDS);
  return {
    ...w,
    random: (example: string) => interpolate(w.random, { example }),
    randomExample: interpolate(w.randomExample, { zone: OWN_NAME_ZONE }),
    free: (host: string) => interpolate(w.free, { host }),
    yours: (host: string) => interpolate(w.yours, { host }),
    changed: (host: string) => interpolate(w.changed, { host }),
    leaving: (date: string) => interpolate(w.leaving, { date }),
    moved: (host: string, date: string) => interpolate(w.moved, { host, date }),
  };
}

export const OWN_NAME_TEXT = ownNameText('en');

/** A typed name as it is checked: trimmed and lower case (the field takes nothing else). */
export function ownNameCandidate(typed: string): string {
  return typed.trim().toLowerCase();
}

/**
 * Where the check of a typed name stands:
 * - `idle`: nothing typed;
 * - `current`: the box's own name now (nothing to change);
 * - `checking`: asked, no answer yet;
 * - `done`: the verdict (`host` when it could be the box's);
 * - `failed`: the check itself didn't work (it doesn't say the name is bad).
 */
export type OwnNameCheck =
  | { kind: 'idle' }
  | { kind: 'current'; name: string }
  | { kind: 'checking'; name: string }
  | { kind: 'done'; name: string; verdict: OwnAddressNameVerdict; host: string | null }
  | { kind: 'failed'; name: string };

/**
 * What the app can say about a name without asking: nothing typed, the current name, or a name with the wrong shape or
 * one nobody gets (the same rules control keeps). Null: ask.
 */
export function ownNameLocal(typed: string, current?: string | null): OwnNameCheck | null {
  const name = ownNameCandidate(typed);
  if (!name) return { kind: 'idle' };
  if (current && name === current) return { kind: 'current', name };
  const problem = ownAddressNameProblem(name);
  return problem ? { kind: 'done', name, verdict: problem, host: null } : null;
}

/** The line under the field, and its tone; null while nothing is typed. */
export function ownNameLine(
  check: OwnNameCheck,
  zone: string = OWN_NAME_ZONE,
  locale?: string | null,
): { text: string; tone: 'ok' | 'bad' | 'mut' } | null {
  const T = ownNameText(locale);
  switch (check.kind) {
    case 'idle':
      return null;
    case 'current':
      return { text: T.current, tone: 'mut' };
    case 'checking':
      return { text: T.checking, tone: 'mut' };
    case 'failed':
      return { text: T.failed, tone: 'bad' };
    case 'done': {
      const host = check.host ?? `${check.name}.${zone}`;
      if (check.verdict === 'free') return { text: T.free(host), tone: 'ok' };
      if (check.verdict === 'yours') return { text: T.yours(host), tone: 'ok' };
      return { text: T[check.verdict], tone: 'bad' };
    }
  }
}

/** The name to send once the check said it can be the box's (`free`, or `yours` when changing), else null. */
export function ownNameChosen(check: OwnNameCheck): string | null {
  return check.kind === 'done' && (check.verdict === 'free' || check.verdict === 'yours') ? check.name : null;
}

/** The zone a host is under (the field's suffix), the default one when it isn't an own-address host. */
export function ownNameZoneOf(host: string | null | undefined): string {
  return (host && ownAddressZoneOf(host)) || OWN_NAME_ZONE;
}

/**
 * Checks a name as it is typed: what the app knows at once, else asks after a short pause (`delayMs`), and only the
 * answer for the name still typed counts.
 */
export function createOwnNameChecker(input: {
  ask: (name: string) => Promise<{ verdict: OwnAddressNameVerdict; host?: string | undefined }>;
  onChange: (check: OwnNameCheck) => void;
  current?: string | null;
  delayMs?: number;
}): { type(typed: string): void; dispose(): void } {
  const delay = input.delayMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;
  return {
    type(typed) {
      clearTimeout(timer);
      const ticket = ++asked;
      const local = ownNameLocal(typed, input.current);
      if (local) return input.onChange(local);
      const name = ownNameCandidate(typed);
      input.onChange({ kind: 'checking', name });
      timer = setTimeout(() => {
        input.ask(name).then(
          (r) => {
            if (ticket === asked)
              input.onChange({ kind: 'done', name, verdict: r.verdict, host: r.host ?? null });
          },
          () => {
            if (ticket === asked) input.onChange({ kind: 'failed', name });
          },
        );
      }, delay);
    },
    /** Drops the waiting check and any answer still coming (typing again starts afresh). */
    dispose() {
      asked++;
      clearTimeout(timer);
    },
  };
}

/** A refused rename in plain words (`error.details.code`). */
export function ownAddressRenameErrorText(error: unknown, locale?: string | null): string {
  const T = ownNameText(locale);
  if (!(error instanceof OperationError)) return T.errors.failed;
  const reason = (error.details as { code?: unknown } | undefined)?.code ?? error.code;
  if (reason === 'unknown_op') return T.errors.own_address_unavailable;
  return typeof reason === 'string' && reason in T.errors
    ? T.errors[reason as keyof typeof T.errors]
    : T.errors.failed;
}

/** “23 December”: the day an old address stops, always within the next month or so. */
export function ownAddressDay(iso: string, timeZone?: string, locale?: string | null): string {
  return new Intl.DateTimeFormat(resolveLanguage(locale) === 'nl' ? 'nl-NL' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    ...(timeZone && { timeZone }),
  }).format(new Date(iso));
}

/** The leaving address's row while it still works: its host and “Old address · works until 23 December”. */
export function ownAddressLeavingView(
  own: Pick<OwnAddressSummary, 'leaving'>,
  now: number = Date.now(),
  timeZone?: string,
  locale?: string | null,
): { host: string; url: string; line: string } | null {
  const l = own.leaving;
  if (!l || Date.parse(l.until) <= now) return null;
  return {
    host: l.host,
    url: l.url,
    line: ownNameText(locale).leaving(ownAddressDay(l.until, timeZone, locale)),
  };
}

/**
 * The line about Cloudflare's certificates for `*.whombat.app`: while the host is right under `whombat.app` (they don't
 * cover `<name>.box.whombat.app`) and they are still valid.
 */
export function ownAddressCloudflareLine(
  host: string,
  now: number = Date.now(),
  locale?: string | null,
): string | null {
  return ownAddressZoneOf(host) === OWN_ADDRESS_ZONES.prod && now < ZONE_CERTIFICATES_END
    ? ownNameText(locale).cloudflare
    : null;
}

/**
 * The banner on the box's page at its old address: where it moved and when this address stops. Null anywhere else
 * (the new address, the local network, Tailscale, the apps).
 */
export function ownAddressMovedView(
  own: Pick<OwnAddressSummary, 'host' | 'url' | 'leaving'> | null,
  pageHost: string | null,
  now: number = Date.now(),
  timeZone?: string,
  locale?: string | null,
): { host: string; url: string; text: string } | null {
  const l = own?.leaving;
  if (!own || !l || !pageHost || pageHost !== l.host || Date.parse(l.until) <= now) return null;
  return {
    host: own.host,
    url: own.url,
    text: ownNameText(locale).moved(own.host, ownAddressDay(l.until, timeZone, locale)),
  };
}

/**
 * Whether the passkeys section at the box's current address offers “Add a passkey for your new address”: the person has
 * no passkey for this address yet, but has some for the leaving one (they made them before the address changed).
 */
export function ownAddressPasskeyMoved(
  own: Pick<OwnAddressSummary, 'host' | 'leaving'>,
  passkeys: readonly { rpId?: string | undefined }[],
): boolean {
  const old = own.leaving?.host;
  if (!old) return false;
  return !passkeys.some((p) => p.rpId === own.host) && passkeys.some((p) => p.rpId === old);
}

/**
 * The address the phone keeps for a box (`KnownAppliance.ownAddress`, `https://<host>/`) once the box reported its
 * current one: the new URL when it differs from what the phone has, else null (nothing to write). A box without an own
 * address (null) changes nothing: the phone keeps the one it was let in with, which may come back.
 */
export function ownAddressToKeep(
  known: string | null | undefined,
  own: Pick<OwnAddressSummary, 'host' | 'url'> | null | undefined,
): string | null {
  if (!own || ownAddressLabelOf(own.host) === null) return null;
  const url = `https://${own.host}/`;
  return known === url ? null : url;
}

/**
 * Where “Go to the new address” goes: the device link the box made (`enroll.link.create`), which opens at its current
 * address and lets this browser in there in one step; its own page there otherwise (a link without that address, which
 * a box of this release doesn't make).
 */
export function ownAddressMoveTarget(link: string | null, own: Pick<OwnAddressSummary, 'url'>): string {
  const parsed = link ? parseLocalLink(link) : null;
  return parsed && parsed.own === own.url && link ? link : own.url;
}
