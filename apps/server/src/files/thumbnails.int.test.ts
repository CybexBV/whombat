/**
 * Image thumbnails (docs/decisions/review-features.md RF-04; contracts CT-298): a PNG or JPEG larger than 720 pixels on
 * its longest side gets its thumbnail when it is uploaded (`thumbnailUrl` and its size on the attachment), served at
 * `…/thumbnail` to whoever may read the file (404 to anyone else and for a file without one), cached for good, and
 * removed with the file. Images within the edge and other files get none.
 */
import { existsSync } from 'node:fs';
import { api, buildPath, THUMBNAIL_MAX_EDGE } from '@whombat/core';
import { eq } from 'drizzle-orm';
import jpeg from 'jpeg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { attachments } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { BURROW, makePng, upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { previewPath } from './previews';
import { filesDir } from './service';
import { sniffBuffer } from './sniff';

const t = useTestServer({ seed: true, app: true });
const auth: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  auth.mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
});

const as = (who: 'mara') => auth[who] as Record<string, string>;

async function get(who: 'mara', url: string, headers: Record<string, string> = {}) {
  return t.api.inject({ method: 'GET', url, headers: { ...as(who), ...headers } });
}

async function send(attachmentId: string) {
  const ep = api.messages.send;
  const res = await t.api.inject({
    method: 'POST',
    url: `${ep.base}${buildPath(ep.path, { burrow: BURROW, conversationId: IDS.billing })}`,
    headers: as('mara'),
    payload: { text: 'Look', attachmentIds: [attachmentId] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().message as { attachments: Record<string, unknown>[] };
}

function makeJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4, 180);
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}

describe('thumbnails', () => {
  it('a large PNG gets one at upload, served to people who may read the file', async () => {
    const png = makePng(1600, 800);
    const att = await upload(t.api, as('mara'), IDS.billing, 'wide.png', png);
    expect(att).toMatchObject({
      thumbnailUrl: `/api/v1/burrows/burrow-hq/attachments/${att.id}/thumbnail`,
      thumbnailWidth: THUMBNAIL_MAX_EDGE,
      thumbnailHeight: 360,
    });
    const url = String(att.thumbnailUrl);
    // Before it is sent: its uploader, like the file.
    expect((await get('mara', url)).statusCode).toBe(200);
    const message = await send(att.id);
    expect(message.attachments[0]).toMatchObject({ id: att.id, thumbnailUrl: url, thumbnailWidth: 720 });
    const res = await get('mara', url);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'image/png' });
    expect(res.rawPayload.length).toBeLessThan(png.length * 4);
    const sniffed = sniffBuffer(res.rawPayload, 'thumb.png');
    expect(sniffed.ok && sniffed.value).toMatchObject({ contentType: 'image/png', width: 720, height: 360 });
  });

  it('a large JPEG too, as a JPEG', async () => {
    const att = await upload(t.api, as('mara'), IDS.billing, 'photo.jpg', makeJpeg(900, 1200));
    expect(att).toMatchObject({ thumbnailWidth: 540, thumbnailHeight: 720 });
    const res = await get('mara', String(att.thumbnailUrl));
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('none for an image within the edge or another file; the route says so', async () => {
    const small = await upload(t.api, as('mara'), IDS.billing, 'small.png', makePng(700, 300));
    expect(small).toMatchObject({ thumbnailUrl: null, thumbnailWidth: null, thumbnailHeight: null });
    expect((await get('mara', `${small.url}/thumbnail`)).statusCode).toBe(404);
    const text = await upload(t.api, as('mara'), IDS.billing, 'notes.txt', Buffer.from('hello'));
    expect(text).toMatchObject({ thumbnailUrl: null });
  });

  it('goes with its file', async () => {
    const png = makePng(1000, 1000, [10, 200, 30]);
    const att = await upload(t.api, as('mara'), IDS.billing, 'square.png', png);
    const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, att.id));
    const path = previewPath(filesDir(t.services.config), row?.sha256 ?? '', 'image/png');
    expect(existsSync(path)).toBe(true);
    const ep = api.uploads.discard;
    const res = await t.api.inject({
      method: ep.method,
      url: `${ep.base}${buildPath(ep.path, { burrow: BURROW, attachmentId: att.id })}`,
      headers: as('mara'),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    await expect.poll(() => existsSync(path)).toBe(false);
  });
});
