/** The demo world's servers' Summaries (dashboards-mobile.md AP-2135): history that parses, Summaries with lines. */
import { serverDashboard, serverDashboardSeries } from '@whombat/client/hosts';
import { api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { figurePress, summaryLayout, toggleFigure } from '../data/dashboard';
import { serverPhoneTabs } from '../data/serverSummary';
import { noticeRows, shownPanels } from '../data/thingPage';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup() {
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: () => {},
    assistant: true,
  });
  return demoClient(server.fetch);
}

describe('server Summaries in the demo world', () => {
  it.each(['pve-02', 'blackbox', 'thetitan', 'the-falcon'])(
    '%s has figures with small lines and chart cards with lines, at 24 hours and 7 days',
    async (serverId) => {
      const client = setup();
      const d = await client.request(api.hosts.getServer, {
        params: { burrow, serverId },
        query: { range: '24h' },
      });
      if (d.status !== 'ok') throw new Error(d.status);
      for (const range of ['24h', '7d'] as const) {
        const series = await client.request(api.hosts.serverMetrics, {
          params: { burrow, serverId },
          query: { range, series: serverDashboardSeries(d.data).join(',') },
        });
        if (series.status !== 'ok') throw new Error(series.status);
        expect(series.data.range).toBe(range);
        const panels = serverDashboard({
          detail: d.data,
          series: series.data,
          range,
          timeZone: 'Europe/Amsterdam',
        });
        const figures = panels.find((p) => p.kind === 'kpis');
        expect(figures?.kind === 'kpis' && figures.items.some((k) => k.spark?.some((v) => v !== null))).toBe(
          true,
        );
        const charts = panels.filter((p) => p.kind === 'chart');
        expect(charts.length).toBeGreaterThan(1);
        for (const c of charts)
          if (c.kind === 'chart') expect(c.series.some((s) => s.values.some((v) => v !== null))).toBe(true);
      }
    },
  );

  async function summary(serverId: string) {
    const client = setup();
    const d = await client.request(api.hosts.getServer, {
      params: { burrow, serverId },
      query: { range: '24h' },
    });
    if (d.status !== 'ok') throw new Error(d.status);
    const series = await client.request(api.hosts.serverMetrics, {
      params: { burrow, serverId },
      query: { range: '24h', series: serverDashboardSeries(d.data).join(',') },
    });
    if (series.status !== 'ok') throw new Error(series.status);
    return shownPanels(
      serverDashboard({ detail: d.data, series: series.data, range: '24h', timeZone: 'Europe/Amsterdam' }),
    );
  }

  it('opens each figure’s charts inside the figures’ card, with the range control (CN-05, AP-2558)', async () => {
    const panels = await summary('pve-02');
    const layout = summaryLayout(panels);
    // Every chart sits behind a figure: no chart card is left, and the range control moves into the opened figure.
    expect(layout.panels.some((p) => p.kind === 'chart')).toBe(false);
    expect(layout.rangeOnTop).toBe(false);
    // The processor opens its own chart with the network's and the disks' traffic.
    expect(layout.open.cpu?.map((c) => c.id)).toEqual(['cpu', 'network', 'disk_io']);
    expect(layout.open.network).toBeUndefined();
    // One figure at a time.
    expect(toggleFigure(null, 'cpu')).toBe('cpu');
    expect(toggleFigure('cpu', 'memory')).toBe('memory');
    expect(toggleFigure('cpu', 'cpu')).toBeNull();
    // Without charts named by a figure, the charts stay cards and the range control stays on top.
    const unnamed = panels.map((p) =>
      p.kind === 'kpis' ? { ...p, items: p.items.map(({ charts: _c, ...k }) => k) } : p,
    );
    expect(summaryLayout(unnamed)).toMatchObject({ rangeOnTop: true, open: {} });
  });

  it('lets a figure without a chart lead to its tab, where the phone has it (AP-2559)', async () => {
    const layout = summaryLayout(await summary('blackbox'));
    const figures = layout.panels.find((p) => p.kind === 'kpis');
    if (figures?.kind !== 'kpis') throw new Error('no figures');
    const tabs = serverPhoneTabs(['summary', 'array', 'guests', 'plugins']);
    const press = (key: string) => {
      const k = figures.items.find((i) => i.key === key);
      return k ? figurePress(k, layout.open, tabs) : undefined;
    };
    // Temperature opens the disks' temperatures; Space (the array) leads to the Array tab.
    expect(press('hottest')).toMatchObject({ kind: 'charts' });
    expect(press('storage')).toMatchObject({ kind: 'link', run: { kind: 'tab', tab: 'array' } });
    // A tab the phone hasn't (Storage) leaves the figure as it is.
    expect(
      figurePress({ key: 'storage', link: { kind: 'tab', label: 'Storage', tab: 'storage' } }, {}, tabs),
    ).toBeNull();
  });

  it('gives Worth a look lines their ⋯ menu where the Whombat can quiet them (quiet-notices-mobile.md AP-4867)', async () => {
    const client = setup();
    const d = await client.request(api.hosts.getServer, {
      params: { burrow, serverId: 'pve-02' },
      query: { range: '24h' },
    });
    if (d.status !== 'ok') throw new Error(d.status);
    const tabs = serverPhoneTabs(['summary', 'guests', 'backups']);
    const look = (quiet: boolean) => {
      const panel = serverDashboard({
        detail: d.data,
        range: '24h',
        timeZone: 'Europe/Amsterdam',
        quiet,
      }).find((p) => p.kind === 'notices' && p.id === 'look');
      if (panel?.kind !== 'notices') throw new Error('no Worth a look');
      return noticeRows(panel, tabs, { quiet });
    };
    const quieting = look(true);
    expect(quieting.length).toBeGreaterThan(0);
    expect(quieting.every((r) => r.menu?.ref.check.startsWith('host.'))).toBe(true);
    // An older runtime gets the lines without a menu.
    expect(look(false).every((r) => r.menu === null)).toBe(true);
  });

  it('answers a guest’s history for the busiest guests', async () => {
    const client = setup();
    const res = await client.request(api.hosts.guestMetrics, {
      params: { burrow, serverId: 'pve-02', guestId: 'pve:118' },
      query: { range: '24h', series: 'cpu_pct' },
    });
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.data.guestId).toBe('pve:118');
    expect(res.data.series.cpu_pct?.some((v) => v !== null)).toBe(true);
  });
});
