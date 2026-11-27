/**
 * A person's photo before `me.setAvatar` (contracts CT-265, docs/decisions/person-avatars.md PA-02): the picked image
 * cropped to its centre square, scaled to `AVATAR_PIXELS` and encoded, stepping quality (then size) down until it fits
 * `AVATAR_MAX_BYTES`. The decoding and encoding are the platform's (a canvas on the web, expo-image-manipulator on the
 * phone); what to try, in which order, and what to say is here, shared and tested.
 */
import { AVATAR_MAX_BYTES, AVATAR_MIN_PIXELS, AVATAR_PIXELS } from '@whombat/core';
import { ApiError } from './http/errors';
import { clientTree } from './i18n/catalog';
import { SETTINGS_AREA_WORDS } from './i18n/messages/chatWork/settings';

const settings = (locale?: string | null) => clientTree(locale, SETTINGS_AREA_WORDS);

/** What Settings says about a photo, on the web and the phone, in a locale (English when none). */
export function avatarCopy(locale?: string | null) {
  return settings(locale).avatar;
}

export const AVATAR_COPY = avatarCopy();

export type AvatarImageProblem = 'unreadable' | 'too_small' | 'too_large';

/** The picked image can't become a photo (the message says why). */
export class AvatarImageError extends Error {
  constructor(readonly problem: AvatarImageProblem) {
    super(
      problem === 'too_small'
        ? AVATAR_COPY.tooSmall
        : problem === 'too_large'
          ? AVATAR_COPY.tooLarge
          : AVATAR_COPY.unreadable,
    );
    this.name = 'AvatarImageError';
  }
}

/** The part of the image that becomes the photo: the largest centred square, in source pixels. */
export interface AvatarSquare {
  x: number;
  y: number;
  side: number;
}

/** The centre square of a `width` × `height` image; too small (under `AVATAR_MIN_PIXELS`) or empty: an error. */
export function avatarSquare(width: number, height: number): AvatarSquare {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new AvatarImageError('unreadable');
  const side = Math.floor(Math.min(width, height));
  if (side < AVATAR_MIN_PIXELS) throw new AvatarImageError('too_small');
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** One encoding to try: the square's side in pixels and the JPEG/WebP quality (0…1). */
export interface AvatarAttempt {
  side: number;
  quality: number;
}

/**
 * The encodings tried, in order: `AVATAR_PIXELS` at falling quality, then smaller squares (never under
 * `AVATAR_MIN_PIXELS`). A 256px photo is ~10–20 KB at 0.85, so the first nearly always fits; the rest are for noisy
 * pictures.
 */
export const AVATAR_ATTEMPTS: readonly AvatarAttempt[] = [
  { side: AVATAR_PIXELS, quality: 0.85 },
  { side: AVATAR_PIXELS, quality: 0.75 },
  { side: AVATAR_PIXELS, quality: 0.6 },
  { side: AVATAR_PIXELS, quality: 0.45 },
  { side: 192, quality: 0.6 },
  { side: 192, quality: 0.45 },
  { side: 128, quality: 0.5 },
  { side: 96, quality: 0.4 },
];

/**
 * The first attempt whose encoding fits `maxBytes`: `encode` makes it and says how many bytes it is. None fits: a
 * `too_large` error. An `encode` that fails is the image's fault (`unreadable`) unless it threw an `AvatarImageError`.
 */
export async function fitAvatar<T>(
  encode: (attempt: AvatarAttempt) => Promise<{ bytes: number; value: T }>,
  maxBytes: number = AVATAR_MAX_BYTES,
  attempts: readonly AvatarAttempt[] = AVATAR_ATTEMPTS,
): Promise<T> {
  for (const attempt of attempts) {
    let out: { bytes: number; value: T };
    try {
      out = await encode(attempt);
    } catch (error) {
      if (error instanceof AvatarImageError) throw error;
      throw new AvatarImageError('unreadable');
    }
    if (out.bytes > 0 && out.bytes <= maxBytes) return out.value;
  }
  throw new AvatarImageError('too_large');
}

/** How many bytes a base64 string decodes to (padding and whitespace allowed). */
export function base64DecodedBytes(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * What to tell the person when choosing or saving a photo failed: why the image can't be used, the Whombat's own words
 * when it refused the photo (a 4xx in the contract's shape, e.g. a type it doesn't take), else to try again.
 */
export function avatarErrorText(error: unknown, locale?: string | null): string {
  const copy = avatarCopy(locale);
  if (error instanceof AvatarImageError)
    return error.problem === 'too_small'
      ? copy.tooSmall
      : error.problem === 'too_large'
        ? copy.tooLarge
        : copy.unreadable;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== 'unknown')
    return error.message;
  return copy.failed;
}
