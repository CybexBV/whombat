import { AVATAR_MAX_BYTES, AVATAR_MIN_PIXELS, AVATAR_PIXELS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_ATTEMPTS,
  AVATAR_COPY,
  AvatarImageError,
  avatarErrorText,
  avatarSquare,
  base64DecodedBytes,
  fitAvatar,
} from './avatarPhoto';
import { ApiError } from './http/errors';
import { base64 } from './svg';

describe('avatarSquare', () => {
  it('is the largest centred square', () => {
    expect(avatarSquare(400, 300)).toEqual({ x: 50, y: 0, side: 300 });
    expect(avatarSquare(300, 401)).toEqual({ x: 0, y: 50, side: 300 });
    expect(avatarSquare(256, 256)).toEqual({ x: 0, y: 0, side: 256 });
  });

  it('refuses an image under the smallest side, and one without a size', () => {
    expect(() => avatarSquare(AVATAR_MIN_PIXELS - 1, 500)).toThrow(AVATAR_COPY.tooSmall);
    expect(avatarSquare(AVATAR_MIN_PIXELS, AVATAR_MIN_PIXELS).side).toBe(AVATAR_MIN_PIXELS);
    expect(() => avatarSquare(0, 0)).toThrow(AVATAR_COPY.unreadable);
    expect(() => avatarSquare(Number.NaN, 10)).toThrow(AvatarImageError);
  });
});

describe('fitAvatar', () => {
  it('starts at AVATAR_PIXELS and never goes under the smallest side', () => {
    expect(AVATAR_ATTEMPTS[0]?.side).toBe(AVATAR_PIXELS);
    for (const a of AVATAR_ATTEMPTS) {
      expect(a.side).toBeGreaterThanOrEqual(AVATAR_MIN_PIXELS);
      expect(a.side).toBeLessThanOrEqual(AVATAR_PIXELS);
      expect(a.quality).toBeGreaterThan(0);
      expect(a.quality).toBeLessThanOrEqual(1);
    }
  });

  it('takes the first encoding that fits', async () => {
    const tried: number[] = [];
    const value = await fitAvatar(async (a) => {
      tried.push(a.quality);
      const bytes = a.quality > 0.6 ? AVATAR_MAX_BYTES + 1 : AVATAR_MAX_BYTES;
      return { bytes, value: `${a.side}@${a.quality}` };
    });
    expect(value).toBe(`${AVATAR_PIXELS}@0.6`);
    expect(tried).toEqual([0.85, 0.75, 0.6]);
  });

  it('steps the size down after the quality', async () => {
    const value = await fitAvatar(async (a) => ({ bytes: a.side * 100, value: a.side }), 128 * 100);
    expect(value).toBe(128);
  });

  it('says it is too large when nothing fits, and unreadable when encoding fails', async () => {
    await expect(fitAvatar(async () => ({ bytes: AVATAR_MAX_BYTES + 1, value: 0 }))).rejects.toThrow(
      AVATAR_COPY.tooLarge,
    );
    await expect(
      fitAvatar(async () => {
        throw new Error('decode');
      }),
    ).rejects.toThrow(AVATAR_COPY.unreadable);
    await expect(fitAvatar(async () => ({ bytes: 0, value: 0 }))).rejects.toThrow(AVATAR_COPY.tooLarge);
  });
});

describe('base64DecodedBytes', () => {
  it('counts the decoded bytes', () => {
    for (const n of [0, 1, 2, 3, 4, 31, 32768]) {
      const b64 = base64(new Uint8Array(n));
      expect(base64DecodedBytes(b64)).toBe(n);
    }
    expect(base64DecodedBytes('AAAA\nAA==')).toBe(4);
  });
});

describe('avatarErrorText', () => {
  it('says why for the image, and to try again otherwise', () => {
    expect(avatarErrorText(new AvatarImageError('too_small'))).toBe(AVATAR_COPY.tooSmall);
    expect(avatarErrorText(new Error('network'))).toBe(AVATAR_COPY.failed);
    const refused = new ApiError(
      400,
      'validation_failed',
      'That photo isn’t a JPEG, PNG or WebP.',
      {},
      'me.setAvatar',
    );
    expect(avatarErrorText(refused)).toBe('That photo isn’t a JPEG, PNG or WebP.');
    expect(avatarErrorText(new ApiError(500, 'internal', 'boom', {}, 'me.setAvatar'))).toBe(
      AVATAR_COPY.failed,
    );
  });
});
