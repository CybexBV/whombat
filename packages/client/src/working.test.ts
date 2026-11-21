import { describe, expect, it } from 'vitest';
import type { AgentNowEntry } from './query/keys';
import { agentNowFor, threadWork, workingLabel } from './working';

const at = Date.parse('2026-10-04T13:46:00.000Z');
const entry: AgentNowEntry = {
  principalId: 'prn_banjo',
  threadRootId: 'msg_root',
  dispatchId: 'dsp_1',
  title: 'Editing Layout.astro',
  status: 'running',
  seq: 4,
  since: at - 72_000,
  at,
};

describe('workingLabel (AP-734)', () => {
  it('says what the agent does, with a clock from 10 s on', () => {
    expect(workingLabel('Banjo', entry, at)).toBe('Banjo · Editing Layout.astro · 1m 12s');
    expect(workingLabel('Banjo', { ...entry, since: at - 4_000 }, at)).toBe('Banjo · Editing Layout.astro');
    expect(workingLabel('Banjo', null, at)).toBe('Banjo is thinking');
  });

  it('only uses a recent action of that agent in that thread', () => {
    expect(agentNowFor([entry], 'prn_banjo', 'msg_root', at + 60_000)).toBe(entry);
    expect(agentNowFor([entry], 'prn_banjo', 'msg_root', at + 4 * 60_000)).toBeNull();
    expect(agentNowFor([entry], 'prn_banjo', null, at)).toBeNull();
    expect(agentNowFor([entry], 'prn_neo', 'msg_root', at)).toBeNull();
  });
});

describe('threadWork (AP-735)', () => {
  const live = {
    agentId: 'prn_banjo',
    status: 'live' as const,
    progress: 38,
    attention: null,
    threadRootId: 'msg_root',
  };

  it('shows a live run’s progress in its thread, and a run that needs a person first', () => {
    expect(threadWork('msg_root', [live], [])).toEqual({
      agentId: 'prn_banjo',
      text: 'is working · 38%',
      progress: 38,
      tone: 'live',
    });
    expect(threadWork('msg_root', [live, { ...live, attention: 'Waiting on John.' }], [])).toMatchObject({
      text: 'needs you',
      tone: 'warn',
    });
    expect(threadWork('msg_other', [live], [])).toBeNull();
    expect(threadWork('msg_root', [{ ...live, status: 'done' }], [])).toBeNull();
  });

  it('falls back to an agent thinking in the thread', () => {
    const typing = [{ principalId: 'prn_banjo', threadRootId: 'msg_root' }];
    expect(threadWork('msg_root', [], typing)).toMatchObject({ text: 'is thinking', progress: null });
    expect(threadWork('msg_other', [], typing)).toBeNull();
  });
});
