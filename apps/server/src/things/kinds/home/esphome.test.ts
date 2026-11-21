import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import {
  ESPHOME_CHECKS,
  type EspSnapshot,
  esphomeKpis,
  esphomeNotices,
  esphomeSkipped,
  esphomeView,
  failedInstalls,
  importableOf,
  installButton,
  parseDevices,
  parseJobs,
  updateAllButton,
} from './esphome';
import { ESPHOME_devices, ESPHOME_hello, ESPHOME_jobs } from './fixtures/esphome';

const NOW = new Date('2026-10-21T19:50:00Z');
const TZ = 'Europe/Amsterdam';
const ROW = {
  access: 'manage',
  label: 'ESPHome',
  catalogId: 'esphome',
  fields: {},
} as unknown as CatalogConnectionRow;
const LOOK = { ...ROW, access: 'read' } as CatalogConnectionRow;

const real = (): EspSnapshot => ({
  readAt: NOW,
  version: ESPHOME_hello.esphome_version,
  devices: parseDevices(ESPHOME_devices),
  jobs: parseJobs(ESPHOME_jobs),
});

/** The real devices with their runtime states as a house with devices would have them. */
function house(): EspSnapshot {
  const [garden, kitchen] = ESPHOME_devices.configured as Record<string, unknown>[];
  const devices = parseDevices({
    configured: [
      {
        ...garden,
        runtime_state: {
          ...(garden?.runtime_state as object),
          state: 'offline',
          offline_seconds: 1800,
          deployed_version: '2026.9.2',
        },
        update_available: true,
        has_pending_changes: false,
      },
      {
        ...kitchen,
        runtime_state: {
          ...(kitchen?.runtime_state as object),
          state: 'online',
          deployed_version: '2026.10.0',
          ip_addresses: ['192.168.1.40'],
        },
        has_pending_changes: true,
      },
      {
        ...kitchen,
        configuration: 'porch.yaml',
        friendly_name: 'Porch',
        runtime_state: { state: 'online', deployed_version: '2026.9.2', ip_addresses: ['192.168.1.41'] },
        update_available: true,
        has_pending_changes: false,
      },
    ],
  });
  return { ...real(), devices };
}

