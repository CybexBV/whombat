import {
  DESK_BOX_TONES,
  DESK_FIRST_PAGE_AFTER_S,
  DESK_SCREEN_WORDS,
  DESK_SPOTLIGHT_S,
  DESK_TURN_S,
  NEWS_WORDS,
  WEATHER_WORDS,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { SPOTLIGHT_S } from './forms';
import { EN, NL, resolveScreenLanguage, screenFormatLocale } from './i18n/catalog';
import { FIRST_PAGE_AFTER_S, TURN_S } from './pager';
import { METER_TONES, SERVER_SHOW_VIEWS, SERVER_SHOWS, serverShow, sizeOf, VIEW_SIZES } from './specs';
import { WEEKDAYS, zonedMinute } from './times';
import {
  agoText,
  clockText,
  dateText,
  fillWords,
  SCREEN_WORDS,
  SERVER_SHOW_WORDS,
  screenWords,
  serverShowWords,
  weekdayText,
} from './words';

describe('the screen’s words', () => {
  it('shares keys and placeholders between the two flat catalogs', () => {
    const placeholders = (text: string) => text.match(/\{\w+\}/g)?.sort() ?? [];
    const keys = Object.keys(EN) as (keyof typeof EN)[];
    expect(Object.keys(NL).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(placeholders(NL[key]), key).toEqual(placeholders(EN[key]));
  });

  it('uses Dutch for regional tags and falls back to English for unsupported languages', () => {
    expect(resolveScreenLanguage(' NL_be ')).toBe('nl');
    expect(screenFormatLocale('nl')).toBe('nl-NL');
    expect(screenFormatLocale(' NL_be ')).toBe('nl-BE');
    expect(screenFormatLocale('en-US')).toBe('en-US');
    expect(screenFormatLocale('nl-')).toBe('nl-NL');
    expect(screenFormatLocale('fr-FR')).toBe('en-GB');
    expect(screenFormatLocale(null)).toBe('en-GB');
    expect(screenWords('nl-BE').own.done.name).toBe('Vandaag gedaan');
    expect(serverShowWords('nl').overview.name).toBe('Overzicht');
    expect(screenWords('fr-FR')).toBe(SCREEN_WORDS);
    expect(serverShowWords()).toBe(SERVER_SHOW_WORDS);
  });

  it('are Settings’ words where both say them', () => {
    for (const [key, own] of Object.entries(SCREEN_WORDS.own))
      expect(own.name).toBe(DESK_SCREEN_WORDS.own[key as keyof typeof DESK_SCREEN_WORDS.own].name);
    expect(SCREEN_WORDS.pill).toEqual(DESK_SCREEN_WORDS.pill);
    expect(SCREEN_WORDS.locked).toEqual(DESK_SCREEN_WORDS.locked);
    expect(SCREEN_WORDS.weather.problem).toBe(WEATHER_WORDS.problem);
    expect(SCREEN_WORDS.weather.noPlace).toBe(WEATHER_WORDS.noPlace);
    expect(SCREEN_WORDS.news.empty).toBe(NEWS_WORDS.widgetEmpty);
    expect(SCREEN_WORDS.news.problem).toBe(NEWS_WORDS.widgetProblem);
    expect(SCREEN_WORDS.spotlight).toEqual(DESK_SCREEN_WORDS.spotlight);
  });

  it('colour a server’s meters at the box’s own tones', () => {
    expect(METER_TONES.cpu).toEqual(DESK_BOX_TONES.cpu);
    expect(METER_TONES.memory).toEqual(DESK_BOX_TONES.memory);
    expect(METER_TONES.storage).toEqual(DESK_BOX_TONES.storage);
  });

  it('name every part of a server, and size it by what it draws', () => {
    for (const show of SERVER_SHOWS) expect(SERVER_SHOW_WORDS[show].name).toBeTruthy();
    expect(serverShow({})).toBe('overview');
    expect(serverShow({ show: 'storage' })).toBe('storage');
    expect(serverShow({ show: 'unknown' })).toBe('overview');
    expect(sizeOf({ type: 'server' })).toBe(VIEW_SIZES.server);
    expect(sizeOf({ type: 'server', opts: { show: 'cpu' } })).toBe(VIEW_SIZES.chart);
    expect(sizeOf({ type: 'server', opts: { show: 'temp' } })).toBe(VIEW_SIZES[SERVER_SHOW_VIEWS.temp]);
  });

  it('turn pages at the contract’s pace, and give a moment the contract’s minute', () => {
    expect(TURN_S).toEqual(DESK_TURN_S);
    expect(FIRST_PAGE_AFTER_S).toBe(DESK_FIRST_PAGE_AFTER_S);
    expect(SPOTLIGHT_S).toBe(DESK_SPOTLIGHT_S);
  });

  it('fill their blanks and leave unknown ones', () => {
    expect(fillWords('{n} things need you', { n: 3 })).toBe('3 things need you');
    expect(fillWords('{assistant} asks', {})).toBe('{assistant} asks');
  });

  it('say how long ago in minutes, hours and days', () => {
    const t = Date.parse('2026-10-27T13:30:00Z');
    expect(agoText(t, t + 20_000)).toBe('just now');
    expect(agoText(t, t + 4 * 60_000)).toBe('4 min');
    expect(agoText(t, t + 120 * 60_000)).toBe('2 h');
    expect(agoText(t, t + 130 * 60_000)).toBe('2 h 10 min');
    expect(agoText(t, t + 50 * 3_600_000)).toBe('2 d');
  });

  it('tell the time in the Whombat’s zone', () => {
    const t = Date.parse('2026-10-27T13:34:20Z');
    expect(clockText(t, 'Europe/Amsterdam')).toBe('14:34');
    expect(dateText(t, 'Europe/Amsterdam')).toBe('Tuesday 27 October');
    expect(clockText(t, 'Not/AZone')).toMatch(/^\d\d:\d\d$/);
    expect(weekdayText('2026-10-28')).toBe('Wed');
    expect(weekdayText('soon')).toBe('soon');
  });

  it('formats dates and elapsed time in Dutch', () => {
    const t = Date.parse('2026-10-27T13:34:20Z');
    expect(clockText(t, 'Europe/Amsterdam', 'nl-BE')).toBe('14:34');
    expect(dateText(t, 'Europe/Amsterdam', 'nl-NL')).toBe('dinsdag 27 oktober');
    expect(weekdayText('2026-10-28', 'nl-NL')).toBe('wo');
    expect(weekdayText('soon', 'nl-NL')).toBe('soon');
    for (const [minutes, label] of [
      [0, 'zojuist'],
      [4, '4 min'],
      [120, '2 u'],
      [130, '2 u 10 min'],
      [3000, '2 d'],
    ] as const) {
      expect(agoText(t, t + minutes * 60_000, 'nl')).toBe(label);
    }
  });

  it('keeps the page scheduler’s weekday keys after formatting Dutch dates', () => {
    const monday = Date.parse('2026-10-26T13:34:00Z');
    const zone = 'Europe/Amsterdam';
    expect(dateText(monday, zone, 'nl')).toContain('maandag');
    expect(WEEKDAYS.map((_, i) => zonedMinute(monday + i * 86_400_000, zone))).toEqual(
      WEEKDAYS.map((day) => ({ day, minute: 874 })),
    );
  });
});
