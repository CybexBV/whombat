/** Software work in the demo world: threads of Chat, with their work line and T3 Code's jobs for the job view. */
import { jobResultView, threadHandoffs, threadWorkLine } from '@whombat/client';
import { api, type ChatThread, HANDOFF_COUNCIL_STEP } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { jobParts, threadJob } from '../data/job';
import { messageMenu } from '../data/messageActions';
import { createClock } from '../lib/time';
import { CODE_RESULT_MESSAGE, CODE_ROOTS } from './code';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup() {
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: () => {},
    assistant: true,
    chat: true,
    code: true,
  });
  const call = (path: string, init?: RequestInit) =>
    server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  const threads = async (query = '') => {
    const res = await call(`/chats/threads${query}`);
    return api.chats.threads.response.parse(await res.json()).threads as ChatThread[];
  };
  const handoffs = async () => {
    const chats = api.chats.list.response.parse(await (await call('/chats')).json()).chats;
    const chatId = chats.find((c) => c.room === 'chat')?.id ?? '';
    const res = await call(`/conversations/${chatId}/handoffs`);
    return api.conversations.handoffs.response.parse(await res.json()).handoffs;
  };
  return { call, threads, handoffs, now };
}

describe('software work in the demo world', () => {
  it('is in Chat’s own list, each thread with its work line and its job', async () => {
    const s = setup();
    const open = await s.threads('?state=open');
    const ids = open.map((t) => t.rootId);
    for (const id of [CODE_ROOTS.council, CODE_ROOTS.tests, CODE_ROOTS.tasks, CODE_ROOTS.checks])
      expect(ids).toContain(id);
    expect(open.some((t) => t.place === 'code' || t.code)).toBe(false);
    const settled = await s.threads('?state=settled');
    expect(settled.map((t) => t.rootId)).toContain(CODE_ROOTS.done);

    const handoffs = await s.handoffs();
    const nowMs = s.now().getTime();
    const line = (rootId: string) => {
      const t = open.find((x) => x.rootId === rootId);
      return threadWorkLine(
        { work: t?.work ?? null },
        threadHandoffs(handoffs, rootId, t?.lastAt ?? null, nowMs),
        nowMs,
      );
    };
    expect(line(CODE_ROOTS.council)?.progress).toMatchObject({ kind: 'steps', done: 2, total: 3 });
    expect(line(CODE_ROOTS.tests)?.who).toBe('T3 Code');
    // The thread's job view: its latest hand-over, with the stage it is on.
    expect(threadJob(handoffs, CODE_ROOTS.tests)?.stage).toBeTruthy();
    expect(threadJob(handoffs, CODE_ROOTS.council)).toBeNull();
  });

  it('answers an older app’s move with the thread as it is, still in Chat', async () => {
    const s = setup();
    const res = await s.call(`/chats/threads/${CODE_ROOTS.tests}/place`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ place: 'code' }),
    });
    expect(api.chats.place.response.parse(await res.json()).thread.rootId).toBe(CODE_ROOTS.tests);
    expect((await s.threads('?state=open')).some((t) => t.rootId === CODE_ROOTS.tests)).toBe(true);
  });

  it('has a job whose result is T3 Code’s report as a message, with points to answer', async () => {
    const s = setup();
    const handoffs = await s.handoffs();
    const job = threadJob(handoffs, CODE_ROOTS.result);
    expect(job?.resultMessageId).toBe(CODE_RESULT_MESSAGE);
    // The message says how it went: the job draws no parts of its own.
    expect(job && jobParts(job)).toEqual([]);
    const thread = api.messages.thread.response.parse(
      await (await s.call(`/messages/${CODE_ROOTS.result}/thread`)).json(),
    );
    const message = thread.replies.find((m) => m.id === CODE_RESULT_MESSAGE);
    if (!message) throw new Error('no result message');
    expect(jobResultView(message)?.open).toBe(3);
    // Nobody edits T3 Code's report in place, not even as its author.
    const menu = messageMenu(
      message,
      { id: message.authorId, kind: 'person' },
      {
        inThread: true,
        features: { edit: true, pins: true },
      },
    );
    expect(menu?.actions.map((a) => a.kind)).not.toContain('edit');
  });

  it('puts the answers sent with the message and holds more until T3 Code is done', async () => {
    const s = setup();
    const answers = [
      { point: 1, title: 'Keep the unused groundwork for moving boxes?', choice: 'Remove', words: null },
    ];
    const send = () =>
      s.call(`/messages/${CODE_RESULT_MESSAGE}/job-answers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
    const res = await send();
    const { message } = api.messages.jobAnswers.response.parse(await res.json());
    const view = jobResultView(message);
    expect(view?.pending?.answers).toBe(1);
    expect(view?.points[0]?.answer?.choice).toBe('Remove');
    expect((await send()).status).toBe(409);
  });

  it('shows the council’s step on a job that waits for its council', async () => {
    const s = setup();
    const job = threadJob(await s.handoffs(), CODE_ROOTS.reviewing);
    expect(job?.steps.at(-1)?.text).toBe(HANDOFF_COUNCIL_STEP);
  });
});
