/**
 * Frigate's page, camera shelf, detections, detectors, storage checks and slot layout from documented API fixtures,
 * plus crashed, disabled and unknown camera handling from `/api/config` and `/api/stats`.
 */
import { readFileSync } from 'node:fs';
import { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import {
  FRIGATE_CHECKS,
  FRIGATE_KIND,
  type FrigateCtx,
  type FrigateSnapshot,
  frigateKpis,
  frigateNotices,
  frigateSeen,
  frigateSkipped,
  frigateVerdict,
  frigateView,
  offlineSinceOf,
  parseConfigEnabled,
  parseEvents,
  parseStats,
  parseSummary,
} from './frigate';

const httpMock = vi.hoisted(() => ({
  handler: null as ((path: string) => { status: number; body: unknown }) | null,
}));

vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { url: string }) => {
      const path = new URL(req.url).pathname;
      const res = httpMock.handler?.(path) ?? { status: 404, body: {} };
      return { status: res.status, headers: {}, body: Buffer.from(JSON.stringify(res.body)) };
    },
  };
});

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';

const snap = (more: Partial<FrigateSnapshot> = {}): FrigateSnapshot => ({
  ...parseStats(fixture('frigate-stats.json'), now, parseConfigEnabled(fixture('frigate-config.json'))),
  ...more,
});

const ctxOf = (s: FrigateSnapshot, more: Partial<FrigateCtx> = {}): FrigateCtx => ({
  now,
  timeZone: TZ,
  events: parseEvents(fixture('frigate-events.json')),
  summary: parseSummary(fixture('frigate-summary.json')),
  offlineSince: offlineSinceOf('con_frigate_test', s),
  ...more,
});

const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);

