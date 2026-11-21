/**
 * Attachments end to end (docs/decisions/bp-attachments.md), as a person's device moves them (the in-process caller:
 * the reserve endpoint, then the bytes as the session's upload and download streams carry them): reserve → upload →
 * send → download as the BP-05 type and disposition, who may read (members now, the uploader before sending), what may
 * be attached, rejected bytes, the orphan sweep, and a restart on the same database and files directory.
 */
import { api, buildPath } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { attachments, events } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { createServices } from '../services';
import { inProcessApi } from '../test/api';
import { BURROW, makePng, reserve, upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { testLogger } from '../test/log';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, env: { WHOMBAT_UPLOAD_MAX_BYTES: String(256 * 1024) } });
const auth: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  auth.mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
  auth.maraMobile = { authorization: (await sessionFor(t.services, IDS.mara)).bearer };
});

const sendPath = (conversationId: string) =>
  `${api.messages.send.base}${buildPath(api.messages.send.path, { burrow: BURROW, conversationId })}`;

async function send(who: Record<string, string>, conversationId: string, body: Record<string, unknown>) {
  return t.api.inject({ method: 'POST', url: sendPath(conversationId), headers: who, payload: body });
}

async function get(who: Record<string, string>, url: string, headers: Record<string, string> = {}) {
  return t.api.inject({ method: 'GET', url, headers: { ...who, ...headers } });
}

