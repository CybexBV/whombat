import { describe, expect, it } from 'vitest';
import { IDLE_AFTER_MS, PresenceTracker } from './presence-tracker';

function world() {
  let now = Date.parse('2026-09-30T10:00:00Z');
  const tracker = new PresenceTracker(() => new Date(now));
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PresenceTracker (one-person.md OP-S14)', () => {
  it('is active on connect, offline when the last connection closes', () => {
    const w = world();
    const back: string[] = [];
    w.tracker.onActive((burrowId) => back.push(burrowId));
    w.tracker.connect('session:1:bur_a', 'bur_a', 'prn_mara');
    w.tracker.connect('session:2:bur_a', 'bur_a', 'prn_mara');
    w.tracker.disconnect('session:1:bur_a');
    expect(w.tracker.stateOf('prn_mara')).toBe('active');
    expect(w.tracker.activeIn('bur_a')).toBe(true);
    w.tracker.disconnect('session:2:bur_a');
    expect(w.tracker.stateOf('prn_mara')).toBe('offline');
    expect(w.tracker.activeIn('bur_a')).toBe(false);
    expect(back).toEqual(['bur_a', 'bur_a']);
    w.tracker.close();
  });

  it('says who opened a client in the last minute, much shorter than active (NT-17)', () => {
    const w = world();
    w.tracker.connect('session:1:bur_a', 'bur_a', 'prn_mara');
    expect(w.tracker.activeWithin('prn_mara', 60_000)).toBe(true);
    w.advance(60_001);
    expect(w.tracker.stateOf('prn_mara')).toBe('active');
    expect(w.tracker.activeWithin('prn_mara', 60_000)).toBe(false);
    w.tracker.close();
  });

  it('is idle after ten quiet minutes, active again on a new connection', () => {
    const w = world();
    w.tracker.connect('session:1:bur_a', 'bur_a', 'prn_mara');
    w.advance(IDLE_AFTER_MS - 1);
    w.tracker.sweep();
    expect(w.tracker.stateOf('prn_mara')).toBe('active');
    w.advance(1);
    w.tracker.sweep();
    expect(w.tracker.stateOf('prn_mara')).toBe('idle');
    w.tracker.connect('session:1:bur_a', 'bur_a', 'prn_mara');
    expect(w.tracker.stateOf('prn_mara')).toBe('active');
    w.tracker.disconnectAll('session:1:');
    expect(w.tracker.has('session:1:bur_a')).toBe(false);
    w.tracker.close();
  });
});
