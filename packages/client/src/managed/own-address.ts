/**
 * The box's own address in both apps (Whombat docs/decisions/own-address.md; the app's own-address.md): which page this
 * is, the setup at the address (claim with the claim link → link to the account → the box's own passkey), linking codes,
 * the address and its certificate watch in Settings, and the words people see (design §7.5, verbatim).
 *
 * Whether a box is set up at its own address (the A3 flag, `shared_route_off`) isn't in any answer the apps read. The
 * page learns it the only safe way: an unclaimed commercial box that takes `enroll.claim.local.start` is one, because a
 * box with the shared route refuses it (`claim_local_unavailable`). The start keeps nothing but a claim id in the box's
 * memory, so asking costs nothing (`probeOwnClaim`).
 */
import { DEFAULT_PUBLIC_URL } from '@whombat/core/text';
import {
  OWN_ADDRESS_CLAIM_PATH,
  OwnAddressClaimSecret,
  OwnAddressHost,
  ownAddressLabelOf,
} from '@whombat/protocol';
import { DIRECT_PATH } from '@whombat/protocol/direct';
import { AccountLinkCode, type DirectRoute } from '@whombat/protocol/session';
import { OperationError, type OwnAddressSummary, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

/** The own-address host this page is on (`<label>.box.whombat.app`, `<label>.dev.whombat.app`), or null. */
export function ownAddressOfPage(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ownAddressLabelOf(host) === null ? null : host;
}

/** The claim link's secret in a path (`/c/<6 letters>`, the link on the box's screen), or null. */
export function claimSecretOfPath(pathname: string): string | null {
  if (!pathname.startsWith(OWN_ADDRESS_CLAIM_PATH)) return null;
  const secret = pathname.slice(OWN_ADDRESS_CLAIM_PATH.length).replace(/\/$/, '').toLowerCase();
  return OwnAddressClaimSecret.safeParse(secret).success ? secret : null;
}

/** The address as people read it: the host, without `https://` or a trailing slash. */
export function ownAddressText(urlOrHost: string): string {
  return urlOrHost.replace(/^https:\/\//, '').replace(/\/$/, '');
}

/**
 * The box's own address as a route the direct connector dials first (`wss://<host>/v1/direct`, the page's own socket
 * through the door). The own address isn't a `DirectWay` (today's apps would refuse one), so it goes as a TLS way; the
 * connector reads only the socket. Null for anything but `https://<own-address host>/`.
 */
export function ownAddressRoute(url: string | null | undefined): DirectRoute | null {
  const m = url ? /^https:\/\/([a-z0-9.-]+)\/$/.exec(url) : null;
  if (!m?.[1] || !isOwnAddressHost(m[1])) return null;
  return { way: 'tailscale', socket: `wss://${m[1]}${DIRECT_PATH}`, web: `https://${m[1]}/` };
}

/** Whether `host` is an own-address host (the box's RP ID for its own passkeys). */
export function isOwnAddressHost(host: string): boolean {
  return OwnAddressHost.safeParse(host).success;
}

/* The setup at the address ----------------------------------------------------------------------------------------- */

export type OwnSetupStep = 'claim' | 'link' | 'passkey';

/**
 * The setup's steps, in order (design §7.1): claim, link, then the box's own passkey. The passkey step is only at the
 * address itself: a local-network or Tailscale page is another RP ID, so its browsers join by device link or screen
 * letters and make the box's passkey later at the address.
 */
export function ownSetupSteps(page: { atAddress: boolean }): OwnSetupStep[] {
  return page.atAddress ? ['claim', 'link', 'passkey'] : ['claim', 'link'];
}

/**
 * What an unclaimed commercial box says when asked to start a claim on this page:
 * - `claim`: it is claimed here (a box set up at its own address);
 * - `new_letters`: it is claimed here, but this device used its tries on the letters showing, or too many claims were
 *   begun: the setup opens on the letters and says to choose New letters on the box's screen;
 * - `needs_link`: it is, but at the address only with the claim link from its screen (the page had none, or a wrong one);
 * - `elsewhere`: it is claimed through the Whombat app (a box with the shared route), or not here (`claim_here_unavailable`);
 * - `claimed`: someone claimed it meanwhile;
 * - `failed`: anything else (not reachable, not showing its letters yet): the claim screen says why when tried.
 */
export type OwnClaimProbe = 'claim' | 'new_letters' | 'needs_link' | 'elsewhere' | 'claimed' | 'failed';

/** Whether the probe says this page claims the box: the setup opens. */
export function ownClaimHere(probe: OwnClaimProbe | null): boolean {
  return probe === 'claim' || probe === 'new_letters';
}

export async function probeOwnClaim(session: ApplianceSession, link: string | null): Promise<OwnClaimProbe> {
  try {
    await sessionOps.claimLocalStart(session, link ? { link } : {});
    return 'claim';
  } catch (error) {
    return ownClaimProbeOf(error);
  }
}

/** A refused start as `OwnClaimProbe`. */
export function ownClaimProbeOf(error: unknown): OwnClaimProbe {
  if (!(error instanceof OperationError)) return 'failed';
  const reason = (error.details as { code?: unknown } | undefined)?.code ?? error.code;
  switch (reason) {
    case 'claim_link':
      return 'needs_link';
    case 'claim_local_unavailable':
    case 'claim_here_unavailable':
    case 'not_allowed':
      return 'elsewhere';
    case 'claim_used':
      return 'claimed';
    // Not showing letters yet, or waiting after wrong guesses: still this page's claim, which says so when tried.
    case 'claim_not_ready':
    case 'claim_backoff':
      return 'claim';
    // Too many tries: still this page's claim. A reload must not end in the page for a Whombat that is set up.
    case 'claim_rate_limited':
    case 'claim_window_closed':
      return 'new_letters';
    default:
      return 'failed';
  }
}

/* Linking to the account ------------------------------------------------------------------------------------------- */

/** A typed link code as the box takes it (`ABCD-EFGH`: spaces, dashes and case don't matter), or null. */
export function normalizeLinkCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== 8) return null;
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return AccountLinkCode.safeParse(code).success ? code : null;
}

