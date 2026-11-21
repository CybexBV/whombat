/**
 * Shared links (docs/decisions/share-links.md): the person shares a thread of their Chat, control keeps only a sealed
 * copy that the link's key opens, the list says how often it was opened, stopping deletes the copy (now, or in the
 * round when control can't be reached), a deleted thread's link stops, and the assistant's ask becomes a card whose yes
 * makes the link. Needs Postgres: the link's row, the thread's messages and the approval go through the commit pipeline.
 */
import { openSnapshot, parseShareLocation, shareFromBase64url } from '@whombat/core/share';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { deleteMessage } from '../commands/message-edits';
import { sendMessage } from '../commands/messages';
import { approvals, dispatches, events, shares } from '../db/schema/index';
import { ManagerCallError } from '../managed/ports';
import { FakeManager } from '../managed/testing';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { createShare } from './commands';
import { useShares } from './publish';
import { shareRound } from './round';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;
let cookie: string;
const manager = new FakeManager();

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
  useShares(t.services, manager);
});

beforeEach(() => {
  manager.shareFails = null;
});

async function thread(...texts: string[]) {
  const first = await t.commit(IDS.mara, sendMessage, { conversationId: mine.dmId, text: texts[0] });
  if (first.status !== 'ok') throw new Error('send');
  const rootId = (first.result as { id: string }).id;
  // The turn the question started is over, so the thread can be deleted later.
  await t.services.db.update(dispatches).set({ state: 'done' });
  for (const [i, text] of texts.slice(1).entries()) {
    const who = i % 2 === 0 ? mine.agentId : IDS.mara;
    const res = await t.commit(who, sendMessage, { conversationId: mine.dmId, text, threadRootId: rootId });
    if (res.status !== 'ok') throw new Error('reply');
  }
  await t.services.db.update(dispatches).set({ state: 'done' });
  return rootId;
}

const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  });

function opened(url: string) {
  const [path, hash] = url.replace(/^https?:\/\/[^/]+/, '').split('#');
  const at = parseShareLocation(path ?? '', `#${hash ?? ''}`);
  if (!at) throw new Error('not a share link');
  const kept = manager.shares.get(at.id);
  if (!kept) return null;
  return openSnapshot(shareFromBase64url(kept.envelope) as Uint8Array, at.id, at.key);
}

