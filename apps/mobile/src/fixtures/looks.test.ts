/**
 * Looks Neo looked into in the demo world (look-research-mobile.md AP-5925): on Needs you with their research, on Home
 * Assistant's page, with their threads in Chat; the step goes from found to fixing to fixed with the go-ahead and Neo's
 * word in the thread; every answer parses with its endpoint's schema (the client checks them).
 */
import { api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { DEFAULT_CHAT_ID } from './assistant';
import { createFixtureServer } from './fixture-server';
import { LOOK_KEYS, LOOK_ROOTS } from './looks';

const burrow = 'burrow-hq';

function setup(looks = true) {
  const now = createClock(new Date(at('14:05')), Date.now());
  const timers: (() => void)[] = [];
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: (fn) => timers.push(fn),
    assistant: true,
    chat: true,
    looks,
  });
  return { client: demoClient(server.fetch, { validateResponses: true }), timers };
}

async function home(client: ReturnType<typeof setup>['client']) {
  const res = await client.request(api.home.overview, { params: { burrow } });
  if (res.status !== 'ok') throw new Error(res.status);
  return res.data;
}

describe('looks in the demo world', () => {
  it('puts each look on Needs you with its research, and Home Assistant’s on its page', async () => {
    const { client } = setup();
    const items = (await home(client)).needsYou.filter((i) => i.research);
    expect(items.map((i) => [i.research?.key, i.research?.state, i.research?.fix ?? null])).toEqual([
      [LOOK_KEYS.ha, 'found', 'Restart Zigbee'],
      [LOOK_KEYS.unifi, 'found', null],
      [LOOK_KEYS.pve, 'looking', null],
    ]);
    const page = await client.request(api.things.page, { params: { burrow, thing: LOOK_KEYS.ha } });
    if (page.status !== 'ok') throw new Error(page.status);
    expect(page.data.research?.state).toBe('found');
    const threads = await client.request(api.chats.threads, { params: { burrow }, query: { room: 'chat' } });
    if (threads.status !== 'ok') throw new Error(threads.status);
    const roots = threads.data.threads.map((t) => t.rootId);
    for (const id of Object.values(LOOK_ROOTS)) expect(roots).toContain(id);
    expect(threads.data.threads.find((t) => t.rootId === LOOK_ROOTS.pve)?.working).toBe(true);
  });

  it('takes the step: fixing with Mara’s go-ahead in the thread, then fixed with Neo’s word', async () => {
    const { client, timers } = setup();
    const fixed = await client.request(api.looks.fix, { params: { burrow }, body: { key: LOOK_KEYS.ha } });
    if (fixed.status !== 'ok') throw new Error(fixed.status);
    expect(fixed.data.research).toMatchObject({ state: 'fixing' });
    expect(fixed.data.research.fix).toBeUndefined();
    const thread = async () => {
      const res = await client.request(api.messages.thread, {
        params: { burrow, messageId: LOOK_ROOTS.ha },
      });
      if (res.status !== 'ok') throw new Error(res.status);
      return res.data;
    };
    expect((await thread()).replies.at(-1)?.text).toContain('restart Zigbee');
    for (const fn of timers.splice(0)) fn();
    const item = (await home(client)).needsYou.find((i) => i.research?.key === LOOK_KEYS.ha);
    expect(item?.research).toMatchObject({ state: 'fixed', title: 'Zigbee works again' });
    expect((await thread()).replies.length).toBe(3);
  });

  it('refuses a step it doesn’t offer, and is off by default', async () => {
    const { client } = setup();
    const none = await client
      .request(api.looks.fix, { params: { burrow }, body: { key: LOOK_KEYS.unifi } })
      .then(
        (r) => r.status,
        (e: { status?: number }) => e.status,
      );
    expect(none).toBe(404);
    const off = setup(false);
    expect((await home(off.client)).needsYou.some((i) => i.research)).toBe(false);
  });

  it('the look’s thread is in Mara’s Chat', async () => {
    const { client } = setup();
    const res = await client.request(api.messages.thread, {
      params: { burrow, messageId: LOOK_ROOTS.unifi },
    });
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.data.conversationId).toBe(DEFAULT_CHAT_ID);
    expect(res.data.root.subject?.id).toBe('con_unifi');
  });
});
