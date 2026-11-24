import type { ThingHistory, ThingWatchCheck } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  durationWords,
  heldLine,
  historyView,
  holdView,
  keepQuietBody,
  keepQuietOptions,
  keepQuietUntil,
  keptToast,
  limitView,
  lineLimit,
  parseLimit,
  pickedInstant,
  pickerValue,
  thingStateWords,
  withoutHoldLine,
} from './monitoring';

const ZONE = 'Europe/Amsterdam';
// 14:32 in Amsterdam (CET, UTC + 1).
const NOW = Date.parse('2026-11-24T13:32:00Z');
const at = (iso: string) => Date.parse(iso);

describe('keep quiet choices', () => {
  it('ends an hour from now, tonight at 23:00 and tomorrow at 09:00', () => {
    expect(keepQuietUntil('hour', NOW, ZONE)).toBe('2026-11-24T14:32:00.000Z');
    expect(keepQuietUntil('tonight', NOW, ZONE)).toBe('2026-11-24T22:00:00.000Z');
    expect(keepQuietUntil('morning', NOW, ZONE)).toBe('2026-11-25T08:00:00.000Z');
  });

  it('offers tonight only while it is ahead, and this morning before dawn', () => {
    expect(keepQuietUntil('tonight', at('2026-11-24T21:45:00Z'), ZONE)).toBeNull();
    expect(keepQuietUntil('tonight', at('2026-11-24T02:00:00Z'), ZONE)).toBeNull();
    expect(keepQuietUntil('morning', at('2026-11-24T02:00:00Z'), ZONE)).toBe('2026-11-24T08:00:00.000Z');
    expect(keepQuietOptions(at('2026-11-24T21:45:00Z'), ZONE).map((o) => o.choice)).toEqual([
      'hour',
      'morning',
      'pick',
    ]);
  });

  it('says when each choice ends', () => {
    expect(keepQuietOptions(NOW, ZONE)).toEqual([
      { choice: 'hour', label: 'For an hour', ends: '15:32' },
      { choice: 'tonight', label: 'Until tonight', ends: '23:00' },
      { choice: 'morning', label: 'Until tomorrow morning', ends: 'tomorrow 09:00' },
      { choice: 'pick', label: 'Pick a time', ends: null },
    ]);
  });

  it('reads a picked time in the Whombat’s zone and back', () => {
    expect(pickedInstant('2026-11-26T18:30', ZONE)).toBe('2026-11-26T17:30:00.000Z');
    expect(pickedInstant('tomorrow', ZONE)).toBeNull();
    expect(pickerValue(NOW, ZONE)).toBe('2026-11-24T14:32');
  });

  it('builds the body: minutes for an hour, the end otherwise, a trimmed note', () => {
    expect(keepQuietBody('hour', { now: NOW, timeZone: ZONE, note: '  ' })).toEqual({
      body: { minutes: 60 },
    });
    expect(keepQuietBody('tonight', { now: NOW, timeZone: ZONE, note: ' Moving the NAS ' })).toEqual({
      body: { until: '2026-11-24T22:00:00.000Z', note: 'Moving the NAS' },
    });
    expect(keepQuietBody('pick', { now: NOW, timeZone: ZONE, picked: '2026-11-26T18:30' })).toEqual({
      body: { until: '2026-11-26T17:30:00.000Z' },
    });
  });

  it('refuses a picked time that is gone, too close, too far or missing', () => {
    const problem = (picked?: string) =>
      'problem' in keepQuietBody('pick', { now: NOW, timeZone: ZONE, ...(picked ? { picked } : {}) });
    expect(problem()).toBe(true);
    expect(problem('2026-11-24T14:00')).toBe(true);
    expect(problem('2026-11-24T14:34')).toBe(true);
    expect(problem('2027-01-30T10:00')).toBe(true);
    expect(problem('2026-11-24T15:00')).toBe(false);
  });

  it('says until when in the toast', () => {
    expect(keptToast('2026-11-24T22:00:00.000Z', NOW, ZONE)).toBe('Quiet until 23:00.');
    expect(keptToast('2026-11-25T08:00:00.000Z', NOW, ZONE)).toBe('Quiet until tomorrow 09:00.');
  });
});

