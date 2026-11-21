/** The work line's bar on a Chat row and a live card's ⋯. */
import { describe, expect, it } from 'vitest';
import { liveCardMenu, parseLiveCardPick, workSegments } from './workLine';

describe('the work line’s bar', () => {
  it('has a segment per member or task, done ones first, then the ones at work', () => {
    expect(workSegments({ kind: 'steps', done: 2, working: 1, total: 3 })).toEqual([
      'done',
      'done',
      'working',
    ]);
    expect(workSegments({ kind: 'steps', done: 2, working: 0, total: 5 })).toEqual([
      'done',
      'done',
      'todo',
      'todo',
      'todo',
    ]);
    expect(workSegments({ kind: 'sweep' })).toEqual([]);
    expect(workSegments(null)).toEqual([]);
  });

  it('keeps a long list to a dozen segments, still showing work going on', () => {
    const many = workSegments({ kind: 'steps', done: 10, working: 1, total: 40 });
    expect(many).toHaveLength(12);
    expect(many).toContain('working');
  });
});

describe('a live card’s menu', () => {
  it('has Council settings and Stop, Stop marked as destructive', () => {
    const menu = liveCardMenu({ change: true, stop: true });
    expect(menu.sections.flat().map((i) => i.id)).toEqual(['change', 'stop']);
    expect(menu.sections.flat().find((i) => i.id === 'stop')?.destructive).toBe(true);
    expect(liveCardMenu({ change: false, stop: true }).sections).toHaveLength(1);
    expect(parseLiveCardPick('stop')).toBe('stop');
    expect(parseLiveCardPick('x')).toBeNull();
  });
});
