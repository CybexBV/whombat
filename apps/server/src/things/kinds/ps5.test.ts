import { PS5_OFFICIAL_REPOSITORY } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { Ps5Snapshot } from '../../connections/ps5-api';
import { genericChecksFor, genericNotices } from '../panels';
import { checkStartsOn } from '../quiet/defaults';
import { KIND_MODULES } from './index';
import { PS5_KIND, ps5Notices, ps5UnavailableView, ps5View } from './ps5';
import { slotProblems } from './slots';

const snapshot: Ps5Snapshot = {
  payloads: {
    self: { running_version: '0.6.3', pending_version: '' },
    items: [
      { slot: 'local/shadowmountplus', filename: 'ShadowMountPlus.elf' },
      { slot: 'local/installer', filename: 'WebKit-Installer.elf', version: 'v0.7.1' },
    ],
  },
  history: null,
  startup: null,
  releases: null,
  updates: null,
  console: null,
  power: null,
  webkit: null,
  config: { AUTOLOAD_ENABLED: true, AUTOLOAD_LIST: 'local/shadowmountplus,!3000', AUTOLOAD_DELAY: 5 },
  processes: {
    processes: [
      { pid: 87, name: 'shadowmountplus.elf', memory: 24.9, is_daemon: true },
      { pid: 74, name: 'fs_cleaner.elf', memory: 2.5, is_daemon: false },
    ],
  },
  shadow: { status: 0, api_version: 1, shadowmount_version: '1.7beta11', capabilities: [] },
  games: {
    status: 0,
    count: 1,
    games: [
      {
        title_id: 'PPSA00001',
        title_name: 'A game',
        version: '01.000.000',
        platform: 'ps5',
        installed: true,
        managed: true,
        mounted: false,
        source_available: true,
        icon_url: '/api/v1/games/icon?title_id=PPSA00001&v=3-f75e',
      },
    ],
  },
  storage: {
    status: 0,
    mounts: ['/system', '/user', '/mnt/usb0'].map((mount_point) => ({
      mount_point,
      total_bytes: 1e12,
      available_bytes: 4e11,
      used_bytes: 6e11,
      read_only: false,
      ejectable: mount_point.endsWith('usb0'),
    })),
  },
  unavailable: [],
};

const at = {
  now: new Date('2026-11-08T12:00:00Z'),
  timeZone: 'Europe/Amsterdam',
  cover: (path: string, alt: string) => ({ ref: `ref:${path}`, alt, shape: 'square' as const }),
};