describe('a held thing', () => {
  const kept = {
    id: 'qw_1',
    words: 'Quiet until 23:00 · Moving the NAS',
    since: '2026-11-24T13:00:00Z',
    until: '2026-11-24T22:00:00Z',
    note: 'Moving the NAS',
    by: { id: 'prn_mara', name: 'Mara' },
    canEnd: true,
  };
  const cause = {
    thing: 'server:pve-02',
    name: 'pve-02',
    words: 'Not answering while pve-02 is down',
    href: '/things/server%3Apve-02',
  };

  it('draws a window with End now for who may end it, and a cause with its link', () => {
    expect(holdView({ keptQuiet: kept })).toMatchObject({ kind: 'window', endNow: true, link: null });
    expect(holdView({ keptQuiet: { ...kept, canEnd: false } })?.endNow).toBe(false);
    expect(holdView({ keptQuiet: { ...kept, by: undefined, whombat: true } })?.who).toContain('Whombat');
    expect(holdView({ causedBy: cause })).toMatchObject({
      kind: 'cause',
      endNow: false,
      link: { href: cause.href, label: 'Open pve-02' },
    });
    expect(holdView({})).toBeNull();
  });

  it('a kept window wins over a cause', () => {
    expect(holdView({ keptQuiet: kept, causedBy: cause })?.kind).toBe('window');
  });

  it('leaves out the heads-up line only when the page draws its hold', () => {
    const items = [{ id: 'quiet-window' }, { id: 'quiet-cause' }, { id: 'disk' }];
    expect(withoutHoldLine(items, { keptQuiet: kept }).map((n) => n.id)).toEqual(['quiet-cause', 'disk']);
    expect(withoutHoldLine(items, { causedBy: cause }).map((n) => n.id)).toEqual(['quiet-window', 'disk']);
    expect(withoutHoldLine(items, {})).toBe(items);
  });

  it('knows a held line from a line’s own quiet', () => {
    expect(heldLine({ quiet: { held: 'window' } })).toBe('window');
    expect(heldLine({ quiet: { held: 'cause' } })).toBe('cause');
    expect(heldLine({ quiet: {} })).toBeNull();
    expect(heldLine({})).toBeNull();
  });

  it('says a thing’s state in a list: its cause, else its quiet, else its line', () => {
    expect(thingStateWords({ line: 'Up', causedBy: cause }, NOW, ZONE)).toBe(cause.words);
    expect(thingStateWords({ line: 'Up', quietUntil: '2026-11-24T22:00:00Z' }, NOW, ZONE)).toBe(
      'Quiet until 23:00',
    );
    expect(thingStateWords({ line: 'Up', quietUntil: '2026-11-24T10:00:00Z' }, NOW, ZONE)).toBe('Up');
    expect(thingStateWords({}, NOW, ZONE)).toBeNull();
  });
});

