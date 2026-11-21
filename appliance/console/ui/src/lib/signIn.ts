/**
 * A device waiting to sign in at this screen (Whombat BX-06; CG-150…): the six letters the person types on that device,
 * whose account it asks for and the device's label, until `expiresAt`. The console server checked and cleaned it
 * (`screen.Parse`, CG-151); the page still reads it as it reads everything (`parseState`): what doesn't fit is none.
 * Pure: the clocks come in as values.
 */
import type { ClaimState } from './api';

export interface SignIn {
  /** Six letters of the claim alphabet, as typed (`KXQMTR`); shown grouped, `KXQ MTR`. */
  code: string;
  /** The account's name, else its email. */
  name: string;
  /** The new device's label, as it asked. */
  device: string;
  /** When the code goes away (RFC 3339, Whombat's clock). */
  expiresAt: string;
}

/** The contracts' `ScreenSignInLetters`: six of CLAIM_CODE_ALPHABET (BX-04). */
export const SIGN_IN_LETTERS_RE = /^[ABCDEFGHJKMNPQRTVWXY]{6}$/;
/** `ConsoleDisplayText`'s length (CT-116), in code points. */
export const SIGN_IN_TEXT_MAX = 64;
/** The console server's bound (`screen.MaxSignInAhead`): a sign-in that claims to last longer isn't shown. */
export const SIGN_IN_AHEAD_MAX_MS = 15 * 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line of display text, at most 64 code points; "" when nothing is left. */
function text(v: unknown): string {
  if (typeof v !== 'string') return '';
  const one = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return [...one].slice(0, SIGN_IN_TEXT_MAX).join('').trim();
}

/** The server's `claim.signIn`, or null when it isn't one (no panel: it must say whose device it is). */
export function parseSignIn(v: unknown): SignIn | null {
  if (!isObj(v) || typeof v.code !== 'string' || !SIGN_IN_LETTERS_RE.test(v.code)) return null;
  const name = text(v.name);
  const device = text(v.device);
  const expiresAt = typeof v.expiresAt === 'string' ? v.expiresAt : '';
  if (!name || !device || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { code: v.code, name, device, expiresAt };
}

/**
 * The sign-in the screen shows at `serverNow` (Whombat's clock: the page's plus the polls' offset): only on a claimed
 * box, and only until its time is up, between polls and while the server is away too.
 */
export function liveSignIn(claim: ClaimState | null, serverNow: number): SignIn | null {
  const s = claim?.state === 'claimed' ? claim.signIn : null;
  if (!s) return null;
  const left = Date.parse(s.expiresAt) - serverNow;
  return left > 0 && left <= SIGN_IN_AHEAD_MAX_MS ? s : null;
}

/** `KXQMTR` → `KXQ MTR` (the contracts' `formatScreenSignInLetters`; the space isn't typed). */
export function groupLetters(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The title's size (layout px): large, smaller for a long name, which then wraps. */
export function signInTitleSize(name: string): number {
  const n = [...name].length;
  if (n <= 16) return 40;
  if (n <= 32) return 34;
  return 28;
}
