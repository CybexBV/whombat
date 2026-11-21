import { ApiError, NetworkError, UploadError, type UploadItem } from '@whombat/client';
import { PAGES_CONTENT_TYPE } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  attachmentMeta,
  canSend,
  fileTile,
  fromDocumentAsset,
  fromImageAsset,
  imageBox,
  oneAtATime,
  PHOTO_MAX_EDGE,
  photoName,
  photoResize,
  scaledPhoto,
  scalesDown,
  uploadRetryable,
} from './attachments';

const item = (state: UploadItem['state']): UploadItem => ({
  localId: 'l',
  name: 'a.png',
  size: 10,
  mediaType: 'image/png',
  state,
  progress: state === 'ready' ? 1 : 0.5,
  attachment: null,
  error: null,
});

describe('mobile attachments', () => {
  it('turns picker assets into upload sources, without empty files', () => {
    expect(
      fromImageAsset(
        { uri: 'file:///a', fileName: null, mimeType: 'image/jpeg', fileSize: 2048 },
        0,
        new Date(2026, 0, 2, 3, 4),
      ),
    ).toEqual({
      uri: 'file:///a',
      name: 'Photo 2026-01-02 03.04.jpg',
      type: 'image/jpeg',
      size: 2048,
    });
    expect(fromImageAsset({ uri: 'file:///a', fileSize: 0 })).toBeNull();
    expect(
      fromDocumentAsset({ uri: 'content://x', name: 'report.pdf', mimeType: 'application/pdf', size: 99 }),
    ).toEqual({
      uri: 'content://x',
      name: 'report.pdf',
      type: 'application/pdf',
      size: 99,
    });
    expect(fromDocumentAsset({ uri: 'content://x', name: 'e', size: null })).toBeNull();
  });

  it('sends with text or ready files, never while uploading', () => {
    expect(canSend('hi', [])).toBe(true);
    expect(canSend('  ', [])).toBe(false);
    expect(canSend('', [item('ready')])).toBe(true);
    expect(canSend('hi', [item('ready'), item('uploading')])).toBe(false);
    expect(canSend('', [item('failed')])).toBe(false);
  });

  it('lays out and labels files', () => {
    expect(imageBox({ width: 1200, height: 800 }, 280)).toEqual({ width: 280, height: 187 });
    expect(imageBox({ width: 100, height: 40 }, 280)).toEqual({ width: 100, height: 40 });
    expect(attachmentMeta({ kind: 'document', size: 2_500_000 })).toBe('PDF · 2.4 MB');
  });

  it('names picker photos that only have a media id after the moment they were picked', () => {
    const now = new Date(2026, 8, 24, 21, 4, 30);
    expect(photoName('19.png', 'png', 0, now)).toBe('Photo 2026-09-24 21.04.png');
    expect(photoName('1000000034.jpg', 'jpg', 1, now)).toBe('Photo 2026-09-24 21.04 (2).jpg');
    expect(photoName(null, 'jpg', 0, now)).toBe('Photo 2026-09-24 21.04.jpg');
    expect(photoName('', 'webp', 2, now)).toBe('Photo 2026-09-24 21.04 (3).webp');
    expect(photoName('IMG_20260901_120000.jpg', 'jpg', 0, now)).toBe('IMG_20260901_120000.jpg');
    expect(photoName('beach.heic', 'heic', 0, now)).toBe('beach.heic');
    expect(
      fromImageAsset({ uri: 'file:///19', fileName: '19.png', mimeType: 'image/png', fileSize: 9 }, 0, now)
        ?.name,
    ).toBe('Photo 2026-09-24 21.04.png');
  });

  it('offers Retry only when trying again can work', () => {
    const api = (status: number) => new ApiError(status, 'unknown', 'x', null, 'uploads.create');
    // The file or the place: Remove only.
    expect(uploadRetryable(new UploadError('That file is too big.', 413))).toBe(false);
    expect(uploadRetryable(api(413))).toBe(false);
    expect(uploadRetryable(new UploadError('That image is damaged.', 400))).toBe(false);
    expect(uploadRetryable(api(404))).toBe(false);
    expect(uploadRetryable(api(403))).toBe(false);
    // The connection, the server, a busy hour, a clash: Retry.
    expect(
      uploadRetryable(new UploadError('Upload failed. Check your connection and try again.', null)),
    ).toBe(true);
    expect(uploadRetryable(new NetworkError('uploads.create', new Error('offline')))).toBe(true);
    expect(uploadRetryable(new UploadError('Upload failed. Try again.', 502))).toBe(true);
    expect(uploadRetryable(api(429))).toBe(true);
    expect(uploadRetryable(api(409))).toBe(true);
    expect(uploadRetryable(new Error('?'))).toBe(true);
  });
});

