/**
 * Reading Find My in the background without Postgres (docs/decisions/findmy-connection.md): when each connection
 * reads, how a Mac in use and a failure wait, and when it stops. The clock is the test's and each pass is run by hand:
 * nothing sleeps.
 */
import type { HostFindMyCode } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { FindMyBackground, type FindMyPlan } from './findmy-background';

const MIN = 60_000;

function world(first: FindMyPlan[]) {
  let now = Date.parse('2026-11-23T10:00:00.000Z');
  let plans = first;
  const reads: string[] = [];
  const held: string[][] = [];
  let answer: HostFindMyCode | null = null;
  const loop = new FindMyBackground({
    now: () => now,
    plans: async () => plans,
    read: async (plan) => {
      reads.push(plan.connectionId);
      return answer;
    },
    hold: (ids) => held.push(ids),
  });
  return {
    loop,
    reads,
    held,
    answer: (code: HostFindMyCode | null) => {
      answer = code;
    },
    plans: (next: FindMyPlan[]) => {
      plans = next;
    },
    /** Moves the clock and runs a pass, waiting for the reads it started. */
    async at(minutes: number) {
      now += minutes * MIN;
      await loop.tick();
      await loop.settled();
    },
    now: () => now,
  };
}

const plan = (everyMinutes: number, automation: string | null = null): FindMyPlan => ({
  connectionId: 'con_findmy01',
  serverId: 'studio',
  label: 'Studio',
  pace: { everyMinutes, automation },
});

describe('background reads', () => {
  it('read at once, then every chosen interval', async () => {
    const w = world([plan(15)]);
    await w.at(0);
    expect(w.reads).toHaveLength(1);
    await w.at(14);
    expect(w.reads).toHaveLength(1);
    await w.at(1);
    expect(w.reads).toHaveLength(2);
    // What was read stays in memory while it reads in the background.
    expect(w.held.at(-1)).toEqual(['studio']);
  });

  it('try again after 2 minutes when someone uses the Mac', async () => {
    const w = world([plan(15)]);
    w.answer('in_use');
    await w.at(0);
    await w.at(1);
    expect(w.reads).toHaveLength(1);
    await w.at(1);
    expect(w.reads).toHaveLength(2);
  });

  it('wait twice as long after each failure, up to an hour, and go back to the pace once one works', async () => {
    const w = world([plan(15)]);
    w.answer('no_find_my');
    await w.at(0);
    const next = () => ((w.loop.nextRead('con_findmy01') ?? 0) - w.now()) / MIN;
    expect(next()).toBe(30);
    await w.at(30);
    expect(next()).toBe(60);
    await w.at(60);
    expect(next()).toBe(60);
    w.answer(null);
    await w.at(60);
    expect(next()).toBe(15);
    expect(w.reads).toHaveLength(4);
  });

  it('take a sooner pace from the last read', async () => {
    const w = world([plan(60)]);
    await w.at(0);
    await w.at(10);
    expect(w.reads).toHaveLength(1);
    // An automation starts listening: every 15 minutes from the last read.
    w.plans([plan(15, 'Tell me when Mara gets home')]);
    await w.at(5);
    expect(w.reads).toHaveLength(2);
  });

  it('stop when the connection no longer reads in the background, and let its Mac go', async () => {
    const w = world([plan(5)]);
    await w.at(0);
    w.plans([]);
    await w.at(5);
    expect(w.reads).toHaveLength(1);
    expect(w.loop.nextRead('con_findmy01')).toBeNull();
    expect(w.held.at(-1)).toEqual([]);
    expect(w.loop.about('studio')).toBeNull();
  });

  it('say how a Mac is read, and for which automation when that is why', async () => {
    const w = world([plan(15, 'Tell me when Mara gets home')]);
    await w.at(0);
    expect(w.loop.about('Studio')).toEqual({ everyMinutes: 15, automation: 'Tell me when Mara gets home' });
    expect(w.loop.about('mini')).toBeNull();
  });

  it('count a read that throws as a failure', async () => {
    const loop = new FindMyBackground({
      now: () => 0,
      plans: async () => [plan(5)],
      read: async () => {
        throw new Error('gone');
      },
    });
    await loop.tick();
    await loop.settled();
    expect(loop.nextRead('con_findmy01')).toBe(10 * MIN);
  });
});
