import { describe, expect, it } from 'vitest';
import { FILL_MAX_TABS, revealOffset, tabWords, underlineTabsLayout } from './tabsLayout';

const tab = (label: string, count?: number | null, tone?: 'warn' | 'bad' | null) => ({ label, count, tone });

describe('tabs with an underline: fill or scroll (underline-tabs-android.md AP-2632)', () => {
  it('counts a tab’s words with its count and its dot', () => {
    expect(tabWords(tab('Servers'))).toBe(7);
    expect(tabWords(tab('Services', 12))).toBe(11);
    expect(tabWords(tab('Services', 12, 'warn'))).toBe(12);
    expect(tabWords(tab('Activity', null, null))).toBe(8);
  });

  it('lets Connections’, a server’s and a small thing page’s tabs share the row', () => {
    expect(underlineTabsLayout([tab('Servers', 2), tab('Services', 12, 'warn'), tab('Pinned', 1)])).toBe(
      'fill',
    );
    expect(underlineTabsLayout([tab('Summary'), tab('Array'), tab('Guests'), tab('Plugins')])).toBe('fill');
    // Overview · Devices 12 · Activity and Settings beside them.
    expect(underlineTabsLayout([tab('Overview'), tab('Devices', 12), tab('Activity')], 4)).toBe('fill');
  });

  it('scrolls with large text, and counts a status mark like a dot', () => {
    const overview = [tab('Servers', 5), tab('Connections', 5), tab('Pinned', 1)];
    expect(underlineTabsLayout(overview)).toBe('fill');
    expect(underlineTabsLayout(overview, 3, 1.3)).toBe('scroll');
    expect(tabWords({ label: 'Servers', count: 5, level: 'notWorking' })).toBe(10);
  });

  it('scrolls more than four, a trailing control counting as one', () => {
    const five = ['Summary', 'Settings', 'Snapshots', 'Backups', 'Tasks'].map((l) => tab(l));
    expect(five.length).toBeGreaterThan(FILL_MAX_TABS);
    expect(underlineTabsLayout(five)).toBe('scroll');
    expect(underlineTabsLayout(five.slice(0, 4), 5)).toBe('scroll');
  });

  it('scrolls tabs whose words don’t fit an equal share', () => {
    expect(
      underlineTabsLayout([tab('Overview'), tab('Integrations', 171), tab('Logs'), tab('Activity')]),
    ).toBe('scroll');
    expect(underlineTabsLayout([tab('Overview'), tab('Integrations', 171)])).toBe('fill');
  });
});

describe('keeping the open tab in view (AP-2632)', () => {
  const view = { x: 0, width: 360 };

  it('leaves a tab that shows where it is', () => {
    expect(revealOffset({ x: 100, width: 80 }, view)).toBeNull();
    expect(revealOffset({ x: 6, width: 80 }, view)).toBeNull();
  });

  it('scrolls just far enough that a tab past the right edge shows with a peek of the next', () => {
    expect(revealOffset({ x: 400, width: 90 }, view)).toBe(400 + 90 + 24 - 360);
  });

  it('scrolls back to a tab left of the view, never before the start', () => {
    expect(revealOffset({ x: 200, width: 90 }, { x: 300, width: 360 })).toBe(176);
    expect(revealOffset({ x: 6, width: 90 }, { x: 300, width: 360 })).toBe(0);
  });

  it('waits until the row and the tab are measured', () => {
    expect(revealOffset({ x: 400, width: 90 }, { x: 0, width: 0 })).toBeNull();
    expect(revealOffset({ x: 0, width: 0 }, view)).toBeNull();
  });
});
