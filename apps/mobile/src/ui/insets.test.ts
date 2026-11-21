import { describe, expect, it } from 'vitest';
import {
  ABOVE_KEYBOARD,
  composerBottomPadding,
  keyboardOverlap,
  keyboardPadding,
  screenBottomRoom,
  TAB_BAR_SYSTEM_GAP,
  tabBarBottomPadding,
} from './insets';

describe('the tab bar’s bottom padding (AP-2750)', () => {
  it('keeps the labels clear of the system’s area: gesture handle, stashed taskbar, three buttons', () => {
    // The unfolded screen's stashed taskbar (~16dp), a phone's gesture area (~24dp), three buttons (48dp).
    for (const inset of [16, 24, 48]) expect(tabBarBottomPadding(inset)).toBe(inset + TAB_BAR_SYSTEM_GAP);
  });

  it('is the mock’s 14 without such an area', () => {
    expect(tabBarBottomPadding(0)).toBe(14);
  });
});

describe('the composer’s bottom padding (AP-6254)', () => {
  it('keeps the home indicator clear on a page of its own, at least 10', () => {
    expect(composerBottomPadding(34, 'nothing')).toBe(34);
    expect(composerBottomPadding(0, 'nothing')).toBe(10);
  });

  it('sits 10 above the tab bar, which keeps the system’s area itself', () => {
    expect(composerBottomPadding(34, 'tab-bar')).toBe(10);
    expect(composerBottomPadding(48, 'tab-bar')).toBe(10);
  });

  it('sits 10 above iOS’s own tab bar, which covers the screen’s bottom', () => {
    expect(composerBottomPadding(34, 'glass-bar', 83)).toBe(93);
    // Before the bar is measured, at least the home indicator's room.
    expect(composerBottomPadding(34, 'glass-bar', 0)).toBe(44);
  });
});

describe('the room a screen’s bottom leaves for what covers it', () => {
  it('is nothing above our own tab bar, which keeps the system’s area itself', () => {
    expect(screenBottomRoom(34, 'tab-bar')).toBe(0);
  });

  it('is the home indicator’s or gesture area’s at the window’s edge', () => {
    for (const inset of [0, 20, 34, 48]) expect(screenBottomRoom(inset, 'edge')).toBe(inset);
  });

  it('is what iOS’s tab bar covers, at least the home indicator’s room before it is measured', () => {
    expect(screenBottomRoom(34, 'glass-bar', 83)).toBe(83);
    expect(screenBottomRoom(34, 'glass-bar', 0)).toBe(34);
  });
});

describe('a bar resting on the keyboard', () => {
  it('has its rest padding with the keyboard down and the gap above the keyboard with it up', () => {
    expect(keyboardPadding(34, ABOVE_KEYBOARD, 0)).toBe(34);
    expect(keyboardPadding(34, ABOVE_KEYBOARD, 1)).toBe(ABOVE_KEYBOARD);
  });

  it('moves between them with the keyboard, never past either end', () => {
    expect(keyboardPadding(30, 10, 0.5)).toBe(20);
    expect(keyboardPadding(30, 10, -0.2)).toBe(30);
    expect(keyboardPadding(30, 10, 1.4)).toBe(10);
  });
});

describe('the part of a screen the keyboard covers', () => {
  it('is the keyboard for a screen that reaches the window’s bottom', () => {
    expect(keyboardOverlap(300, 800, 800)).toBe(300);
  });

  it('leaves out what is under the screen, such as a tab bar', () => {
    expect(keyboardOverlap(300, 800, 720)).toBe(220);
  });

  it('is nothing with the keyboard down or lower than what is under the screen', () => {
    expect(keyboardOverlap(0, 800, 720)).toBe(0);
    expect(keyboardOverlap(50, 800, 720)).toBe(0);
  });
});
