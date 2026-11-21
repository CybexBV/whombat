import type { RunStatus } from '@whombat/core';
import { run } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { runActionToast, runControls, runLineControls, runLineText, runShowsAsLine } from './runs';

const quiet = { ...run, diff: { add: 0, del: 0, files: 0 }, prNumber: null };

describe('runShowsAsLine (AP-668)', () => {
  it('is a line until the run changes a file or has a pull request', () => {
    expect(runShowsAsLine(quiet)).toBe(true);
    expect(runShowsAsLine({ ...quiet, diff: { add: 3, del: 1, files: 1 } })).toBe(false);
    expect(runShowsAsLine({ ...quiet, prNumber: 7 })).toBe(false);
  });
});

describe('runLineText (AP-668)', () => {
  const live = { ...quiet, status: 'live' as const, activity: 'Inspect repository update', attention: null };

  it('says what a live run is checking', () => {
    expect(runLineText(live)).toEqual({
      lead: 'Checking',
      detail: 'Inspect repository update',
      tone: 'live',
    });
  });

  it('says why a live run needs a person', () => {
    expect(runLineText({ ...live, attention: 'Banjo stopped without finishing this run.' })).toEqual({
      lead: 'Needs attention',
      detail: 'Banjo stopped without finishing this run.',
      tone: 'warn',
    });
  });

  it('says how long a finished run took and what it found', () => {
    const done = {
      ...live,
      number: 6,
      status: 'done' as const,
      startedAt: '2026-10-03T07:40:00.000Z',
      finishedAt: '2026-10-03T07:41:12.000Z',
      summary: 'Confirmed the fix is on main.',
    };
    expect(runLineText(done)).toEqual({
      lead: 'Run #6 · Done in 1m 12s',
      detail: 'Confirmed the fix is on main.',
      tone: 'ok',
    });
    expect(runLineText({ ...done, status: 'failed', summary: null }).lead).toBe('Run #6 · Failed in 1m 12s');
    expect(runLineText({ ...done, status: 'paused', finishedAt: null }).lead).toBe('Run #6 · Paused');
  });

  it('says why a run failed, or the step it stopped on when the runner left no summary', () => {
    const failed = {
      ...live,
      number: 1,
      status: 'failed' as const,
      startedAt: '2026-10-04T07:40:00.000Z',
      finishedAt: '2026-10-04T07:42:05.000Z',
      summary: 'Couldn’t fetch the repository.',
    };
    expect(runLineText(failed)).toEqual({
      lead: 'Run #1 · Failed in 2m 05s',
      detail: 'Couldn’t fetch the repository.',
      tone: 'bad',
    });
    expect(runLineText({ ...failed, summary: '  ' }).detail).toBe('Inspect repository update');
    expect(runLineText({ ...failed, summary: null, activity: '' }).detail).toBeNull();
  });
});

describe('runLineControls (AP-699)', () => {
  const stopped: RunStatus[] = ['paused', 'done', 'failed', 'taken_over'];

  it('says Watch run while the run is live and Open run once nothing moves on it', () => {
    expect(runLineControls({ status: 'live' }).link).toBe('Watch run');
    for (const status of stopped) expect(runLineControls({ status }).link).toBe('Open run');
  });

  it('offers Try again on a failed run only', () => {
    expect(runLineControls({ status: 'failed' })).toEqual({ link: 'Open run', retry: true });
    for (const status of ['live', 'paused', 'done', 'taken_over'] as const) {
      expect(runLineControls({ status }).retry).toBe(false);
    }
  });
});

describe('run controls on the web and the phone (AP-596, AP-711)', () => {
  it('Pause while live, Resume while paused, Take over while it holds the branch, Try again where it can', () => {
    expect(runControls('live')).toEqual({ toggle: 'pause', takeOver: true, retry: false });
    expect(runControls('paused')).toEqual({ toggle: 'resume', takeOver: true, retry: false });
    expect(runControls('failed')).toEqual({ toggle: null, takeOver: false, retry: true });
    expect(runControls('done')).toEqual({ toggle: null, takeOver: false, retry: false });
  });

  it('what it says after', () => {
    expect(runActionToast('pause', 'Banjo', 'feat/x')).toBe('Paused. Banjo stopped where it was.');
    expect(runActionToast('take_over', 'Banjo', 'feat/x')).toBe('You have feat/x now. Banjo has stopped.');
    expect(runActionToast('retry', 'Banjo', 'feat/x')).toBe('Asked Banjo to try again.');
  });
});
