/** Councils in the demo world's Chat (council.md): the cards parse as the contract has them, Stop acts. */
import {
  api,
  type ChatThread,
  COUNCIL_CARD_ANSWER_MAX,
  CouncilCard,
  DelegationCard,
  type Message,
  type RealtimeEvent,
} from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { COUNCIL_IDS, COUNCIL_ROOTS, COUNCIL_SHOT_ATTACHMENT } from './council';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup(councils = true) {
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: () => {},
    assistant: true,
    chat: true,
    councils,
  });
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((event) => events.push(event));
  server.realtime.connect();
  const call = (path: string, init?: RequestInit) =>
    server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  const thread = async (rootId: string) => {
    const res = await call(`/messages/${rootId}/thread`);
    return api.messages.thread.response.parse(await res.json()).replies as Message[];
  };
  const press = (councilId: string) =>
    call('/councils/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ councilId }),
    });
  const threads = async () => {
    const res = await call('/chats/threads');
    return api.chats.threads.response.parse(await res.json()).threads as ChatThread[];
  };
  return { call, events, press, thread, threads };
}

const councilOf = (replies: Message[]) =>
  replies.flatMap((m) => (m.card?.kind === 'council' ? [{ message: m, card: m.card }] : []))[0];

describe('councils in the demo Chat', () => {
  it('has a review at work, a plan being built and a finished council, as the contract has them', async () => {
    const s = setup();
    const review = councilOf(await s.thread(COUNCIL_ROOTS.review));
    expect(CouncilCard.parse(review?.card).members.map((m) => m.state)).toEqual([
      'working',
      'done',
      'no_answer',
    ]);
    const gpt = review?.card.members.find((m) => m.state === 'done');
    expect(gpt?.score).toBe(8);
    // Its answer is as long as the card opens to: T3 Code has the rest.
    expect(gpt?.answer?.length).toBe(COUNCIL_CARD_ANSWER_MAX);
    const final = councilOf(await s.thread(COUNCIL_ROOTS.final));
    expect(final?.card).toMatchObject({ live: false, outcome: 'done' });
    expect(final?.card.shots[0]?.attachmentId).toBe(COUNCIL_SHOT_ATTACHMENT);
    expect(final?.message.attachments.map((a) => a.id)).toContain(COUNCIL_SHOT_ATTACHMENT);
  });

  it('builds through a checklist of the plan’s tasks right under the council’s card', async () => {
    const s = setup();
    const replies = await s.thread(COUNCIL_ROOTS.build);
    const build = councilOf(replies);
    // It waits for the go-ahead, which is the checklist's Hand over.
    expect(build?.card).toMatchObject({ stage: 'approve', live: true });
    expect(build?.card.plan).toBeTruthy();
    expect(build?.card.members.every((m) => m.answer)).toBe(true);
    const at = replies.findIndex((m) => m.id === build?.message.id);
    const checklist = replies[at + 1]?.card;
    expect(checklist?.kind).toBe('delegation');
    expect(DelegationCard.parse(checklist)).toMatchObject({ council: true, stage: 'offer' });
  });

  it('says a thread with a council at work doesn’t settle, and refuses to settle it', async () => {
    const s = setup();
    const listed = await s.threads();
    const of = (rootId: string) => listed.find((t) => t.rootId === rootId);
    expect(of(COUNCIL_ROOTS.review)?.handedOver).toBe(true);
    expect(of(COUNCIL_ROOTS.build)?.handedOver).toBe(true);
    expect(of(COUNCIL_ROOTS.final)?.handedOver).toBe(false);
    const res = await s.call(`/chats/threads/${COUNCIL_ROOTS.review}/settled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settled: true }),
    });
    expect(res.status).toBe(409);
  });

  it('stops a council: it ends as stopped, its working member too', async () => {
    const s = setup();
    const res = await s.press(COUNCIL_IDS.review);
    expect(api.councils.stop.response.parse(await res.json()).stage).toBe('stopped');
    const card = councilOf(await s.thread(COUNCIL_ROOTS.review))?.card;
    expect(card).toMatchObject({ live: false, outcome: 'stopped' });
    expect(card?.members.map((m) => m.state)).not.toContain('working');
    expect((await s.press('cnl_nothing')).status).toBe(404);
    // Ended: its thread can settle again.
    expect((await s.threads()).find((t) => t.rootId === COUNCIL_ROOTS.review)?.handedOver).toBe(false);
  });

  it('isn’t there unless asked for', async () => {
    const s = setup(false);
    expect((await s.threads()).map((t) => t.rootId)).not.toContain(COUNCIL_ROOTS.review);
  });
});