describe('Frigate page in slots', () => {
  it('parses stats, config enabled flags, events and summary and passes slot validation', () => {
    const cfgMap = parseConfigEnabled(fixture('frigate-config.json'));
    expect([...cfgMap.entries()]).toEqual([
      ['front_door', true],
      ['driveway', true],
      ['garage', true],
    ]);

    const s = snap();
    expect(s.version).toBe('0.15.0');
    expect(s.cameras.map((c) => [c.id, c.name, c.status, c.online])).toEqual([
      ['front_door', 'Front door', 'online', true],
      ['driveway', 'Driveway', 'online', true],
      ['garage', 'Garage', 'offline', false],
    ]);
    expect(s.detectors).toEqual([{ name: 'coral', inferenceMs: 11.4 }]);
    expect(s.storage?.totalBytes).toBeGreaterThan(1_000_000_000_000);

    const view = frigateView(s, ctxOf(s), {
      openUrl: 'http://10.100.0.20:5000',
      picture: (id, alt) => ({ ref: `frigate_${id}.signature12345678`, alt, shape: 'wide' }),
    });
    expect(slotProblems(view)).toEqual([]);
    for (const p of view.panels) ThingPagePanel.parse(p);
    for (const n of view.notices) ThingPageNotice.parse(n);
    expect(view.refreshS).toBe(10);
    expect(view.verdict).toBe('Frigate is fine: 2 of 3 cameras are online.');

    const cameras = panel(view.panels, 'cameras');
    expect(cameras?.kind === 'gallery' && [cameras.look, cameras.shape, cameras.meta]).toEqual([
      'shelf',
      'wide',
      '2 of 3 online',
    ]);
    expect(cameras?.kind === 'gallery' && cameras.items.map((c) => [c.id, c.muted ?? false])).toEqual([
      ['driveway', false],
      ['front_door', false],
      ['garage', true],
    ]);

    const today = panel(view.panels, 'detections');
    expect(today?.kind === 'list' && today.meta).toBe('34 detections');
    expect(today?.kind === 'list' && today.items[0]?.title).toBe('Person (Mara) seen at Front door');

    const week = panel(view.panels, 'week');
    expect(week?.kind === 'chart' && week.labels?.at(-1)).toBe('Today');
  });

  it('reports card KPIs and verdict cleanly when all cameras are online', () => {
    const allOnline = snap({
      cameras: snap().cameras.map((c) => ({
        ...c,
        enabled: true,
        status: 'online',
        online: true,
        cameraFps: 5,
      })),
    });
    expect(frigateVerdict(allOnline)).toBe('Frigate is fine: all 3 cameras are online.');
    const kpis = frigateKpis(allOnline, ctxOf(allOnline));
    expect(kpis.map((k) => [k.key, k.value, k.sub])).toEqual([
      ['cameras', '3', 'all online'],
      ['detections', '34', 'most at Driveway'],
    ]);
  });

  it('starts only offline cameras on, and reports full storage, slow detectors and dropped frames when on', () => {
    expect(FRIGATE_KIND.checks).toBe(FRIGATE_CHECKS);
    expect(FRIGATE_CHECKS.filter((c) => c.startsOn).map((c) => c.check)).toEqual(['frigate.camera_offline']);

    const s = snap({
      detectors: [{ name: 'cpu1', inferenceMs: 145 }],
      storage: { mount: '/media/frigate/recordings', totalBytes: 1_000e9, usedBytes: 960e9, freeBytes: 40e9 },
      cameras: [
        {
          id: 'front_door',
          name: 'Front door',
          enabled: true,
          status: 'online',
          online: true,
          cameraFps: 5,
          detectionFps: 1,
          skippedFps: 2.5,
        },
        {
          id: 'garage',
          name: 'Garage',
          enabled: true,
          status: 'offline',
          online: false,
          cameraFps: 0,
          detectionFps: 0,
          skippedFps: 0,
        },
      ],
    });
    const notices = frigateNotices(s, ctxOf(s));
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.check, n.tone, n.nature])).toEqual([
      ['frigate.camera_offline', 'warn', 'problem'],
      ['frigate.storage_full', 'bad', 'problem'],
      ['frigate.detector_slow', 'info', 'fyi'],
      ['frigate.skipped_fps', 'info', 'fyi'],
    ]);
    expect(frigateSkipped(snap({ storage: null, detectors: [] }))).toEqual([
      'frigate.storage_full',
      'frigate.detector_slow',
    ]);
  });

  it('treats crashed ffmpeg on enabled cameras as offline and only marks explicitly disabled cameras as Disabled', () => {
    const configEnabled = parseConfigEnabled({
      cameras: {
        front_door: { enabled: true, enabled_in_config: true },
        // Crashed ffmpeg: enabled in config, ffmpeg_pid 0, 0 fps — must be offline, not Disabled.
        shed: { enabled: true, enabled_in_config: true },
        // All workers crashed: enabled in config, null pids and ffmpeg_pid 0 — must be offline.
        porch: { enabled: true, enabled_in_config: true },
        // Disabled in config (and runtime).
        guest_room: { enabled: false, enabled_in_config: false },
        // Enabled in YAML, toggled off at runtime in Frigate 0.16 (`enabled: false` wins over `enabled_in_config`).
        nursery: { enabled: false, enabled_in_config: true },
        // Disabled camera omitted from /api/stats (Frigate 0.14/0.15).
        basement: { enabled: false },
        // Enabled camera missing from /api/stats completely.
        backyard: { enabled: true },
      },
    });

    const s = parseStats(
      {
        cameras: {
          front_door: {
            camera_fps: 5.0,
            capture_pid: 412,
            pid: 415,
            ffmpeg_pid: 418,
            detection_enabled: false,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          shed: {
            camera_fps: 0.0,
            capture_pid: 440,
            pid: 441,
            ffmpeg_pid: 0,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          porch: {
            camera_fps: 0.0,
            capture_pid: null,
            pid: null,
            ffmpeg_pid: 0,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          guest_room: {
            camera_fps: 0.0,
            capture_pid: null,
            pid: null,
            ffmpeg_pid: 0,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          nursery: {
            camera_fps: 0.0,
            capture_pid: 448,
            pid: 449,
            ffmpeg_pid: 0,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          // Explicit per-camera enabled: false on /api/stats itself.
          attic: {
            enabled: false,
            camera_fps: 0.0,
            capture_pid: 450,
            pid: 451,
            ffmpeg_pid: 452,
          },
          // Explicit per-camera enabled: true on /api/stats with crashed ffmpeg_pid 0.
          side_gate: {
            enabled: true,
            camera_fps: 0.0,
            ffmpeg_pid: 0,
          },
        },
        service: { version: '0.16.2' },
      },
      now,
      configEnabled,
    );

    expect(s.cameras.map((c) => [c.id, c.enabled, c.status, c.online])).toEqual([
      ['front_door', true, 'online', true],
      ['shed', true, 'offline', false],
      ['porch', true, 'offline', false],
      ['guest_room', false, 'disabled', false],
      ['nursery', false, 'disabled', false],
      ['attic', false, 'disabled', false],
      ['side_gate', true, 'offline', false],
      ['basement', false, 'disabled', false],
      ['backyard', true, 'offline', false],
    ]);

    const ctx = ctxOf(s, { offlineSince: offlineSinceOf('con_frigate_crashed_test', s) });
    const notices = frigateNotices(s, ctx);
    // itemLines shows the first 2 individually and rolls the other 2 into "+more".
    expect(notices.map((n) => [n.check, n.subject?.id])).toEqual([
      ['frigate.camera_offline', 'camera:backyard'],
      ['frigate.camera_offline', 'camera:porch'],
      ['frigate.camera_offline', '+more'],
    ]);
    expect(notices[2]?.detail).toBe('Shed · Side gate');
    expect([...ctx.offlineSince.keys()].sort()).toEqual(['backyard', 'porch', 'shed', 'side_gate']);

    const view = frigateView(s, ctx, {
      openUrl: 'http://10.100.0.20:5000',
      picture: (id, alt) => ({ ref: `frigate_${id}.signature12345678`, alt, shape: 'wide' }),
    });
    expect(slotProblems(view)).toEqual([]);
    const shelfPanel = panel(view.panels, 'cameras');
    expect(shelfPanel?.kind === 'gallery' && shelfPanel.items.find((i) => i.id === 'shed')).toMatchObject({
      id: 'shed',
      badge: { text: 'Offline', tone: 'warn' },
      muted: true,
    });
    expect(
      shelfPanel?.kind === 'gallery' && shelfPanel.items.find((i) => i.id === 'guest_room'),
    ).toMatchObject({
      id: 'guest_room',
      sub: 'Disabled',
      muted: true,
    });
    expect(
      shelfPanel?.kind === 'gallery' && shelfPanel.items.find((i) => i.id === 'guest_room')?.badge,
    ).toBeUndefined();
  });

  it('marks 0 fps cameras as unknown without false alarms when enabled state cannot be read', () => {
    const s = parseStats(
      {
        cameras: {
          front_door: { camera_fps: 5.0, capture_pid: 412, pid: 415, ffmpeg_pid: 418 },
          // No /api/config and no explicit enabled flag on stats: could be disabled or crashed.
          shed: { camera_fps: 0.0, capture_pid: 440, pid: 441, ffmpeg_pid: 0 },
          garage: { camera_fps: 0.0, capture_pid: 430, pid: 433, ffmpeg_pid: 436 },
          mystery: { camera_fps: 0.0 },
        },
        service: { version: '0.16.2' },
      },
      now,
    );

    expect(s.cameras.map((c) => [c.id, c.enabled, c.status, c.online])).toEqual([
      ['front_door', true, 'online', true],
      ['shed', null, 'unknown', false],
      ['garage', null, 'unknown', false],
      ['mystery', null, 'unknown', false],
    ]);

    const ctx = ctxOf(s, { offlineSince: offlineSinceOf('con_frigate_unknown_test', s) });
    expect(frigateNotices(s, ctx)).toEqual([]);
    expect([...ctx.offlineSince.keys()]).toEqual([]);
    expect(frigateSkipped(s)).toContain('frigate.camera_offline');
    expect(frigateVerdict(s)).toContain('unknown');
    expect(frigateVerdict(s)).not.toContain('all');
    expect(frigateKpis(s, ctx)[0]).toMatchObject({
      key: 'cameras',
      value: '1',
      rest: 'of 4',
      sub: '3 unknown',
    });

    const view = frigateView(s, ctx, {
      openUrl: 'http://10.100.0.20:5000',
      picture: (id, alt) => ({ ref: `frigate_${id}.signature12345678`, alt, shape: 'wide' }),
    });
    expect(slotProblems(view)).toEqual([]);
    for (const p of view.panels) ThingPagePanel.parse(p);
    const shelfPanel = panel(view.panels, 'cameras');
    expect(shelfPanel?.kind === 'gallery' && shelfPanel.meta).toContain('3 unknown');
    for (const id of ['shed', 'garage', 'mystery']) {
      const item = shelfPanel?.kind === 'gallery' ? shelfPanel.items.find((i) => i.id === id) : undefined;
      expect(item).toMatchObject({ id, sub: 'Status unknown', muted: true });
      expect(item?.badge).toBeUndefined();
    }
  });

  it('fetches /api/config alongside /api/stats in frigateSeen and degrades to unknown if /api/config fails', async () => {
    const services = {} as Services;
    const row = rowOf('frigate', {
      id: 'con_frigate_seen_1',
      baseUrl: 'http://192.0.2.25:5000',
      fields: { url: 'http://192.0.2.25:5000' },
    });

    // Case 1: /api/config succeeds -> crashed camera (ffmpeg_pid 0) raises offline, disabled camera does not.
    httpMock.handler = (path) => {
      if (path === '/api/stats')
        return {
          status: 200,
          body: {
            cameras: {
              front_door: { camera_fps: 5.0, ffmpeg_pid: 418 },
              shed: { camera_fps: 0.0, capture_pid: 440, pid: 441, ffmpeg_pid: 0 },
              guest_room: { camera_fps: 0.0, capture_pid: null, pid: null, ffmpeg_pid: 0 },
            },
            service: { version: '0.16.2' },
          },
        };
      if (path === '/api/config')
        return {
          status: 200,
          body: {
            cameras: {
              front_door: { enabled: true },
              shed: { enabled: true },
              guest_room: { enabled: false },
            },
          },
        };
      return { status: 200, body: [] };
    };
    forgetKindReads(services);
    const okSeen = await frigateSeen(services, row, now, TZ);
    expect(okSeen.notices.map((n) => [n.check, n.subject?.id])).toEqual([
      ['frigate.camera_offline', 'camera:shed'],
    ]);
    expect(okSeen.skipped).not.toContain('frigate.camera_offline');

    // Case 2: /api/config returns 403 -> 0 fps cameras become unknown, no false alarm, check marked skipped.
    httpMock.handler = (path) => {
      if (path === '/api/stats')
        return {
          status: 200,
          body: {
            cameras: {
              front_door: { camera_fps: 5.0, ffmpeg_pid: 418 },
              shed: { camera_fps: 0.0, capture_pid: 440, pid: 441, ffmpeg_pid: 0 },
            },
            service: { version: '0.16.2' },
          },
        };
      if (path === '/api/config') return { status: 403, body: { message: 'Forbidden' } };
      return { status: 200, body: [] };
    };
    forgetKindReads(services);
    const forbiddenSeen = await frigateSeen(services, row, now, TZ);
    expect(forbiddenSeen.notices).toEqual([]);
    expect(forbiddenSeen.skipped).toContain('frigate.camera_offline');
  });
});
