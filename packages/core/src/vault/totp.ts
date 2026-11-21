/**
 * A website login's authenticator key (Whombat vault-simplify.md): what the person pastes — the setup key a site
 * shows under its QR code (base32, often in groups) or the QR code's `otpauth://totp/…` link — read into the
 * parameters RFC 6238 needs, and the one form the Vault seals (`vaultTotpCanonical`). The runner's logins service makes
 * the current code from it with the HMAC its platform has (`vaultTotpCounterBytes`, then `vaultTotpTruncate`). Pure:
 * no `URL`, `Buffer` or crypto.
 */
import { z } from 'zod';

/** The longest authenticator key or `otpauth://` link the Vault takes. */
export const VAULT_TOTP_INPUT_MAX = 2048;
/** The shortest key: 80 bits (16 base32 characters), what RFC 4226 allows at least. */
export const VAULT_TOTP_SECRET_MIN_BITS = 80;
/** The longest key: 512 bits (103 base32 characters), a SHA-512 block's worth. */
export const VAULT_TOTP_SECRET_MAX_BITS = 512;

export const VAULT_TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;
export type VaultTotpAlgorithm = (typeof VAULT_TOTP_ALGORITHMS)[number];

/** What RFC 6238 needs, with the defaults a link leaves out (SHA-1, 6 digits, 30 seconds). */
export interface VaultTotp {
  /** The key in base32, upper case, without spaces or padding. */
  secret: string;
  algorithm: VaultTotpAlgorithm;
  digits: 6 | 7 | 8;
  /** Seconds a code lasts. */
  period: number;
}

export const VAULT_TOTP_DEFAULTS = Object.freeze({ algorithm: 'SHA1', digits: 6, period: 30 } as const);
/** The periods a link may set, in seconds. */
export const VAULT_TOTP_PERIOD_MIN = 10;
export const VAULT_TOTP_PERIOD_MAX = 300;

/** Why an authenticator key can't be used (shown on the field). */
export const VAULT_TOTP_PROBLEM_TEXT = {
  empty: 'Paste the setup key or the otpauth:// link.',
  notTotp: 'That link is for counter codes. Whombat uses time-based ones: look for another setup key.',
  link: 'That otpauth:// link can’t be read. Paste the setup key instead.',
  key: 'That isn’t a setup key. It has letters A to Z and digits 2 to 7.',
  short: 'That setup key is too short.',
  long: 'That setup key is too long.',
  algorithm: 'That link uses a code type Whombat doesn’t know.',
  digits: 'That link asks for codes of an unusual length.',
  period: 'That link asks for codes that change too fast or too slowly.',
} as const;

export type VaultTotpProblem = keyof typeof VAULT_TOTP_PROBLEM_TEXT;

export type VaultTotpParse =
  | { ok: true; totp: VaultTotp }
  | { ok: false; problem: VaultTotpProblem; message: string };

