import { describe, expect, it } from 'vitest';
import { areaOverlaps, overlapAfter } from './areas';

describe('tasks that change the same thing', () => {
  it('overlaps on the same file or a folder it is in', () => {
    expect(areaOverlaps('agent/exam/dock.c', './agent/exam/dock.c')).toBe(true);
    expect(areaOverlaps('agent/exam/', 'agent/exam/dock.c')).toBe(true);
    expect(areaOverlaps('agent/exam/dock.c', 'agent/exam/dock.h')).toBe(false);
    expect(areaOverlaps('agent/exa', 'agent/exam/dock.c')).toBe(false);
    expect(areaOverlaps('The dock', 'the dock')).toBe(true);
  });

  it('puts a task after the nearest earlier one it shares a part with, unless it names one itself', () => {
    const after = overlapAfter([
      { areas: ['agent/exam/dock.c'], after: null },
      { areas: ['web/settings'], after: null },
      { areas: ['agent/exam'], after: null },
      { areas: ['agent/exam/dock.c'], after: 2 },
      { areas: [], after: null },
    ]);
    expect(after[0]).toBeNull();
    expect(after[1]).toBeNull();
    expect(after[2]).toEqual({ index: 0, shared: ['agent/exam'] });
    expect(after[3]).toBeNull();
    expect(after[4]).toBeNull();
  });
});
