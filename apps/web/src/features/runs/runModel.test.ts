import type { Run } from '@whombat/core';
import { run as fixtureRun } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { runAttention, runControls, runDot, runFaceState, runNotice } from './runModel';

const _TZ = 'Europe/Amsterdam';
const names = {
  agent: 'Banjo',
  nameOf: (id: string) => (id === 'prn_waffle' ? 'Waffle' : '?'),
  viewerId: 'prn_mara',
};

describe('run header', () => {
  it('shows the live dot with its halo only while live', () => {
    expect(runDot('live')).toEqual({ tone: 'live', halo: true });
    expect(runDot('done')).toEqual({ tone: 'ok', halo: false });
    expect(runDot('paused')).toEqual({ tone: 'warn', halo: false });
    expect(runDot('failed')).toEqual({ tone: 'bad', halo: false });
    expect(runDot('taken_over')).toEqual({ tone: 'mut', halo: false });
  });
});

describe('notices', () => {
  it('shows the failure summary', () => {
    const failed: Run = { ...fixtureRun, status: 'failed', summary: 'Stopped after an error.' };
    expect(runNotice(failed, names)).toEqual({ tone: 'bad', text: 'Stopped after an error.' });
  });
});

describe('Try again and attention (CT-197, AP-596, AP-597)', () => {
  it('offers Try again only on a failed run', () => {
    expect(runControls('failed')).toEqual({ toggle: null, takeOver: false, retry: true });
    for (const status of ['live', 'paused', 'done', 'taken_over'] as const) {
      expect(runControls(status).retry).toBe(false);
    }
  });

  it('points the failure note to Try again when it is there', () => {
    const failed: Run = { ...fixtureRun, status: 'failed', summary: null };
    expect(runNotice(failed, names)?.text).toBe('Banjo stopped after an error. Ask again to retry.');
    expect(runNotice(failed, { ...names, canRetry: true })?.text).toBe(
      'Banjo stopped after an error. Try again to give it another turn.',
    );
  });

  it('shows the server’s attention sentence on a live run only', () => {
    const text = 'Banjo stopped without finishing this run.';
    expect(runAttention({ status: 'live', attention: text })).toBe(text);
    expect(runAttention({ status: 'live', attention: null })).toBeNull();
    expect(runAttention({ status: 'live' })).toBeNull();
    expect(runAttention({ status: 'live', attention: '  ' })).toBeNull();
    expect(runAttention({ status: 'failed', attention: text })).toBeNull();
  });
});

describe('the agent’s face in the header', () => {
  const started: Run = { ...fixtureRun, status: 'live', attention: null, progress: 40 };

  it('thinks until the run has started on something, then works', () => {
    const queued: Run = {
      ...started,
      progress: 0,
      logCount: 0,
      steps: started.steps.map((s) => ({ ...s, state: 'queued' as const, at: null })),
    };
    expect(runFaceState(queued)).toBe('thinking');
    expect(runFaceState(started)).toBe('working');
  });

  it('waits for the person when the run needs one', () => {
    expect(runFaceState({ ...started, attention: 'Banjo stopped without finishing this run.' })).toBe(
      'needs',
    );
  });

  it('is glad when done, sorry when failed and rests when paused or taken over', () => {
    expect(runFaceState({ ...started, status: 'done' })).toBe('done');
    expect(runFaceState({ ...started, status: 'failed' })).toBe('sorry');
    expect(runFaceState({ ...started, status: 'paused' })).toBe('idle');
    expect(runFaceState({ ...started, status: 'taken_over' })).toBe('idle');
  });
});