describe('shared links', () => {
  it('previews what a link shows and what to look at first', async () => {
    const rootId = await thread('Where is the NAS?', 'It is at 192.168.1.20 on your network.');
    const res = await req('POST', '/shares/preview', { rootId });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({
      messages: 2,
      pictures: 0,
      fits: { withPictures: true, withoutPictures: true },
    });
    expect(p.warnings.map((w: { kind: string }) => w.kind)).toEqual(['address']);
  });

  it('shares a thread: control keeps a sealed copy only the link opens, for seven days', async () => {
    const rootId = await thread('Plan a trip to Lisbon', 'May is lovely there.', 'And the food?');
    const res = await req('POST', '/shares', { rootId, pictures: true, expiry: '7d' });
    expect(res.statusCode, res.body).toBe(201);
    const { share } = res.json();
    expect(share).toMatchObject({ state: 'live', messages: 3, rootId, stopping: false });
    const days = (Date.parse(share.expiresAt) - Date.parse(share.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    const snapshot = opened(share.url);
    expect(snapshot?.messages.map((m) => m.from)).toEqual(['person', 'assistant', 'person']);
    expect(snapshot?.assistant.name).toBe('Dusty');
    // The copy at control can't be read without the key in the link's fragment.
    expect(manager.shares.get(share.id)?.envelope).not.toContain('Lisbon');
    const [event] = await t.services.db.select().from(events).where(eq(events.type, 'share.created'));
    expect(JSON.stringify(event?.payload)).not.toContain('Lisbon');
  });

  it('shares from one message of the thread on', async () => {
    const rootId = await thread('First question', 'First answer', 'Second question');
    const preview = await req('POST', '/shares/preview', { rootId });
    expect(preview.json().messages).toBe(3);
    const all = await t.services.db.query.messages.findMany({
      where: (m, { eq: is }) => is(m.threadRootId, rootId),
      orderBy: (m, { asc }) => [asc(m.createdAt), asc(m.ord)],
    });
    const res = await req('POST', '/shares', {
      rootId,
      fromMessageId: all[1]?.id,
      pictures: false,
      expiry: '1d',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(opened(res.json().share.url)?.messages.map((m) => m.text)).toEqual(['Second question']);
  });

  it('lists the links with how often each was opened, and stops one at control', async () => {
    const rootId = await thread('Something to share');
    const made = (await req('POST', '/shares', { rootId, pictures: true, expiry: 'never' })).json().share;
    const kept = manager.shares.get(made.id);
    if (kept) kept.views = 3;
    const list = (await req('GET', '/shares')).json().shares;
    expect(list.find((s: { id: string }) => s.id === made.id)).toMatchObject({ views: 3, expiresAt: null });
    const stop = await req('DELETE', `/shares/${made.id}`);
    expect(stop.statusCode, stop.body).toBe(200);
    expect(stop.json().share).toMatchObject({ state: 'stopped', stopping: false });
    expect(manager.shares.has(made.id)).toBe(false);
  });

  it('stops a link here when control can’t be reached and deletes the copy in the round', async () => {
    const rootId = await thread('Another one');
    const made = (await req('POST', '/shares', { rootId, pictures: true, expiry: '7d' })).json().share;
    manager.shareFails = new ManagerCallError(
      '/v1/runtime/shares/delete',
      503,
      'control_unreachable',
      'down',
    );
    const stop = await req('DELETE', `/shares/${made.id}`);
    expect(stop.json().share).toMatchObject({ state: 'stopped', stopping: true });
    manager.shareFails = null;
    await shareRound(t.services);
    expect(manager.shares.has(made.id)).toBe(false);
    const [row] = await t.services.db.select().from(shares).where(eq(shares.id, made.id));
    expect(row?.stopPending).toBe(false);
  });

  it('says so in plain words when control isn’t there and keeps no link', async () => {
    const rootId = await thread('Not today');
    manager.shareFails = new ManagerCallError('/v1/runtime/shares/put', 0, 'unreachable', 'no socket');
    const res = await req('POST', '/shares', { rootId, pictures: true, expiry: '7d' });
    expect(res.statusCode).toBe(503);
    const rows = await t.services.db.select().from(shares).where(eq(shares.rootId, rootId));
    expect(rows).toHaveLength(0);
  });

  it('stops the link of a thread that was deleted', async () => {
    const rootId = await thread('Delete me later');
    const made = (await req('POST', '/shares', { rootId, pictures: true, expiry: '7d' })).json().share;
    const gone = await t.commit(IDS.mara, deleteMessage, { messageId: rootId });
    expect(gone.status).toBe('ok');
    await shareRound(t.services);
    expect(manager.shares.has(made.id)).toBe(false);
    const [row] = await t.services.db.select().from(shares).where(eq(shares.id, made.id));
    expect(row?.stoppedAt).not.toBeNull();
  });

  it('turns the assistant’s ask into a card, and its yes makes the link', async () => {
    const rootId = await thread('Share this with my sister');
    const asked = await t.commit(mine.agentId, createShare, {
      rootId,
      pictures: true,
      expiry: '7d',
      personId: IDS.mara,
    });
    expect(asked.status).toBe('pending_approval');
    if (asked.status !== 'pending_approval') return;
    expect(await t.services.db.select().from(shares).where(eq(shares.rootId, rootId))).toHaveLength(0);
    const [a] = await t.services.db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    const yes = await t.commit(IDS.mara, decideApproval, { number: a?.number, decision: 'approve' });
    expect(yes.status).toBe('ok');
    const deadline = Date.now() + 5_000;
    let row: typeof shares.$inferSelect | undefined;
    while (Date.now() < deadline) {
      [row] = await t.services.db.select().from(shares).where(eq(shares.rootId, rootId));
      if (row?.viewerUrl) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(row?.viewerUrl).toBeTruthy();
    expect(row?.createdById).toBe(mine.agentId);
  });
});