describe('photos scaled down for the upload (AP-908)', () => {
  it('scales camera photos longer than 2048px, and nothing else', () => {
    expect(PHOTO_MAX_EDGE).toBe(2048);
    expect(scalesDown({ width: 4000, height: 3000, mimeType: 'image/jpeg' })).toBe(true);
    expect(scalesDown({ width: 3024, height: 4032, mimeType: 'image/heic' })).toBe(true);
    expect(scalesDown({ width: 2048, height: 1536, mimeType: 'image/jpeg' })).toBe(false);
    // Screenshots and diagrams keep their sharp text, GIFs their motion; unknown sizes are left alone.
    expect(scalesDown({ width: 1440, height: 3120, mimeType: 'image/png' })).toBe(false);
    expect(scalesDown({ width: 4000, height: 3000, mimeType: 'image/gif' })).toBe(false);
    expect(scalesDown({ width: 4000, height: 3000, mimeType: 'image/webp' })).toBe(false);
    expect(scalesDown({ mimeType: 'image/jpeg' })).toBe(false);
  });

  it('brings the longest side to 2048, whichever way the photo stands', () => {
    expect(photoResize(4000, 3000)).toEqual({ width: 2048 });
    expect(photoResize(3000, 4000)).toEqual({ height: 2048 });
    expect(photoResize(3000, 3000)).toEqual({ width: 2048 });
  });

  it('sends the scaled JPEG when it is smaller, named and typed as one', () => {
    const picked = { uri: 'file:///p.heic', name: 'IMG_0412.HEIC', type: 'image/heic', size: 4_800_000 };
    expect(scaledPhoto(picked, { uri: 'file:///s.jpg', size: 610_000 })).toEqual({
      uri: 'file:///s.jpg',
      name: 'IMG_0412.jpg',
      type: 'image/jpeg',
      size: 610_000,
    });
    expect(
      scaledPhoto(
        { uri: 'file:///p', name: 'Photo 2026-09-24 21.04.jpg', type: 'image/jpeg', size: 3_000_000 },
        { uri: 'file:///s.jpg', size: 500_000 },
      ).name,
    ).toBe('Photo 2026-09-24 21.04.jpg');
    // Not smaller, or unreadable: as picked.
    expect(scaledPhoto(picked, { uri: 'file:///s.jpg', size: 5_000_000 })).toBe(picked);
    expect(scaledPhoto(picked, { uri: 'file:///s.jpg', size: 0 })).toBe(picked);
  });
});

describe('the tile a message’s file gets', () => {
  const can = { avif: true, svg: true };
  const file = (
    name: string,
    contentType: string,
    kind: 'image' | 'text' | 'document' | 'file' = 'file',
  ) => ({
    name,
    contentType,
    kind,
    size: 4096,
  });

  it('gives a page set its own card, though its name and older apps say ZIP', () => {
    expect(fileTile(file('Council mockups.zip', PAGES_CONTENT_TYPE), can)).toBe('pages');
    expect(fileTile(file('Council mockups.zip', 'application/zip'), can)).toBe('row');
  });

  it('keeps pictures, pages, diagrams and rows as they were', () => {
    expect(fileTile(file('a.png', 'image/png', 'image'), can)).toBe('image');
    expect(fileTile(file('a.avif', 'image/avif', 'image'), { ...can, avif: false })).toBe('row');
    expect(fileTile(file('a.svg', 'image/svg+xml'), can)).toBe('svg');
    // An SVG that couldn't be drawn goes back to its row.
    expect(fileTile(file('a.svg', 'image/svg+xml'), { ...can, svg: false })).toBe('row');
    expect(fileTile(file('page.html', 'text/html', 'text'), can)).toBe('html');
    expect(fileTile(file('flow.mmd', 'text/vnd.mermaid', 'text'), can)).toBe('mermaid');
    expect(fileTile(file('report.pdf', 'application/pdf', 'document'), can)).toBe('row');
  });
});

describe('oneAtATime', () => {
  it('starts an item only when the one before it is done, and keeps their order', async () => {
    let running = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const all = oneAtATime(['a', 'b', 'c'], async (item, index) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((done) => waiting.push(done));
      running -= 1;
      return `${index}${item}`;
    });
    for (let step = 0; step < 3; step += 1) {
      await Promise.resolve();
      expect(waiting).toHaveLength(step + 1);
      waiting[step]?.();
      await Promise.resolve();
    }
    expect(await all).toEqual(['0a', '1b', '2c']);
    expect(most).toBe(1);
  });
});
