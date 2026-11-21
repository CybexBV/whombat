/** A person's photo: what `me.setAvatar` accepts (docs/decisions/person-avatars.md PVA-05). */
import { randomBytes } from 'node:crypto';
import { AVATAR_MAX_BYTES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { makePng } from '../test/files';
import { AVATAR_REFUSALS, avatarName, checkAvatar } from './avatars';
import { sha256OfKey } from './service';
import { blobKey } from './store';

const b64 = (bytes: Buffer) => bytes.toString('base64');

/** A JPEG's start: SOI, an APP0 segment, then a baseline frame header with the size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** An extended WebP header (VP8X) with the canvas size. */
function webp(width: number, height: number): Buffer {
  const head = Buffer.alloc(30);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(22, 4);
  head.write('WEBP', 8, 'latin1');
  head.write('VP8X', 12, 'latin1');
  head.writeUInt32LE(10, 16);
  head.writeUIntLE(width - 1, 24, 3);
  head.writeUIntLE(height - 1, 27, 3);
  return head;
}

describe('checkAvatar', () => {
  it('takes a JPEG, PNG or WebP square with its sniffed type and size', () => {
    expect(checkAvatar(b64(makePng(256, 256)))).toMatchObject({
      ok: true,
      contentType: 'image/png',
      width: 256,
      height: 256,
    });
    expect(checkAvatar(b64(jpeg(256, 200)))).toMatchObject({
      ok: true,
      contentType: 'image/jpeg',
      width: 256,
      height: 200,
    });
    expect(checkAvatar(b64(webp(128, 128)))).toMatchObject({ ok: true, contentType: 'image/webp' });
  });

  it('refuses SVG, GIF and anything that isn’t an image', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>');
    expect(checkAvatar(b64(svg))).toEqual({ ok: false, reason: 'type' });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([64, 0, 64, 0]), Buffer.alloc(8)]);
    expect(checkAvatar(b64(gif))).toEqual({ ok: false, reason: 'type' });
    expect(checkAvatar(b64(randomBytes(2000)))).toEqual({ ok: false, reason: 'type' });
    expect(checkAvatar(b64(Buffer.from('%PDF-1.7 hello')))).toEqual({ ok: false, reason: 'type' });
  });

  it('refuses a damaged image, an empty one and one over the byte limit', () => {
    const png = makePng(64, 64);
    expect(checkAvatar(b64(png.subarray(0, 12)))).toEqual({ ok: false, reason: 'damaged' });
    expect(checkAvatar('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkAvatar(b64(randomBytes(AVATAR_MAX_BYTES + 1)))).toEqual({ ok: false, reason: 'too_big' });
  });

  it('refuses sides under 32 or over 1024 pixels', () => {
    expect(checkAvatar(b64(makePng(31, 64)))).toEqual({ ok: false, reason: 'too_small' });
    expect(checkAvatar(b64(makePng(64, 16)))).toEqual({ ok: false, reason: 'too_small' });
    expect(checkAvatar(b64(webp(1025, 300)))).toEqual({ ok: false, reason: 'too_large' });
    expect(checkAvatar(b64(webp(30_000, 300)))).toEqual({ ok: false, reason: 'too_large' });
    expect(checkAvatar(b64(makePng(32, 1024)))).toMatchObject({ ok: true });
  });

  it('says why in words people read', () => {
    expect(AVATAR_REFUSALS.too_big).toBe('That photo is too big. Photos can be up to 32 KB.');
    expect(AVATAR_REFUSALS.type).toBe('Choose a JPEG, PNG or WebP photo.');
  });
});

describe('photo rows', () => {
  it('have a name from their type, never one a person chose', () => {
    expect(avatarName('image/png')).toBe('photo.png');
    expect(avatarName('image/webp')).toBe('photo.webp');
    expect(avatarName('image/jpeg')).toBe('photo.jpg');
  });

  it('keep their blob by sha256', () => {
    const sha = 'ab'.repeat(32);
    expect(sha256OfKey(blobKey(sha))).toBe(sha);
  });
});
