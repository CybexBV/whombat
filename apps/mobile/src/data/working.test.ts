/**
 * Small signs that an agent is at work, on the phone (docs/decisions/card-settle.md AP-734, AP-735): the thinking row's
 * words and a thread's reply row.
 */
import type { AgentNowEntry } from '@whombat/client/query';
import { dusty } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { liveTyping, thinkingLabels, threadWorkView } from './working';

const T0 = Date.parse('2026-10-04T13:00:00.000Z');

const entry = (o: Partial<AgentNowEntry> = {}): AgentNowEntry => ({
  principalId: dusty.id,
  threadRootId: 'msg_root',
  dispatchId: 'dsp_1',
  title: 'Editing Layout.astro',
  status: 'running',
  seq: 3,
  since: T0,
  at: T0 + 60_000,
  ...o,
});

describe('thinkingLabels (AP-734)', () => {
  it('says what the agent does, with the clock from 10 s, and leaves the clock out for TalkBack', () => {
    const now = [entry()];
    expect(thinkingLabels('Dusty', now, dusty.id, 'msg_root', T0 + 72_000)).toEqual({
      label: 'Dusty · Editing Layout.astro · 1m 12s',
      spoken: 'Dusty · Editing Layout.astro',
      ticks: true,
    });
    expect(thinkingLabels('Dusty', now, dusty.id, 'msg_root', T0 + 5_000).label).toBe(
      'Dusty · Editing Layout.astro',
    );
  });

  it('is “is thinking” without a recent action here', () => {
    expect(thinkingLabels('Dusty', [entry()], dusty.id, null, T0).label).toBe('Dusty is thinking');
    expect(thinkingLabels('Dusty', [entry()], dusty.id, 'msg_root', T0 + 10 * 60_000)).toMatchObject({
      label: 'Dusty is thinking',
      ticks: true,
    });
    // What it does in another thread is no action here.
    expect(
      thinkingLabels('Dusty', [entry({ threadRootId: 'msg_other' })], dusty.id, 'msg_root', T0),
    ).toMatchObject({
      label: 'Dusty is thinking',
      ticks: false,
    });
  });
});

describe('threadWorkView (AP-735)', () => {
  const people = worldContext().people;
  const live = {
    agentId: dusty.id,
    status: 'live' as const,
    progress: 38.4,
    attention: null,
    threadRootId: 'msg_root',
  };

  it('names the agent with its face and how far its run is', () => {
    expect(threadWorkView('msg_root', [live], [], people)).toEqual({
      agent: dusty,
      name: 'Dusty',
      text: 'is working · 38%',
      progress: 38.4,
      tone: 'live',
    });
  });

  it('says the agent needs you first, then who thinks there, else nothing', () => {
    const stuck = { ...live, attention: 'Dusty stopped without finishing this run.' };
    expect(threadWorkView('msg_root', [live, stuck], [], people)).toMatchObject({
      text: 'needs you',
      tone: 'warn',
      progress: null,
    });
    const thinking = [{ principalId: dusty.id, threadRootId: 'msg_root' }];
    expect(threadWorkView('msg_root', [], thinking, people)).toMatchObject({
      name: 'Dusty',
      text: 'is thinking',
    });
    expect(threadWorkView('msg_other', [live], thinking, people)).toBeNull();
    // A run without its thread (an older server) shows nowhere.
    expect(threadWorkView('msg_root', [{ ...live, threadRootId: null }], [], people)).toBeNull();
  });

  it('keeps typing entries until they expire', () => {
    const entries = [{ expiresAt: T0 + 1 }, { expiresAt: T0 - 1 }];
    expect(liveTyping(entries, T0)).toEqual([{ expiresAt: T0 + 1 }]);
  });
});
