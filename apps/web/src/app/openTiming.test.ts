import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOpenTimings, createOpenTiming, readOpenTimings } from './openTiming';

afterEach(() => {
  clearOpenTimings();
  vi.restoreAllMocks();
});

describe('local opening timings', () => {
  it('separates connection time from loaded content and records each phase once', () => {
    let at = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    const opening = createOpenTiming();
    opening.mark('selected');
    at = 400;
    opening.mark('welcome');
    at = 650;
    opening.mark('history');
    at = 700;
    opening.mark('content');
    at = 900;
    opening.mark('content');
    expect(readOpenTimings()).toEqual([
      {
        prepared: false,
        phasesMs: { selected: 0, welcome: 300, history: 550, content: 600 },
        connectionMs: 300,
        dataMs: 300,
        totalMs: 600,
      },
    ]);
  });

  it('counts only the time after selection when the connection was prepared already', () => {
    let at = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    const opening = createOpenTiming();
    opening.mark('welcome');
    expect(readOpenTimings()).toEqual([]);
    at = 600;
    opening.mark('selected');
    at = 800;
    opening.mark('content');
    expect(readOpenTimings()[0]).toMatchObject({
      prepared: true,
      connectionMs: 0,
      dataMs: 200,
      totalMs: 200,
    });
  });

  it('keeps incomplete opens distinguishable, bounds its history and clears on sign-out', () => {
    for (let n = 0; n < 12; n++) createOpenTiming().mark('selected');
    expect(readOpenTimings()).toHaveLength(10);
    expect(readOpenTimings()[0]).toMatchObject({ connectionMs: null, dataMs: null, totalMs: null });
    clearOpenTimings();
    expect(readOpenTimings()).toEqual([]);
  });
});
