/**
 * The settled-cards world (`EXPO_PUBLIC_WHOMBAT_SETTLE=1`, AP-730…AP-735) through the fixture server and the chat view
 * model: the roots in PR #482's room, the report thread folded and settled as on John's reports thread, the live runs
 * in their threads and the agent saying what it does.
 */
import type { RealtimeEvent } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { chatItems } from '../data/messages';
import { threadWorkView } from '../data/working';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { minutesAfterSeed, worldContext } from '../test/world';
import { createFixtureServer } from './fixture-server';
import { DEPLOY_ROOT, QUESTION_ROOT, REPORT_ROOT, SETTLE_ROOM } from './settle';

const burrow = 'burrow-hq';

function setup() {
  const now = createClock(minutesAfterSeed(0), Date.now());
  const stops: (() => void)[] = [];
  const pulses: (() => void)[] = [];
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    settle: true,
    every: (fn) => {
      pulses.push(fn);
      return () => stops.push(fn);
    },
  });
  const client = demoClient(server.fetch);
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((e) => events.push(e));
  server.realtime.connect();
  return { client, events, pulses };
}

describe('the settle world', () => {
  it('adds the three roots to PR #482’s room, in time order', async () => {
    const { client } = setup();
    const page = await client.messages.list({ params: { burrow, conversationId: SETTLE_ROOM } });
    const roots = [REPORT_ROOT, DEPLOY_ROOT, QUESTION_ROOT];
    expect(page.messages.map((m) => m.id).filter((id) => roots.includes(id))).toEqual(roots);
  });

  it('shows the report thread as John would want it: lines, runs with what they did, cards only for the active', async () => {
    const { client } = setup();
    const thread = await client.messages.thread({ params: { burrow, messageId: REPORT_ROOT } });
    const messages = [thread.root, ...thread.replies];
    const items = chatItems(messages, worldContext(), { authors: true, threads: false });
    // The schedule is inside its run.
    expect(items).toHaveLength(messages.length - 1);
    const shown = items.map((i) => [
      i.display,
      i.line?.lead ?? i.card?.runSettled?.line.lead ?? i.card?.runLine?.lead,
    ]);
    expect(shown).toEqual([
      ['full', undefined],
      ['line', 'Assessment · FB-7K3Q-9M2X'],
      [null, undefined],
      ['line', 'Run #3101 · Done in 6m 12s'],
      ['line', 'Plan · 4 of 4 done'],
      ['line', 'Run #3102 · Done in 3m 40s'],
      ['line', 'Run #3103 · Done in 1m 05s'],
      ['line', 'Turn failed'],
      ['line', 'Approved by Mara Okafor'],
      ['live', 'Checking'],
      ['full', 'Needs attention'],
    ]);
    const fix = items.find((i) => i.id === 'msg_settle-run1');
    expect(fix?.card?.runSettled?.chips).toEqual({ prNumber: 3, diff: '+12 −8', files: '3 files' });
    expect(fix?.inside).toEqual([]);
    const follow = items.find((i) => i.id === 'msg_settle-run2');
    expect(follow?.inside.map((s) => s.line.lead)).toEqual(['Once, Wed 23 Sep at 15:23']);
    expect(items.find((i) => i.id === 'msg_settle-live')?.card?.runSettled).toMatchObject({
      title: 'Run #3104 · Verify and deploy',
      now: 'Now: Running pnpm test',
      link: 'Watch ›',
    });
  });

  it('puts the live runs on their threads’ reply rows', async () => {
    const { client } = setup();
    const runs = await client.runs.list({ params: { burrow }, query: { status: 'live' } });
    const people = worldContext().people;
    expect(threadWorkView(REPORT_ROOT, runs.runs, [], people)).toMatchObject({
      name: 'Dusty',
      text: 'needs you',
      tone: 'warn',
    });
    expect(threadWorkView(DEPLOY_ROOT, runs.runs, [], people)).toMatchObject({
      text: 'is working · 38%',
      progress: 38,
    });
    expect(threadWorkView(QUESTION_ROOT, runs.runs, [], people)).toBeNull();
  });

  it('has the agent say what it does in the report thread, and think in the question’s', () => {
    const { events, pulses } = setup();
    // Its first pulse came before the socket opened; the next one, 4 s later, reaches the app.
    expect(pulses).toHaveLength(1);
    pulses[0]?.();
    expect(events.map((e) => e.type)).toEqual(['activity.updated', 'typing', 'typing']);
    const activity = events[0];
    if (activity?.type !== 'activity.updated') throw new Error('no activity');
    expect(activity.activity).toMatchObject({ title: 'Editing format.ts', threadRootId: REPORT_ROOT });
  });
});