describe('upload → send → download', () => {
  const png = makePng(40, 30);
  let att: Awaited<ReturnType<typeof upload>>;

  it('reserves with a safe name and stores sniffed bytes', async () => {
    const res = await reserve(t.api, auth.mara as Record<string, string>, {
      conversationId: IDS.billing,
      name: '../../etc/sc\u0007reen‮shot.png',
      contentType: 'image/png',
      size: png.length,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.attachment.name).toBe('screenshot.png');
    expect(body.method).toBe('PUT');
    expect(body.maxBytes).toBe(256 * 1024);
    expect(body.uploadUrl).toBe(`/api/v1/burrows/burrow-hq/uploads/${body.attachment.id}/content`);
    const put = await t.api.inject({
      method: 'PUT',
      url: body.uploadUrl,
      headers: { ...auth.mara, 'content-type': 'application/octet-stream' },
      payload: png,
    });
    expect(put.statusCode).toBe(200);
    att = put.json().attachment;
    expect(att).toMatchObject({ kind: 'image', contentType: 'image/png', width: 40, height: 30 });
    expect(att.url).toBe(`/api/v1/burrows/burrow-hq/attachments/${att.id}`);
  });

  it('sends a message with only the file and serves it to members with safe headers', async () => {
    const res = await send(auth.mara as Record<string, string>, IDS.billing, {
      text: '',
      attachmentIds: [att.id],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.attachments).toEqual([
      expect.objectContaining({ id: att.id, name: 'screenshot.png', kind: 'image', width: 40, height: 30 }),
    ]);
    const dl = await get(auth.mara as Record<string, string>, att.url);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(png)).toBe(true);
    expect(dl.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff' });
    expect(dl.headers['content-disposition']).toMatch(/^inline; filename="screenshot.png"/);
    const forced = await get(auth.mara as Record<string, string>, `${att.url}?download=1`);
    expect(forced.headers['content-disposition']).toMatch(/^attachment;/);
    // Listing the conversation shows the file too.
    const list = await get(
      auth.mara as Record<string, string>,
      `${api.messages.list.base}${buildPath(api.messages.list.path, { burrow: BURROW, conversationId: IDS.billing })}`,
    );
    const listed = list.json().messages.find((m: { id: string }) => m.id === res.json().message.id);
    expect(listed.attachments[0].id).toBe(att.id);
  });

  it('keeps file names and bytes out of the signed events', async () => {
    const rows = await t.services.db
      .select()
      .from(events)
      .where(inArray(events.type, ['attachment.uploaded', 'attachments.attached', 'message.posted']));
    const signed = JSON.stringify(rows.map((r) => [r.text, r.payload]));
    expect(rows.some((r) => r.type === 'attachment.uploaded')).toBe(true);
    expect(rows.some((r) => r.type === 'attachments.attached')).toBe(true);
    expect(signed).not.toContain('screenshot');
    expect(signed).toContain(att.id);
  });

  it('serves the same file after a restart on the same database and files directory', async () => {
    const services = createServices({ config: t.services.config, sql: t.services.sql, log: testLogger() });
    try {
      const res = await inProcessApi(() => services).inject({
        method: 'GET',
        url: att.url,
        headers: auth.mara,
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(png)).toBe(true);
    } finally {
      services.typing.close();
      services.files.close();
    }
  });
});

describe('what can be attached', () => {
  it('refuses another conversation’s upload, one not uploaded, and one already sent', async () => {
    const mara = auth.mara as Record<string, string>;
    const mine = await upload(t.api, mara, IDS.general, 'notes.txt', Buffer.from('hello there\n'));
    const elsewhere = await send(mara, IDS.incidents, { text: 'hi', attachmentIds: [mine.id] });
    expect(elsewhere.json().error.message).toBe('That file was uploaded for another conversation.');
    const reserved = (
      await reserve(t.api, mara, { conversationId: IDS.general, name: 'later.txt', size: 5 })
    ).json();
    const early = await send(mara, IDS.general, { text: 'hi', attachmentIds: [reserved.attachment.id] });
    expect(early.json().error.message).toBe('That file hasn’t finished uploading.');
    expect((await send(mara, IDS.general, { text: '', attachmentIds: [mine.id] })).statusCode).toBe(201);
    const twice = await send(mara, IDS.general, { text: 'again', attachmentIds: [mine.id] });
    expect(twice.json().error.message).toBe('That file is on a message already.');
    expect((await send(mara, IDS.general, { text: '   ' })).statusCode).toBe(400);
  });

  it('a phone uploads as its account, like any device', async () => {
    const att = await upload(
      t.api,
      auth.maraMobile as Record<string, string>,
      IDS.general,
      'm.txt',
      Buffer.from('from the phone'),
    );
    expect(att.kind).toBe('text');
  });
});

describe('bytes that are refused or downgraded', () => {
  const mara = () => auth.mara as Record<string, string>;

  it('refuses a declared size over the limit, and a body larger or smaller than reserved', async () => {
    const big = await reserve(t.api, mara(), {
      conversationId: IDS.general,
      name: 'big.bin',
      size: 300 * 1024,
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toMatchObject({
      code: 'too_large',
      details: { reason: 'file', limit: 256 * 1024 },
    });
    // Bytes that aren't what was reserved: more is too large, less isn't the file; nothing is kept of either.
    const more = (
      await reserve(t.api, mara(), { conversationId: IDS.general, name: 'a.bin', size: 10 })
    ).json();
    const less = await t.api.inject({
      method: 'PUT',
      url: more.uploadUrl,
      headers: { ...mara(), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(4),
    });
    expect(less.statusCode).toBe(400);
    const mismatch = await t.api.inject({
      method: 'PUT',
      url: more.uploadUrl,
      headers: { ...mara(), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(11),
    });
    expect(mismatch.statusCode).toBe(413);
    const [row] = await t.services.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, more.attachment.id));
    expect(row?.state).toBe('reserved');
  });

  it('refuses a damaged PNG', async () => {
    const bytes = Buffer.concat([makePng(4, 4).subarray(0, 8), Buffer.from('not a header at all, sorry')]);
    await expect(upload(t.api, mara(), IDS.general, 'broken.png', bytes, 'image/png')).rejects.toThrow(
      /put 400/,
    );
  });

  it('refuses an image with absurd dimensions (decompression bomb)', async () => {
    const png = makePng(1, 1);
    png.writeUInt32BE(50_000, 16);
    png.writeUInt32BE(50_000, 20);
    await expect(upload(t.api, mara(), IDS.general, 'bomb.png', png, 'image/png')).rejects.toThrow(/put 400/);
  });

  it('serves HTML and SVG dressed up as images as text downloads', async () => {
    for (const [name, text] of [
      ['cat.png', '<html><script>alert(1)</script></html>'],
      ['logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ] as const) {
      const att = await upload(t.api, mara(), IDS.general, name, Buffer.from(text), 'image/svg+xml');
      // An SVG keeps its label so clients can show it as an image (MPO-02), but it is text and served as text.
      expect(att).toMatchObject({
        kind: 'text',
        contentType: name.endsWith('.svg') ? 'image/svg+xml' : 'text/plain',
      });
      const dl = await get(mara(), att.url);
      expect(dl.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    }
  });
});

describe('cleanup', () => {
  it('discarding an unsent upload removes it; its bytes go when nothing else uses them', async () => {
    const mara = auth.mara as Record<string, string>;
    const bytes = Buffer.from('discard me please');
    const a = await upload(t.api, mara, IDS.general, 'a.txt', bytes);
    const b = await upload(t.api, mara, IDS.general, 'b.txt', bytes);
    const [rowA] = await t.services.db.select().from(attachments).where(eq(attachments.id, a.id));
    const key = rowA?.blobKey as string;
    expect(key).toBeTruthy();
    const path = `${api.uploads.discard.base}${buildPath(api.uploads.discard.path, { burrow: BURROW, attachmentId: a.id })}`;
    expect((await t.api.inject({ method: 'DELETE', url: path, headers: mara })).statusCode).toBe(200);
    // Same bytes, separate upload: dedupe shares the blob, never the row or who may read it.
    expect(await t.services.files.store.size(key)).toBe(bytes.length);
    const pathB = `${api.uploads.discard.base}${buildPath(api.uploads.discard.path, { burrow: BURROW, attachmentId: b.id })}`;
    expect((await t.api.inject({ method: 'DELETE', url: pathB, headers: mara })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(await t.services.files.store.size(key)).toBeNull();
  });

  it('the sweep removes uploads never sent after the window, keeps sent ones, and is idempotent', async () => {
    const mara = auth.mara as Record<string, string>;
    const unsent = await upload(t.api, mara, IDS.general, 'old.txt', Buffer.from('left behind'));
    const reserved = (
      await reserve(t.api, mara, { conversationId: IDS.general, name: 'never.txt', size: 4 })
    ).json();
    const sent = await upload(t.api, mara, IDS.general, 'kept.txt', Buffer.from('sent and kept'));
    expect((await send(mara, IDS.general, { text: 'keep', attachmentIds: [sent.id] })).statusCode).toBe(201);
    const old = new Date(Date.now() - 48 * 3_600_000);
    await t.services.db
      .update(attachments)
      .set({ createdAt: old })
      .where(inArray(attachments.id, [unsent.id, reserved.attachment.id, sent.id]));
    const [before] = await t.services.db.select().from(attachments).where(eq(attachments.id, unsent.id));
    const first = await t.services.files.sweep();
    expect(first.rows).toBeGreaterThanOrEqual(2);
    const left = await t.services.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(inArray(attachments.id, [unsent.id, reserved.attachment.id, sent.id]));
    expect(left.map((r) => r.id)).toEqual([sent.id]);
    expect(await t.services.files.store.size(before?.blobKey as string)).toBeNull();
    const second = await t.services.files.sweep();
    expect(second).toEqual({ rows: 0, blobs: 0, staging: 0 });
    expect((await get(mara, sent.url)).statusCode).toBe(200);
    const stillThere = await t.services.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, sent.id), eq(attachments.state, 'ready')));
    expect(stillThere).toHaveLength(1);
  });
});