describe('PS5 dashboard', () => {
  it('shows reboot readiness as a calm capability without adding an alarm', () => {
    const missing = ps5View(snapshot, at);
    expect(missing.panels.find((p) => p.id === 'remote-reboot')).toMatchObject({
      kind: 'text',
      body: expect.stringContaining('enable remote reboot'),
    });
    const ready = ps5View(
      {
        ...snapshot,
        power: {
          ready: true,
          pid: 101,
          build: 'SystemStateManager shutdown_type2 rest_stmgr0 cdioceject 2026-05-25',
        },
      },
      at,
    );
    expect(ready.panels.find((p) => p.id === 'remote-reboot')).toMatchObject({
      body: expect.stringContaining('Ready.'),
    });
    expect(ready.notices).toEqual(missing.notices);
    expect(slotProblems(ready)).toEqual([]);
  });
  it('fits the shared slots and keeps storage and the library readable', () => {
    const view = ps5View(snapshot, at);
    expect(slotProblems(view)).toEqual([]);
    const text = JSON.stringify(view);
    for (const fact of [
      'A game',
      '01.000.000',
      '1.7beta11',
      '0.6.3',
      '/mnt/usb0',
      'Internal storage',
      'Wait 3 s',
      'cached version unknown',
    ])
      expect(text).toContain(fact);
    expect(text).not.toContain('/system');
    const running = view.panels.find((p) => p.id === 'running');
    expect(running?.kind === 'list' && running.items).toEqual([
      { id: 'process-87', title: 'shadowmountplus.elf', right: '26 MB' },
    ]);
    expect(text).not.toContain('fs_cleaner');
  });

  it('leaves missing optional data unknown and remains calm when homebrew is unavailable', () => {
    const view = ps5View(
      {
        ...snapshot,
        games: null,
        shadow: null,
        storage: null,
        processes: null,
        config: null,
        unavailable: ['ShadowMountPlus'],
      },
      at,
    );
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.some((p) => p.id === 'library' || p.id === 'games')).toBe(false);
    expect(view.notices).toEqual([]);
    expect(slotProblems(ps5UnavailableView())).toEqual([]);
    expect(ps5UnavailableView().status?.status).toBe('ok');
    expect(KIND_MODULES.ps5).toBeDefined();
    expect(checkStartsOn('ps5.available')).toBe(false);
    expect(genericChecksFor('ps5').some((c) => c.check === 'conn.answers')).toBe(false);
    expect(genericChecksFor('plex').some((c) => c.check === 'conn.answers')).toBe(true);
    for (const outcome of ['offline', 'error'] as const) {
      const notices = genericNotices(
        {
          catalogId: 'ps5',
          label: 'PS5',
          status: 'active',
          checks: [],
          glance: { status: 'ok', outcome, facts: [] },
        },
        0,
        null,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ check: 'ps5.available', nature: 'fyi', tone: 'info' });
    }
    expect(
      genericNotices(
        {
          catalogId: 'ps5',
          label: 'PS5',
          status: 'active',
          glance: null,
          checks: [{ id: 'credential', state: 'error', message: 'Connection refused' }],
        },
        0,
        null,
      ).map((n) => n.check),
    ).toEqual(['ps5.available']);
  });

  it('shows covers, updates, how startup went, the console and what Whombat installed', () => {
    const items = [
      { slot: 'local/kstuff-lite', filename: 'kstuff-lite_v1.10.elf' },
      { slot: 'local/shadowmountplus', filename: 'ShadowMountPlus_1.7beta11.elf' },
      {
        slot: 'repo/webkit-autoloader-installer@e8cce5d1',
        filename: 'WebKit-Autoloader-Installer_v0.7.1.elf',
        id: 'webkit-autoloader-installer',
        version: 'v0.7.1',
        source_url: PS5_OFFICIAL_REPOSITORY,
      },
    ];
    const s: Ps5Snapshot = {
      ...snapshot,
      payloads: { ...snapshot.payloads, items },
      config: {
        AUTOLOAD_ENABLED: true,
        AUTOLOAD_LIST: 'local/kstuff-lite,!3000,local/shadowmountplus',
        AUTOLOAD_DELAY: 5,
      },
      startup: {
        state: 'done',
        entries: [
          { slot: 'local/kstuff-lite', outcome: 'started' },
          { slot: 'local/shadowmountplus', outcome: 'failed' },
        ],
      },
      updates: [
        {
          slot: 'local/kstuff-lite',
          name: 'kstuff-lite',
          installed: 'v1.10',
          source: 'uploaded',
          available: { id: 'kstuff-lite', version: 'v1.11', checksum: 'a'.repeat(64) },
          newer: true,
          startup: true,
          firmware: null,
          fits: null,
        },
        {
          slot: 'local/shadowmountplus',
          name: 'ShadowMountPlus',
          installed: '1.7beta11',
          source: 'uploaded',
          available: { id: 'shadowmountplus', version: '1.7beta11', checksum: 'b'.repeat(64) },
          newer: false,
          startup: true,
          firmware: null,
          fits: null,
        },
      ],
      console: { state: 'awake', name: 'PS5-103', firmware: '10.01' },
      webkit: { version: 'v0.7.1', at: '2026-11-08T10:00:00Z', startedSince: true },
    };
    const view = ps5View(s, at);
    expect(slotProblems(view)).toEqual([]);
    const library = view.panels.find((p) => p.id === 'library');
    expect(library?.kind === 'gallery' && library.items[0]?.image?.ref).toBe(
      'ref:/api/v1/games/icon?title_id=PPSA00001&v=3-f75e',
    );
    const text = JSON.stringify(view);
    for (const fact of [
      'kstuff-lite v1.10 → v1.11',
      'Uploaded by hand',
      'Didn’t start',
      'Last start finished',
      'PS5-103',
      'Firmware 10.01',
      'Installer · run by Whombat on 8 Nov',
      'Updated by Whombat on 8 Nov · started again since',
      'From its file name',
      'v1.11 available',
    ])
      expect(text).toContain(fact);
    expect(text).not.toContain('Not reported');
    expect(ps5Notices(s).map((n) => [n.check, n.nature])).toEqual([
      ['ps5.startup', 'problem'],
      ['ps5.updates', 'fyi'],
    ]);
    for (const check of ['ps5.updates', 'ps5.startup']) expect(checkStartsOn(check)).toBe(false);
  });

  it('says what the console told it when homebrew doesn’t answer', async () => {
    expect(ps5UnavailableView({ state: 'resting', name: 'PS5-103', firmware: '10.01' }).status?.badge).toBe(
      'Resting',
    );
    expect(ps5UnavailableView({ state: 'awake', name: null, firmware: null }).status?.badge).toBe(
      'Homebrew isn’t running',
    );
    expect(ps5UnavailableView('silent').status?.badge).toBe('Not answering');
    for (const seen of [
      { state: 'resting', name: 'PS5-103', firmware: '10.01' } as const,
      'silent' as const,
      null,
    ])
      expect(slotProblems(ps5UnavailableView(seen))).toEqual([]);
    expect(PS5_KIND.unanswered).toBeDefined();
  });
});
