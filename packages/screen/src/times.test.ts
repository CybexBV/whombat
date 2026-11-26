import { describe, expect, it } from 'vitest';
import { pagerGo, pagerStart, pagerTick, pagerTouch } from './pager';
import { everyPage, pageShowing, pageShowsAt, rotationNow, zonedMinute } from './times';
import type { DeskPageShow } from './types';

const ZONE = 'Europe/Amsterdam';
/** Tuesday 27 October 2026 (Amsterdam is UTC+1 then): `hh:mm` there. */
const tue = (clock: string) => Date.parse(`2026-10-27T${clock}:00+01:00`);
const S = 1000;

const morning: DeskPageShow = { from: '07:00', to: '09:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
const night: DeskPageShow = { from: '22:00', to: '06:00' };
const pages = [
  { id: 'p_overview' },
  { id: 'p_morning', show: morning },
  { id: 'p_media' },
  { id: 'p_night', show: night },
];

describe('pages by time of day', () => {
  it('reads the day and the minute in the person’s zone', () => {
    expect(zonedMinute(tue('07:30'), ZONE)).toEqual({ day: 'tue', minute: 450 });
    expect(zonedMinute(Date.parse('2026-10-27T23:30:00Z'), ZONE)).toEqual({ day: 'wed', minute: 30 });
  });

  it('shows a page inside its window, on its days', () => {
    expect(pageShowing(morning, tue('07:00'), ZONE)).toBe(true);
    expect(pageShowing(morning, tue('08:59'), ZONE)).toBe(true);
    expect(pageShowing(morning, tue('09:00'), ZONE)).toBe(false);
    expect(pageShowsAt(morning, { day: 'sat', minute: 480 })).toBe(false);
    expect(pageShowing(undefined, tue('03:00'), ZONE)).toBe(true);
  });

  it('runs a window past midnight into the next morning, from the day it starts', () => {
    const fri = { ...night, days: ['fri' as const] };
    expect(pageShowsAt(fri, { day: 'fri', minute: 23 * 60 })).toBe(true);
    expect(pageShowsAt(fri, { day: 'sat', minute: 5 * 60 })).toBe(true);
    expect(pageShowsAt(fri, { day: 'fri', minute: 5 * 60 })).toBe(false);
    expect(pageShowsAt(fri, { day: 'sat', minute: 23 * 60 })).toBe(false);
  });

  it('takes the same time twice as the whole day', () => {
    const weekend: DeskPageShow = { from: '00:00', to: '00:00', days: ['sat', 'sun'] };
    expect(pageShowsAt(weekend, { day: 'sun', minute: 13 * 60 })).toBe(true);
    expect(pageShowsAt(weekend, { day: 'mon', minute: 13 * 60 })).toBe(false);
  });

  it('turns through the pages whose time it is, the open window first as home', () => {
    expect(rotationNow(pages, tue('07:30'), ZONE)).toMatchObject({
      pages: [0, 1, 2],
      home: 1,
      open: [{ id: 'p_morning', page: 1 }],
    });
    expect(rotationNow(pages, tue('12:00'), ZONE)).toMatchObject({ pages: [0, 2], home: 0, open: [] });
    expect(rotationNow(pages, tue('23:00'), ZONE)).toMatchObject({ pages: [0, 2, 3], home: 3 });
  });

  it('shows the first page when no page’s time it is, never nothing', () => {
    const only = [{ id: 'p_morning', show: morning }];
    expect(rotationNow(only, tue('12:00'), ZONE)).toMatchObject({ pages: [0], home: 0, open: [] });
    expect(rotationNow([{ id: 'p_a' }, { id: 'p_b' }], tue('12:00'), ZONE)).toEqual(everyPage(2));
  });
});

describe('turning pages by time of day', () => {
  it('starts at home, and goes to a page once when its window opens', () => {
    let p = pagerStart(tue('05:59'), rotationNow(pages, tue('05:59'), ZONE));
    expect(p.page).toBe(3);
    p = pagerTick(p, tue('06:00'), rotationNow(pages, tue('06:00'), ZONE), 'touch');
    // The night is over: home is the first page without a window.
    expect(p.page).toBe(0);
    p = pagerTick(p, tue('07:00'), rotationNow(pages, tue('07:00'), ZONE), 'touch');
    expect(p.page).toBe(1);
    // Someone turns to Media; the morning window stays open, so it doesn't pull the screen back at once.
    p = pagerGo(2, 4, tue('07:10'), p);
    p = pagerTick(p, tue('07:11'), rotationNow(pages, tue('07:11'), ZONE), 'touch');
    expect(p.page).toBe(2);
    // Untouched, it goes home: the morning page while its window is open.
    p = pagerTick(p, tue('07:13'), rotationNow(pages, tue('07:13'), ZONE), 'touch');
    expect(p.page).toBe(1);
    // The window closes: home again.
    p = pagerTick(p, tue('09:00'), rotationNow(pages, tue('09:00'), ZONE), 'touch');
    expect(p.page).toBe(0);
  });

  it('waits for a window under someone’s finger until they let go a while', () => {
    let p = pagerStart(tue('06:50'), rotationNow(pages, tue('06:50'), ZONE));
    p = pagerTouch(p, tue('06:59') + 50 * S);
    p = pagerTick(p, tue('07:00'), rotationNow(pages, tue('07:00'), ZONE), 'touch');
    expect(p.page).toBe(0);
    p = pagerTick(p, tue('07:00') + 15 * S, rotationNow(pages, tue('07:00') + 15 * S, ZONE), 'touch');
    expect(p.page).toBe(0);
    p = pagerTick(p, tue('07:00') + 25 * S, rotationNow(pages, tue('07:00') + 25 * S, ZONE), 'touch');
    expect(p.page).toBe(1);
  });

  it('turns by itself only through the pages whose time it is', () => {
    const at = tue('12:00');
    const r = rotationNow(pages, at, ZONE);
    let p = pagerStart(at, r);
    p = pagerTick(p, at + 30 * S, r, '30s');
    expect(p.page).toBe(2);
    p = pagerTick(p, at + 60 * S, r, '30s');
    expect(p.page).toBe(0);
  });
});