describe('ESPHome', () => {
  it('reads the Builder’s devices and jobs', () => {
    const s = real();
    expect(s.devices.map((d) => [d.config, d.state, d.pending, d.update])).toEqual([
      ['garden-light.yaml', 'unknown', true, false],
      ['kitchen-sensor.yaml', 'unknown', false, false],
    ]);
    expect(s.devices[0]?.address).toBe('garden-light.local');
    expect(s.jobs?.map((j) => [j.type, j.status])).toEqual([
      ['upload', 'failed'],
      ['compile', 'completed'],
    ]);
  });

  it('notices the install whose upload failed, within a day', () => {
    expect(failedInstalls(real(), NOW).map((j) => j.config)).toEqual(['kitchen-sensor.yaml']);
    expect(failedInstalls(real(), new Date(NOW.getTime() + 2 * 86_400_000))).toEqual([]);
    const lines = esphomeNotices(real(), NOW, TZ);
    expect(lines.map((n) => [n.id, n.tone])).toEqual([['failed-kitchen-sensor.yaml', 'warn']]);
    // Each install is a job of its own: another one failing is a new line (QN-11).
    expect(lines[0]).toMatchObject({
      check: 'esphome.install_failed',
      nature: 'problem',
      subject: { id: 'device:kitchen-sensor.yaml' },
      ignore: { lifts: 'newer' },
      episode: real().jobs?.[0]?.id,
    });
    expect(esphomeSkipped(real())).toEqual([]);
    expect(esphomeSkipped({ ...real(), jobs: null })).toEqual(['esphome.install_failed']);
  });

  it('counts online, updates and changes', () => {
    expect(esphomeKpis(house()).map((k) => [k.key, k.value, k.rest ?? null])).toEqual([
      ['online', '2', 'of 3'],
      ['updates', '2', null],
      ['pending', '1', null],
      ['version', '2026.10.0', null],
    ]);
    expect(esphomeKpis(house())[0]?.tone).toBe('warn');
  });

  it('says since when a device is offline: a problem after two passes, a heads-up after a week (QN-04)', () => {
    const notices = esphomeNotices(house(), NOW, TZ);
    const offline = notices.find((n) => n.check === 'esphome.device_offline');
    expect(offline).toMatchObject({
      id: 'offline-garden-light.yaml',
      tone: 'warn',
      nature: 'problem',
      confirm: 2,
      subject: { id: 'device:garden-light.yaml' },
      ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
      link: { kind: 'ask' },
    });
    expect(offline?.title).toContain('21:20');
    // A few days is still a problem; no red for a device that has been gone a while.
    const days = house();
    (days.devices[0] as { offlineSeconds: number }).offlineSeconds = 3 * 86_400;
    expect(esphomeNotices(days, NOW, TZ)[0]).toMatchObject({ tone: 'warn', nature: 'problem' });
    const away = house();
    (away.devices[0] as { offlineSeconds: number }).offlineSeconds = 9 * 86_400;
    const gone = esphomeNotices(away, NOW, TZ)[0];
    expect(gone).toMatchObject({ tone: 'info', nature: 'fyi' });
    expect(gone?.link).toBeUndefined();
    expect(gone?.detail).toContain('Stop watching');
  });

  it('one heads-up per device on an older ESPHome, until the next ESPHome', () => {
    const older = esphomeNotices(house(), NOW, TZ).filter((n) => n.check === 'esphome.older');
    expect(older.map((n) => [n.subject?.id, n.tone, n.nature, n.episode])).toEqual([
      ['device:garden-light.yaml', 'info', 'fyi', '2026.10.0'],
      ['device:porch.yaml', 'info', 'fyi', '2026.10.0'],
    ]);
    expect(older.every((n) => !n.link)).toBe(true);
    expect(ESPHOME_CHECKS.map((c) => c.check)).toEqual([
      'esphome.device_offline',
      'esphome.install_failed',
      'esphome.older',
    ]);
    // The head comes from the lines now.
    expect(esphomeView(house(), { now: NOW, timeZone: TZ, buttons: { row: ROW } }).status).toBe(undefined);
  });

  it('offers Update or Install per device and Update all, confirmed', () => {
    const [garden, kitchen, porch] = house().devices;
    const b = { row: ROW };
    expect(installButton(garden as never, b)).toMatchObject({
      action: 'install',
      target: 'garden-light.yaml',
      label: 'Update',
      allowed: true,
    });
    expect(installButton(kitchen as never, b)?.label).toBe('Install');
    expect(installButton(porch as never, b)?.confirm).toBeDefined();
    expect(installButton(real().devices[1] as never, b)).toBeNull();
    const all = updateAllButton(house(), { row: LOOK });
    expect(all).toMatchObject({ action: 'install-all', allowed: false });
    expect(updateAllButton(real(), b)).toBeNull();
  });

  it('lists every device below the slots, offline ones first', () => {
    const view = esphomeView(house(), { now: NOW, timeZone: TZ, buttons: { row: ROW } });
    const table = view.panels.find((p) => p.id === 'devices');
    expect(table).toMatchObject({ kind: 'table', place: 'main' });
    if (table?.kind !== 'table') return;
    expect(table.rows.map((r) => r.id)).toEqual(['garden-light.yaml', 'kitchen-sensor.yaml', 'porch.yaml']);
    expect(table.rows[0]?.cells.state?.dot).toBe('warn');
  });

  it('builds its Summary in slots: To update with Update all, In ESPHome, its line on a known machine', () => {
    const view = esphomeView(
      { ...house(), importable: 1 },
      { now: NOW, timeZone: TZ, buttons: { row: ROW }, openUrl: 'http://10.0.0.5:6052', knownMachine: true },
    );
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.buttons).toEqual([]);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    expect(view.panels.map((p) => p.id)).toEqual(['updates', 'inventory', 'devices']);

    const live = view.panels[0];
    if (live?.kind !== 'list') throw new Error('To update is a list');
    expect(live.buttons?.map((x) => x.action)).toEqual(['install-all']);
    expect(live.meta).toBe('3 waiting · ESPHome 2026.10.0 is here');
    // Online ones first, updates before installs, each with its own button; the offline one amber.
    expect(live.items.map((i) => [i.title, i.detail, i.actions?.[0]?.label, i.tone ?? null])).toEqual([
      ['Porch', 'Runs 2026.9.2', 'Update', null],
      ['kitchen-sensor', 'Changed since it was installed', 'Install', null],
      ['garden-light', 'Runs 2026.9.2 · Offline since 21:20', 'Update', 'warn'],
    ]);

    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('In ESPHome is a list');
    expect(inv.items.map((i) => [i.title, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['Devices', '3', '1 offline'],
      ['Up to date', '1', '2 on an older ESPHome'],
      ['Changed since installed', '1', 'Install to use it'],
      ['Found on the network', '1', 'Not added yet'],
    ]);
    expect(inv.items[0]?.detail).toBe('3 ESP32');
    expect(view.slots?.machine).toEqual([
      { id: 'esphome-version', label: 'ESPHome', value: '2026.10.0', pct: null, sub: '1 of 3 devices on it' },
    ]);
    expect(view.verdict).toBe('ESPHome is fine: 2 of 3 devices are online.');
    // On a machine Whombat doesn't know: no card of one line, the head says the version.
    expect(esphomeView(house(), { now: NOW, timeZone: TZ, buttons: { row: ROW } }).slots?.machine).toEqual(
      [],
    );
  });

  it('shows an install going on with how far it is, and asks again every 5 seconds', () => {
    const s = house();
    const running: EspSnapshot = {
      ...s,
      jobs: [
        ...(s.jobs ?? []),
        { id: 'j9', config: 'porch.yaml', type: 'compile', status: 'running', at: NOW, progress: 63 },
        { id: 'j10', config: 'porch.yaml', type: 'upload', status: 'queued', at: NOW, progress: null },
      ],
    };
    const view = esphomeView(running, { now: NOW, timeZone: TZ, buttons: { row: ROW } });
    expect(view.refreshS).toBe(5);
    const live = view.panels[0];
    if (live?.kind !== 'list') throw new Error('To update is a list');
    expect(live.items[0]).toMatchObject({ title: 'Porch', detail: 'Building it', right: '63 %' });
    // Porch is installing: not offered again below.
    expect(live.items.filter((i) => i.title === 'Porch')).toHaveLength(1);
    expect(live.meta).toBe('1 installing · 2 waiting · ESPHome 2026.10.0 is here');
  });

  it('leaves To update out when nothing waits or runs', () => {
    const tidy: EspSnapshot = {
      ...real(),
      devices: real().devices.map((d) => ({ ...d, pending: false, update: false, state: 'online' as const })),
    };
    const view = esphomeView(tidy, { now: NOW, timeZone: TZ, buttons: { row: ROW } });
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['inventory', 'devices']);
    expect(view.verdict).toBe('ESPHome is fine: all 2 devices are online and up to date.');
    expect(importableOf(ESPHOME_devices)).toBe(0);
    expect(esphomeKpis(tidy).map((k) => k.key)).toEqual(['online', 'updates', 'pending', 'version']);
  });
});
