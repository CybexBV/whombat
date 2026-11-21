import { describe, expect, it } from 'vitest';
import { TABS } from '../data/shell';
import {
  BROKEN_WORDS,
  DOT_BADGE,
  systemBadgeValue,
  systemTabLabel,
  TAB_SYMBOLS,
  tabBarKind,
} from './systemTabs';

describe('which bar the tabs get (native-feel.md)', () => {
  it('is iOS’s own along the bottom of an iPhone', () => {
    expect(tabBarKind('bottom', 'ios')).toBe('system');
  });

  it('is ours along the bottom on Android', () => {
    expect(tabBarKind('bottom', 'android')).toBe('bottom');
  });

  it('is our side tabs where the tabs go down the side, on either phone (the Duo, a wide window)', () => {
    for (const side of ['left', 'right'] as const) {
      expect(tabBarKind(side, 'ios')).toBe('side');
      expect(tabBarKind(side, 'android')).toBe('side');
    }
  });
});

describe('a badge on iOS’s bar', () => {
  it('writes the count as our bar does', () => {
    expect(systemBadgeValue({ count: 3, dot: false })).toBe('3');
    expect(systemBadgeValue({ count: 120, dot: false })).toBe('99+');
  });

  it('shows a dot as a badge without words, and a count over a dot', () => {
    expect(systemBadgeValue({ count: 0, dot: true, tone: 'ok' })).toBe(DOT_BADGE);
    expect(systemBadgeValue({ count: 2, dot: true })).toBe('2');
  });

  it('shows nothing without a count or a dot', () => {
    expect(systemBadgeValue(undefined)).toBeUndefined();
    expect(systemBadgeValue({ count: 0, dot: false })).toBeUndefined();
  });
});

describe('what VoiceOver hears for a tab of iOS’s bar', () => {
  it('is the tab’s name, iOS reading a count from the badge', () => {
    expect(systemTabLabel('Chat', undefined)).toBe('Chat');
    expect(systemTabLabel('Needs you', { count: 3, dot: false })).toBe('Needs you');
  });

  it('says that something isn’t working, since every iPhone badge has the same colour', () => {
    expect(systemTabLabel('Inbox', { count: 3, dot: false, tone: 'bad' })).toBe(`Inbox, ${BROKEN_WORDS}`);
    expect(systemTabLabel('Inbox', { count: 3, dot: false, tone: 'warn' })).toBe('Inbox');
  });

  it('says what a dot means', () => {
    const label = systemTabLabel('Settings', { count: 0, dot: true, spoken: 'a newer app is ready' });
    expect(label).toContain('Settings');
    expect(label).toContain('a newer app is ready');
  });
});

it('has an SF Symbol for every tab', () => {
  for (const tab of TABS) expect(TAB_SYMBOLS[tab]).toMatch(/^[a-z0-9.]+$/);
});
