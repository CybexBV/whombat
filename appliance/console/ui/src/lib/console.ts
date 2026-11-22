/** The console's logic (CG-06…CG-09): which scene a state shows, the backoff countdown, the burrow count. */
import type { ClaimState, ClaimStateName, ConsoleState, ReachLink, StartProblem } from './api';
import { WORD } from './copy';

export type ConsoleScene = ClaimStateName;

/** A claim code the sign can show: four letters today (CC-01); anything short and plain is drawn as sent. */
const codeRe = /^[A-Z0-9-]{1,12}$/;

/**
 * Whether the box has no address a person can open: the server sends no claim or app URL then, as plain HTTP on the
 * network serves no page (Whombat LNK-55).
 */
export function noAddress(c: ClaimState): boolean {
  return c.claimUrl === '';
}

/**
 * Whether the claim screen has nowhere to type the code: no address to open and none for the app on this network
 * (`inApp`). It says how to get an address instead of showing a code.
 */
export function nowhereToType(c: ClaimState): boolean {
  return noAddress(c) && !c.inApp;
}

/**
 * The claim screen's line without an address to open: what Tailscale still needs when it asks for something (the note
 * above says how), else either way to get an address. The text console's `claimNoAddress`.
 */
export function noAddressLine(s: ConsoleState): 'claimAfterTailscale' | 'claimAfterHttps' | 'claimNoAddress' {
  const t = s.reach?.tailscale;
  if (t?.loginUrl) return 'claimAfterTailscale';
  if (t?.needsHttps) return 'claimAfterHttps';
  return 'claimNoAddress';
}

/**
 * The scene for a console state. A state that doesn't make sense (no claim, a claimable state without a code where
 * there is an address to type it at) shows the calmer neighbour instead of something broken or empty.
 */
export function consoleScene(s: ConsoleState): ConsoleScene {
  const c = s.claim;
  if (!c) return 'starting';
  if (c.state === 'claimable' && !nowhereToType(c) && !codeRe.test(c.code)) return 'waiting';
  // A network with IPv6 only left the box without an address to name: the claim screen without an address says what
  // to do, where “check the network cable” would send the person the wrong way.
  if (c.state === 'waiting' && c.ipv6Only && nowhereToType(c)) return 'claimable';
  return c.state;
}

/**
 * Whole minutes the letters on the screen still stay (they were asked for here), or null when they change after a
 * wrong try: the text console's `LettersStay`.
 */
export function lettersStayMinutes(c: ClaimState, now: number): number | null {
  if (c.state !== 'claimable' || !c.lettersUntil) return null;
  const until = Date.parse(c.lettersUntil);
  if (!Number.isFinite(until) || until <= now) return null;
  // The page's idea of the box's time is up to two seconds behind (a state a second old, whole seconds): without
  // this, letters that stay ten minutes would start at “11 min”.
  return Math.max(Math.ceil((until - now - CLOCK_SLACK_MS) / 60_000), 1);
}

/** How far behind the box's own clock the page's reading of it can be. */
const CLOCK_SLACK_MS = 2000;

/** Whether a key press asks for new letters: the N key by itself, as on the text console. */
export function asksNewLetters(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'>,
): boolean {
  return !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && (e.key === 'n' || e.key === 'N');
}

/** Server clock minus page clock, in ms (0 when the server's time can't be read). */
export function clockOffset(serverNow: string, localNow: number): number {
  const t = Date.parse(serverNow);
  return Number.isFinite(t) ? t - localNow : 0;
}

/** Whole minutes until retryAt, rounded up, at least 1: the text console's `MinutesLeft`. */
export function minutesLeft(retryAt: string | null, now: number): number {
  const t = retryAt ? Date.parse(retryAt) : Number.NaN;
  if (!Number.isFinite(t)) return 1;
  return Math.max(Math.ceil((t - now) / 60_000), 1);
}

