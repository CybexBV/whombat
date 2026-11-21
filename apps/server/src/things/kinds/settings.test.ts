/**
 * Generic declared settings plumbing: `declaredSettings`, `settingsTab` (normal, unread, custom unread message,
 * per-row elsewhere addresses), and `withCurrent`.
 */
import { ThingPageTab } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../../services';
import { rowOf } from './media/testing';
import {
  type DeclaredSettings,
  declaredSettings,
  SERVICE_SETTINGS_TAB_KEY,
  settingsTab,
  withCurrent,
} from './settings';
import type { KindCtx } from './types';

interface DemoState {
  flag: boolean;
  level: string;
}

function makeDeclared(overrides: Partial<DeclaredSettings<DemoState>> = {}): DeclaredSettings<DemoState> {
  return {
    name: 'Demo',
    url: (base) => `${base}/settings`,
    groups: [
      { id: 'main', title: 'Main', ask: ['What does Flag do?'] },
      { id: 'other', title: 'Other' },
    ],
    specs: [
      {
        id: 'flag',
        group: 'main',
        label: 'Flag',
        help: 'Turns the demo flag on or off.',
        kind: 'switch',
        read: (s) => s.flag,
        write: (v) => ({ method: 'POST', path: '/flag', body: { flag: Boolean(v) } }),
      },
      {
        id: 'level',
        group: 'main',
        label: 'Level',
        help: 'How much detail Demo keeps.',
        kind: 'choice',
        read: (s) => s.level,
        choices: (s) =>
          withCurrent(
            [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
            ],
            s.level,
            (v) => `Custom (${String(v)})`,
          ),
        write: (v) => ({ method: 'POST', path: '/level', body: { level: String(v) } }),
      },
      {
        id: 'danger',
        group: 'other',
        label: 'Dangerous setting',
        help: 'Stays in Demo itself.',
        kind: 'elsewhere',
        read: () => 'Managed in Demo',
        elsewhere: (base) => `${base}/settings/danger`,
      },
      {
        id: 'same_page',
        group: 'other',
        label: 'Another external setting',
        help: 'Links to Demo’s main settings page.',
        kind: 'elsewhere',
        read: () => 'Automatic',
      },
    ],
    read: async () => ({ flag: true, level: 'high' }),
    ...overrides,
  };
}

function fakeCtx(overrides: Partial<KindCtx> = {}): KindCtx {
  return {
    services: { db: null } as unknown as Services,
    row: rowOf('plex', { id: 'con_demo', baseUrl: 'http://192.0.2.10:8080/' }),
    entry: {} as KindCtx['entry'],
    now: new Date('2026-11-04T20:13:00Z'),
    timeZone: 'UTC',
    machine: null,
    range: '24h',
    burrowId: 'brw_1',
    disk: { pct: [], gb: [] },
    viewer: {} as KindCtx['viewer'],
    ...overrides,
  };
}

describe('settingsTab and declaredSettings', () => {
  it('builds a valid service-settings tab and resolves elsewhere links against the base URL', async () => {
    const declared = makeDeclared();
    const bundled = declaredSettings(declared);
    expect(bundled.name).toBe('Demo');

    const tab = await bundled.tab(fakeCtx());
    expect(tab.key).toBe(SERVICE_SETTINGS_TAB_KEY);
    expect(tab.label).toBe('Demo settings');
    expect(ThingPageTab.safeParse(tab).success).toBe(true);

    const intro = tab.panels.find((p) => p.id === 'settings-intro');
    expect(intro?.kind === 'text' ? intro.link : null).toEqual({
      kind: 'url',
      label: 'All settings in Demo',
      url: 'http://192.0.2.10:8080/settings',
    });

    const rows = tab.panels.flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(rows.find((r) => r.id === 'danger')?.elsewhere?.url).toBe(
      'http://192.0.2.10:8080/settings/danger',
    );
    expect(rows.find((r) => r.id === 'same_page')?.elsewhere?.url).toBe('http://192.0.2.10:8080/settings');
  });

  it('shows an unread card when reading fails, using a custom unread message when declared', async () => {
    const generic = await settingsTab(
      fakeCtx({ row: rowOf('plex', { id: 'con_fail1', baseUrl: 'http://192.0.2.11', fields: {} }) }),
      makeDeclared({
        read: async () => {
          throw new Error('offline');
        },
      }),
    );
    expect(ThingPageTab.safeParse(generic).success).toBe(true);
    expect(generic.panels).toHaveLength(1);
    expect(generic.panels[0]).toMatchObject({
      kind: 'text',
      id: 'settings-unread',
      link: { kind: 'url', label: 'Open Demo', url: 'http://192.0.2.11/settings' },
    });

    const custom = await settingsTab(
      fakeCtx({ row: rowOf('plex', { id: 'con_fail2', baseUrl: 'http://192.0.2.12', fields: {} }) }),
      makeDeclared({
        read: async () => {
          throw new Error('forbidden');
        },
        unread: () => 'Only an administrator can read Demo’s settings.',
      }),
    );
    expect(custom.panels[0]?.kind === 'text' ? custom.panels[0].body : '').toContain('administrator');
  });

  it('adds an unlisted current value with withCurrent without duplicating known ones', () => {
    const base = [
      { value: 10, label: '10 min' },
      { value: 30, label: '30 min' },
    ];
    expect(withCurrent(base, 10, (v) => `${v} min`)).toBe(base);
    expect(withCurrent(base, 45, (v) => `${v} min`)).toEqual([...base, { value: 45, label: '45 min' }]);
    expect(withCurrent(base, undefined, (v) => `${v} min`)).toBe(base);
  });
});