/** What a refused link code says. */
export function accountLinkErrorText(error: unknown): string {
  const t = OWN_ADDRESS_TEXT.link.errors;
  if (!(error instanceof OperationError)) return t.failed;
  const reason = (error.details as { code?: unknown } | undefined)?.code ?? error.code;
  switch (reason) {
    case 'link_code_invalid':
      return t.invalid;
    case 'link_code_expired':
      return t.expired;
    case 'link_code_used':
      return t.used;
    case 'link_other_account':
      return t.otherAccount;
    case 'link_devices_allowed':
      return t.devicesAllowed;
    case 'link_terms':
      return t.terms;
    case 'control_unreachable':
    case 'unavailable':
      return t.unreachable;
    case 'rate_limited':
      return t.rateLimited;
    default:
      return t.failed;
  }
}

/** Minutes and seconds left on a link code (`9:59`), or null once it ran out. */
export function linkCodeTimeLeft(expiresAt: string, now: number = Date.now()): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* The address in Settings ------------------------------------------------------------------------------------------ */

/** The box's own address, or null when it has none or is older than 4.3 (`unknown_op`). */
export async function readOwnAddress(session: ApplianceSession): Promise<OwnAddressSummary | null> {
  try {
    return (await sessionOps.ownAddressStatus(session)).ownAddress;
  } catch (error) {
    if (error instanceof OperationError && error.code === 'unknown_op') return null;
    throw error;
  }
}

