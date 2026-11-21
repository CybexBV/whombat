/**
 * qBittorrent's page, checks, actions (v5 + v4 fallback) and activity from documented WebUI API v2 fixtures.
 */
import { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { slotProblems } from '../slots';
import {
  parseMaindata,
  QBITTORRENT_KIND,
  QBT_ACTIONS,
  QBT_CHECKS,
  type QbtInput,
  type QbtSnapshot,
  qbtActivity,
  qbtKpis,
  qbtNotices,
  qbtSkipped,
  qbtVerdict,
  qbtView,
} from './qbittorrent';
import { fixture, rowOf } from './testing';

const http = vi.hoisted(() => ({
  calls: [] as { method: string; url: URL; body?: string }[],
  v4Only: false,
}));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; body?: string },
    ) => {
      const url = new URL(req.url);
      http.calls.push({ method: req.method, url, body: req.body });
      if (http.v4Only && (url.pathname.endsWith('/stop') || url.pathname.endsWith('/start'))) {
        return { status: 404, headers: {}, body: Buffer.from('Not Found') };
      }
      return { status: 200, headers: {}, body: Buffer.from('') };
    },
  };
});

const now = new Date('2026-10-21T19:46:00Z');
const TZ = 'Europe/Amsterdam';
const row = rowOf('qbittorrent');

const snap = (more: Partial<QbtSnapshot> = {}): QbtSnapshot => ({
  ...parseMaindata(fixture('qbittorrent-maindata.json'), now, '5.0.3'),
  ...more,
});

const input = (snapshot: QbtSnapshot, more: Partial<QbtInput> = {}): QbtInput => ({
  snapshot,
  now,
  timeZone: TZ,
  range: '24h',
  speed: { timestamps: [], values: [] },
  who: { row },
  url: 'http://10.100.0.20:8080',
  ...more,
});

const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);

describe('qBittorrent page and checks', () => {
  it('parses maindata, validates slots, and shows queue, inventory, done today and machine lines', () => {
    const s = snap();
    const view = qbtView(input(s));
    expect(slotProblems(view)).toEqual([]);
    for (const p of view.panels) ThingPagePanel.parse(p);
    for (const n of view.notices) ThingPageNotice.parse(n);
    expect(view.refreshS).toBe(5);
    expect(view.verdict).toBe('qBittorrent is fine: downloading 1 torrent at 18 MB/s and seeding 1.');
    expect(view.slots?.machine.map((b) => [b.label, b.value])).toEqual([
      ['qBittorrent', '5.0.3'],
      ['Connection', 'Connected'],
      ['Download disk', '480 GB free'],
    ]);

    const queue = panel(view.panels, 'queue');
    expect(queue?.kind === 'gallery' && queue.items.map((i) => i.title)).toEqual([
      'Slow.Horses.S05E03.1080p.WEB-DL.DDP5.1-GRP',
      'Conclave.2024.2160p.WEB-DL.HDR-GRP',
    ]);
    expect(queue?.kind === 'gallery' && queue.items[1]?.badge?.text).toBe('Stalled');
    expect(panel(view.panels, 'done')?.kind).toBe('list');
  });

  it('reports card KPIs and desk activity', () => {
    const s = snap();
    expect(qbtKpis(input(s)).map((k) => [k.key, k.value])).toEqual([
      ['speed', '18 MB/s'],
      ['left', '20 GB'],
      ['disk', '480 GB'],
    ]);
    expect(qbtActivity(s)).toMatchObject({
      active: true,
      detail: 'Slow.Horses.S05E03.1080p.WEB-DL.DDP5.1-GRP',
    });
    expect(qbtVerdict({ ...s, torrents: s.torrents.slice(2) })).toBe(
      'qBittorrent is fine: nothing downloading, seeding 1 torrent.',
    );
  });

  it('raises only real breakage checks on by default and reports all optional checks cleanly', () => {
    expect(QBITTORRENT_KIND.checks).toBe(QBT_CHECKS);
    expect(QBT_CHECKS.filter((c) => c.startsOn).map((c) => c.check)).toEqual([
      'qbittorrent.disk_low',
      'qbittorrent.disconnected',
    ]);
    const s = snap();
    const first = s.torrents[0];
    if (!first) throw new Error('missing torrent');
    const bad = snap({
      state: {
        ...s.state,
        freeSpaceBytes: 1_000_000_000,
        connectionStatus: 'disconnected',
        altSpeedLimits: true,
      },
      torrents: [
        ...s.torrents,
        {
          ...first,
          hash: 'err1',
          name: 'Broken.Release',
          state: 'missingFiles',
          dlSpeedBps: 0,
        },
      ],
    });
    const notices = qbtNotices(input(bad));
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.check, n.tone, n.nature])).toEqual([
      ['qbittorrent.disk_low', 'bad', 'problem'],
      ['qbittorrent.disconnected', 'bad', 'problem'],
      ['qbittorrent.errored', 'warn', 'problem'],
      ['qbittorrent.stalled', 'info', 'fyi'],
      ['qbittorrent.alt_speed', 'info', 'fyi'],
    ]);
    expect(
      qbtSkipped({
        ...s,
        state: { ...s.state, freeSpaceBytes: null, connectionStatus: 'unknown' },
      }),
    ).toEqual(['qbittorrent.disk_low', 'qbittorrent.disconnected', 'qbittorrent.firewalled']);
  });
});

describe('qBittorrent actions (v5 and v4 fallback)', () => {
  const ctx = { services: {} as Services, row, now, timeZone: TZ };

  it('pauses, resumes and toggles speed limits on qBittorrent v5', async () => {
    http.calls = [];
    http.v4Only = false;
    await QBT_ACTIONS.pause?.(ctx, {});
    await QBT_ACTIONS.resume?.(ctx, {});
    await QBT_ACTIONS.toggle_alt_speed?.(ctx, {});
    expect(http.calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['POST', '/api/v2/torrents/stop', 'hashes=all'],
      ['POST', '/api/v2/torrents/start', 'hashes=all'],
      ['POST', '/api/v2/transfer/toggleSpeedLimitsMode', undefined],
    ]);
  });

  it('falls back to /pause and /resume on qBittorrent v4', async () => {
    http.calls = [];
    http.v4Only = true;
    await QBT_ACTIONS.pause?.(ctx, {});
    await QBT_ACTIONS.resume?.(ctx, {});
    expect(http.calls.map((c) => c.url.pathname)).toEqual([
      '/api/v2/torrents/stop',
      '/api/v2/torrents/pause',
      '/api/v2/torrents/start',
      '/api/v2/torrents/resume',
    ]);
    http.v4Only = false;
  });
});
