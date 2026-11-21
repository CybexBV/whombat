import {
  DEFAULT_DESK_SHOW,
  DeskShowOption,
  type HostServer,
  type ThingSummary,
  type Widget,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { deskShowOptions, serverLine } from './options';
import type { DeskServer } from './shapes';
import { showOf } from './store';

const row = (over: Partial<HostServer>) =>
  ({ platform: 'standard', os: null, cpu: null, ...over }) as Pick<HostServer, 'platform' | 'os' | 'cpu'>;

describe('a server’s line (DK-106)', () => {
  it('says what it runs and its cores', () => {
    expect(
      serverLine(
        row({ platform: 'proxmox', os: 'Debian GNU/Linux 12', cpu: { model: 'x', cores: 16, threads: 32 } }),
      ),
    ).toBe('Proxmox · 16 cores');
    expect(
      serverLine(row({ os: 'Debian GNU/Linux 13 (trixie)', cpu: { model: 'x', cores: 4, threads: 4 } })),
    ).toBe('Debian · 4 cores');
    expect(serverLine(row({ os: 'Ubuntu 24.04.1 LTS' }))).toBe('Ubuntu');
    expect(serverLine(row({}))).toBe('');
  });
});

const thing = (id: string, over: Partial<ThingSummary> = {}) =>
  ({
    id,
    kind: 'connection',
    name: id,
    icon: 'x',
    status: 'ok',
    facts: [],
    href: { kind: 'thing', id },
    ...over,
  }) as ThingSummary;
const card = (id: string): DeskServer => ({ id, name: id, mark: 'proxmox', state: 'ok', note: 'up 3 d' });

describe('Settings’ lists (DK-106, DK-108)', () => {
  const options = deskShowOptions({
    assistant: 'Neo',
    things: [
      thing('connection:con_plex', { name: 'Plex', catalogId: 'plex' }),
      thing('device:dev_lamp', { kind: 'device', name: 'Lamp', catalogId: 'device', line: '2 lights on' }),
      thing('server:pve-01', { kind: 'server' }),
    ],
    widgets: [
      {
        id: 'wdg_living',
        title: 'Living room',
        kind: 'line',
        series: [{ key: 't', label: 'Temperature', unit: '°C', color: 1 }],
        latest: [{ key: 't', value: 21.44, unit: '°C' }],
        points: [],
        refreshSec: 300,
        updatedAt: null,
      } as unknown as Widget,
    ],
    servers: [
      { card: card('blackbox') },
      { card: card('nas') },
      {
        card: card('pve-01'),
        row: row({ platform: 'proxmox', cpu: { model: 'x', cores: 16, threads: 32 } }) as HostServer,
      },
    ],
    show: { order: ['pve-01', 'gone'] },
    activityLine: (id) => (id === 'plex' ? 'Who’s watching' : null),
  });

  it('lists the work, the things, the widgets, the servers in the strip’s order and the box', () => {
    for (const o of options) expect(DeskShowOption.safeParse(o).success).toBe(true);
    expect(options.map((o) => o.key)).toEqual([
      'work',
      'coming',
      'connection:con_plex',
      'device:dev_lamp',
      'widget:wdg_living',
      'server:pve-01',
      'server:blackbox',
      'server:nas',
      'box',
    ]);
    expect(options[0]?.name).toContain('Neo');
  });

  it('says what each shows: an activity where the kind has one, else its line; a widget’s value now', () => {
    const by = new Map(options.map((o) => [o.key, o]));
    expect(by.get('connection:con_plex')).toMatchObject({
      line: 'Who’s watching',
      mark: 'plex',
      activity: true,
    });
    expect(by.get('device:dev_lamp')).toMatchObject({ line: '2 lights on', activity: false });
    expect(by.get('device:dev_lamp')).not.toHaveProperty('mark');
    expect(by.get('widget:wdg_living')).toMatchObject({
      name: 'Living room',
      line: '21.4 °C',
      activity: false,
    });
    expect(by.get('server:pve-01')).toMatchObject({
      line: 'Proxmox · 16 cores',
      mark: 'proxmox',
      group: 'server',
    });
    expect(by.get('server:nas')?.line).toBe('');
  });
});

describe('the kept choices (DK-102)', () => {
  it('reads nothing or an older row as the defaults, and a part it can’t read as that part’s default', () => {
    expect(showOf({})).toEqual(DEFAULT_DESK_SHOW);
    expect(showOf(null)).toEqual(DEFAULT_DESK_SHOW);
    const kept = showOf({ clock: 'small', items: { 'server:nas': 'off' }, bar: { battery: 'huge' } });
    expect(kept).toMatchObject({
      clock: 'small',
      items: { 'server:nas': 'off' },
      bar: DEFAULT_DESK_SHOW.bar,
    });
  });
});
