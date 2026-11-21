import { describe, expect, it } from 'vitest';
import { DEFAULT_DESK_SETTINGS, DESK_SERVER_ID_RE, DeskSettings, DeskSettingsPatch } from './desk.js';
import {
  applyDeskShowPatch,
  DEFAULT_DESK_SHOW,
  DESK_STRIP_ID_RE,
  DeskCalm,
  DeskShow,
  deskShowDefault,
  deskShowLevel,
} from './desk-glance.js';

describe('what the screen shows (3.2, CT-1620…CT-1625)', () => {
  it('keeps the strip’s id pattern the same as a desk server’s', () => {
    expect(DESK_STRIP_ID_RE.source).toBe(DESK_SERVER_ID_RE.source);
  });

  it('defaults servers to Always, widgets to Off and the rest to When it matters', () => {
    expect(deskShowDefault('server:pve-01')).toBe('always');
    expect(deskShowDefault('widget:w1')).toBe('off');
    for (const key of ['connection:con_1', 'device:con_2', 'work', 'coming', 'box'])
      expect(deskShowDefault(key), key).toBe('matters');
    expect(deskShowLevel({ items: { 'server:nas': 'matters' } }, 'server:nas')).toBe('matters');
  });

  it('reads settings from before 3.2 with the default choices', () => {
    const { show: _show, ...older } = DEFAULT_DESK_SETTINGS;
    expect(DeskSettings.parse(older).show).toEqual(DEFAULT_DESK_SHOW);
  });

  it('patches the parts it names, drops a key set to its default and keeps the order without repeats', () => {
    const before = DeskShow.parse({ items: { 'server:a': 'off', 'connection:c': 'always' } });
    const after = applyDeskShowPatch(before, {
      bar: { updates: 'off' },
      items: { 'server:a': 'always', 'connection:c': null, 'widget:w': 'always' },
      order: ['b', 'a', 'b'],
      clock: 'small',
    });
    expect(after.items).toEqual({ 'widget:w': 'always' });
    expect(after.bar).toEqual({ network: 'always', internet: 'always', battery: 'always', updates: 'off' });
    expect(after.order).toEqual(['b', 'a']);
    expect(after.clock).toBe('small');
    expect(after.welcomeBack).toBe(true);
    expect(before.items).toEqual({ 'server:a': 'off', 'connection:c': 'always' });
  });

  it('refuses keys it doesn’t know and words over two lines', () => {
    expect(DeskSettingsPatch.safeParse({ show: { items: { 'thing:1': 'off' } } }).success).toBe(false);
    const calm = {
      headline: { tone: 'ok', text: 'All fine' },
      clock: 'big',
      also: [],
      moreNeeds: 0,
      moments: [],
      strip: [{ name: 'pve-01', mark: 'proxmox', state: 'ok', spark: [3, 4, 5] }],
      moreStrip: 0,
      bar: DEFAULT_DESK_SHOW.bar,
    };
    expect(DeskCalm.safeParse(calm).success).toBe(true);
    expect(DeskCalm.safeParse({ ...calm, headline: { tone: 'ok', text: 'All\nfine' } }).success).toBe(false);
    expect(DeskCalm.safeParse({ ...calm, headline: { tone: 'great', text: 'All fine' } }).success).toBe(
      false,
    );
  });
});
