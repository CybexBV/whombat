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
import { formatLocaleOf, interpolate } from '@whombat/core/i18n';
import { DEFAULT_PUBLIC_URL } from '@whombat/core/text';
import {
  OWN_ADDRESS_CLAIM_PATH,
  OwnAddressClaimSecret,
  OwnAddressHost,
  ownAddressLabelOf,
} from '@whombat/protocol';
import { DIRECT_PATH } from '@whombat/protocol/direct';
import { AccountLinkCode, type DirectRoute } from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { OWN_ADDRESS_WORDS } from '../i18n/messages/hostManaged/ownAddress';
import { OperationError, type OwnAddressSummary, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { operationReason, passkeyCopy, passkeyErrorOf } from './passkeys';

/** The own-address host this page is on (`<name>.whombat.app`, `<label>.box.whombat.app`, `<name>.dev.whombat.app`), or null. */
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

/**
 * The claim link's secret as typed on the page at the address: the six letters after `/c/` on the box's screen, or the
 * whole address pasted (upper case, spaces and anything around them don't matter). Null when it isn't one.
 */
export function claimSecretOfTyped(typed: string): string | null {
  const text = typed.trim().toLowerCase();
  const at = text.lastIndexOf(OWN_ADDRESS_CLAIM_PATH);
  const letters = (at < 0 ? text : text.slice(at + OWN_ADDRESS_CLAIM_PATH.length)).replace(/[^a-z]/g, '');
  return OwnAddressClaimSecret.safeParse(letters).success ? letters : null;
}

/** The name and email the account site already has, carried to the box's claim so the person needn't type them. */
export interface OwnClaimPrefill {
  name: string;
  email: string;
  /**
   * Opened from the account site's link page right after linking: the setup carries on that page's count (its first
   * step, Link your Whombat, is done).
   */
  fromLink?: boolean;
}

/** Longer than the box takes: anything past it isn't something the account site sent. */
const PREFILL_MAX = 320;

/**
 * The fragment that carries them (`#name=…&email=…`): a fragment never reaches a server, not the door's and not the
 * box's, and the box's page takes it out of the address as soon as it read it.
 */
export function ownClaimPrefillHash(prefill: Partial<OwnClaimPrefill>): string {
  const params = new URLSearchParams();
  const name = prefill.name?.trim();
  const email = prefill.email?.trim();
  if (name) params.set('name', name.slice(0, PREFILL_MAX));
  if (email) params.set('email', email.slice(0, PREFILL_MAX));
  if (prefill.fromLink && (name || email)) params.set('from', 'link');
  const text = params.toString();
  return text ? `#${text}` : '';
}

/** The name and email in a claim page's fragment, or null; only on the page's root and its claim link. */
export function readOwnClaimPrefill(loc: { pathname: string; hash: string }): OwnClaimPrefill | null {
  if (loc.pathname !== '/' && !claimSecretOfPath(loc.pathname)) return null;
  if (!loc.hash || loc.hash.length > PREFILL_MAX * 4) return null;
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const name = (params.get('name') ?? '').trim().slice(0, PREFILL_MAX);
  const email = (params.get('email') ?? '').trim().slice(0, PREFILL_MAX);
  if (!name && !email) return null;
  return params.get('from') === 'link' ? { name, email, fromLink: true } : { name, email };
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

/**
 * Whether `host` is an own-address host (the box's RP ID for its own passkeys). A zone itself (`box.whombat.app`,
 * `dev.whombat.app`) has a name's shape under `whombat.app` but is never a box's.
 */
export function isOwnAddressHost(host: string): boolean {
  return OwnAddressHost.safeParse(host).success && ownAddressLabelOf(host) !== null;
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
export function accountLinkErrorText(error: unknown, locale?: string | null): string {
  const t = ownAddressWords(locale).link.errors;
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

const day = (iso: string, locale?: string | null) =>
  new Date(iso).toLocaleDateString(formatLocaleOf(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const dayTime = (iso: string, locale?: string | null) =>
  new Date(iso).toLocaleString(formatLocaleOf(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** When the box tries for its certificate again: the time today, the day and the time later, null once it passed. */
function retryWhen(iso: string, now: number, locale?: string | null): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return null;
  const tag = formatLocaleOf(locale);
  const t = ownAddressWords(locale).settings;
  const time = new Date(at).toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });
  const sameDay = (ms: number) => new Date(ms).toLocaleDateString(tag);
  if (sameDay(at) === sameDay(now)) return t.retryAt(time);
  const date = new Date(at).toLocaleDateString(tag, { day: 'numeric', month: 'short' });
  return t.retryOn(date, time);
}

/** The state line while the box can't get its certificate: why, and when it tries again. */
function failingState(a: OwnAddressSummary, now: number, locale?: string | null) {
  const t = ownAddressWords(locale).settings;
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
  locale?: string | null,
): OwnAddressView {
  const t = ownAddressWords(locale).settings;
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

/**
 * The words of the setup at the address, joining there, Settings → This Whombat → About and app.whombat.com's link
 * codes, in the person's language. The passkey words follow design §7.5.
 */
export function ownAddressWords(locale?: string | null) {
  const w = clientTree(locale, OWN_ADDRESS_WORDS);
  const s = w.settings;
  return {
    /** An unclaimed box opened at its address without the claim link; its form takes the six letters after `/c/`. */
    openOnScreen: w.openOnScreen,
    steps: w.steps,
    stepLabel: (i: number, of: number) => interpolate(w.stepLabel, { n: i + 1, of }),
    claim: w.claim,
    account: w.account,
    link: {
      ...w.link,
      confirmTitle: (email: string) => interpolate(w.link.confirmTitle, { email }),
      linked: (email: string) => interpolate(w.link.linked, { email }),
    },
    // The passkey step asks twice on purpose: the second checks that the key the passkey gave when it was made is the
    // one it gives when it is used, so the backups really open with it later.
    passkey: w.passkey,
    /** Joining at the address with a box passkey (design §7.3). */
    join: w.join,
    /** Device links and screen sign-in at a box with its own address (design §7.3). */
    onlyContinue: (address: string) => interpolate(w.onlyContinue, { address }),
    /** Settings → This Whombat → About, and Devices → PASSKEYS on a box with its own address. */
    settings: {
      section: s.section,
      title: s.title,
      copy: s.copy,
      copied: s.copied,
      reach: s.reach,
      reachMeta: s.reachMeta,
      ready: s.ready,
      starting: s.starting,
      failing: s.failing,
      failingRetry: (when: string) => interpolate(s.failingRetry, { when }),
      /** Let's Encrypt asked it to wait: nothing for the person to do. */
      busy: (when: string | null) => (when ? interpolate(s.busyWhen, { when }) : s.busyNow),
      /** When it tries again: today at a time, or on a later day. */
      retryAt: (time: string) => interpolate(s.retryAt, { time }),
      retryOn: (date: string, time: string) => interpolate(s.retryOn, { date, time }),
      off: s.off,
      foreign: s.foreign,
      certificate: (date: string) => interpolate(s.certificate, { date }),
      lastCheck: (when: string) => interpolate(s.lastCheck, { when }),
      notChecked: s.notChecked,
      missed: (from: string, to: string) => interpolate(s.missed, { from, to }),
      failed: s.failed,
      passkeys: s.passkeys,
      passkeyNone: s.passkeyNone,
      passkeyReady: s.passkeyReady,
      passkeyElsewhere: s.passkeyElsewhere,
      passkeyAdd: s.passkeyAdd,
      passkeyAdding: s.passkeyAdding,
      passkeyNoWebAuthn: s.passkeyNoWebAuthn,
      link: s.link,
      linkMeta: s.linkMeta,
      linkAction: s.linkAction,
      cancel: s.cancel,
    },
    /** At app.whombat.com; `addressElsewhere` is the list of Whombats for one set up at its own address. */
    hosted: { ...w.hosted, left: (time: string) => interpolate(w.hosted.left, { time }) },
  } as const;
}

export type OwnAddressWords = ReturnType<typeof ownAddressWords>;

export const OWN_ADDRESS_TEXT: OwnAddressWords = ownAddressWords('en');

/**
 * What the setup's passkey step says when the passkey wasn't made; null for a dismissed prompt. Each says the way on,
 * because the setup goes on without it (Later) and the passkey can be made in Settings → Devices.
 */
export function boxPasskeySetupProblem(error: unknown, locale?: string | null): string | null {
  const t = ownAddressWords(locale).passkey;
  if (error instanceof OperationError && operationReason(error) === 'address_moved') return t.moved;
  const code = passkeyErrorOf(error);
  if (!code) return null;
  if (code === 'unsupported') return t.unsupported;
  // These say what happened and what to do already; the rest (“didn’t open your Whombat”, …) are about signing in.
  if (code === 'exists' || code === 'limit' || code === 'rate_limited' || code === 'unreachable')
    return passkeyCopy(locale).errors[code];
  return t.failed;
}

/** What the page says once the box's passkey is made, by what came of its backup key. */
export function boxPasskeyOutcome(made: { backups: string }, locale?: string | null): string {
  const t = ownAddressWords(locale).passkey;
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
