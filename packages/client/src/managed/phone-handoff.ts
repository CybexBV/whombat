/**
 * Signing a phone in by QR code (CT-190, AP-520): the signed-in browser asks control for a handoff and shows
 * `<hosted UI>/auth/phone#t=<token>&k=<key>&d=<device>&p=<PeerId>` as a QR code. The phone redeems the token for its own
 * cloud session, pins the Whombat the code names (like an add-a-device link, AP-66), asks it to pair and reports the
 * pairing code back through control. The report carries an HMAC under `k`, a key that exists only in the QR code and
 * in the browser that made it, so control (which relays the report) can't swap in another device's code. The browser
 * then looks the code up on the Whombat, checks the fingerprint and lets the phone in after its person confirms.
 *
 * Everything secret is in the fragment, so it never reaches a server log.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { uiLinkParts } from './links';
import { isPeerId } from './pin';

export const PHONE_SIGNIN_PATH = '/auth/phone';

/** How often the browser asks control how the handoff is going. */
export const PHONE_HANDOFF_POLL_MS = 1500;

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const MAC_TAG = 'whombat-phone-handoff/1';

export interface PhoneSignInLink {
  /** The handoff's one-time token (`auth.redeemPhoneHandoff`). */
  token: string;
  /** 32 random bytes, base64url: the key of the report's MAC. */
  key: string;
  /** The Whombat to let the phone in to and its identity; null when the browser had none open. */
  appliance: { device: string; peerId: string } | null;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding. */
function base64url(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET.charAt((value >> bits) & 63);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (6 - bits)) & 63);
  return out;
}

function base64urlDecode(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('not base64url');
    value = ((value << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** A fresh key for one QR code (the platform's CSPRNG; the phone app polyfills `crypto.getRandomValues`). */
export function newPhoneHandoffKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** What the browser shows as the QR code. `appliance` names the open Whombat (the browser's pin, never the directory). */
export function phoneSignInLink(
  uiOrigin: string,
  input: { token: string; key: string; appliance: { device: string; peerId: string } | null },
): string {
  const params = new URLSearchParams({ t: input.token, k: input.key });
  if (input.appliance) {
    params.set('d', input.appliance.device);
    params.set('p', input.appliance.peerId);
  }
  return `${uiOrigin.replace(/\/+$/, '')}${PHONE_SIGNIN_PATH}#${params.toString()}`;
}

/**
 * A phone sign-in link, from the hosted UI (one of `uiOrigins`) or the app's own `whombat://auth/phone#…`; null for
 * anything else, a malformed token or key, or a Whombat without a valid identity.
 */
export function parsePhoneSignInLink(text: string, uiOrigins: readonly string[]): PhoneSignInLink | null {
  const parts = uiLinkParts(text, uiOrigins);
  if (!parts || parts.path.replace(/\/+$/, '') !== PHONE_SIGNIN_PATH) return null;
  const token = parts.fragment.get('t');
  const key = parts.fragment.get('k');
  if (!token || !TOKEN.test(token) || !key || !KEY.test(key)) return null;
  const device = parts.fragment.get('d');
  const peerId = parts.fragment.get('p');
  if (device === null && peerId === null) return { token, key, appliance: null };
  if (!device || device.length > 128 || !isPeerId(peerId)) return null;
  return { token, key, appliance: { device, peerId } };
}

function macBytes(key: string, handoffId: string, code: string, fingerprint: string): Uint8Array {
  const message = new TextEncoder().encode(`${MAC_TAG}\n${handoffId}\n${code}\n${fingerprint}`);
  return hmac(sha256, base64urlDecode(key), message);
}

/** The phone's MAC over its pairing report (`PhoneHandoffReport.mac`, 43 characters). */
export function phoneHandoffMac(key: string, handoffId: string, code: string, fingerprint: string): string {
  return base64url(macBytes(key, handoffId, code, fingerprint));
}

/** The browser's check of a pairing report (constant time); false for anything malformed. */
export function verifyPhoneHandoffReport(
  key: string,
  handoffId: string,
  report: { code: string; fingerprint: string; mac: string },
): boolean {
  let got: Uint8Array;
  try {
    got = base64urlDecode(report.mac);
  } catch {
    return false;
  }
  const want = macBytes(key, handoffId, report.code, report.fingerprint);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= (got[i] ?? 0) ^ (want[i] ?? 0);
  return diff === 0;
}
