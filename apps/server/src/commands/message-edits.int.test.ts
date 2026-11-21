/**
 * Editing, deleting and pinning messages (docs/decisions/essentials-conversations.md EC-02…EC-16): who may, what an edit
 * wakes and notifies, whole threads removed with their first message (EC-04b), what a deletion takes with it, the pin limit, archived channels, and
 * what agents' context reads afterwards.
 */
import { api, buildPath, type Message, PINS_MAX, type RealtimeEvent } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  approvals,
  attachments,
  dispatches,
  events,
  messages,
  notifications,
  reactions,
  searchDocuments,
} from '../db/schema/index';
import { indexMessage } from '../domain/search-index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { makePng, upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { reactToMessage, sendMessage } from './messages';
import { createPlan } from './plans';

const t = useTestServer({ seed: true, app: true });
const cookies: Record<string, string> = {};
const frames: { topic: string; event: RealtimeEvent }[] = [];

beforeAll(async () => {
  cookies.mara = (await sessionFor(t.services, IDS.mara)).cookie;
  t.services.bus.onFrame((f) => frames.push({ topic: f.topic, event: f.event }));
});

const B = { burrow: 'burrow-hq' };
const url = (ep: { base: string; path: string }, params: Record<string, string>) =>
  `${ep.base}${buildPath(ep.path, { ...B, ...params })}`;

