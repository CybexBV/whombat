/**
 * What a turn reads and where it acts (docs/decisions/one-person.md OP-17, OP-S71; outsiders-turns.md OT-01, OT-04): the
 * person's turn reads any room of the burrow and searches them; an outsiders' turn (queued for nobody) reads and replies
 * only in its own thread, searches nothing and never gets a room's window, so what strangers send can't pull the
 * person's rooms into its answer or put words in them.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createCanvas } from '../commands/content';
import { sendMessage } from '../commands/messages';
import { canvases, dispatches, messages } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { makeRoom } from '../test/rooms';
import { agentTokenFor } from '../test/tokens';

const t = useTestServer({ seed: true, listen: true });
const clients: TestMcp[] = [];
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

async function as(conversationId: string, options: { outside?: boolean; threadRootId?: string } = {}) {
  const { token, dispatchId } = await agentTokenFor(
    t.services,
    t.burrowId,
    IDS.dusty,
    conversationId,
    options.outside ? { onBehalfOfAccountId: null, threadRootId: options.threadRootId ?? null } : {},
  );
  const mcp = await mcpClient(t.baseUrl, token);
  clients.push(mcp);
  return Object.assign(mcp, { dispatchId });
}

const WORD = 'wombatpagerSECRET';

/** A message of Mara's at the top level of a room: the request an outsiders' turn answers in its thread. */
async function asked(conversationId: string, text: string): Promise<string> {
  const res = await t.services.pipeline.commit(
    sendMessage,
    { conversationId, text },
    { burrowId: t.burrowId, actorId: IDS.mara },
  );
  if (res.status !== 'ok') throw new Error('not posted');
  return res.result.id;
}

/** Messages in a room now (the outsiders' turn must add none outside its own). */
async function count(conversationId: string): Promise<number> {
  const [row] = await t.services.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.n ?? 0;
}

