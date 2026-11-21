/**
 * Frigate's page, camera shelf, detections, detectors, storage checks and slot layout from documented API fixtures.
 */
import { readFileSync } from 'node:fs';
import { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import {
  FRIGATE_CHECKS,
  FRIGATE_KIND,
  type FrigateCtx,
  type FrigateSnapshot,
  frigateKpis,
  frigateNotices,
  frigateSkipped,
  frigateVerdict,
  frigateView,
  offlineSinceOf,
  parseEvents,
  parseStats,
  parseSummary,
} from './frigate';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;

const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';

const snap = (more: Partial<FrigateSnapshot> = {}): FrigateSnapshot => ({
  ...parseStats(fixture('frigate-stats.json'), now),
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
  it('parses stats, events and summary and passes slot validation', () => {
    const s = snap();
    expect(s.version).toBe('0.15.0');
    expect(s.cameras.map((c) => [c.id, c.name, c.online])).toEqual([
      ['front_door', 'Front door', true],
      ['driveway', 'Driveway', true],
      ['garage', 'Garage', false],
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
    const allOnline = snap({ cameras: snap().cameras.map((c) => ({ ...c, online: true, cameraFps: 5 })) });
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
          online: true,
          cameraFps: 5,
          detectionFps: 1,
          skippedFps: 2.5,
        },
        {
          id: 'garage',
          name: 'Garage',
          enabled: true,
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

  it('does not raise camera_offline for Frigate 0.16 disabled or unknown-state 0 fps cameras', () => {
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
          // Configured with enabled: false in Frigate 0.16: 0 fps, null pid/capture_pid, ffmpeg_pid 0.
          guest_room: {
            camera_fps: 0.0,
            capture_pid: null,
            pid: null,
            ffmpeg_pid: 0,
            detection_enabled: true,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          // Capture worker present but ffmpeg never started (ffmpeg_pid 0).
          shed: {
            camera_fps: 0.0,
            capture_pid: 440,
            pid: 441,
            ffmpeg_pid: 0,
            detection_enabled: false,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
          // Explicit enabled: false on stats.
          attic: {
            enabled: false,
            camera_fps: 0.0,
            capture_pid: 450,
            pid: 451,
            ffmpeg_pid: 452,
          },
          // Minimal 0 fps payload with no PIDs and no enabled flag: not known to be enabled.
          mystery: {
            camera_fps: 0.0,
          },
          // Enabled camera that is actually offline: live worker + capture + ffmpeg PIDs, 0 fps.
          garage: {
            camera_fps: 0.0,
            capture_pid: 430,
            pid: 433,
            ffmpeg_pid: 436,
            detection_enabled: false,
            detection_fps: 0.0,
            skipped_fps: 0.0,
          },
        },
        service: { version: '0.16.2' },
      },
      now,
    );

    expect(s.cameras.map((c) => [c.id, c.enabled, c.online])).toEqual([
      ['front_door', true, true],
      ['guest_room', false, false],
      ['shed', false, false],
      ['attic', false, false],
      ['mystery', false, false],
      ['garage', true, false],
    ]);

    const ctx = ctxOf(s, { offlineSince: offlineSinceOf('con_frigate_disabled_test', s) });
    const notices = frigateNotices(s, ctx);
    expect(notices.map((n) => [n.check, n.subject?.id])).toEqual([
      ['frigate.camera_offline', 'camera:garage'],
    ]);
    expect([...ctx.offlineSince.keys()]).toEqual(['garage']);

    // When all enabled cameras are online and disabled cameras remain at 0 fps, no offline alarm or warning KPI fires.
    const healthy = parseStats(
      {
        cameras: {
          front_door: { camera_fps: 5.0, capture_pid: 412, pid: 415, ffmpeg_pid: 418 },
          guest_room: { camera_fps: 0.0, capture_pid: null, pid: null, ffmpeg_pid: 0 },
        },
        service: { version: '0.16.2' },
      },
      now,
    );
    const healthyCtx = ctxOf(healthy, {
      offlineSince: offlineSinceOf('con_frigate_healthy_disabled_test', healthy),
    });
    expect(frigateNotices(healthy, healthyCtx)).toEqual([]);
    expect(frigateVerdict(healthy)).toBe('Frigate is fine: the camera is online.');
    expect(frigateKpis(healthy, healthyCtx)[0]).toMatchObject({
      key: 'cameras',
      value: '1',
      rest: 'of 1',
      sub: 'all online',
    });
    const view = frigateView(healthy, healthyCtx, {
      openUrl: 'http://10.100.0.20:5000',
      picture: (id, alt) => ({ ref: `frigate_${id}.signature12345678`, alt, shape: 'wide' }),
    });
    expect(slotProblems(view)).toEqual([]);
    const shelfPanel = panel(view.panels, 'cameras');
    expect(
      shelfPanel?.kind === 'gallery' &&
        shelfPanel.items.find((i) => i.id === 'guest_room'),
    ).toMatchObject({ id: 'guest_room', sub: 'Disabled', muted: true });
    expect(
      shelfPanel?.kind === 'gallery' &&
        shelfPanel.items.find((i) => i.id === 'guest_room')?.badge,
    ).toBeUndefined();
  });
});
