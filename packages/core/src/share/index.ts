/**
 * Shared links (docs/decisions/share-links.md): a copy of part of a Chat thread that anyone with the link can read.
 *
 * The box builds a `SharedSnapshot`, seals it with a fresh random key (`sealSnapshot`) and hands control only the
 * sealed bytes. The key travels in the link's fragment (`https://<app>/s/<id>#<key>`), which browsers never send to a
 * server, so control and the relay can't read what was shared. The viewer page fetches the sealed bytes from control and
 * opens them in the browser (`openSnapshot`). Pure (web, phone, box and control).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { utf8Decode } from '../backup/bytes.js';
import { fromBase64url, toBase64url } from '../backup/kit-envelope.js';

/** A share's id: `shr_` + 22 base64url characters (16 random bytes), chosen by the box. */
export const SHARE_ID_RE = /^shr_[A-Za-z0-9_-]{22}$/;
export const ShareId = z.string().regex(SHARE_ID_RE);
export type ShareId = z.infer<typeof ShareId>;

/** A share's key: 32 random bytes, 43 base64url characters in the link's fragment. */
export const SHARE_KEY_BYTES = 32;
export const SHARE_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** The largest sealed snapshot control keeps (pictures are inside it). */
export const SHARE_MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
/** The most messages and pictures one snapshot holds. */
export const SHARE_MAX_MESSAGES = 400;
export const SHARE_MAX_PICTURES = 24;
/** One message's text. */
export const SHARE_MAX_TEXT_CHARS = 60_000;
/** One chart or page's HTML (a visual reply), drawn in the viewer's sandboxed frame. */
export const SHARE_MAX_PAGE_CHARS = 400_000;

/** How long a link works. A week unless the person picks otherwise. */
export const SHARE_EXPIRIES = ['1d', '7d', '30d', 'never'] as const;
export const ShareExpiry = z.enum(SHARE_EXPIRIES);
export type ShareExpiry = z.infer<typeof ShareExpiry>;
export const SHARE_DEFAULT_EXPIRY: ShareExpiry = '7d';
const EXPIRY_S: Record<ShareExpiry, number | null> = {
  '1d': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  never: null,
};
/** When a link made at `nowS` (epoch seconds) stops working; null: never. */
export function shareExpiresAt(expiry: ShareExpiry, nowS: number): number | null {
  const s = EXPIRY_S[expiry];
  return s === null ? null : nowS + s;
}

/** The viewer page's path on the hosted app; the key follows `#`. */
export const SHARE_VIEWER_PATH_RE = /^\/s\/(shr_[A-Za-z0-9_-]{22})\/?$/;
/** The public read of a sealed snapshot at control (no sign-in): the bytes, or 404 once the link stopped. */
export const sharePublicPath = (id: string) => `/v1/shares/${id}`;

/** The link people get: control's viewer URL for the share (no fragment) and the key. */
export function shareLink(viewerUrl: string, key: Uint8Array): string {
  return `${viewerUrl.replace(/#.*$/, '')}#${toBase64url(key)}`;
}

/** The share id and key of a viewer page's location; null when either is missing or malformed. */
export function parseShareLocation(pathname: string, hash: string): { id: string; key: Uint8Array } | null {
  const id = SHARE_VIEWER_PATH_RE.exec(pathname)?.[1];
  const keyText = hash.replace(/^#/, '');
  if (!id || !SHARE_KEY_RE.test(keyText)) return null;
  const key = fromBase64url(keyText);
  return key && key.length === SHARE_KEY_BYTES ? { id, key } : null;
}

const Text = (max: number) => z.string().max(max);
const EpochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A picture in a snapshot, its bytes inline. Only raster images a browser draws by itself. */
export const SharedPicture = z.strictObject({
  id: z.string().regex(/^p[0-9]{1,3}$/),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  /** base64url bytes. */
  data: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: Text(200).optional(),
});
export type SharedPicture = z.infer<typeof SharedPicture>;

/** A chart or small page the assistant drew in its reply, drawn in the viewer's sandboxed frame. */
export const SharedPage = z.strictObject({
  title: Text(200).optional(),
  html: Text(SHARE_MAX_PAGE_CHARS),
});
export type SharedPage = z.infer<typeof SharedPage>;

/** One message as the reader sees it: who said it, when, its words (Markdown) and what it showed. */
export const SharedMessage = z.strictObject({
  from: z.enum(['person', 'assistant']),
  at: EpochMs,
  text: Text(SHARE_MAX_TEXT_CHARS),
  pictures: z
    .array(z.string().regex(/^p[0-9]{1,3}$/))
    .max(SHARE_MAX_PICTURES)
    .optional(),
  pages: z.array(SharedPage).max(8).optional(),
});
export type SharedMessage = z.infer<typeof SharedMessage>;

/**
 * What a link shows. Only words, pictures the person chose and the assistant's charts: never commands and their output,
 * folded details, approvals, files or anything else a message carries.
 */
export const SharedSnapshot = z.strictObject({
  v: z.literal(1),
  /** The thread's title; it is inside the sealed copy only (link previews say nothing about it). */
  title: Text(200),
  sharedAt: EpochMs,
  /** The names readers see: the person's first name and the assistant's name and face. */
  person: z.strictObject({ name: Text(80) }),
  assistant: z.strictObject({ name: Text(80), face: Text(40).optional() }),
  messages: z.array(SharedMessage).min(1).max(SHARE_MAX_MESSAGES),
  pictures: z.array(SharedPicture).max(SHARE_MAX_PICTURES),
});
export type SharedSnapshot = z.infer<typeof SharedSnapshot>;

/** Sealed snapshots start with these four bytes (`WBS1`), then a 24-byte nonce and the ciphertext. */
const MAGIC = utf8ToBytes('WBS1');
const NONCE_BYTES = 24;

/** A new share id and key. */
export function newShare(): { id: string; key: Uint8Array } {
  return { id: `shr_${toBase64url(randomBytes(16))}`, key: randomBytes(SHARE_KEY_BYTES) };
}

/**
 * The sealed bytes control keeps: XChaCha20-Poly1305 under the share's key, the share id as associated data so a
 * copy put under another id doesn't open.
 */
export function sealSnapshot(snapshot: SharedSnapshot, id: string, key: Uint8Array): Uint8Array {
  if (key.length !== SHARE_KEY_BYTES) throw new Error('share.key_length');
  const plain = utf8ToBytes(JSON.stringify(SharedSnapshot.parse(snapshot)));
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce, utf8ToBytes(id)).encrypt(plain);
  return concatBytes(MAGIC, nonce, sealed);
}

/** The snapshot in sealed bytes; null when they aren't a snapshot of this id under this key. */
export function openSnapshot(bytes: Uint8Array, id: string, key: Uint8Array): SharedSnapshot | null {
  if (bytes.length < MAGIC.length + NONCE_BYTES + 16 || key.length !== SHARE_KEY_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null;
  const nonce = bytes.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  try {
    const plain = xchacha20poly1305(key, nonce, utf8ToBytes(id)).decrypt(
      bytes.subarray(MAGIC.length + NONCE_BYTES),
    );
    const text = utf8Decode(plain);
    if (text === null) return null;
    const parsed = SharedSnapshot.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export { fromBase64url as shareFromBase64url, toBase64url as shareToBase64url };
