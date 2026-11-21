import { describe, expect, it } from 'vitest';
import { screenInView } from './ScreenFocus';

const tabs = { index: 1, routes: [{ key: 'chat' }, { key: 'needs' }] } as never;

describe('which screens count as in view', () => {
  it('a page on top, and the tabs as the left page of two whatever is beside them', () => {
    const at = { state: tabs, routeKey: 'x' };
    expect(screenInView('page', { ...at, role: 'only', focused: true })).toBe(true);
    expect(screenInView('page', { ...at, role: 'only', focused: false })).toBe(false);
    expect(screenInView('page', { ...at, role: 'list', focused: false })).toBe(true);
    // Under the right page's top screen.
    expect(screenInView('page', { ...at, role: 'beside-first', focused: false })).toBe(false);
    expect(screenInView('page', { ...at, role: 'beside', focused: true })).toBe(true);
  });

  it('a tab: the one its bar shows', () => {
    expect(screenInView('tab', { role: 'list', focused: false, state: tabs, routeKey: 'needs' })).toBe(true);
    expect(screenInView('tab', { role: 'list', focused: false, state: tabs, routeKey: 'chat' })).toBe(false);
  });
});