describe('what happened', () => {
  const history: ThingHistory = {
    thing: 'server:pve-02',
    days: 30,
    from: '2026-10-25T13:32:00Z',
    uptime: {
      text: 'Up 99.6 % in the last 30 days · down 3 times, 41 min',
      upPct: 99.6,
      downs: 3,
      downMinutes: 41,
      from: '2026-10-25T13:32:00Z',
    },
    incidents: [
      {
        id: 'inc_2',
        nature: 'down',
        words: 'Not answering',
        startedAt: '2026-11-24T12:50:00Z',
        endedAt: null,
        minutes: 42,
      },
      {
        id: 'inc_1',
        nature: 'problem',
        words: 'A disk is failing',
        startedAt: '2026-11-10T06:31:00Z',
        endedAt: '2026-11-10T08:36:00Z',
        minutes: 125,
        cause: { thing: 'server:pve-01', name: 'pve-01' },
      },
    ],
    alerts: [
      {
        title: 'Disk / is 93 % full',
        severity: 'warning',
        rule: 'disk.space_high',
        openedAt: '2026-11-23T20:00:00Z',
        resolvedAt: '2026-11-23T21:30:00Z',
      },
    ],
  };

  it('lists incidents newest first with when, how long and their cause', () => {
    const view = historyView(history, NOW, ZONE);
    expect(view.uptime).toContain('99.6 %');
    expect(view.rows.map((r) => [r.tone, r.words, r.open])).toEqual([
      ['bad', 'Not answering', true],
      ['warn', 'A disk is failing', false],
    ]);
    expect(view.rows[0]?.when).toBe('Today 13:50 · still going');
    expect(view.rows[1]?.when).toBe('10 Nov 07:31 · 2 h 5 min');
    expect(view.rows[1]?.cause).toBe('While pve-01 was down');
    expect(view.alerts[0]).toMatchObject({ tone: 'warn', when: 'Yesterday 21:00 · 1 h 30 min' });
    expect(view.empty).toBeNull();
  });

  it('says nothing went wrong when the period is empty', () => {
    expect(historyView({ ...history, incidents: [], alerts: [] }, NOW, ZONE).empty).toBe(
      'Nothing went wrong in the last 30 days.',
    );
  });

  it('says how long in minutes, hours and days', () => {
    expect(durationWords(0)).toBe('1 min');
    expect(durationWords(41)).toBe('41 min');
    expect(durationWords(120)).toBe('2 h');
    expect(durationWords(27 * 60)).toBe('1 d 3 h');
  });
});

describe('change the limit', () => {
  const disk: Pick<ThingWatchCheck, 'check' | 'name' | 'limit' | 'perItem'> = {
    check: 'host.disk.space_high',
    name: 'Disks filling up',
    perItem: true,
    limit: {
      unit: '%',
      min: 1,
      max: 100,
      defaultValue: 90,
      value: 85,
      items: [{ subject: { id: '/mnt/backup', name: '/mnt/backup' }, value: 97 }],
    },
  };

  it('starts with the server’s own limit and says the default', () => {
    expect(limitView(disk)).toMatchObject({ value: 85, own: true, defaultValue: 90, unit: '%' });
    expect(limitView(disk)?.defaultWords).toContain('90 %');
  });

  it('for one item, starts with its own or the server’s and falls back to the server', () => {
    const own = limitView(disk, { id: '/mnt/backup', name: '/mnt/backup' });
    expect(own).toMatchObject({ value: 97, own: true, defaultValue: 85, name: '/mnt/backup' });
    expect(own?.defaultWords).toContain('follows the server');
    const other = limitView(disk, { id: '/', name: '/' });
    expect(other).toMatchObject({ value: 85, own: false });
  });

  it('says sensors have their own limits when the check has no default', () => {
    const temp = { ...disk, limit: { unit: '°C' as const, min: 1, max: 150, value: null, items: [] } };
    expect(limitView(temp)).toMatchObject({ value: null, own: false, defaultValue: null });
    expect(limitView(temp)?.defaultWords).toContain('each sensor');
  });

  it('offers it on a line of the check, for its item', () => {
    const line = { check: 'host.disk.space_high', subject: { id: '/mnt/backup', name: '/mnt/backup' } };
    expect(lineLimit(line, [disk])?.subject?.id).toBe('/mnt/backup');
    expect(lineLimit({ check: 'host.cpu.high' }, [disk])).toBeNull();
    expect(lineLimit(line, null)).toBeNull();
  });

  it('says the limit in What Whombat watches, with the items that have their own', () => {
    expect(limitLine(disk)).toEqual({
      words: 'Warns above 85 %',
      items: [{ subject: { id: '/mnt/backup', name: '/mnt/backup' }, words: 'above 97 %' }],
    });
    expect(limitLine({ limit: { ...(disk.limit as never), value: null, items: [] } })?.words).toContain(
      'the default',
    );
    expect(limitLine({})).toBeNull();
  });

  it('reads a typed limit within its range', () => {
    const view = { min: 1, max: 100, unit: '%' };
    expect(parseLimit('95', view)).toBe(95);
    expect(parseLimit('92,5', view)).toBe(92.5);
    expect(parseLimit('0', view)).toEqual({ problem: expect.stringContaining('1 to 100') });
    expect(parseLimit('', view)).toHaveProperty('problem');
  });
});
