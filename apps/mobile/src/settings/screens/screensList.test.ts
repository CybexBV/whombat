import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { OperationError } from '@whombat/client/session';
import { describe, expect, it } from 'vitest';
import {
  boxParts,
  layoutLine,
  lettersProblem,
  popupOptions,
  screenLetters,
  screenName,
  screenRow,
  screensOffered,
  screensRowLine,
} from './screensList';

const NOW = Date.parse('2026-10-27T14:34:00Z');
const api = () =>
  fakeDeskApi(createFakeDesk({ screens: true, now: () => NOW }), { personId: 'p_me', name: 'Mara' });

describe('Settings → Screens on the phone', () => {
  it('shows Screens where the runtime answers, the older page where it doesn’t know the op, even with an old answer kept', async () => {
    const list = await api().screens();
    const unknown = new OperationError('desk.screens', 404, 'unknown_op', 'No operation desk.screens');
    expect(screensOffered({ data: list })).toBe('screens');
    expect(screensOffered({ error: unknown })).toBe('older');
    expect(screensOffered({ data: list, error: unknown })).toBe('older');
    expect(screensOffered({ data: list, error: new Error('offline') })).toBe('screens');
    expect(screensOffered({ error: new Error('offline') })).toBe('failed');
    expect(screensOffered({ isLoading: true })).toBe('loading');
    expect(screensRowLine(list)).toBe('3 screens');
    expect(screensRowLine({ ...list, screens: list.screens.slice(0, 1) })).toBe('This Whombat’s screen');
  });

  it('gives each screen the shared lines, from its own read once it’s there', async () => {
    const a = api();
    const { screens } = await a.screens();
    const office = screens.find((s) => s.name === 'Office monitor');
    if (!office) throw new Error('no office');
    const detail = await a.screen(office.id);
    const row = screenRow(office, detail, { now: NOW, timeZone: 'Europe/Amsterdam' });
    expect(row.what).toContain('12 × 7');
    expect(row.what).toContain('2 pages');
    expect(row.what).toContain('every 30 s');
    expect(row.how).toContain('problems only');
    expect(row.status).toBeNull();
    expect(row.spoken).toContain('Office monitor');
    // Before its own read: the list's summary at Normal.
    expect(screenRow(office, undefined, { now: NOW, timeZone: 'Europe/Amsterdam' }).what).toContain(
      '2 pages',
    );
    const away = screenRow({ ...office, online: false, lastSeenAt: '2026-10-27T12:02:00Z' }, detail, {
      now: NOW,
      timeZone: 'Europe/Amsterdam',
    });
    expect(away.status).toContain('13:02');
    expect(layoutLine(detail)).toBe('2 pages · 12 × 7');
  });

  it('takes the six letters as the screen shows them, and a name of one line', () => {
    expect(screenLetters('ktr · mwp')).toBe('KTRMWP');
    expect(screenLetters('KTRMWPX')).toBe('KTRMWP');
    expect(lettersProblem('KTRM')).toBe('short');
    expect(lettersProblem('KTRMWO')).toBe('io');
    expect(lettersProblem('KTRMWP')).toBeNull();
    expect(screenName('  Kitchen\n tablet ')).toBe('Kitchen tablet');
    expect(screenName('   ')).toBeNull();
    expect(screenName('x'.repeat(50))).toHaveLength(40);
  });

  it('offers the three pop-ups in their order, and the box’s parts once paired', () => {
    expect(popupOptions().map((o) => o.value)).toEqual(['all', 'problems', 'none']);
    expect(boxParts({ paired: null })).toEqual([]);
    expect(
      boxParts({
        paired: { personId: 'p', name: 'Mara', pairedAt: '2026-10-01T10:00:00Z', hasPin: true, self: false },
      }),
    ).toEqual(['bar', 'lock', 'night', 'talk']);
  });
});
