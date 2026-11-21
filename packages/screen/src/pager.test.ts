import { describe, expect, it } from 'vitest';
import { pagerGo, pagerProgress, pagerStart, pagerTick, pagerTouch } from './pager';

const S = 1000;

describe('page turning', () => {
  it('turns every 30 seconds by itself, round to the first', () => {
    let p = pagerStart(0);
    p = pagerTick(p, 29 * S, 3, '30s');
    expect(p.page).toBe(0);
    p = pagerTick(p, 30 * S, 3, '30s');
    expect(p.page).toBe(1);
    p = pagerTick(p, 60 * S, 3, '30s');
    p = pagerTick(p, 90 * S, 3, '30s');
    expect(p.page).toBe(0);
  });

  it('waits while someone touches the screen', () => {
    let p = pagerStart(0);
    p = pagerTouch(p, 20 * S);
    p = pagerTick(p, 45 * S, 2, '30s');
    expect(p.page).toBe(0);
    p = pagerTick(p, 50 * S, 2, '30s');
    expect(p.page).toBe(1);
  });

  it('goes back to the first page two minutes after the last touch when it turns when touched', () => {
    let p = pagerGo(2, 3, 10 * S);
    p = pagerTick(p, 100 * S, 3, 'touch');
    expect(p.page).toBe(2);
    p = pagerTouch(p, 100 * S);
    p = pagerTick(p, 200 * S, 3, 'touch');
    expect(p.page).toBe(2);
    p = pagerTick(p, 220 * S, 3, 'touch');
    expect(p.page).toBe(0);
  });

  it('never turns by itself when it turns when touched and stays put on one page', () => {
    let p = pagerStart(0);
    p = pagerTick(p, 600 * S, 3, 'touch');
    expect(p.page).toBe(0);
    p = pagerTick(p, 600 * S, 1, '30s');
    expect(p.page).toBe(0);
  });

  it('keeps within the pages there are', () => {
    const p = pagerTick({ page: 4, shownAt: 0, touchedAt: 0 }, 1 * S, 2, 'touch');
    expect(p.page).toBe(1);
    expect(pagerGo(-1, 3, 0).page).toBe(2);
    expect(pagerGo(3, 3, 0).page).toBe(0);
  });

  it('says how far a page is to turning', () => {
    const p = pagerStart(0);
    expect(pagerProgress(p, 15 * S, '30s')).toBeCloseTo(0.5);
    expect(pagerProgress(p, 15 * S, 'touch')).toBeNull();
  });

  it('keeps the same pager when nothing changes, so nothing redraws', () => {
    const p = pagerStart(0);
    expect(pagerTick(p, 5 * S, 3, '60s')).toBe(p);
  });
});