describe('what a turn reads', () => {
  it('the person’s turn reads and searches another room of the burrow', async () => {
    await t.services.pipeline.commit(
      sendMessage,
      {
        conversationId: IDS.incidents,
        text: `Root cause ${WORD}: the signing key leaked in the deploy log.`,
      },
      { burrowId: t.burrowId, actorId: IDS.mara },
    );
    await new Promise((r) => setTimeout(r, 300));
    const dusty = await as(IDS.billing);
    const read = await dusty.call('read_conversation', { conversationId: IDS.incidents, limit: 20 });
    expect(read.body.status).toBe('ok');
    expect(JSON.stringify(read.body)).toContain(WORD);
    const search = await dusty.call('search', { query: WORD, limit: 20 });
    expect(search.body.status).toBe('ok');
    expect(JSON.stringify(search.body.results)).toContain(WORD);
  });

  it('an outsiders’ turn reads only its own thread and searches nothing', async () => {
    const root = await asked(IDS.billing, 'A customer wrote in about exports.');
    const outside = await as(IDS.billing, { outside: true, threadRootId: root });
    const own = await outside.call('read_conversation', {
      conversationId: IDS.billing,
      threadRootId: root,
      limit: 5,
    });
    expect(own.body.status).toBe('ok');
    const top = await outside.call('read_conversation', { conversationId: IDS.billing, limit: 5 });
    expect(top.body).toMatchObject({ error: { code: 'forbidden' } });
    const other = await outside.call('read_conversation', { conversationId: IDS.incidents, limit: 20 });
    expect(other.body).toMatchObject({ error: { code: 'forbidden' } });
    expect(JSON.stringify(other.body)).not.toContain(WORD);
    const search = await outside.call('search', { query: WORD, limit: 20 });
    expect(search.body).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('an outsiders’ turn reads no plan or canvas, of another room or without one', async () => {
    const outside = await as(IDS.general, { outside: true });
    // The seeded plan and its canvas are in #billing-v2.
    expect((await outside.call('plan_read', { planId: 'pln_invoice-pdf' })).body).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect((await outside.call('canvas_read', { canvas: 'invoice-pdf-export-plan' })).body).toMatchObject({
      error: { code: 'forbidden' },
    });
    const made = await t.services.pipeline.commit(
      createCanvas,
      { title: 'Burrow notes', markdown: `Notes ${WORD}` },
      { burrowId: t.burrowId, actorId: IDS.mara },
    );
    expect(made.status).toBe('ok');
    const [roomless] = await t.services.db
      .select({ slug: canvases.slug })
      .from(canvases)
      .where(and(eq(canvases.burrowId, t.burrowId), eq(canvases.title, 'Burrow notes')));
    const read = await outside.call('canvas_read', { canvas: roomless?.slug ?? '' });
    expect(read.body).toMatchObject({ error: { code: 'forbidden' } });
    expect(JSON.stringify(read.body)).not.toContain(WORD);
    // The person's turn reads it.
    const mine = await as(IDS.general);
    expect((await mine.call('canvas_read', { canvas: roomless?.slug ?? '' })).body).toMatchObject({
      status: 'ok',
    });
  });

  it('an outsiders’ turn never gets the room’s window, even in a pull request’s room', async () => {
    const room = await makeRoom(t.services, t.burrowId, 'feat/outside-window');
    await t.services.pipeline.commit(
      sendMessage,
      { conversationId: room, text: `Earlier: ${WORD}` },
      { burrowId: t.burrowId, actorId: IDS.mara },
    );
    const window = async (outside: boolean) => {
      const { dispatchId } = await agentTokenFor(
        t.services,
        t.burrowId,
        IDS.dusty,
        room,
        outside ? { onBehalfOfAccountId: null } : {},
      );
      const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
      if (!row) throw new Error('no dispatch');
      return (await buildDispatchContext(t.services, row)).window;
    };
    expect(JSON.stringify(await window(false))).toContain(WORD);
    expect(await window(true)).toEqual([]);
  });
});

describe('where an outsiders’ turn acts', () => {
  it('replies in its own thread only', async () => {
    const root = await asked(IDS.general, 'Someone mailed about the invoice.');
    const outside = await as(IDS.general, { outside: true, threadRootId: root });
    const own = await outside.call('reply_in_thread', { messageId: root, text: 'Thanks, noted.' });
    expect(own.body).toMatchObject({ status: 'ok' });
    // Not at the top level of its own room either.
    const top = await outside.call('post_message', { conversationId: IDS.general, text: 'Injected.' });
    expect(top.body).toMatchObject({ error: { code: 'forbidden' } });

    const before = await count(IDS.billing);
    const tries: [string, Record<string, unknown>][] = [
      ['post_message', { conversationId: IDS.billing, text: 'Injected.' }],
      ['reply_in_thread', { messageId: 'msg_billing-dusty-0941', text: 'Injected.' }],
      [
        'post_card',
        {
          conversationId: IDS.billing,
          text: 'Injected.',
          card: { kind: 'pill', text: 'Injected', tone: 'neutral' },
        },
      ],
      ['upload_file', { conversationId: IDS.billing, name: 'x.txt', text: 'injected' }],
      [
        'request_approval',
        {
          conversationId: IDS.billing,
          action: { type: 'grant_key', params: { keyId: 'web.browse' } },
          whatHappens: ['Read a page'],
          explainer: '',
          summary: '',
        },
      ],
      [
        'perform_action',
        {
          conversationId: IDS.billing,
          action: { type: 'merge_pr', params: { prNumber: 482, base: 'release' } },
          reason: 'Injected.',
        },
      ],
      [
        'start_run',
        {
          conversationId: IDS.billing,
          title: 'Injected',
          repo: 'whombat/billing',
          branch: 'feat/invoice-pdf',
          steps: [{ title: 'Do it', detail: '' }],
        },
      ],
      ['plan_create', { conversationId: IDS.billing, title: 'Injected', steps: [{ title: 'x' }] }],
      ['canvas_create', { conversationId: IDS.billing, title: 'Injected' }],
    ];
    for (const [tool, input] of tries) {
      const res = await outside.call(tool, input);
      expect([tool, res.body]).toMatchObject([tool, { error: { code: 'forbidden' } }]);
    }
    expect(await count(IDS.billing)).toBe(before);
  });
});
