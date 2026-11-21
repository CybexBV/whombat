import { AVATAR_MAX_BYTES } from '@whombat/core';
import { mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { readPhotoBody, sniffPhotoType, withPhotos } from './avatarFixtures';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

describe('avatar fixtures (PA-07)', () => {
  it('sniffs JPEG, PNG and WebP from the bytes, never anything else', () => {
    expect(sniffPhotoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffPhotoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(sniffPhotoType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffPhotoType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it('checks a body as the runtime does', () => {
    expect(readPhotoBody({ image: null })).toEqual({ image: null });
    expect(readPhotoBody({ image: b64([0xff, 0xd8, 0xff, 0xe0]) })).toMatchObject({
      image: { type: 'image/jpeg' },
    });
    expect(readPhotoBody({ image: b64([1, 2, 3]) })).toEqual({
      refused: 'That photo isn’t a JPEG, PNG or WebP.',
    });
    expect(readPhotoBody({ image: b64(new Array(AVATAR_MAX_BYTES + 1).fill(0xff)) })).toEqual({
      refused: 'That photo is too large.',
    });
    expect(readPhotoBody({})).toEqual({ refused: 'Send a photo or null.' });
  });

  it('puts the photo on every copy of the person', () => {
    const url = '/api/v1/burrows/hq/attachments/att_1';
    const body = withPhotos(
      { me: { ...mara }, principals: [{ ...mara }, { id: 'agt_x', kind: 'agent' }] },
      new Map([[mara.id, url]]),
    );
    expect(body.me).toMatchObject({ avatarUrl: url });
    expect(body.principals[0]).toMatchObject({ avatarUrl: url });
    expect(body.principals[1]).not.toHaveProperty('avatarUrl');
  });
});