const day = (iso: string, locale?: string) =>
  new Date(iso).toLocaleDateString(locale ?? 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = (iso: string, locale?: string) =>
  new Date(iso).toLocaleString(locale ?? 'en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** When the box tries for its certificate again: the time today, the day and the time later, null once it passed. */
function retryWhen(iso: string, now: number, locale?: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return null;
  const time = new Date(at).toLocaleTimeString(locale ?? 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay = (ms: number) => new Date(ms).toLocaleDateString(locale ?? 'en-GB');
  if (sameDay(at) === sameDay(now)) return `at ${time}`;
  const date = new Date(at).toLocaleDateString(locale ?? 'en-GB', { day: 'numeric', month: 'short' });
  return `on ${date} at ${time}`;
}

/** The state line while the box can't get its certificate: why, and when it tries again. */
function failingState(a: OwnAddressSummary, now: number, locale?: string) {
  const t = OWN_ADDRESS_TEXT.settings;
  const f = a.failure;
  const when = f?.retryAt ? retryWhen(f.retryAt, now, locale) : null;
  if (f?.reason === 'rate_limited') return { state: t.busy(when), tone: 'warn' as const };
  return { state: when ? t.failingRetry(when) : t.failing, tone: 'bad' as const };
}

/** What Settings → This Whombat → About shows for the address, line by line. */
export interface OwnAddressView {
  /** The address as people read it. */
  address: string;
  url: string;
  /** One line on whether the page works. */
  state: string;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  /** “Certificate ends …”, or null without one. */
  certificate: string | null;
  /** “Last checked …”, or “Not checked yet.” */
  lastCheck: string;
  /** One line per stretch the watch couldn't check (newest first). */
  missed: string[];
  /** Certificates the box didn't ask for, still valid. */
  foreign: number;
}

export function ownAddressView(
  a: OwnAddressSummary,
  now: number = Date.now(),
  locale?: string,
): OwnAddressView {
  const t = OWN_ADDRESS_TEXT.settings;
  const foreign = a.watch.foreign.filter((f) => Date.parse(f.notAfter) > now).length;
  const state = !a.reachable
    ? { state: t.off, tone: 'mut' as const }
    : a.state === 'ready'
      ? { state: t.ready, tone: 'ok' as const }
      : a.state === 'failing'
        ? failingState(a, now, locale)
        : a.state === 'starting'
          ? { state: t.starting, tone: 'warn' as const }
          : { state: t.off, tone: 'mut' as const };
  return {
    address: ownAddressText(a.url),
    url: a.url,
    ...(foreign > 0 ? { state: t.foreign, tone: 'bad' as const } : state),
    certificate: a.certificateEndsAt ? t.certificate(day(a.certificateEndsAt, locale)) : null,
    lastCheck: a.watch.lastCheckAt ? t.lastCheck(dayTime(a.watch.lastCheckAt, locale)) : t.notChecked,
    missed: [...a.watch.missed]
      .sort((x, y) => y.from.localeCompare(x.from))
      .map((m) => t.missed(dayTime(m.from, locale), dayTime(m.to, locale))),
    foreign,
  };
}

/* Words ------------------------------------------------------------------------------------------------------------ */

/** The privacy page the passkey words point to until the claim exists (design §7.5). */
export const PRIVACY_PAGE_PATH = '/legal/privacy-policy';
export const PRIVACY_PAGE_URL = `${DEFAULT_PUBLIC_URL}${PRIVACY_PAGE_PATH}`;

export const OWN_ADDRESS_TEXT = {
  /** An unclaimed box opened at its address without the claim link. */
  openOnScreen: {
    kicker: 'THIS WHOMBAT',
    title: 'Set up your Whombat',
    sub: 'Open the address on your Whombat’s screen to set it up.',
  },
  steps: {
    claim: { t: 'Claim your Whombat', d: 'The letters on its screen' },
    link: { t: 'Link your account', d: 'The code from your Whombat account' },
    passkey: { t: 'Make its passkey', d: 'For this Whombat only' },
  },
  stepLabel: (i: number, of: number) => `STEP ${i + 1} OF ${of}`,
  claim: {
    title: 'Claim your Whombat',
    sub: 'Your Whombat shows four letters on its screen. Type them here to make it yours.',
    tip: 'No screen on it? Look at the console of the machine it runs on.',
  },
  account: {
    title: 'Who are you?',
    sub: 'Your name is how your agent greets you.',
    tip: 'Your name and email stay on this Whombat.',
  },
  link: {
    title: 'Type the code from your Whombat account',
    sub: 'Sign in at app.whombat.com and choose “Link a Whombat”. It shows a code for 10 minutes.',
    tip: 'Linking lets your phone reach this Whombat from anywhere. Your account gets nothing on it.',
    label: 'CODE',
    placeholder: 'ABCD-EFGH',
    next: 'Continue',
    checking: 'Checking…',
    confirmTitle: (email: string) => `Link to ${email}?`,
    confirmSub: 'This Whombat will belong to that Whombat account. Only link an account that’s yours.',
    confirm: 'Link',
    linking: 'Linking…',
    other: 'Use another code',
    later: 'Later',
    linked: (email: string) => `Linked to ${email}.`,
    errors: {
      code: 'Enter the 8 letters of the code.',
      invalid: 'That code doesn’t work. Check it, or make a new one.',
      expired: 'That code ran out. Make a new one.',
      used: 'That code was used already. Make a new one.',
      otherAccount: 'This Whombat is linked to another account already.',
      devicesAllowed: 'Your plan has room for no more Whombats. Change it at app.whombat.com.',
      terms: 'Accept the Whombat terms at app.whombat.com first, then make a new code.',
      unreachable: 'Whombat’s service didn’t answer. Try again in a moment.',
      rateLimited: 'Too many tries. Wait a few minutes, then try again.',
      failed: 'That didn’t work. Try again.',
    },
  },
  passkey: {
    title: 'Make a passkey for this Whombat',
    sub: 'It opens this Whombat and its backups. You’ll touch it twice: once to make it, once to check it.',
    /** Design §7.5, at setup, making the box passkey: verbatim. */
    words:
      'This passkey is for your Whombat only. Our website can’t use it to open your Whombat or its backups.',
    why: 'Why?',
    make: 'Make the passkey',
    making: 'Making the passkey…',
    unlock: 'Touch your passkey again to unlock your backups.',
    check: 'Touch your passkey once more to check it opens your backups.',
    skip: 'Later',
    done: 'Your passkey opens this Whombat and its backups.',
    madeNoBackups:
      'Your passkey opens this Whombat. Your backups use their paper copy: this passkey can’t unlock them.',
    saving: 'Your passkey is made. Your backups will use it once they’re set up.',
    noBackups:
      'Your passkey is made and opens this Whombat. Backups aren’t set up here yet, so there’s nothing for it to unlock.',
    notArmed:
      'Your passkey is made and opens this Whombat. It doesn’t unlock your backups yet: touch it again in Settings → Devices.',
    next: 'Continue',
  },
  /** Joining at the address with a box passkey (design §7.3). */
  join: {
    use: 'Sign in with this Whombat’s passkey',
    signingIn: 'Signing in…',
    or: 'or',
    failed: 'That passkey didn’t open this Whombat. Try another way in.',
    none: 'There’s no passkey for this Whombat on this device. Try another way in.',
  },
  /** Device links and screen sign-in at an A3 box (design §7.3). */
  onlyContinue: (address: string) =>
    `Only continue if you started this at ${address} or in your Whombat app.`,
  /** Settings → This Whombat → About. */
  settings: {
    section: 'ADDRESS',
    title: 'Your Whombat’s address',
    copy: 'Copy',
    copied: 'Copied.',
    reach: 'Reach my Whombat’s page from anywhere',
    reachMeta: 'Off: only your apps, your home network and Tailscale reach this Whombat.',
    ready: 'Works from anywhere',
    starting: 'Getting its certificate…',
    failing: 'Can’t get its certificate. Check that this Whombat is online.',
    failingRetry: (when: string) =>
      `Can’t get its certificate yet. It tries again by itself ${when}. Check that this Whombat is online.`,
    /** Let's Encrypt asked it to wait: nothing for the person to do. */
    busy: (when: string | null) =>
      `Many new Whombats are getting their addresses right now. Yours ${when ? `tries again by itself ${when}` : 'is trying again'}.`,
    off: 'Switched off',
    foreign: 'Someone got a certificate for this address that your Whombat didn’t ask for.',
    certificate: (date: string) => `Certificate ends ${date}.`,
    lastCheck: (when: string) => `Certificates last checked ${when}.`,
    notChecked: 'Certificates not checked yet.',
    missed: (from: string, to: string) => `Whombat couldn’t check certificates from ${from} to ${to}.`,
    failed: 'That didn’t work. Try again.',
    /** Devices → PASSKEYS on a box with its own address: its own passkeys. */
    passkeys: 'PASSKEYS',
    passkeyNone: 'Make a passkey for this Whombat',
    passkeyReady: 'Your passkey opens this Whombat',
    passkeyElsewhere: 'Make it at this Whombat’s address:',
    passkeyAdd: 'Add a passkey',
    passkeyAdding: 'Making the passkey…',
    passkeyNoWebAuthn: 'This browser can’t make passkeys.',
    link: 'Link to your Whombat account',
    linkMeta: 'With a code from app.whombat.com, so your phone reaches this Whombat from anywhere.',
    linkAction: 'Link',
    cancel: 'Cancel',
  },
  /** At app.whombat.com. */
  hosted: {
    linkEntry: 'Link a Whombat',
    linkTitle: 'Link a Whombat',
    linkSub: 'Type this code on your Whombat’s page, at the address on its screen.',
    making: 'Making a code…',
    left: (time: string) => `Works for ${time} more.`,
    over: 'This code ran out.',
    again: 'New code',
    done: 'Done',
    /** Design §7.5, at app.whombat.com, making the account passkey: verbatim. */
    accountPasskeyWords:
      'This passkey signs you in to your Whombat account and can bring your Whombat back on new hardware. It doesn’t open your Whombat, which has a passkey of its own.',
    accountPasskey: 'Make an account passkey',
    accountPasskeyMaking: 'Making the passkey…',
    accountPasskeyMade: 'Your account passkey is made.',
    accountPasskeyExists: 'This device already has a passkey for your account.',
    why: 'Why?',
    /** The list of Whombats for one set up at its own address. */
    addressElsewhere: 'Its address is in your Whombat app and on your Whombat’s screen.',
    errors: {
      terms: 'Accept the Whombat terms first.',
      rateLimited: 'Too many codes. Wait a few minutes, then try again.',
      failed: 'That didn’t work. Try again.',
    },
  },
} as const;

/** What the page says once the box's passkey is made, by what came of its backup key. */
export function boxPasskeyOutcome(made: { backups: string }): string {
  const t = OWN_ADDRESS_TEXT.passkey;
  switch (made.backups) {
    case 'verified':
      return t.done;
    case 'unsupported':
      return t.madeNoBackups;
    case 'no_backups':
      return t.noBackups;
    case 'not_armed':
      return t.notArmed;
    default:
      return t.saving;
  }
}
