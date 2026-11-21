/**
 * The Summary renderer drawing panels a builder sent (dashboards-web.md AP-2050…): the places (figures, chart rows,
 * the main and side columns, the bottom), a bar list with its forecast words, a table with a small bar, a small line
 * and a button per row, a note with its way out, and “Worth a look” folding after five.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ThingPagePanel } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { Providers } from '../../../app/providers';
import { fixtureServices } from '../../../test/renderApp';
import { Dashboard } from './Dashboard';
import { rangeInTabRow, splitFigureValue } from './figures';
import type { DashboardContext } from './Panels';

const T0 = Date.parse('2026-10-18T10:00:00Z');
const stamps = Array.from({ length: 8 }, (_, k) => new Date(T0 + k * 900_000).toISOString());

const PANELS: ThingPagePanel[] = [
  {
    kind: 'kpis',
    id: 'figures',
    place: 'top',
    items: [
      {
        key: 'cpu',
        label: 'CPU',
        value: '18 %',
        sub: 'of 16 threads',
        spark: [10, 12, 30, 18],
        color: 'blue',
      },
      { key: 'guests', label: 'Guests', value: '12', rest: 'of 14 running', meter: 12 / 14, color: 'green' },
    ],
  },
  {
    kind: 'chart',
    id: 'cpu',
    place: 'chart',
    span: 1,
    title: 'CPU',
    figure: { value: '18 %', rest: 'of 16 threads' },
    timestamps: stamps,
    series: [
      {
        key: 'cpu_pct',
        label: 'CPU',
        unit: '%',
        values: [1, 2, 3, 4, 5, 6, 7, 18],
        color: 'blue',
        fill: true,
      },
    ],
    axis: { min: 0, max: 100, unit: '%' },
  },
  {
    kind: 'chart',
    id: 'net',
    place: 'chart',
    span: 2,
    title: 'Network',
    timestamps: stamps,
    series: [
      { key: 'in', label: 'In', unit: 'Mb/s', values: [1, 2, 3, 4, 5, 6, 7, 61], color: 'green', fill: true },
      { key: 'out', label: 'Out', unit: 'Mb/s', values: [1, 1, 1, 1, 1, 1, 1, 23], color: 'orange' },
    ],
  },
  {
    kind: 'notices',
    id: 'look',
    place: 'side',
    title: 'Worth a look',
    items: [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `n${i}`,
        tone: 'warn' as const,
        icon: 'warn' as const,
        title: `Notice ${i + 1}`,
      })),
      { id: 'fyi', tone: 'info' as const, icon: 'update' as const, title: '1 update waiting' },
    ],
  },
  {
    kind: 'table',
    id: 'busiest',
    place: 'main',
    title: 'Busiest guests',
    link: { kind: 'tab', label: 'All guests', tab: 'guests' },
    columns: [
      { key: 'guest', label: 'Guest' },
      { key: 'cpu', label: 'CPU', numeric: true },
      { key: 'day', label: '24 h' },
      { key: 'open', label: '' },
    ],
    rows: [
      {
        id: 'pve:131',
        cells: {
          guest: {
            text: 'home-assistant',
            mono: true,
            note: 'CT 131',
            href: '/things/server%3Apve-02?guest=pve%3A131',
          },
          cpu: { text: '6.1 %', meter: 0.061 },
          day: { text: 'CPU', spark: [1, 2, 6, 3] },
          open: { text: 'Console', button: true, href: '/things/server%3Apve-02?console=pve%3A131' },
        },
      },
    ],
  },
  {
    kind: 'text',
    id: 'agent',
    place: 'main',
    body: 'Hetzner can’t see memory or disk space. Add whombat-prod as a server to see them here.',
    link: { kind: 'href', label: 'Add as a server', href: '/things/servers?add=1' },
  },
  {
    kind: 'bars',
    id: 'storage',
    place: 'bottom',
    title: 'Storage',
    meta: '3 storages · 2.8 of 8.2 TB',
    columns: 3,
    items: [
      {
        id: 'local-lvm',
        label: 'local-lvm',
        mono: true,
        note: 'thin · NVMe',
        value: '660 of 930 GB',
        pct: 0.71,
        sub: 'Full in about 5 months',
        subTone: 'warn',
      },
      { id: 'tank', label: 'tank', mono: true, note: 'ZFS mirror', value: '2.1 of 7.2 TB', pct: 0.29 },
      { id: 'parity', label: 'Parity', value: 'valid', pct: null },
    ],
  },
];

function renderDashboard(
  onTab = vi.fn(),
  {
    panels = PANELS,
    url = '/',
    onRange,
    onAsk = vi.fn(),
    look,
  }: {
    panels?: ThingPagePanel[];
    url?: string;
    onRange?: () => void;
    onAsk?: (q?: string) => void;
    look?: Pick<DashboardContext, 'research' | 'onHandle'>;
  } = {},
) {
  const ctx: DashboardContext = {
    burrow: burrow.slug,
    thing: { id: 'server:pve-02', name: 'pve-02', settings: false, canManage: false },
    timeZone: 'Europe/Amsterdam',
    now: T0,
    range: '24h',
    ...(onRange ? { ranges: ['1h', '6h', '24h', '7d'] as const, onRange } : {}),
    onAsk,
    onTab,
    ...look,
  };
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <Dashboard panels={panels} ctx={ctx} />,
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree: root.addChildren([page]), history });
  render(
    <Providers services={fixtureServices()}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { onTab, search: () => history.location.search };
}

const text = (el: Element | null) => (el?.textContent ?? '').replaceAll(' ', ' ');
const card = async (name: string) =>
  (await screen.findByRole('heading', { name, level: 2 })).closest('section') as HTMLElement;

describe('the Summary renderer', () => {
  it('places the panels: figures, chart rows, the main column before the side, the bottom last', async () => {
    renderDashboard();
    const glance = await screen.findByRole('region', { name: 'At a glance' });
    expect(within(glance).getByRole('img', { name: 'Guests: 86 %' })).toBeTruthy();
    expect(
      within(glance).getByRole('img', { name: 'CPU over the last 24 hours: between 10 and 30' }),
    ).toBeTruthy();
    const order = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(order).toEqual(['CPU', 'Network', 'Busiest guests', 'Worth a look', 'Storage']);
    // A legend for two lines without a figure.
    expect(text(await card('Network'))).toContain('In61 Mb/sOut23 Mb/s');
  });

  it('draws a table’s small bar, small line and button, and its corner link', async () => {
    const { onTab } = renderDashboard();
    const busiest = await card('Busiest guests');
    const row = within(busiest).getAllByRole('row')[1] as HTMLElement;
    expect(text(row)).toContain('home-assistantCT 131');
    expect(within(row).getByRole('img', { name: '24 h: between 1 and 6' })).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Console' }).getAttribute('href')).toBe(
      '/things/server%3Apve-02?console=pve%3A131',
    );
    expect(
      within(busiest)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Guest', 'CPU', '24 h', 'Open']);
    await userEvent.setup().click(within(busiest).getByRole('button', { name: 'All guests' }));
    expect(onTab).toHaveBeenCalledWith('guests');
  });

  it('draws a bar list with its words under the bars, and a note with its way out', async () => {
    renderDashboard();
    const storage = await card('Storage');
    expect(within(storage).getByRole('img', { name: 'local-lvm: 71 %' })).toBeTruthy();
    expect(within(storage).getByText('Full in about 5 months')).toBeTruthy();
    // A parity disk has no bar.
    expect(within(storage).queryByRole('img', { name: /^Parity/ })).toBeNull();
    const note = screen.getByRole('region', { name: 'Hetzner can’t see memory or disk space' });
    expect(within(note).getByRole('link', { name: 'Add as a server' }).getAttribute('href')).toBe(
      '/things/servers?add=1',
    );
  });

  it('shows five notices and folds the rest', async () => {
    const user = userEvent.setup();
    renderDashboard();
    const look = await card('Worth a look');
    expect(within(look).getAllByText(/^Notice \d$/)).toHaveLength(5);
    await user.click(within(look).getByRole('button', { name: 'Show 2 more' }));
    expect(within(look).getAllByText(/^Notice \d$/)).toHaveLength(7);
    await user.click(within(look).getByRole('button', { name: 'Show fewer' }));
    expect(within(look).getAllByText(/^Notice \d$/)).toHaveLength(5);
  });

  it('counts what asks, folds heads-ups under one row and hands what asks to the assistant', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    renderDashboard(vi.fn(), { onAsk });
    const look = await card('Worth a look');
    expect(within(look).getByText('7')).toBeTruthy();
    expect(within(look).queryByText('1 update waiting')).toBeNull();
    await user.click(within(look).getByRole('button', { name: 'Show 1 heads-up' }));
    expect(within(look).getByText('1 update waiting')).toBeTruthy();
    await user.click(within(look).getByRole('button', { name: /to handle these$/ }));
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('Notice 1'));
  });

  it('hands what asks to the assistant, then says it is looking into them (handle-it.md)', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    const onHandle = vi.fn();
    renderDashboard(vi.fn(), { onAsk, look: { research: null, onHandle } });
    const look = await card('Worth a look');
    await user.click(within(look).getByRole('button', { name: /to handle these$/ }));
    // Today's question goes along, for a Whombat without looks.handle.
    expect(onHandle).toHaveBeenCalledWith(expect.stringContaining('Notice 1'));
    expect(onAsk).not.toHaveBeenCalled();
    cleanup();
    renderDashboard(vi.fn(), {
      look: { research: { key: 'server:pve-02', state: 'looking', at: '2026-10-30T09:00:00Z' }, onHandle },
    });
    const busy = await card('Worth a look');
    expect(within(busy).queryByRole('button', { name: /to handle these$/ })).toBeNull();
    expect(within(busy).getByRole('status').textContent).toMatch(/is looking into these$/);
  });
});

/** Figures that open their charts (connections-page.md CN-05, AP-2510): CPU one, Network two, Guests its tab. */
const chart = (id: string, title: string, span: 1 | 2 = 1): ThingPagePanel => ({
  kind: 'chart',
  id,
  place: 'chart',
  span,
  title,
  stats: [[{ text: 'Avg ' }, { text: '4 %', strong: true }]],
  timestamps: stamps,
  series: [{ key: id, label: title, unit: '%', values: [1, 2, 3, 4, 5, 6, 7, 8], color: 'blue', fill: true }],
  foot: [{ label: 'User', value: '3 %' }],
  axis: { min: 0, max: 100, unit: '%' },
});