async function call(
  method: 'PATCH' | 'DELETE' | 'PUT' | 'GET',
  ep: { base: string; path: string },
  params: Record<string, string>,
  who: string,
  payload?: unknown,
) {
  const res = await t.api.inject({
    method,
    url: url(ep, params),
    headers: { cookie: cookies[who] as string },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function post(authorId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await t.commit(authorId, sendMessage, { conversationId: IDS.billing, text, ...extra });
  if (res.status !== 'ok') throw new Error(`send: ${res.status}`);
  return res.result.id;
}

const row = async (id: string) => (await t.services.db.select().from(messages).where(eq(messages.id, id)))[0];
const edit = (id: string, text: string, who = 'mara') =>
  call('PATCH', api.messages.edit, { messageId: id }, who, { text });
const del = (id: string, who = 'mara') => call('DELETE', api.messages.delete, { messageId: id }, who);
const pin = (id: string, pinned: boolean, who = 'mara') =>
  call('PUT', api.messages.pin, { messageId: id }, who, { pinned });

describe('editing', () => {
  it('lets the person edit their own words: editedAt, a message.updated frame and an event without text', async () => {
    const id = await post(IDS.mara, 'Draft of the PDF plan');
    frames.length = 0;
    const res = await edit(id, 'Final PDF plan');
    expect(res.status).toBe(200);
    const message = res.body.message as Message;
    expect(message.text).toBe('Final PDF plan');
    expect(message.editedAt).not.toBeNull();
    expect(
      frames.some(
        (f) => f.event.type === 'message.updated' && f.event.message.id === id && f.event.message.editedAt,
      ),
    ).toBe(true);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'message.edited'), sql`${events.payload}->>'messageId' = ${id}`));
    expect(event?.kind).toBe('Messages');
    expect(event?.text).toBeNull();
    expect(JSON.stringify(event?.payload)).not.toContain('PDF');
    // The search document reads the new words.
    await indexMessage(t.services.db, id);
    const [doc] = await t.services.db.select().from(searchDocuments).where(eq(searchDocuments.id, id));
    expect(doc?.text).toContain('Final');
  });

  it('refuses agents', async () => {
    const id = await post(IDS.mara, 'Mine to change');
    const res = t.commit(IDS.dusty, (await import('./message-edits')).editMessage, {
      messageId: id,
      text: 'Dusty was here',
    });
    await expect(res).rejects.toThrow(/Agents don’t edit/);
  });

  it('refuses cards and empty text', async () => {
    const plan = await t.commit(IDS.mara, createPlan, {
      conversationId: IDS.billing,
      title: 'Edit test plan',
      steps: [{ title: 'One step' }],
    });
    if (plan.status !== 'ok') throw new Error('plan');
    const planMessage = (plan.result as { messageId: string }).messageId;
    const [card] = await t.services.db.select().from(messages).where(eq(messages.id, planMessage));
    expect(card?.card).not.toBeNull();
    expect((await edit(planMessage, 'Not a card any more')).status).toBe(400);
    const id = await post(IDS.mara, 'Something');
    expect((await edit(id, '')).status).toBe(400);
  });

  it('lets an attachment-only message gain text', async () => {
    const file = await upload(
      t.api,
      { cookie: cookies.mara as string },
      IDS.billing,
      'dot.png',
      makePng(2, 2),
    );
    const id = await post(IDS.mara, '', { attachmentIds: [file.id] });
    const res = await edit(id, 'The logo, 2 px');
    expect(res.status).toBe(200);
    expect((res.body.message as Message).attachments.map((a) => a.id)).toEqual([file.id]);
  });

  it('wakes an agent an edit newly mentions, once', async () => {
    const id = await post(IDS.mara, 'Can someone look at the rounding?');
    expect((await edit(id, 'Can @Dusty look at the rounding?')).status).toBe(200);
    const woken = () =>
      t.services.db
        .select()
        .from(dispatches)
        .where(and(eq(dispatches.messageId, id), eq(dispatches.agentId, IDS.dusty)));
    expect(await woken()).toHaveLength(1);
    // Removing the mention and adding it back wakes nobody again; nor does a plain edit.
    await edit(id, 'Can someone look at the rounding?');
    await edit(id, 'Can @Dusty look at the rounding, please?');
    expect(await woken()).toHaveLength(1);
    // Mentions are read again from the new words.
    expect((await row(id))?.mentions).toEqual([IDS.dusty]);
  });

  it('clears previews of links that are gone', async () => {
    const id = await post(IDS.mara, 'The build is green https://example.com/build');
    await t.services.db
      .update(messages)
      .set({
        previews: [{ url: 'https://example.com/build', title: 'Build', description: null, siteName: null }],
      })
      .where(eq(messages.id, id));
    await edit(id, 'The build is green');
    expect((await row(id))?.previews).toBeNull();
  });

  it('keeps stale words out of the agent’s sessions and shows the current words in its context', async () => {
    const id = await post(IDS.mara, '@Dusty use the old VAT table');
    // A turn that saw the words ran in a Hermes session: the edit forgets it (HE-S119).
    const { dispatchId: earlier } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
    const at = t.services.clock();
    await t.services.db
      .update(dispatches)
      .set({ state: 'done', providerSessionId: 'hermes:local-vat', claimedAt: at, finishedAt: at })
      .where(eq(dispatches.id, earlier));
    await edit(id, '@Dusty use the new VAT table');
    const [ran] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, earlier));
    expect(ran?.providerSessionId).toBeNull();
    // Dusty's queued turn here (mentions coalesce into one) reads the message as it is now.
    const [dispatch] = await t.services.db
      .select()
      .from(dispatches)
      .where(
        and(
          eq(dispatches.agentId, IDS.dusty),
          eq(dispatches.conversationId, IDS.billing),
          eq(dispatches.state, 'queued'),
        ),
      );
    if (!dispatch) throw new Error('no dispatch');
    const context = await buildDispatchContext(t.services, dispatch);
    const seen = [context.trigger, ...context.window].filter((m) => m?.id === id);
    expect(seen.length).toBeGreaterThan(0);
    for (const m of seen) {
      expect(m?.text).toBe('@Dusty use the new VAT table');
      expect(m?.editedAt).not.toBeNull();
    }
    expect(JSON.stringify(context)).not.toContain('old VAT table');
  });
});

