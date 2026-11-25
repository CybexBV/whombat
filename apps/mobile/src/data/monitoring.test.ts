/**
 * Monitoring on the phone: Pick a time's days and first value,
 * the head's facts without the week's copy, the hold's heads-up left out where the page draws the hold, held lines in
 * Worth a look (End now, not Undo), the ⋯ menus and a limit's words.
 */
import { keepQuietBody } from '@whombat/client';
import type { ThingPage, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  daysEdges,
  factsWithoutUptime,
  firstPick,
  parseMonitoringPick,
  pickDays,
  pickedValue,
  serverMoreMenu,
  thingMoreMenu,
  withoutHoldLines,
} from './monitoring';
import { quietLineMenu } from './nativeMenu';
import { noticeRows } from './thingPage';

const ZONE = 'Europe/Amsterdam';
// Wednesday 23 September 2026, 14:05 in Amsterdam.
const NOW = Date.parse('2026-09-23T12:05:00Z');

type Notices = Extract<ThingPagePanel, { kind: 'notices' }>;

const notices = (items: Notices['items']): Notices => ({
  kind: 'notices',
  id: 'notices',
  title: 'Worth a look',
  items,
});

const page = (extra: Partial<ThingPage>, items: Notices['items']): ThingPage =>
  ({
    id: 'connection:con_unifi',
    kind: 'connection',
    name: 'UniFi',
    status: 'ok',
    badge: 'Fine',
    facts: [],
    actions: [],
    tabs: [{ key: 'overview', label: 'Overview', panels: [notices(items)] }],
    ...extra,
  }) as ThingPage;

const KEPT = {
  id: 'qw_1',
  words: 'Quiet until 23:00 · Moving the access points',
  since: '2026-09-23T11:40:00Z',
  until: '2026-09-23T21:00:00Z',
  canEnd: true,
};

describe('Pick a time', () => {
  it('offers today, tomorrow and the days after by their weekday', () => {
    const days = pickDays(NOW, ZONE, 4);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow', 'Fri 25', 'Sat 26']);
    expect(days[0]?.value).toBe('2026-09-23');
  });

  it('starts two whole hours ahead, or tomorrow morning late in the evening', () => {
    expect(firstPick(NOW, ZONE)).toEqual({ day: '2026-09-23', clock: '16:00' });
    expect(firstPick(Date.parse('2026-09-23T20:30:00Z'), ZONE)).toEqual({
      day: '2026-09-24',
      clock: '09:00',
    });
  });

  it('fades the days where more are past an edge, so a cut-off day never shows as a sliver beside the clock', () => {
    // A week of days on a 402 pt iPhone: about three fit before the clock.
    expect(daysEdges(228, 560, 0)).toEqual({ left: false, right: true });
    expect(daysEdges(228, 560, 120)).toEqual({ left: true, right: true });
    expect(daysEdges(228, 560, 332)).toEqual({ left: true, right: false });
    // All the days fit (a wide phone), or a pixel of rounding: nothing fades.
    expect(daysEdges(400, 360, 0)).toEqual({ left: false, right: false });
    expect(daysEdges(228, 228.5, 0.5)).toEqual({ left: false, right: false });
  });

  it('gives the shared rules a value they read as a time in the Whombat’s zone', () => {
    const asked = keepQuietBody('pick', {
      now: NOW,
      timeZone: ZONE,
      picked: pickedValue('2026-09-23', '16:00'),
    });
    expect(asked).toEqual({ body: { until: '2026-09-23T14:00:00.000Z' } });
  });
});

describe('the hold on a page', () => {
  it('draws the week once: the head has it, not More detail', () => {
    const uptime = {
      text: 'Up all week',
      upPct: 100,
      downs: 0,
      downMinutes: 0,
      from: '2026-09-16T12:05:00Z',
    };
    const facts = [[{ text: 'UniFi Network 9.4.19' }], [{ text: 'Up all week' }]];
    expect(factsWithoutUptime(facts, uptime)).toEqual([[{ text: 'UniFi Network 9.4.19' }]]);
    expect(factsWithoutUptime(facts, undefined)).toBe(facts);
  });

  it('leaves out the heads-up line only where the page carries the hold', () => {
    const hold = { id: 'quiet-window', tone: 'info' as const, icon: 'clock' as const, title: KEPT.words };
    const line = { id: 'ap', tone: 'warn' as const, icon: 'device' as const, title: 'Garage AP is offline' };
    const kept = withoutHoldLines(page({ keptQuiet: KEPT }, [hold, line]));
    const panel = kept.tabs[0]?.panels[0] as Notices;
    expect(panel.items.map((n) => n.id)).toEqual(['ap']);
    const plain = page({}, [hold, line]);
    expect(withoutHoldLines(plain)).toBe(plain);
  });

  it('offers End now on a line held by the window, nothing on one held by a cause, Undo on its own quiet', () => {
    const quiet = (held?: 'window' | 'cause') => ({
      state: 'snoozed' as const,
      words: 'until 23:00',
      at: '2026-09-23T11:40:00Z',
      ...(held ? { held } : {}),
    });
    const base = {
      tone: 'warn' as const,
      icon: 'device' as const,
      check: 'unifi.device_offline',
      ignore: { lifts: 'fixed' as const, words: 'Until it’s back online.' },
    };
    const rows = noticeRows(
      notices([
        {
          ...base,
          id: 'w',
          title: 'Garage AP',
          subject: { id: 'ap1', name: 'Garage AP' },
          quiet: quiet('window'),
        },
        {
          ...base,
          id: 'c',
          title: 'Hall AP',
          subject: { id: 'ap2', name: 'Hall AP' },
          quiet: quiet('cause'),
        },
        { ...base, id: 'o', title: 'Shed AP', subject: { id: 'ap3', name: 'Shed AP' }, quiet: quiet() },
      ]),
      [],
      { quiet: true },
    );
    expect(rows.map((r) => [r.id, r.endNow, !!r.undo])).toEqual([
      ['w', true, false],
      ['c', false, false],
      ['o', false, true],
    ]);
  });
});

describe('menus and limits', () => {
  it('puts Keep quiet… in a page’s ⋯ and after Rename on a server’s', () => {
    expect(
      thingMoreMenu()
        .sections.flat()
        .map((i) => i.title),
    ).toEqual(['Keep quiet…']);
    expect(
      serverMoreMenu(true)
        .sections.flat()
        .map((i) => i.id),
    ).toEqual(['rename', 'keep_quiet']);
    expect(
      serverMoreMenu(false)
        .sections.flat()
        .map((i) => i.id),
    ).toEqual(['rename']);
    expect(parseMonitoringPick('keep_quiet')).toBe('keep_quiet');
    expect(parseMonitoringPick('rename')).toBeNull();
  });

  it('offers Change the limit in a line’s ⋯ before Stop watching, the gentler choice', () => {
    const menu = {
      ref: { check: 'host.sensor.temp_high' },
      label: 'More for CPU running warm',
      ignore: { label: 'Ignore', words: 'Until it cools down.' },
      snooze: { label: 'Remind me tomorrow' },
      stop: { label: 'Stop watching this', words: 'Whombat won’t warn about it.' },
    };
    const ids = (limit: { label: string; words: string } | null) =>
      quietLineMenu(menu, 'CPU running warm', limit)
        .sections.flat()
        .map((i) => i.id);
    expect(ids({ label: 'Change the limit', words: 'Now 80 °C' })).toEqual([
      'ignore',
      'snooze',
      'limit',
      'stop',
    ]);
    expect(ids(null)).toEqual(['ignore', 'snooze', 'stop']);
  });
});