const OPENING: ThingPagePanel[] = [
  {
    kind: 'kpis',
    id: 'figures',
    place: 'top',
    items: [
      { key: 'cpu', label: 'CPU', value: '10 %', sub: 'of 32 threads', spark: [1, 4, 2], charts: ['cpu'] },
      { key: 'network', label: 'Network', value: '84', rest: 'Mb/s', charts: ['network', 'disk_io'] },
      {
        key: 'guests',
        label: 'Guests',
        value: '19',
        rest: 'of 22 running',
        meter: 0.86,
        link: { kind: 'tab', label: 'Guests', tab: 'guests' },
      },
      { key: 'load', label: 'Load', value: '2.9' },
    ],
  },
  chart('cpu', 'CPU'),
  chart('network', 'Network', 2),
  chart('disk_io', 'Disk I/O'),
  chart('temperatures', 'Temperatures'),
];

describe('a figure opens its charts (CN-05, AP-2510)', () => {
  it('draws figures with charts as buttons, a link figure as its tab, and only the unnamed chart as a card', async () => {
    const { onTab } = renderDashboard(vi.fn(), { panels: OPENING });
    const glance = await screen.findByRole('region', { name: 'At a glance' });
    const cpu = within(glance).getByRole('button', { name: 'CPU 10 %' });
    expect(cpu.getAttribute('aria-expanded')).toBe('false');
    expect(cpu.getAttribute('aria-controls')).toBeTruthy();
    expect(
      within(glance).getByRole('button', { name: 'Network 84 Mb/s' }).getAttribute('aria-expanded'),
    ).toBe('false');
    // A figure without charts or a link is words.
    expect(within(glance).queryByRole('button', { name: /^Load/ })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Temperatures']);
    await userEvent.setup().click(within(glance).getByRole('button', { name: 'Guests 19 of 22 running' }));
    expect(onTab).toHaveBeenCalledWith('guests');
  });

  it('opens one figure at a time under the figures, keeps it in the address, and closes', async () => {
    const user = userEvent.setup();
    const onRange = vi.fn();
    const { search } = renderDashboard(vi.fn(), { panels: OPENING, onRange });
    const glance = await screen.findByRole('region', { name: 'At a glance' });
    const cpu = within(glance).getByRole('button', { name: 'CPU 10 %' });
    await user.click(cpu);
    const open = await within(glance).findByRole('region', { name: 'CPU' });
    expect(cpu.getAttribute('aria-expanded')).toBe('true');
    expect(cpu.getAttribute('aria-controls')).toBe(open.id);
    expect(search()).toContain('chart=cpu');
    expect(within(open).getByRole('heading', { level: 3, name: 'CPU' })).toBeTruthy();
    expect(text(open)).toContain('Avg 4 %');
    expect(text(open)).toContain('User3 %');
    // The range beside the charts.
    await user.click(
      within(within(open).getByRole('group', { name: 'Range' })).getByRole('radio', { name: '7d' }),
    );
    expect(onRange).toHaveBeenCalledWith('7d');
    // Network opens its two charts instead.
    await user.click(within(glance).getByRole('button', { name: 'Network 84 Mb/s' }));
    const net = await within(glance).findByRole('region', { name: 'Network Disk I/O' });
    expect(
      within(net)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Network', 'Disk I/O']);
    expect(cpu.getAttribute('aria-expanded')).toBe('false');
    expect(search()).toContain('chart=network');
    await user.click(within(net).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(glance).queryByRole('region')).toBeNull());
    expect(search()).not.toContain('chart=');
  });

  it('opens the figure the address names, and nothing for a key without charts', async () => {
    renderDashboard(vi.fn(), { panels: OPENING, url: '/?chart=network' });
    expect(await screen.findByRole('region', { name: 'Network Disk I/O' })).toBeTruthy();
    cleanup();
    renderDashboard(vi.fn(), { panels: OPENING, url: '/?chart=load' });
    const glance = await screen.findByRole('region', { name: 'At a glance' });
    expect(within(glance).queryByRole('region')).toBeNull();
  });

  it('keeps the range picker in the tab row only while a chart card is left', () => {
    expect(rangeInTabRow(OPENING)).toBe(true);
    expect(rangeInTabRow(OPENING.filter((p) => p.id !== 'temperatures'))).toBe(false);
    // No figure opens a chart: the picker stays where it was.
    expect(rangeInTabRow(PANELS)).toBe(true);
  });

  it('sets a short unit apart from its number', () => {
    expect(splitFigureValue('10 %')).toEqual({ number: '10', unit: ' %' });
    expect(splitFigureValue('75 °C')).toEqual({ number: '75', unit: ' °C' });
    expect(splitFigureValue('76')).toEqual({ number: '76', unit: null });
    expect(splitFigureValue('2 integrations')).toEqual({ number: '2 integrations', unit: null });
  });
});
