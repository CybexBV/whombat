/** A delegation in the demo world's Chat (delegate.md): the card parses as the contract has it, its four buttons act. */
import { api, type ChatThread, DelegationCard, type Message, type RealtimeEvent } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import {
  DELEGATION_ID,
  DELEGATION_ROOT,
  DELEGATION_SHOT_ATTACHMENT,
  DELEGATION_TASKS,
  type DelegationFixtureStage,
  delegationStageFrom,
} from './delegation';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup(delegation: DelegationFixtureStage | null) {
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: () => {},
    assistant: true,
    chat: true,
    delegation,
  });
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((event) => events.push(event));
  server.realtime.connect();
  const call = (path: string, init?: RequestInit) =>
    server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  const message = async () => {
    const res = await call(`/messages/${DELEGATION_ROOT}/thread`);
    const replies = api.messages.thread.response.parse(await res.json()).replies as Message[];
    return replies.find((m) => m.card?.kind === 'delegation') ?? null;
  };
  const card = async () => {
    const found = (await message())?.card;
    return found?.kind === 'delegation' ? found : null;
  };
  const listed = async () => {
    const res = await call('/chats/threads');
    const threads = api.chats.threads.response.parse(await res.json()).threads as ChatThread[];
    return threads.find((t) => t.rootId === DELEGATION_ROOT) ?? null;
  };
  const press = (which: 'pick' | 'ai' | 'start' | 'stop-task' | 'stop', body: Record<string, unknown> = {}) =>
    call(`/delegations/${which}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delegationId: DELEGATION_ID, ...body }),
    });
  const updated = () =>
    events.flatMap((e) =>
      e.type === 'message.updated' && e.message.card?.kind === 'delegation' ? [e.message.card] : [],
    );
  return { call, card, listed, message, press, updated };
}

describe('a delegation in the demo Chat', () => {
  it('has the checklist, the tasks at work or the ended card, as the contract has them', async () => {
    const offer = await setup('offer').card();
    expect(DelegationCard.parse(offer)).toMatchObject({ stage: 'offer', live: true });
    expect(offer?.tasks.filter((t) => t.picked)).toHaveLength(5);
    expect(offer?.tasks.find((t) => t.id === DELEGATION_TASKS.search)?.after).toBe(2);

    const s = setup('working');
    const working = DelegationCard.parse(await s.card());
    const of = (id: string) => working.tasks.find((t) => t.id === id);
    expect(working.tasks.filter((t) => t.merge === 'merged')).toHaveLength(2);
    expect(of(DELEGATION_TASKS.search)).toMatchObject({ state: 'working', checks: 'running' });
    expect(of(DELEGATION_TASKS.danger)?.merge).toBe('merging');
    expect(of(DELEGATION_TASKS.save)).toMatchObject({ state: 'done', checks: 'failing' });
    expect(of(DELEGATION_TASKS.contrast)?.pending).toBe('question');
    expect(working.note).toBeTruthy();
    // The search task's picture of what it changed is a file of the card's message.
    expect(of(DELEGATION_TASKS.search)?.shots?.[0]?.attachmentId).toBe(DELEGATION_SHOT_ATTACHMENT);
    expect((await s.message())?.attachments.map((a) => a.id)).toContain(DELEGATION_SHOT_ATTACHMENT);

    const done = DelegationCard.parse(await setup('done').card());
    expect(done).toMatchObject({ stage: 'done', live: false, outcome: 'incomplete' });
    expect(done.tasks.map((t) => t.state)).toContain('failed');
  });

  it('ticks and unticks a task on the card’s message', async () => {
    const s = setup('offer');
    const res = await s.press('pick', { taskId: DELEGATION_TASKS.names, picked: true });
    expect(api.delegations.pick.response.parse(await res.json())).toEqual({
      delegationId: DELEGATION_ID,
      stage: 'offer',
    });
    expect(s.updated()[0]?.tasks.find((t) => t.id === DELEGATION_TASKS.names)?.picked).toBe(true);
    expect((await s.press('pick', { taskId: 'dlt_nothing', picked: true })).status).toBe(404);
  });

  it('lists what T3 Code runs and keeps the AI chosen for a task or every task', async () => {
    const s = setup('offer');
    const listed = api.delegations.models.response.parse(await (await s.call('/delegations/models')).json());
    expect(listed.t3).toBe('ready');
    expect(listed.options?.flatMap((p) => p.models.map((m) => m.label))).toContain('GPT 6.1 Sol');
    const sol = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: true };
    const res = await s.press('ai', { taskId: DELEGATION_TASKS.rows, ai: sol });
    expect(api.delegations.setAi.response.parse(await res.json()).stage).toBe('offer');
    const card = await s.card();
    expect(card?.tasks.find((t) => t.id === DELEGATION_TASKS.rows)?.ai).toMatchObject({
      label: 'GPT 6.1 Sol',
      fast: true,
    });
    await s.press('ai', { ai: { ...sol, model: 'claude-sonnet-5-5', provider: 'claudeAgent', fast: null } });
    expect((await s.card())?.ai?.label).toBe('Claude Sonnet 5.5');
    await s.press('ai', { taskId: DELEGATION_TASKS.group, ai: null });
    expect((await s.card())?.tasks.find((t) => t.id === DELEGATION_TASKS.group)?.ai).toBeNull();
    // A model T3 Code doesn't run, a fast tier Sonnet hasn't, a task that isn't there.
    expect((await s.press('ai', { ai: { ...sol, model: 'gpt-0' } })).status).toBe(400);
    expect(
      (
        await s.press('ai', {
          ai: { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: null, fast: true },
        })
      ).status,
    ).toBe(400);
    expect((await s.press('ai', { taskId: 'dlt_nothing', ai: null })).status).toBe(404);
    // Handed over: the AI can't change any more.
    await s.press('start');
    expect((await s.press('ai', { ai: null })).status).toBe(409);
  });

  it('hands the ticked tasks over: up to three at work, the one after another waits, the rest skipped', async () => {
    const s = setup('offer');
    const res = await s.press('start');
    expect(api.delegations.start.response.parse(await res.json()).stage).toBe('working');
    const card = await s.card();
    expect(card?.handedAt).toBeTruthy();
    const state = (id: string) => card?.tasks.find((t) => t.id === id)?.state;
    expect(state(DELEGATION_TASKS.rows)).toBe('working');
    expect(state(DELEGATION_TASKS.search)).toBe('queued');
    expect(state(DELEGATION_TASKS.names)).toBe('skipped');
    // Handed over: no more ticks, no second hand-over.
    expect((await s.press('start')).status).toBe(409);
    expect((await s.press('pick', { taskId: DELEGATION_TASKS.names, picked: true })).status).toBe(409);
  });

  it('refuses a hand-over with nothing ticked', async () => {
    const s = setup('offer');
    for (const t of (await s.card())?.tasks ?? [])
      if (t.picked) await s.press('pick', { taskId: t.id, picked: false });
    expect((await s.press('start')).status).toBe(409);
  });

  it('says a thread with tasks at work doesn’t settle; a checklist or an ended card does', async () => {
    expect((await setup('working').listed())?.handedOver).toBe(true);
    expect((await setup('offer').listed())?.handedOver).toBe(false);
    expect((await setup('done').listed())?.handedOver).toBe(false);
  });

  it('stops one task, then all of them', async () => {
    const s = setup('working');
    const one = await s.press('stop-task', { taskId: DELEGATION_TASKS.contrast });
    expect(api.delegations.stopTask.response.parse(await one.json()).stage).toBe('working');
    expect((await s.card())?.tasks.find((t) => t.id === DELEGATION_TASKS.contrast)?.state).toBe('stopped');
    const all = await s.press('stop');
    expect(api.delegations.stop.response.parse(await all.json()).stage).toBe('stopped');
    const card = await s.card();
    expect(card).toMatchObject({ live: false, outcome: 'stopped' });
    expect(card?.tasks.map((t) => t.state)).not.toContain('working');
    expect((await s.press('stop')).status).toBe(409);
  });

  it('says Not now to a checklist: it ends without being handed over', async () => {
    const s = setup('offer');
    await s.press('stop');
    expect(await s.card()).toMatchObject({ stage: 'stopped', live: false, handedAt: null });
  });

  it('isn’t there unless asked for, and the switch takes its three stages and 1', async () => {
    const s = setup(null);
    const res = await s.call('/chats/threads');
    const threads = api.chats.threads.response.parse(await res.json()).threads as ChatThread[];
    expect(threads.map((t) => t.rootId)).not.toContain(DELEGATION_ROOT);
    expect(delegationStageFrom('working')).toBe('working');
    // `1`, as the other demo switches: the stage where most shows.
    expect(delegationStageFrom('1')).toBe('working');
    expect(delegationStageFrom('yes')).toBeNull();
    expect(delegationStageFrom(undefined)).toBeNull();
  });
});