describe('deleting', () => {
  it('removes a message without replies: gone for every reader, its reactions, search document and inbox rows too', async () => {
    const id = await post(IDS.mara, 'Oops, wrong channel');
    await t.commit(IDS.mara, reactToMessage, { messageId: id, value: '👀', on: true });
    await indexMessage(t.services.db, id);
    frames.length = 0;
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: id, message: null });
    expect(await row(id)).toBeUndefined();
    expect(await t.services.db.select().from(reactions).where(eq(reactions.messageId, id))).toHaveLength(0);
    expect(await t.services.db.select().from(searchDocuments).where(eq(searchDocuments.id, id))).toHaveLength(
      0,
    );
    expect(
      await t.services.db
        .select()
        .from(notifications)
        .where(sql`${notifications.link}->>'messageId' = ${id}`),
    ).toHaveLength(0);
    expect(frames.some((f) => f.event.type === 'message.deleted' && f.event.messageId === id)).toBe(true);
    expect((await call('GET', api.messages.get, { messageId: id }, 'mara')).status).toBe(404);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'message.deleted'), sql`${events.payload}->>'messageId' = ${id}`));
    expect(event).toMatchObject({ kind: 'Messages', text: null });
    expect(JSON.stringify(event?.payload)).not.toContain('Oops');
  });

  it('removes the whole thread with its first message', async () => {
    const root = await post(IDS.mara, 'Root with a secret');
    const mine = await post(IDS.mara, 'My own reply', { threadRootId: root });
    const agents = await post(IDS.dusty, 'An agent’s reply', { threadRootId: root });
    await t.commit(IDS.mara, reactToMessage, { messageId: agents, value: '👀', on: true });
    frames.length = 0;
    const res = await del(root);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: root, message: null });
    for (const id of [root, mine, agents]) expect(await row(id)).toBeUndefined();
    expect(await t.services.db.select().from(reactions).where(eq(reactions.messageId, agents))).toHaveLength(
      0,
    );
    const gone = frames
      .filter((f) => f.event.type === 'message.deleted')
      .map((f) => (f.event as { messageId: string }).messageId);
    expect(gone.sort()).toEqual([root, mine, agents].sort());
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'message.deleted'), sql`${events.payload}->>'messageId' = ${root}`));
    expect(event?.payload).toMatchObject({ removed: true, replies: 2 });
  });

  it('keeps a thread an agent is still working in', async () => {
    // No earlier test's turn is still open: Dusty's mention here starts its own.
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
    const root = await post(IDS.mara, 'Totals look off');
    await post(IDS.mara, '@Dusty can you check?', { threadRootId: root });
    expect((await del(root)).status).toBe(409);
    await t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(
        and(eq(dispatches.threadRootId, root), inArray(dispatches.state, ['queued', 'claimed', 'running'])),
      );
    expect((await del(root)).status).toBe(200);
    expect(await row(root)).toBeUndefined();
  });

  it('removes a thread whose first message was kept as a tombstone before, replies and all', async () => {
    const root = await post(IDS.mara, 'Deleted before whole threads went');
    const reply = await post(IDS.mara, 'Still here', { threadRootId: root });
    await t.services.db
      .update(messages)
      .set({ text: '', card: null, deletedAt: new Date() })
      .where(eq(messages.id, root));
    // The tombstone kept for its replies goes now, and they with it.
    expect((await del(root)).status).toBe(200);
    expect(await row(root)).toBeUndefined();
    expect(await row(reply)).toBeUndefined();
  });

  it('updates a thread’s counts when a reply goes', async () => {
    const root = await post(IDS.mara, 'Counting replies');
    const a = await post(IDS.mara, 'first', { threadRootId: root });
    await post(IDS.dusty, 'second', { threadRootId: root });
    await del(a, 'mara');
    const r = await row(root);
    expect(r?.replyCount).toBe(1);
    expect(r?.threadParticipantIds).toEqual([IDS.dusty]);
  });

  it('never lets agents delete a message', async () => {
    const id = await post(IDS.mara, 'Something to keep');
    await expect(
      t.commit(IDS.dusty, (await import('./message-edits')).deleteMessage, { messageId: id }),
    ).rejects.toThrow(/Agents don’t delete/);
  });

  it('keeps a message that holds live work', async () => {
    const plan = await t.commit(IDS.mara, createPlan, {
      conversationId: IDS.billing,
      title: 'Delete test plan',
      steps: [{ title: 'Step' }],
    });
    if (plan.status !== 'ok') throw new Error('plan');
    expect((await del((plan.result as { messageId: string }).messageId)).status).toBe(409);
  });

  it('removes a finished guide card but keeps an open one (EC-04c)', async () => {
    const guide = (state: 'open' | 'done' | 'expired') => ({
      kind: 'guide' as const,
      guide: 'welcome',
      node: 'start',
      step: null,
      title: 'Hi, I’m your assistant',
      body: '',
      blocks: [],
      state,
      answer: null,
    });
    const ids: Record<string, string> = {};
    for (const state of ['open', 'done', 'expired'] as const) {
      ids[state] = await post(IDS.mara, `Guide ${state}`);
      await t.services.db
        .update(messages)
        .set({ card: guide(state) })
        .where(eq(messages.id, ids[state] as string));
    }
    expect((await del(ids.open as string)).status).toBe(409);
    expect((await del(ids.done as string)).status).toBe(200);
    expect((await del(ids.expired as string)).status).toBe(200);
    expect(await row(ids.done as string)).toBeUndefined();
  });

  it('removes a thread whose approval was decided, not one still waiting for it (EC-04c)', async () => {
    const root = await post(IDS.mara, 'Can you restart staging?');
    const asked = await post(IDS.dusty, 'Approval', { threadRootId: root });
    await t.services.db
      .update(messages)
      .set({ card: { kind: 'approval', approvalId: 'apr_staging-482' } })
      .where(eq(messages.id, asked));
    await t.services.db
      .update(approvals)
      .set({ state: 'pending' })
      .where(eq(approvals.id, 'apr_staging-482'));
    expect((await del(root)).status).toBe(409);
    await t.services.db
      .update(approvals)
      .set({ state: 'approved' })
      .where(eq(approvals.id, 'apr_staging-482'));
    expect((await del(root)).status).toBe(200);
    expect(await row(asked)).toBeUndefined();
  });

  it('removes the files of a deleted message, and their bytes once nothing uses them', async () => {
    const png = makePng(3, 3, [1, 2, 3]);
    const file = await upload(t.api, { cookie: cookies.mara as string }, IDS.billing, 'x.png', png);
    const id = await post(IDS.mara, 'with a file', { attachmentIds: [file.id] });
    const [stored] = await t.services.db.select().from(attachments).where(eq(attachments.id, file.id));
    const key = stored?.blobKey as string;
    expect(await t.services.files.store.size(key)).toBe(png.length);
    expect((await del(id)).status).toBe(200);
    expect(await t.services.db.select().from(attachments).where(eq(attachments.id, file.id))).toHaveLength(0);
    // No other row holds these bytes: they are gone after the commit.
    expect(await t.services.files.store.size(key)).toBeNull();
    // Served no more.
    const res = await t.api.inject({
      method: 'GET',
      url: file.url,
      headers: { cookie: cookies.mara as string },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('pinning', () => {
  it('pins and unpins for the person in the conversation, newest pin first', async () => {
    const a = await post(IDS.mara, 'Pin me first');
    const b = await post(IDS.mara, 'Pin me second');
    expect((await pin(a, true)).status).toBe(200);
    const pinned = await pin(b, true);
    expect(pinned.body.message).toMatchObject({ id: b, pinnedById: IDS.mara });
    const list = await call('GET', api.conversations.pins, { conversationId: IDS.billing }, 'mara');
    const ids = (list.body.messages as Message[]).map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual([b, a]);
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'message.pinned'), sql`${events.payload}->>'messageId' = ${a}`));
    expect(event).toMatchObject({ kind: 'Messages' });
    expect((await pin(a, false)).status).toBe(200);
    expect((await row(a))?.pinnedAt).toBeNull();
    // Agents don't pin.
    await expect(
      t.commit(IDS.dusty, (await import('./message-edits')).pinMessage, { messageId: b, pinned: false }),
    ).rejects.toThrow(/Agents don’t pin/);
  });

  it(`stops at ${PINS_MAX} pins per conversation`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < PINS_MAX + 1; i++) ids.push(await post(IDS.mara, `pin candidate ${i}`));
    await t.services.db
      .update(messages)
      .set({ pinnedAt: null })
      .where(eq(messages.conversationId, IDS.billing));
    await t.services.db
      .update(messages)
      .set({ pinnedAt: new Date(), pinnedById: IDS.mara })
      .where(inArray(messages.id, ids.slice(0, PINS_MAX)));
    const over = await pin(ids[PINS_MAX] as string, true);
    expect(over.status).toBe(409);
    expect(String((over.body.error as { message: string }).message)).toMatch(/Unpin one first/);
    const list = await call('GET', api.conversations.pins, { conversationId: IDS.billing }, 'mara');
    expect((list.body.messages as Message[]).length).toBe(PINS_MAX);
    await t.services.db
      .update(messages)
      .set({ pinnedAt: null, pinnedById: null })
      .where(eq(messages.conversationId, IDS.billing));
  });
});