const fail = (problem: VaultTotpProblem): VaultTotpParse => ({
  ok: false,
  problem,
  message: VAULT_TOTP_PROBLEM_TEXT[problem],
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A setup key as sites show it (`jbsw y3dp ehpk 3pxp`, dashes, `=` padding) in canonical base32, or why not. */
function normalizeKey(text: string): { ok: true; secret: string } | { ok: false; problem: VaultTotpProblem } {
  const secret = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!secret) return { ok: false, problem: 'empty' };
  if (![...secret].every((c) => BASE32.includes(c))) return { ok: false, problem: 'key' };
  const bits = secret.length * 5;
  if (bits < VAULT_TOTP_SECRET_MIN_BITS) return { ok: false, problem: 'short' };
  if (bits > VAULT_TOTP_SECRET_MAX_BITS + 7) return { ok: false, problem: 'long' };
  return { ok: true, secret };
}

/** The key's bytes (RFC 4648 base32; trailing bits that make no whole byte are dropped). */
export function vaultBase32Decode(secret: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of secret.toUpperCase()) {
    const v = BASE32.indexOf(c);
    if (v < 0) continue;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** A query parameter's value, percent-decoded (null when it can't be). */
function decodePart(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** `otpauth://totp/Label?secret=…&algorithm=…&digits=…&period=…` (Google Authenticator's key URI format). */
function parseLink(text: string): VaultTotpParse {
  const match = /^otpauth:\/\/([^/?#]*)\/?([^?#]*)(?:\?([^#]*))?/i.exec(text);
  if (!match) return fail('link');
  const type = (match[1] ?? '').toLowerCase();
  if (type === 'hotp') return fail('notTotp');
  if (type !== 'totp') return fail('link');
  const params = new Map<string, string>();
  for (const part of (match[3] ?? '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = decodePart(eq < 0 ? part : part.slice(0, eq));
    const value = decodePart(eq < 0 ? '' : part.slice(eq + 1));
    if (name === null || value === null) return fail('link');
    // The first of a repeated parameter counts, as authenticator apps read it.
    if (!params.has(name.toLowerCase())) params.set(name.toLowerCase(), value);
  }
  const key = normalizeKey(params.get('secret') ?? '');
  if (!key.ok) return fail(key.problem === 'empty' ? 'link' : key.problem);
  const algorithm = (params.get('algorithm') ?? VAULT_TOTP_DEFAULTS.algorithm).toUpperCase().replace('-', '');
  if (!(VAULT_TOTP_ALGORITHMS as readonly string[]).includes(algorithm)) return fail('algorithm');
  const digitsText = params.get('digits') ?? String(VAULT_TOTP_DEFAULTS.digits);
  const digits = /^[0-9]{1,2}$/.test(digitsText) ? Number(digitsText) : Number.NaN;
  if (digits !== 6 && digits !== 7 && digits !== 8) return fail('digits');
  const periodText = params.get('period') ?? String(VAULT_TOTP_DEFAULTS.period);
  const period = /^[0-9]{1,4}$/.test(periodText) ? Number(periodText) : Number.NaN;
  if (!(period >= VAULT_TOTP_PERIOD_MIN && period <= VAULT_TOTP_PERIOD_MAX)) return fail('period');
  return {
    ok: true,
    totp: { secret: key.secret, algorithm: algorithm as VaultTotpAlgorithm, digits, period },
  };
}

/**
 * Reads an authenticator key as the person pasted it: an `otpauth://totp/…` link (its algorithm, digits and period,
 * else SHA-1, 6 and 30 s) or a bare base32 setup key (the defaults). Refuses counter-based (`hotp`) links, keys
 * shorter than 80 bits and anything else, with the words the field shows.
 */
export function parseVaultTotp(text: string): VaultTotpParse {
  const raw = text.trim();
  if (!raw) return fail('empty');
  if (raw.length > VAULT_TOTP_INPUT_MAX) return fail('long');
  if (/^otpauth:/i.test(raw)) return parseLink(raw);
  const key = normalizeKey(raw);
  if (!key.ok) return fail(key.problem);
  return { ok: true, totp: { secret: key.secret, ...VAULT_TOTP_DEFAULTS } };
}

/** Why an authenticator key can't be used, or null. */
export function vaultTotpProblem(text: string): string | null {
  const parsed = parseVaultTotp(text);
  return parsed.ok ? null : parsed.message;
}

/**
 * The one form the Vault seals and the runner reads back: `otpauth://totp/Whombat?secret=…&algorithm=…&digits=…&period=…`.
 * No issuer or account: they say nothing the entry doesn't, and the site's own label isn't kept.
 */
export function vaultTotpCanonical(totp: VaultTotp): string {
  return `otpauth://totp/Whombat?secret=${totp.secret}&algorithm=${totp.algorithm}&digits=${totp.digits}&period=${totp.period}`;
}

/** The time step a code is for (RFC 6238: Unix seconds over the period, rounded down). */
export function vaultTotpCounter(nowMs: number, period: number): number {
  return Math.floor(Math.floor(nowMs / 1000) / period);
}

/** The counter as the 8 big-endian bytes the HMAC signs. */
export function vaultTotpCounterBytes(counter: number): Uint8Array {
  const out = new Uint8Array(8);
  let rest = counter;
  for (let i = 7; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** RFC 4226's dynamic truncation of the HMAC to a code of `digits` digits, zero-padded. */
export function vaultTotpTruncate(hmac: Uint8Array, digits: number): string {
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binary =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * An authenticator key as a body takes it (`vault.create`'s and `vault.setTotp`'s `totp`): the setup key or the
 * `otpauth://totp/…` link, checked by `parseVaultTotp`. The server seals `vaultTotpCanonical` of it.
 */
export const VaultTotpInput = z
  .string()
  .trim()
  .min(1, VAULT_TOTP_PROBLEM_TEXT.empty)
  .max(VAULT_TOTP_INPUT_MAX)
  .superRefine((text, ctx) => {
    const problem = vaultTotpProblem(text);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
