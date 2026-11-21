import { describe, expect, it } from 'vitest';
import { isWidePage, listHiding, parseFullWidthTabs, withFullWidth, writeFullWidthTabs } from './fullWidth';

describe('the tabs whose list is hidden', () => {
  it('reads what the phone kept, ignoring Chat and words it does not know', () => {
    expect([...parseFullWidthTabs('Automations,ChatRoom,Nope,Dashboard')]).toEqual([
      'Automations',
      'Dashboard',
    ]);
    expect(parseFullWidthTabs(null).size).toBe(0);
    expect(parseFullWidthTabs('').size).toBe(0);
  });

  it('writes them in the tabs’ order and reads them back', () => {
    const tabs = withFullWidth(withFullWidth(new Set(), 'Automations', true), 'Dashboard', true);
    expect(writeFullWidthTabs(tabs)).toBe('Dashboard,Automations');
    expect(parseFullWidthTabs(writeFullWidthTabs(tabs))).toEqual(tabs);
    expect(writeFullWidthTabs(withFullWidth(tabs, 'Dashboard', false))).toBe('Automations');
  });
});

describe('hiding a list', () => {
  it('beside Chat is offered with nothing open, as before', () => {
    expect(listHiding({ chat: true, kept: true, open: false })).toEqual({ hidden: true, offered: true });
    expect(listHiding({ chat: true, kept: false, open: false })).toEqual({ hidden: false, offered: true });
  });

  it('beside another tab only while something is open there', () => {
    expect(listHiding({ chat: false, kept: true, open: true })).toEqual({ hidden: true, offered: true });
    expect(listHiding({ chat: false, kept: true, open: false })).toEqual({ hidden: false, offered: false });
    expect(listHiding({ chat: false, kept: false, open: true })).toEqual({ hidden: false, offered: true });
  });
});

describe('a wide page', () => {
  it('is an open Duo or foldable with the list hidden, not the page beside a list', () => {
    // The Duo open is 951 wide: less the side bar and the page's margins.
    expect(isWidePage(951 - 84 - 36)).toBe(true);
    // An unfolded foldable, 841 wide.
    expect(isWidePage(841 - 72 - 36)).toBe(true);
    // The page beside a list.
    expect(isWidePage(480)).toBe(false);
  });
});
