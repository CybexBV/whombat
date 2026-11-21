import { type DeskWidgetView, DeskWidgetView as DeskWidgetViewSchema, type Widget } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { DeskFleet } from '../glance';
import type { DeskServer } from '../shapes';
import { homeWidgetsGroup, ownGroup, serverGroups } from './catalog';
import { homeWidgetView } from './home';
import { comingView, doneView, workView } from './own';
import { serverLineOf, serverSay, serverStats, serverView, uptimeWords } from './servers';
import type { Resolved } from './types';

const NOW = new Date('2026-10-27T14:34:00.000Z');
const TZ = 'Europe/Amsterdam';

const valid = (r: Resolved): DeskWidgetView => {
  const parsed = DeskWidgetViewSchema.safeParse(r.view);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues[0]));
  return parsed.data;
};
const list = (r: Resolved) => {
  const v = valid(r);
  if (v.kind !== 'list') throw new Error(v.kind);
  return v;
};

describe('Whombat’s own widgets (DK-139)', () => {
  it('shows the work with its steps and how far along, or that there is none', () => {
    const work = {
      title: 'Updating the server agents',
      steps: [
        { label: 'pve-01', state: 'done' as const },
        { label: 'pve-02', state: 'done' as const },
        { label: 'the-falcon', state: 'now' as const },
        { label: 'blackbox', state: 'next' as const },
      ],
    };
    const v = list(workView('w_work', work, 'Dusty'));
    expect(v.title).toContain('Dusty');
    expect(v.head).toBe('Updating the server agents');
    expect(v.progress).toBe(50);
    expect(v.rows.map((r) => r.meta)).toEqual(['done', 'done', 'now', 'next']);
    expect(v.rows[0]?.tone).toBe('ok');
    const idle = list(workView('w_work', null, 'Dusty'));
    expect(idle.rows).toEqual([]);
    expect(idle.empty).toContain('Dusty');
    // A long piece of work shows the steps around the one going on, and counts them all.
    const long = {
      title: 'Many',
      steps: Array.from({ length: 30 }, (_, i) => ({
        label: `s${i}`,
        state: i < 20 ? ('done' as const) : ('next' as const),
      })),
    };
    const many = list(workView('w_work', long, 'Dusty'));
    expect(many.rows).toHaveLength(12);
    expect(many.rows[0]?.title).toBe('s18');
    expect(many.count).toBe(30);
  });

  it('shows what’s coming at its hour today, else its day', () => {
    const v = list(
      comingView(
        'w_coming',
        [
          { name: 'Morning summary', at: '2026-10-27T22:00:00.000Z' },
          { name: 'Backups', at: '2026-10-28T01:00:00.000Z' },
          { name: 'Renew the certificate', at: '2026-10-29T08:00:00.000Z' },
        ],
        NOW,
        TZ,
      ),
    );
    expect(v.rows.map((r) => r.time)).toEqual(['23:00', '02:00', 'Thu 09:00']);
    expect(list(comingView('w_coming', [], NOW, TZ)).empty).toBeTruthy();
  });

  it('counts what was done today, newest first, and keeps its words private', () => {
    const recent = [
      { text: 'Renewed the certificate on pve-01', at: '2026-10-27T11:41:00.000Z' },
      { text: 'Updated the-falcon', at: '2026-10-27T10:05:00.000Z' },
      { text: 'Yesterday’s', at: '2026-10-26T10:05:00.000Z' },
    ];
    const r = doneView('w_done', recent, Date.parse('2026-10-26T23:00:00.000Z'), 'Dusty', TZ);
    const v = list(r);
    expect(v.title).toContain('2');
    expect(v.rows.map((x) => x.time)).toEqual(['12:41', '11:05']);
    expect(r.private).toBe(true);
    const none = doneView('w_done', [], 0, 'Dusty', TZ);
    expect(none.private).toBe(false);
  });
});

const card = (over: Partial<DeskServer> = {}): DeskServer => ({
  id: 'pve-01',
  name: 'pve-01',
  mark: 'proxmox',
  state: 'ok',
  note: 'up 41 d',
  cpu: { value: 12, tone: 'ok' },
  memory: { value: 41, tone: 'ok' },
  disk: { value: 37, tone: 'ok' },
  ...over,
});