/** The countdown on the sign, `m:ss`, rounded up to the next second, never negative. */
export function countdown(retryAt: string | null, now: number): string {
  const t = retryAt ? Date.parse(retryAt) : Number.NaN;
  const s = Number.isFinite(t) ? Math.max(Math.ceil((t - now) / 1000), 0) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** “+ 1 more burrow”, “+ 3 more burrows”; nothing for none. */
export function moreBurrows(more: number): string | null {
  if (!Number.isFinite(more) || more < 1) return null;
  return more === 1 ? '+ 1 more burrow' : `+ ${Math.floor(more)} more burrows`;
}

/** True when the claim turned `claimed` while the page was watching (not on the first state it saw). */
export function justClaimed(prev: ConsoleScene | null, next: ConsoleScene): boolean {
  return next === 'claimed' && prev !== null && prev !== 'claimed';
}

/** The burrow name's size on the claimed screen (layout px): big, smaller for long names, then ellipsized. */
export function burrowNameSize(name: string): number {
  const n = [...name].length;
  if (n <= 14) return 88;
  if (n <= 20) return 72;
  if (n <= 28) return 58;
  return 48;
}

/** The sign's letter size for a code of `len` characters (four letters: huge; longer codes shrink to fit). */
export function codeSize(len: number): number {
  if (len <= 4) return 176;
  if (len <= 6) return 128;
  return Math.max(56, Math.floor(700 / len));
}

/** The Link screen in place of the claim's (CG-402, CG-404): the code, waiting for an address, or starting. */
export type LinkScreen = 'code' | 'waiting' | 'starting';

/** The Link code the screen shows at `now` (server clock): none once it has expired, until the next poll. */
export function liveLinkCode(l: ReachLink, now: number): string {
  if (!l.code) return '';
  const t = l.expiresAt ? Date.parse(l.expiresAt) : Number.NaN;
  return Number.isFinite(t) && now >= t ? '' : l.code;
}

/**
 * Whether Link takes the claim's place, the text console's rule (screen.LinkShown): starting, on a claimed box only
 * while there is a code to type; or on while an unclaimed box waits for its web address (the server sends `on` only
 * then). The server sends a code only while it is live, so this needs no clock: the desk steps aside for it as it
 * does for a claim code (deskActive).
 */
export function linkShown(s: ConsoleState): boolean {
  const l = s.reach?.link;
  if (l?.state === 'on') return l.waitingForAddress && s.claim?.state === 'claimable';
  return l?.state === 'starting' && (s.claim?.state !== 'claimed' || l.code !== '');
}

/**
 * The claim in the Whombat app on this network while the screen waits for the web address (screen.WaitingInApp): its
 * address and the letters to enter there, or null when there is none.
 */
export function waitingInApp(s: ConsoleState): { address: string; letters: string } | null {
  const c = s.claim;
  if (!s.reach?.link?.waitingForAddress || c?.state !== 'claimable' || !c.inApp || !codeRe.test(c.code))
    return null;
  return { address: c.inApp, letters: c.code };
}

/**
 * Whether the footer (the console and recovery note) shows, the text console's rule (screen.FooterShown): not while the
 * person sets the box up (the claim, or Link's code and its wait on a box nobody claimed), where it is words they don't
 * need yet; under every other screen.
 */
export function footerShown(s: ConsoleState, link: LinkScreen | null): boolean {
  const scene = consoleScene(s);
  if (scene === 'claimed') return true;
  return scene !== 'claimable' && scene !== 'backoff' && link === null;
}

/** The Link screen at `now` (server clock), or null for the claim's own screen. */
export function linkScreen(s: ConsoleState, now: number): LinkScreen | null {
  const l = s.reach?.link;
  if (!l || !linkShown(s)) return null;
  const code = liveLinkCode(l, now);
  if (s.claim?.state === 'claimed' && !code) return null;
  if (l.waitingForAddress) return 'waiting';
  return code ? 'code' : 'starting';
}

/** A note above every claim screen, in the text console's order: what Tailscale needs, then Link's grace or end. */
/** Tailscale's note is numbered (`first`: “1 · ”) when the claim under it is the second step. */
export type ReachNote =
  | { kind: 'tailscaleLogin'; url: string; qr: string[]; first: boolean }
  | { kind: 'tailscaleHttps'; first: boolean }
  | { kind: 'linkGrace'; day: string }
  | { kind: 'linkEnded' };

export function reachNotes(s: ConsoleState): ReachNote[] {
  const out: ReachNote[] = [];
  const t = s.reach?.tailscale;
  // Only Tailscale's first note carries the number: the claim is the second step.
  if (t?.loginUrl) out.push({ kind: 'tailscaleLogin', url: t.loginUrl, qr: t.loginQr, first: t.first });
  if (t?.needsHttps) out.push({ kind: 'tailscaleHttps', first: t.first && !t.loginUrl });
  const l = s.reach?.link;
  if (l?.state === 'grace' && l.graceEndsOn) out.push({ kind: 'linkGrace', day: l.graceEndsOn });
  else if (l?.state === 'ended') out.push({ kind: 'linkEnded' });
  return out;
}

/** What the starting screen says about a start problem, after its title (the text console's `StartWords`, CG-409). */
export function startWords(start: StartProblem): string {
  switch (start.problem) {
    case 'release-missing':
      return start.release ? WORD.startReleaseMissing(start.release) : WORD.startReleaseMissingNoId;
    case 'offline':
      return WORD.startOffline;
    default:
      return WORD.startFailed;
  }
}
