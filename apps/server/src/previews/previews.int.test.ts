/**
 * Link previews end to end (docs/decisions/essentials-conversations.md EC-17…EC-22) against a local fake website: a
 * post gets its previews after the commit and its room hears `message.updated`; the cache answers the same URL in the
 * same burrow; code blocks and this Whombat's own links get none; failures leave none and are recorded; an edit keeps
 * previews in step with the words; the person switches them off, for the burrow or one channel; and with the address
 * rules on (as in production) the same local site is refused.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, buildPath, type RealtimeEvent } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateConversation } from '../commands/conversations';
import { editMessage } from '../commands/message-edits';
import { sendMessage } from '../commands/messages';
import { burrows, linkPreviews, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { sessionFor } from '../test/tokens';

const t = useTestServer({
  seed: true,
  app: true,
  env: {
    WHOMBAT_LINK_PREVIEWS: 'on',
    WHOMBAT_OUTBOUND_ALLOW_PRIVATE: '1',
    PUBLIC_URL: 'http://whombat.localhost:4400',
  },
});
const frames: RealtimeEvent[] = [];
const hits = new Map<string, number>();
let server: Server;
let site = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    if (req.url?.startsWith('/article')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><head><title>Fallback</title><meta property="og:title" content="Invoices, explained ${req.url}">
         <meta property="og:description" content="How the PDF export works."><meta property="og:site_name" content="Docs"></head></html>`,
      );
    } else if (req.url === '/file.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.7');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.services.bus.onFrame((f) => frames.push(f.event));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function post(text: string, conversationId: string = IDS.billing, authorId: string = IDS.mara) {
  const res = await t.commit(authorId, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('send');
  await t.services.linkPreviews.settled();
  return res.result.id;
}
const row = async (id: string) => (await t.services.db.select().from(messages).where(eq(messages.id, id)))[0];

describe('link previews', () => {
  it('appear under a message after it is posted, and its room hears about it', async () => {
    frames.length = 0;
    const id = await post(`Read this: ${site}/article-1 before the review`);
    expect((await row(id))?.previews).toEqual([
      {
        url: `${site}/article-1`,
        title: 'Invoices, explained /article-1',
        description: 'How the PDF export works.',
        siteName: 'Docs',
      },
    ]);
    const update = frames.find(
      (e): e is Extract<RealtimeEvent, { type: 'message.updated' }> =>
        e.type === 'message.updated' && e.message.id === id,
    );
    expect(update?.message.previews?.[0]?.title).toBe('Invoices, explained /article-1');
  });

  it('come from the cache for the same link in the same burrow', async () => {
    const before = hits.get('/article-2') ?? 0;
    await post(`${site}/article-2`);
    await post(`Again ${site}/article-2`);
    expect(hits.get('/article-2')).toBe(before + 1);
    const [cached] = await t.services.db
      .select()
      .from(linkPreviews)
      .where(and(eq(linkPreviews.burrowId, t.burrowId), eq(linkPreviews.url, `${site}/article-2`)));
    expect(cached?.status).toBe('ok');
  });

  it('skip code, this Whombat’s own links and pages that aren’t HTML; failures leave none and are recorded', async () => {
    const code = await post(`\`\`\`\ncurl ${site}/article-code\n\`\`\``);
    expect((await row(code))?.previews).toBeNull();
    expect(hits.get('/article-code')).toBeUndefined();
    const own = await post('Open http://whombat.localhost:4400/burrow-hq/c/general');
    expect((await row(own))?.previews).toBeNull();
    const pdf = await post(`${site}/file.pdf`);
    expect((await row(pdf))?.previews).toBeNull();
    const missing = await post(`${site}/gone`);
    expect((await row(missing))?.previews).toBeNull();
    const [failed] = await t.services.db
      .select()
      .from(linkPreviews)
      .where(eq(linkPreviews.url, `${site}/gone`));
    expect(failed).toMatchObject({ status: 'failed', reason: 'answered 404', preview: null });
  });

  it('follow edits: a removed link loses its preview, a new one gets it', async () => {
    const id = await post(`First ${site}/article-3`);
    expect((await row(id))?.previews).toHaveLength(1);
    const res = await t.commit(IDS.mara, editMessage, {
      messageId: id,
      text: `Now ${site}/article-4 instead`,
    });
    if (res.status !== 'ok') throw new Error('edit');
    await t.services.linkPreviews.settled();
    expect((await row(id))?.previews?.map((p) => p.url)).toEqual([`${site}/article-4`]);
  });

  it('work in every kind of conversation', async () => {
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    const id = await post(`${site}/article-5`, chat);
    expect((await row(id))?.previews?.[0]?.title).toBe('Invoices, explained /article-5');
  });

  it('are switched off by the person for the whole burrow', async () => {
    const mara = (await sessionFor(t.services, IDS.mara)).cookie;
    const path = `${api.burrows.update.base}${buildPath(api.burrows.update.path, { burrow: 'burrow-hq' })}`;
    const off = await t.api.inject({
      method: 'PATCH',
      url: path,
      headers: { cookie: mara },
      payload: { linkPreviews: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().burrow.linkPreviews).toBe(false);
    try {
      const id = await post(`${site}/article-6`);
      expect((await row(id))?.previews).toBeNull();
      expect(hits.get('/article-6')).toBeUndefined();
    } finally {
      await t.services.db.update(burrows).set({ linkPreviews: null }).where(eq(burrows.id, t.burrowId));
    }
  });

  it('are switched off per channel by the person, not by an agent (EC-23)', async () => {
    const mara = (await sessionFor(t.services, IDS.mara)).cookie;
    const path = `${api.conversations.update.base}${buildPath(api.conversations.update.path, {
      burrow: 'burrow-hq',
      conversationId: IDS.billing,
    })}`;
    const before = await post(`${site}/article-8`);
    expect((await row(before))?.previews?.[0]?.title).toBe('Invoices, explained /article-8');
    await expect(
      t.commit(IDS.dusty, updateConversation, { conversationId: IDS.billing, linkPreviews: false }),
    ).rejects.toThrow('Only you can turn link previews');
    const off = await t.api.inject({
      method: 'PATCH',
      url: path,
      headers: { cookie: mara },
      payload: { linkPreviews: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().conversation.linkPreviews).toBe(false);
    try {
      const id = await post(`${site}/article-9`);
      expect((await row(id))?.previews).toBeNull();
      expect(hits.get('/article-9')).toBeUndefined();
      // Another conversation keeps its previews.
      const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
      const elsewhere = await post(`${site}/article-10`, chat);
      expect((await row(elsewhere))?.previews?.[0]?.title).toBe('Invoices, explained /article-10');
    } finally {
      const on = await t.api.inject({
        method: 'PATCH',
        url: path,
        headers: { cookie: mara },
        payload: { linkPreviews: true },
      });
      expect(on.json().conversation.linkPreviews).toBe(true);
    }
    expect((await row(await post(`${site}/article-11`)))?.previews?.[0]?.title).toBe(
      'Invoices, explained /article-11',
    );
  });
});

describe('with the address rules on, as in production', () => {
  it('refuses a private address and a port that isn’t 80 or 443, and records why', async () => {
    t.services.linkPreviews.fetchOptions = { allowPrivate: false };
    try {
      const id = await post(`${site}/article-7`);
      expect((await row(id))?.previews).toBeNull();
      expect(hits.get('/article-7')).toBeUndefined();
      const [refused] = await t.services.db
        .select()
        .from(linkPreviews)
        .where(eq(linkPreviews.url, `${site}/article-7`));
      expect(refused?.status).toBe('failed');
      expect(refused?.reason).toMatch(/^refused: port \d+ is not a standard web port/);
      const loopback = await post(
        'http://127.0.0.1/article-8 and http://[::1]/x and http://169.254.169.254/latest',
      );
      expect((await row(loopback))?.previews).toBeNull();
      const reasons = await t.services.db
        .select()
        .from(linkPreviews)
        .where(eq(linkPreviews.status, 'failed'));
      expect(reasons.find((r) => r.url === 'http://169.254.169.254/latest')?.reason).toMatch(
        /refused.*not a public address/,
      );
    } finally {
      t.services.linkPreviews.fetchOptions = {};
    }
  });

  it('leaves a deleted message without previews', async () => {
    const root = await post(`${site}/article-9`);
    await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: 'reply',
      threadRootId: root,
    });
    const { deleteMessage } = await import('../commands/message-edits');
    // Dusty replied, so the person removes the thread (EC-04b); nothing of it, previews included, is left.
    const res = await t.commit(IDS.mara, deleteMessage, { messageId: root });
    if (res.status !== 'ok') throw new Error('delete');
    expect(res.result.message).toBeNull();
    expect(await row(root)).toBeUndefined();
  });
});