describe('mentions in any letter case (messaging.md MS-C01, MS-C02)', () => {
  const openTurns = () =>
    t.services.db
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: new Date() })
      .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
  const turnsFor = (messageId: string, agentId: string) =>
    t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, agentId)));

  it('wakes Dusty for “@dusty hi” in a channel thread and stores “@Dusty hi” everywhere', async () => {
    await openTurns();
    const root = await post(IDS.mara, 'Rounding question');
    frames.length = 0;
    const id = await post(IDS.mara, '@dusty hi', { threadRootId: root });
    const stored = await row(id);
    expect(stored?.text).toBe('@Dusty hi');
    expect(stored?.mentions).toEqual([IDS.dusty]);
    expect(await turnsFor(id, IDS.dusty)).toHaveLength(1);
    // The realtime frame and the search document read the canonical text too.
    expect(
      frames.some(
        (f) =>
          f.event.type === 'message.created' &&
          f.event.message.id === id &&
          f.event.message.text === '@Dusty hi',
      ),
    ).toBe(true);
    await indexMessage(t.services.db, id);
    const [doc] = await t.services.db.select().from(searchDocuments).where(eq(searchDocuments.id, id));
    expect(doc?.text).toContain('@Dusty hi');
    await openTurns();
  });

  it('leaves an email address, a path and code alone, and canonicalises an agent’s words too', async () => {
    await openTurns();
    const id = await post(IDS.mara, 'Mail john@dusty.example or see x/@dusty and `@dusty`');
    expect((await row(id))?.text).toBe('Mail john@dusty.example or see x/@dusty and `@dusty`');
    expect((await row(id))?.mentions).toEqual([]);
    expect(await turnsFor(id, IDS.dusty)).toHaveLength(0);
    const fromDusty = await post(IDS.dusty, 'Over to you, @MARA.');
    expect((await row(fromDusty))?.text).toBe('Over to you, @Mara.');
    expect((await row(fromDusty))?.mentions).toEqual([IDS.mara]);
    await openTurns();
  });

  it('stores an edit to “@dusty” as “@Dusty” and wakes Dusty once; a change of letter case alone is no edit', async () => {
    await openTurns();
    const id = await post(IDS.mara, 'Who knows the VAT rules?');
    const res = await edit(id, 'Who knows the VAT rules, @dusty?');
    expect(res.status).toBe(200);
    expect((res.body.message as Message).text).toBe('Who knows the VAT rules, @Dusty?');
    expect((await row(id))?.mentions).toEqual([IDS.dusty]);
    expect(await turnsFor(id, IDS.dusty)).toHaveLength(1);
    const editedAt = (await row(id))?.editedAt;
    const again = await edit(id, 'Who knows the VAT rules, @DUSTY?');
    expect(again.status).toBe(200);
    expect((await row(id))?.editedAt).toEqual(editedAt);
    expect(await turnsFor(id, IDS.dusty)).toHaveLength(1);
    await openTurns();
  });
});