describe('a server as a widget (DK-139)', () => {
  it('says why it isn’t fine in the strip’s words', () => {
    expect(serverSay(card())).toBeUndefined();
    expect(serverSay(card({ state: 'off', note: 'off' }))).toBe('off');
    expect(serverSay(card({ state: 'warn', note: 'Filling up' }))).toBe('filling up');
    expect(serverSay(card({ state: 'warn', note: 'up', disk: { value: 91, tone: 'bad' } }))).toContain('91');
    expect(serverSay(card({ note: 'updating' }))).toBe('updating');
  });

  it('draws its processor over the range with its average and peak', () => {
    const series = {
      serverId: 'pve-01',
      range: '24h',
      stepSeconds: 900,
      asOf: '2026-10-27T14:30:00.000Z',
      timestamps: [],
      series: { cpu_pct: Array.from({ length: 96 }, (_, i) => (i === 40 ? 63 : 10)) },
    };
    const line = serverLineOf(series as never, '24h', NOW);
    expect(line.spark.length).toBeLessThanOrEqual(48);
    expect(line.peak?.percent).toBe(63);
    const stats = serverStats(line, '24h', TZ);
    expect(stats).toMatch(/^Avg 11 % · Peak 63 % \w{3} \d\d:\d\d$/);
    expect(uptimeWords(21 * 86_400 + 5)).toBe('Up 21 days');
    expect(uptimeWords(3_600)).toBe('Up 1 hour');
    expect(uptimeWords(30)).toBe('Up 1 minute');
    expect(uptimeWords(600)).toBe('Up 10 minutes');
  });

  it('is a server view with its figures, or says it’s gone', () => {
    const v = valid(
      serverView({
        id: 'w_srv',
        serverId: 'pve-01',
        card: card(),
        row: { platform: 'proxmox', os: 'Proxmox VE 9', cpu: { cores: 16 }, uptimeS: 3 * 86_400 } as never,
        line: { spark: [1, 2, 3], avg: 2, peak: { percent: 3, at: NOW.toISOString() } },
        range: '24h',
        timeZone: TZ,
      }),
    );
    expect(v).toMatchObject({
      kind: 'server',
      server: 'pve-01',
      cpu: 12,
      memory: 41,
      disk: 37,
      line: 'Proxmox · 16 cores',
    });
    expect(v.kind === 'server' && v.uptime).toBe('Up 3 days');
    const off = valid(
      serverView({
        id: 'w_srv',
        serverId: 'pve-01',
        card: card({ state: 'off', note: 'off' }),
        row: undefined,
        line: null,
        range: '1h',
        timeZone: TZ,
      }),
    );
    expect(off.kind === 'server' && off.cpu).toBeFalsy();
    const gone = valid(
      serverView({
        id: 'w_srv',
        serverId: 'pve-09',
        card: undefined,
        row: undefined,
        line: null,
        range: '24h',
        timeZone: TZ,
      }),
    );
    expect(gone.kind).toBe('text');
    expect(gone.problem?.text).toContain('pve-09');
  });
});

const homeWidget = (over: Partial<Widget> = {}): Widget => ({
  id: 'wdg_1',
  title: 'Living room',
  kind: 'line',
  series: [{ key: 'temp', label: 'Temperature', unit: '°C', color: 1 }],
  latest: [{ key: 'temp', value: 21.43, unit: '°C' }],
  points: [
    { t: '2026-10-27T13:00:00.000Z', values: { temp: 20 } },
    { t: '2026-10-27T14:00:00.000Z', values: { temp: 21.4 } },
  ],
  refreshSec: 300,
  updatedAt: '2026-10-27T14:00:00.000Z',
  ...over,
});

describe('a Home widget as a widget (DK-139)', () => {
  it('shows its figures and its line, or that it’s gone', () => {
    const v = valid(homeWidgetView('w_h', homeWidget()));
    expect(v).toMatchObject({
      kind: 'figures',
      title: 'Living room',
      items: [{ value: '21.4', unit: '°C', label: 'Temperature' }],
    });
    expect(v.kind === 'figures' && v.spark).toEqual([20, 21.4]);
    expect(
      valid(homeWidgetView('w_h', homeWidget({ problem: 'The sensor didn’t answer.' }))).problem,
    ).toBeTruthy();
    expect(valid(homeWidgetView('w_h', undefined)).kind).toBe('text');
  });
});

describe('Add a widget (DK-139)', () => {
  it('lists Whombat’s own with the assistant’s name, the servers and Home’s widgets', () => {
    const own = ownGroup('Dusty');
    expect(own.label).toContain('Dusty');
    expect(own.items.map((i) => i.type)).toEqual([
      'clock',
      'status',
      'now',
      'strip',
      'work',
      'coming',
      'done',
    ]);
    expect(own.items.find((i) => i.type === 'work')?.name).toContain('Dusty');
    const fleet: DeskFleet = {
      cards: [card(), card({ id: undefined, name: 'no id' })],
      rows: new Map([['pve-01', { platform: 'proxmox', os: null, cpu: { cores: 16 } } as never]]),
    };
    // A group per server: its overview, then its parts (no guests or temperature it doesn't report).
    const servers = serverGroups(fleet);
    expect(servers.map((g) => g.key)).toEqual(['server:pve-01']);
    expect(servers[0]?.items[0]).toEqual(
      expect.objectContaining({
        type: 'server',
        ref: 'server:pve-01',
        opts: {},
        line: 'Proxmox · 16 cores',
        view: 'server',
      }),
    );
    expect(servers[0]?.items.map((i) => [i.opts.show ?? '', i.view])).toEqual([
      ['', 'server'],
      ['cpu', 'chart'],
      ['memory', 'chart'],
      ['network', 'chart'],
      ['storage', 'list'],
      ['alerts', 'list'],
    ]);
    expect(servers[0]?.items.find((i) => i.opts.show === 'alerts')?.private).toBe(true);
    const busy: DeskFleet = {
      cards: [card()],
      rows: new Map([
        [
          'pve-01',
          {
            platform: 'proxmox',
            os: null,
            cpu: null,
            guests: [{ platform: 'proxmox', running: 3, total: 4 }],
            temperature: { maxC: 54, limitC: 85 },
          } as never,
        ],
      ]),
    };
    expect(serverGroups(busy)[0]?.items.map((i) => i.opts.show ?? '')).toContain('guests');
    expect(serverGroups(busy)[0]?.items.map((i) => i.opts.show ?? '')).toContain('temp');
    expect(serverGroups(null)).toEqual([]);
    const widgets = homeWidgetsGroup([homeWidget()], 'Dusty');
    expect(widgets?.items[0]).toMatchObject({ type: 'widget', ref: 'widget:wdg_1', view: 'figures' });
    expect(widgets?.label).toContain('Dusty');
  });
});
