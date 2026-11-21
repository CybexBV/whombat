/**
 * The magic link (AP-20): control mails `<hosted UI>/auth/verify#token=…&next=…` — the token in the fragment, so
 * it never reaches a server log. The web reads it from its own address; the phone app receives the same URL
 * through its app link (or `whombat://auth/verify#token=…`). A token is exchanged exactly once.
 */
import { isSafeNext } from '@whombat/control-contracts';
import { type ControlApi, ControlError, type ControlSession } from './control';
import { COPY } from './copy';

export interface MagicLink {
  token: string;
  /** A path of this app to continue to (never another origin). */
  next: string;
}

/** The fragment of `/auth/verify` (`#token=…&next=…`); null for any other path or without a token. */
export function readVerifyFragment(loc: { pathname: string; hash: string }): MagicLink | null {
  if (loc.pathname.replace(/\/+$/, '') !== '/auth/verify') return null;
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const token = params.get('token');
  if (!token) return null;
  const next = params.get('next');
  // Only paths of this app (the contract's same-origin check, CT-48).
  return { token, next: next && isSafeNext(next) ? next : '/appliances' };
}

/**
 * A magic link as a URL string: `https://<ui>/auth/verify#token=…`, or the app's own `whombat://auth/verify#…`.
 * `uiOrigins` limits the https links accepted to the hosted UI's origins.
 */
export function parseMagicLinkUrl(url: string, uiOrigins: readonly string[]): MagicLink | null {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const custom = /^whombat:\/\/(\/?auth\/verify)\/?(\?.*)?$/.exec(beforeHash);
  if (custom) return readVerifyFragment({ pathname: '/auth/verify', hash });
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?/.exec(beforeHash);
  if (!m?.[1]) return null;
  const origin = m[1].toLowerCase();
  if (!uiOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === origin)) return null;
  return readVerifyFragment({ pathname: m[2] ?? '/', hash });
}

/**
 * Why asking for a sign-in link failed, in words: control refusing it (a malformed address, the per-email or
 * per-network limit) is never worded as “couldn’t reach” (AP-34; rc 0.5.2 device run).
 */
export function signInErrorText(error: unknown): string {
  if (!(error instanceof ControlError)) return COPY.signIn.unreachable;
  if (error.code === 'rate_limited') return COPY.signIn.tooMany;
  if (error.code === 'invalid_link') return COPY.signIn.badEmail;
  if (error.code === 'unavailable') return COPY.signIn.unreachable;
  return COPY.signIn.failed;
}

const verifications = new Map<string, Promise<ControlSession>>();

/** Exchanges a magic-link token once; a second caller gets the same answer. */
export function verifyOnce(env: { control: Pick<ControlApi, 'verifySignIn'> }, token: string) {
  let p = verifications.get(token);
  if (!p) {
    p = env.control.verifySignIn(token);
    verifications.set(token, p);
  }
  return p;
}
