/**
 * One Chat (docs/decisions/one-chat.md): a council going on from a thread shows on its row, and the lists an app from
 * before one Chat asks for keep every thread in Chat. Needs Postgres: a thread's row is a join of its first message with
 * its council and its members.
 */

import { newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import {
  catalogConnections,
  councilMembers,
  councils,
  delegations,
  delegationTasks,
  t3Watches,
} from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let mine: PersonalSetup;
let cookie: string;

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    name: 'Dusty',
    services: null,
    grants: [],
  });
  ({ cookie } = await sessionFor(t.services, IDS.mara));
});

async function send(text: string) {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: mine.dmId, text });
  if (res.status !== 'ok') throw new Error(`send: ${res.status}`);
  return res.result.id as string;
}

async function threads(place?: 'chat' | 'code') {
  const res = await t.api.inject({
    method: 'GET',
    url: `/api/v1/burrows/burrow-hq/chats/threads?room=chat${place ? `&place=${place}` : ''}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json().threads as {
    rootId: string;
    place?: string;
    code?: unknown;
    work?: unknown;
    handedOver?: boolean;
    job?: { outcome: string; endedAt: string } | null;
  }[];
}

async function place(rootId: string, body: Record<string, unknown>) {
  return t.api.inject({
    method: 'PUT',
    url: `/api/v1/burrows/burrow-hq/chats/threads/${rootId}/place`,
    headers: { cookie },
    payload: body,
  });
}

describe('one Chat', () => {
  it('an app from before one Chat finds every thread in Chat and none in Code', async () => {
    const rootId = await send('The backup page has been empty since yesterday, can you fix it?');
    expect((await threads()).some((x) => x.rootId === rootId)).toBe(true);
    expect((await threads('chat')).some((x) => x.rootId === rootId)).toBe(true);
    expect(await threads('code')).toEqual([]);

    const moved = await place(rootId, { place: 'code' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().thread).toMatchObject({ rootId });
    expect(moved.json().thread.place).toBeUndefined();
    const listed = (await threads()).find((x) => x.rootId === rootId);
    expect(listed?.place).toBeUndefined();
    expect(listed?.code).toBeUndefined();

    const unread = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/chats/unread?room=chat&place=code',
      headers: { cookie },
    });
    expect(unread.statusCode).toBe(200);
    expect(unread.json().threads).toEqual([]);
  });

  it('a council going on from a thread shows on its row', async () => {
    const rootId = await send('Can the council look at the Settings page?');
    const councilId = newId('council');
    const now = new Date();
    const connectionId = newId('connection');
    await t.services.db.insert(catalogConnections).values({
      id: connectionId,
      catalogId: 't3code',
      burrowId: t.burrowId,
      label: 'T3 Code',
      handle: 't3code-work-test',
      transport: 'mcp' as never,
      signIn: 'token' as never,
      baseUrl: 'http://127.0.0.1:1',
    });
    await t.services.db.insert(councils).values({
      id: councilId,
      burrowId: t.burrowId,
      conversationId: mine.dmId,
      threadRootId: rootId,
      agentId: mine.agentId,
      personId: IDS.mara,
      connectionId,
      kind: 'review',
      seats: [],
      title: 'Make the Settings page calmer',
      question: 'Is the Settings page cluttered?',
      stage: 'research',
      round: 1,
      roundsMax: 3,
      createdAt: now,
      updatedAt: now,
    });
    await t.services.db.insert(councilMembers).values(
      ['openai', 'claude', 'muse'].map((provider, position) => ({
        id: newId('councilMember'),
        councilId,
        burrowId: t.burrowId,
        role: 'member' as const,
        stage: 'research' as const,
        round: 1,
        position,
        provider,
        providerName: provider,
        model: 'm',
        label: provider,
        options: [],
        state: position === 1 ? ('working' as const) : ('done' as const),
        startedAt: now,
        deadline: new Date(now.getTime() + 3_600_000),
      })),
    );
    const row = (await threads()).find((x) => x.rootId === rootId);
    expect(row?.work).toMatchObject({ kind: 'council', stage: 'research', answered: 2, of: 3 });
  });

  it('a checklist whose one thread does several tasks counts what it said it finished, and works as one', async () => {
    const rootId = await send('Hand the Exams page list to T3 Code.');
    const now = new Date();
    const connectionId = newId('connection');
    await t.services.db.insert(catalogConnections).values({
      id: connectionId,
      catalogId: 't3code',
      burrowId: t.burrowId,
      label: 'T3 Code',
      handle: 't3code-work-tasks',
      transport: 'mcp' as never,
      signIn: 'token' as never,
      baseUrl: 'http://127.0.0.1:1',
    });
    const delegationId = newId('delegation');
    await t.services.db.insert(delegations).values({
      id: delegationId,
      burrowId: t.burrowId,
      conversationId: mine.dmId,
      threadRootId: rootId,
      agentId: mine.agentId,
      personId: IDS.mara,
      connectionId,
      title: 'Make the Exams page calmer',
      stage: 'working',
      atOnce: 3,
      handedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ids = [0, 1, 2, 3].map(() => newId('delegationTask'));
    await t.services.db.insert(delegationTasks).values(
      ids.map((id, position) => ({
        id,
        delegationId,
        burrowId: t.burrowId,
        position,
        title: `Task ${position + 1}`,
        brief: 'b',
        // The second wasn't handed over: the third is number 3 on the card all the same.
        state: position === 1 ? ('skipped' as const) : ('working' as const),
        threadId: position === 1 ? null : 'mcp:lead',
        startedAt: now,
        createdAt: new Date(now.getTime() + position),
      })),
    );
    await t.services.db.insert(t3Watches).values({
      burrowId: t.burrowId,
      connectionId,
      threadId: 'mcp:lead',
      title: 'Make the Exams page calmer (3 items)',
      conversationId: mine.dmId,
      threadRootId: rootId,
      agentId: mine.agentId,
      armedAt: now,
      delegationTaskId: ids[0] as string,
      progress: { said: 'Item 3 is in.', reported: { '3': 'Done.' }, saidAt: 9 },
    });
    const row = (await threads()).find((x) => x.rootId === rootId);
    expect(row?.work).toMatchObject({ kind: 'tasks', done: 1, total: 3, working: 1 });
  });

  it('an offered list shows as waiting for the person’s Hand over, counting its tasks', async () => {
    const rootId = await send('What would you change on the Inbox?');
    const now = new Date();
    const connectionId = newId('connection');
    await t.services.db.insert(catalogConnections).values({
      id: connectionId,
      catalogId: 't3code',
      burrowId: t.burrowId,
      label: 'T3 Code',
      handle: 't3code-work-offer',
      transport: 'mcp' as never,
      signIn: 'token' as never,
      baseUrl: 'http://127.0.0.1:1',
    });
    const delegationId = newId('delegation');
    await t.services.db.insert(delegations).values({
      id: delegationId,
      burrowId: t.burrowId,
      conversationId: mine.dmId,
      threadRootId: rootId,
      agentId: mine.agentId,
      personId: IDS.mara,
      connectionId,
      title: 'Calm the Inbox',
      stage: 'offer',
      atOnce: 3,
      createdAt: now,
      updatedAt: now,
    });
    await t.services.db.insert(delegationTasks).values(
      [0, 1, 2].map((position) => ({
        id: newId('delegationTask'),
        delegationId,
        burrowId: t.burrowId,
        position,
        title: `Task ${position + 1}`,
        brief: 'b',
        state: 'offered' as const,
        createdAt: new Date(now.getTime() + position),
      })),
    );
    const row = (await threads()).find((x) => x.rootId === rootId);
    // An app from before reads it as needing the person; this one as waiting for Hand over.
    expect(row?.work).toMatchObject({
      kind: 'tasks',
      offered: true,
      needsYou: true,
      total: 3,
      done: 0,
      working: 0,
    });
  });

  it('a thread says how its latest T3 Code job ended until the person writes again', async () => {
    const rootId = await send('Fix the Settle button in Feedback.');
    const connectionId = newId('connection');
    await t.services.db.insert(catalogConnections).values({
      id: connectionId,
      catalogId: 't3code',
      burrowId: t.burrowId,
      label: 'T3 Code',
      handle: 't3code-row-job',
      transport: 'mcp' as never,
      signIn: 'token' as never,
      baseUrl: 'http://127.0.0.1:1',
    });
    // Its work starts after the person's question and ends later still.
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const armedAt = later(1);
    const watch = {
      burrowId: t.burrowId,
      connectionId,
      threadId: 'mcp:settle',
      title: 'Dusty - Fix Settle',
      conversationId: mine.dmId,
      threadRootId: rootId,
      agentId: mine.agentId,
      armedAt,
    };
    const rowOf = async () => (await threads()).find((x) => x.rootId === rootId);
    const where = (threadId: string) =>
      and(eq(t3Watches.connectionId, connectionId), eq(t3Watches.threadId, threadId));

    // At work: nothing ended.
    await t.services.db.insert(t3Watches).values({ ...watch, status: 'running', runStartedAt: armedAt });
    expect((await rowOf())?.job).toBeUndefined();

    // Its run ended but it waits for a pull request's checks: not over yet.
    const endedAt = later(5);
    await t.services.db
      .update(t3Watches)
      .set({ status: 'completed', runEndedAt: endedAt, prs: ['#342'] })
      .where(where('mcp:settle'));
    expect((await rowOf())?.job).toBeUndefined();

    // Done: the watch went quiet after its end.
    await t.services.db.update(t3Watches).set({ state: 'idle', prs: [] }).where(where('mcp:settle'));
    expect((await rowOf())?.job).toEqual({ outcome: 'completed', endedAt: endedAt.toISOString() });

    // A newer job of the same thread that failed is the one that counts.
    const failedAt = later(8);
    await t.services.db.insert(t3Watches).values({
      ...watch,
      threadId: 'mcp:settle-2',
      armedAt: later(6),
      state: 'idle',
      status: 'failed',
      runEndedAt: failedAt,
    });
    expect((await rowOf())?.job).toMatchObject({ outcome: 'failed' });

    // The person wrote after it ended: their question is the news now.
    await t.services.db
      .update(t3Watches)
      .set({ runEndedAt: new Date(Date.now() - 1000) })
      .where(where('mcp:settle-2'));
    await t.commit(IDS.mara, sendMessage, {
      conversationId: mine.dmId,
      text: 'Try again?',
      threadRootId: rootId,
    });
    expect((await rowOf())?.job).toBeUndefined();
  });
});
