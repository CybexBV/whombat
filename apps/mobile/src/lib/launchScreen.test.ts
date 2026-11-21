/** When the launch screen gives way (one-layout-android.md AP-2643). */
import { describe, expect, it } from 'vitest';
import { createLaunchScreen, LAUNCH_MAX_MS } from './launchScreen';

function harness() {
  const calls: string[] = [];
  const draws: (() => void)[] = [];
  const timers: { fn: () => void; ms: number; stopped: boolean }[] = [];
  const launch = createLaunchScreen({
    keep: () => calls.push('keep'),
    hide: () => calls.push('hide'),
    setTimer(fn, ms) {
      const t = { fn, ms, stopped: false };
      timers.push(t);
      return () => {
        t.stopped = true;
      };
    },
    afterDraw: (fn) => draws.push(fn),
  });
  const draw = () => {
    for (const fn of draws.splice(0)) fn();
  };
  return { launch, calls, draw, timers };
}

describe('the launch screen (AP-2643)', () => {
  it('stays while a placeholder shows, and goes at the first frame drawn without one', () => {
    const { launch, calls, draw } = harness();
    launch.start();
    const fonts = launch.hold();
    launch.settle();
    draw();
    expect(calls).toEqual(['keep']);
    // The fonts give way to the next placeholder in the same commit: still held once drawn.
    fonts();
    const opening = launch.hold();
    draw();
    expect(launch.gone).toBe(false);
    opening();
    draw();
    expect(calls).toEqual(['keep', 'hide']);
    expect(launch.gone).toBe(true);
  });

  it('goes at the first frame when nothing is held', () => {
    const { launch, calls, draw } = harness();
    launch.start();
    launch.settle();
    draw();
    expect(calls).toEqual(['keep', 'hide']);
  });

  it('waits for the first commit before it may go', () => {
    const { launch, calls, draw } = harness();
    launch.start();
    launch.hold()();
    draw();
    expect(calls).toEqual(['keep']);
    launch.settle();
    draw();
    expect(calls).toEqual(['keep', 'hide']);
  });

  it('goes after the limit whatever is held, once, and holds nothing after', () => {
    const { launch, calls, draw, timers } = harness();
    launch.start();
    launch.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(LAUNCH_MAX_MS);
    const held = launch.hold();
    launch.settle();
    timers[0]?.fn();
    expect(calls).toEqual(['keep', 'hide']);
    held();
    launch.hold()();
    draw();
    expect(calls).toEqual(['keep', 'hide']);
  });

  it('stops the limit when it goes earlier', () => {
    const { launch, draw, timers } = harness();
    launch.start();
    launch.settle();
    draw();
    expect(timers[0]?.stopped).toBe(true);
  });
});
