import {
  HomeHref,
  type HostSeriesRange,
  type HostServerDetail,
  type ThingPagePanel,
  ThingPagePanel as ThingPagePanelSchema,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { figureCharts, placePanels } from '../home/thingPage';
import {
  DASHBOARD_RANGE_WORDS,
  dashboardGuests,
  parseDashboardRange,
  SERVER_DASHBOARD_PHONE_RANGES,
  SERVER_DASHBOARD_RANGES,
  serverConsoleHref,
  serverControlLevel,
  serverDashboard,
  serverDashboardHead,
  serverDashboardKind,
  serverDashboardSeries,
  serverDashboardTabs,
  serverDashboardView,
  serverDashboardVolumeSeries,
  serverGuestHref,
  serverTabHref,
} from './dashboard';
import { DASHBOARD_FIXTURE_IDS, type DashboardFixtureId, dashboardFixtures } from './dashboard-fixtures';

const TZ = 'Europe/Amsterdam';
/** Sunday 18 October 2026, 18:00 in Amsterdam. */
const NOW = Date.parse('2026-10-18T16:00:00Z');
const fx = dashboardFixtures(NOW);
const nb = (s: string | undefined) => (s ?? '').replace(/ /g, ' ');

function view(
  id: DashboardFixtureId,
  range: HostSeriesRange = '24h',
  o: { detail?: HostServerDetail; loading?: boolean; assistant?: string } = {},
) {
  const f = fx[id];
  const detail = o.detail ?? f.detail;
  return serverDashboardView({
    detail,
    series: o.loading ? null : f.series(range, serverDashboardSeries(detail)),
    volumes: o.loading ? null : f.series('30d', serverDashboardVolumeSeries(detail)),
    guests: o.loading
      ? null
      : Object.fromEntries(dashboardGuests(detail).map((g) => [g.id, f.guestSeries(g.id, range)])),
    range,
    timeZone: TZ,
    now: NOW,
    ...(o.assistant ? { assistant: o.assistant } : {}),
  });
}

function build(
  id: DashboardFixtureId,
  range: HostSeriesRange = '24h',
  o: { detail?: HostServerDetail; loading?: boolean; assistant?: string } = {},
): ThingPagePanel[] {
  return view(id, range, o).panels;
}

function panel<K extends ThingPagePanel['kind']>(
  panels: readonly ThingPagePanel[],
  id: string,
  kind: K,
): Extract<ThingPagePanel, { kind: K }> {
  const p = panels.find((x) => x.id === id);
  if (!p || p.kind !== kind) throw new Error(`no ${kind} panel ${id}`);
  return p as Extract<ThingPagePanel, { kind: K }>;
}

function layout(panels: readonly ThingPagePanel[]) {
  const p = placePanels(panels);
  return {
    top: p.top.map((x) => x.id),
    chart: p.chart.map((r) => r.map((c) => `${c.panel.id}:${c.span}`)),
    main: p.main.map((x) => x.id),
    side: p.side.map((x) => x.id),
    bottom: p.bottom.map((x) => x.id),
  };
}

const text = (line: { text: string }[] | undefined) => nb(line?.map((p) => p.text).join(''));

/** Every link and href in a page's panels. */
function links(panels: readonly ThingPagePanel[]) {
  const out: { kind: string; tab?: string; href?: string; label: string }[] = [];
  const add = (l: unknown) => {
    if (l && typeof l === 'object' && 'kind' in l) out.push(l as (typeof out)[number]);
  };
  for (const p of panels) {
    if ('link' in p) add(p.link);
    if (p.kind === 'notices') for (const i of p.items) add(i.link);
    if (p.kind === 'table')
      for (const r of p.rows)
        for (const c of Object.values(r.cells))
          if (c.href) out.push({ kind: 'href', href: c.href, label: c.text });
    if (p.kind === 'bars')
      for (const b of p.items) if (b.href) out.push({ kind: 'href', href: b.href, label: b.label });
  }
  return out;
}

describe('a server’s Summary for every kind (DS-09, AP-2007)', () => {
  it('knows every fixture’s kind', () => {
    expect(DASHBOARD_FIXTURE_IDS.map((id) => serverDashboardKind(fx[id].detail))).toEqual([
      'proxmox',
      'unraid',
      'incus',
      'libvirt',
      'linux',
      'docker',
    ]);
  });

  for (const id of DASHBOARD_FIXTURE_IDS)
    for (const range of SERVER_DASHBOARD_RANGES)
      it(`${id} over ${range}: valid panels, filled chart rows, links to tabs that exist`, () => {
        const panels = build(id, range);
        for (const p of panels) {
          const r = ThingPagePanelSchema.safeParse(p);
          expect(r.success, `${p.id}: ${JSON.stringify(r.error?.issues.slice(0, 2))}`).toBe(true);
        }
        expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
        const placed = placePanels(panels);
        for (const row of placed.chart) expect(row.reduce((a, c) => a + c.span, 0)).toBe(3);
        const kpis = panel(panels, 'figures', 'kpis');
        expect(kpis.items.length).toBeGreaterThanOrEqual(3);
        const tabs = serverDashboardTabs(serverDashboardKind(fx[id].detail));
        for (const l of links(panels)) {
          if (l.kind === 'tab') expect(tabs, l.label).toContain(l.tab);
          if (l.kind === 'href') expect(HomeHref.safeParse(l.href).success, l.href).toBe(true);
          expect(l.label.length).toBeLessThanOrEqual(30);
        }
        // Every chart sits behind a figure (connections-page.md CN-05, CT-449): none is a card of its own.
        expect(
          figureCharts(panels)
            .panels.filter((p) => p.kind === 'chart')
            .map((p) => p.id),
        ).toEqual([]);
        for (const k of kpis.items)
          if (k.link?.kind === 'tab') expect(tabs, k.link.label).toContain(k.link.tab);
        const chart = panel(panels, 'cpu', 'chart');
        expect(chart.timestamps.length).toBeGreaterThan(0);
        expect(chart.series[0]?.values.length).toBe(chart.timestamps.length);
      });

  it('pve-02 (Proxmox VE): figures in words, two chart rows, busiest machines, backups; the rest in details', () => {
    const panels = build('pve-02');
    expect(layout(panels)).toEqual({
      top: ['figures'],
      chart: [
        ['cpu:1', 'memory:1', 'temperatures:1'],
        ['network:2', 'disk_io:1'],
      ],
      main: ['guests'],
      side: ['look', 'backups'],
      bottom: [],
    });
    expect(view('pve-02').details.map((p) => p.id)).toEqual(['storage', 'cluster']);
    const k = panel(panels, 'figures', 'kpis').items;
    expect(k.map((x) => [x.key, x.label, nb(x.value), nb(x.sub)])).toEqual([
      ['cpu', 'Processor', 'Quiet', '18 % in use'],
      ['memory', 'Memory', 'Plenty free', '23 GB free · 41 of 64 GB in use (64 %)'],
      ['storage', 'Storage', 'Plenty free', 'Full in about 5 months · 34 % in use'],
      // Temperature is its figure, never a word that could contradict the pill.
      ['hottest', 'Temperature', '71 °C', 'CPU package'],
    ]);
    expect(k.map((x) => x.color)).toEqual(['blue', 'violet', 'blue', 'amber']);
    expect(k.map((x) => [x.key, x.charts ?? (x.link?.kind === 'tab' ? x.link.tab : null)])).toEqual([
      ['cpu', ['cpu', 'network', 'disk_io']],
      ['memory', ['memory']],
      ['storage', 'storage'],
      ['hottest', ['temperatures']],
    ]);
    expect(k[0]?.spark).toHaveLength(96);
    expect(k[2]?.meter).toBeGreaterThan(0);

    const cpu = panel(panels, 'cpu', 'chart');
    expect(cpu.figure).toEqual({ value: '18\u00a0%', rest: 'of 16 threads' });
    expect(text(cpu.stats?.[0])).toMatch(/^Avg \d+ %$/);
    expect(text(cpu.stats?.[1])).toMatch(/^Peak \d+ % Sun 03:\d0$/);
    expect(cpu.foot?.map((f) => `${f.label} ${nb(f.value)}`)).toEqual([
      'User 11.4 %',
      'System 4.9 %',
      'I/O wait 1.7 %',
      'Load 2.9',
    ]);
    expect(cpu.series[0]).toMatchObject({ color: 'blue', fill: true, unit: '%' });
    expect(cpu.axis).toEqual({ min: 0, max: 100, unit: '%' });

    const mem = panel(panels, 'memory', 'chart');
    expect(nb(mem.figure?.rest)).toBe('41 of 64 GB');
    expect(mem.foot?.map((f) => f.label)).toEqual(['Guests', 'ZFS ARC', 'Free', 'Swap']);
    expect(nb(mem.foot?.[3]?.value)).toBe('0 / 8 GB');
    expect(mem.series[0]).toMatchObject({ color: 'violet', fill: true });

    const temps = panel(panels, 'temperatures', 'chart');
    expect(temps.series.map((s) => [s.label, s.color])).toEqual([
      ['CPU package', 'amber'],
      ['NVMe, hottest', 'blue'],
      ['Board', 'green'],
    ]);
    expect(temps.line).toEqual({ value: 85, label: '85 °C limit' });
    expect(temps.foot?.map((f) => nb(f.value))).toEqual(['71 / 85 °C', '48 / 75 °C', '41 °C']);
    expect(temps.axis?.unit).toBe('°');

    const net = panel(panels, 'network', 'chart');
    expect(net.series.map((s) => [s.label, s.color])).toEqual([
      ['In', 'green'],
      ['Out', 'orange'],
    ]);
    expect(text(net.stats?.[0])).toMatch(/^Peak in \d+ Mb\/s Sun 03:\d0$/);
    expect(text(net.stats?.[1])).toMatch(/^Total [\d.]+ GB in · [\d.]+ GB out$/);
    const disk = panel(panels, 'disk_io', 'chart');
    expect(disk.series.map((s) => [s.label, s.color])).toEqual([
      ['Read', 'blue'],
      ['Write', 'violet'],
    ]);

    const t = panel(panels, 'guests', 'table');
    expect(t.title).toBe('Busiest machines');
    expect(t.meta).toBe('12 of 14 running');
    expect(t.link).toEqual({ kind: 'tab', label: 'See all', tab: 'guests' });
    expect(t.columns.map((c) => c.label)).toEqual(['Name', 'CPU', 'Memory', '24 h']);
    expect(t.rows.map((r) => r.cells.guest?.text)).toEqual([
      'home-assistant',
      'nextcloud',
      'unifi',
      'frigate',
      'pihole',
    ]);
    const ha = t.rows[0]?.cells;
    expect(ha?.guest).toMatchObject({ mono: true, href: '/things/server%3Apve-02?guest=pve%3A131' });
    // A machine is its name: no type code or number under it.
    expect(ha?.guest?.note).toBeUndefined();
    expect(ha?.cpu).toMatchObject({ text: '6.1\u00a0%', meter: 0.061 });
    expect(nb(ha?.memory?.text)).toBe('3.0 / 8 GB');
    expect(ha?.trend?.spark).toHaveLength(96);
    expect(ha?.open).toBeUndefined();
    expect(t.rows[3]?.cells.guest?.note).toBe('restart to apply 1 change');

    const look = panel(panels, 'look', 'notices');
    expect(look.items.map((i) => [i.tone, i.title, i.link?.label])).toEqual([
      ['warn', 'CPU package at 79 °C', 'See temperatures'],
      ['info', 'Storage “local-lvm” full in about 5 months', 'See storage'],
      ['info', '3 updates waiting', 'See details'],
    ]);

    const backups = panel(panels, 'backups', 'list');
    expect(backups.items[0]).toMatchObject({ title: '14 of 14 machines backed up', tone: 'ok' });
    expect([nb(backups.items[0]?.detail), nb(backups.items[0]?.right)]).toEqual([
      'Today 03:00 · 41 min',
      'next in 9 h',
    ]);
    expect(backups.link).toEqual({ kind: 'tab', label: 'See backups', tab: 'backups' });
    const details = view('pve-02').details;
    expect(panel(details, 'cluster', 'list').items.map((i) => [i.title, i.right])).toEqual([
      ['pve-01', undefined],
      ['pve-02', 'This one'],
    ]);

    const storage = panel(details, 'storage', 'bars');
    expect(storage.columns).toBe(1);
    expect(nb(storage.meta)).toBe('4 storages · 4 of 12 TB');
    expect(storage.items.map((b) => [b.label, b.note, nb(b.value), b.sub])).toEqual([
      ['local-lvm', 'LVM-thin', '660 of 930 GB', 'Full in about 5 months'],
      ['tank', 'ZFS', '2.1 of 7.2 TB', undefined],
      ['local', 'folder', '38 of 94 GB', undefined],
      ['pbs', 'Proxmox Backup Server · backups', '1.2 of 4 TB', undefined],
    ]);
  });

  it('blackbox (Unraid): space is the array, disk temperatures, the array, busiest apps, the VM', () => {
    const panels = build('blackbox');
    expect(layout(panels)).toEqual({
      top: ['figures'],
      chart: [['cpu:1', 'memory:1', 'disk_temperatures:1']],
      main: ['array', 'guests'],
      side: ['look', 'vms'],
      bottom: [],
    });
    expect(view('blackbox').details.map((p) => p.id)).toEqual(['pools', 'kind_facts']);
    const k = panel(panels, 'figures', 'kpis').items;
    expect(k.map((x) => [x.label, nb(x.value), nb(x.sub)])).toEqual([
      ['Processor', 'Quiet', '9 % in use'],
      ['Memory', 'Plenty free', '18 GB free · 14 of 32 GB in use (44 %)'],
      ['Storage', 'Filling up', '24 % free'],
      ['Temperature', '46 °C', 'CPU package'],
    ]);
    expect(k.map((x) => x.charts ?? (x.link?.kind === 'tab' ? x.link.tab : null))).toEqual([
      ['cpu'],
      ['memory'],
      'array',
      ['disk_temperatures'],
    ]);
    const temps = panel(panels, 'disk_temperatures', 'chart');
    expect(temps.title).toBe('Disk temperatures');
    expect(temps.stats?.map(text)).toEqual(['Limit 55 °C', '1 disk spun down']);
    expect(temps.line?.value).toBe(55);
    expect(temps.series.map((s) => s.label)).toEqual(['NVMe, hottest', 'HDD, hottest']);

    const array = panel(panels, 'array', 'bars');
    expect(array.meta).toBe('Parity checked 1 Oct · no errors');
    expect(array.link).toEqual({ kind: 'tab', label: 'See disks', tab: 'array' });
    expect(array.items.map((b) => [b.label, nb(b.note), nb(b.value), b.tone, b.sub])).toEqual([
      ['Parity', 'WD Red 8 TB · 34 °C', 'valid', undefined, undefined],
      ['Disk 1', 'WD Red 8 TB · spun down', '7.1 of 8 TB', 'warn', 'Full in about 7 months'],
      ['Disk 2', 'WD Red 8 TB · 36 °C', '6 of 8 TB', undefined, undefined],
      ['Disk 3', 'WD Red 8 TB · 39 °C', '5.1 of 8 TB', undefined, undefined],
    ]);
    expect(array.items[0]?.pct).toBeNull();

    const t = panel(panels, 'guests', 'table');
    expect(t.title).toBe('Busiest apps');
    expect(t.rows.map((r) => [r.cells.guest?.text, r.cells.guest?.note])).toEqual([
      ['plex', 'media'],
      ['sabnzbd', 'downloads'],
      ['immich', 'photos'],
      ['immich-db', 'photos'],
      ['sonarr', 'media'],
    ]);
    const details = view('blackbox').details;
    expect(panel(details, 'pools', 'bars').items.map((b) => [b.label, b.note, nb(b.value)])).toEqual([
      ['cache', 'NVMe mirror', '310 of 1,000 GB'],
    ]);
    expect(panel(panels, 'vms', 'list').items).toEqual([
      {
        id: 'libvirt:pbs',
        title: 'pbs',
        detail: 'Proxmox Backup Server · 4\u00a0GB',
        tone: 'ok',
        right: '3\u00a0%',
      },
    ]);
    expect(panel(details, 'kind_facts', 'facts').title).toBe('Unraid');
    const look = panel(panels, 'look', 'notices');
    expect(look.items.map((i) => [i.title, i.link])).toEqual([
      ['Disk 1 is 89 % full', { kind: 'tab', label: 'See disks', tab: 'array' }],
      // Two containers: the tab that lists both, not the first one's page.
      ['2 apps have an update', { kind: 'tab', label: 'See them', tab: 'guests' }],
    ]);
  });

  it('the-titan (Incus): its pools in details, the dev box as This Whombat, a file system filling up', () => {
    const panels = build('the-titan');
    const details = view('the-titan').details;
    expect(layout(panels).side).toEqual(['look']);
    expect(details.map((p) => p.id)).toEqual(['storage', 'pools', 'kind_facts']);
    expect(panel(details, 'pools', 'bars').items.map((b) => [b.label, b.note])).toEqual([
      ['default', 'zfs · 17 volumes'],
      ['ci-nvme', 'dir · 6 volumes'],
    ]);
    const t = panel(panels, 'guests', 'table');
    expect(t.rows.find((r) => r.id === 'incus:whombat-dev-box')?.cells.guest?.note).toBe('This Whombat');
    const storage = panel(details, 'storage', 'bars');
    // Incus's own pool is beside, not again in Storage.
    expect(storage.items.map((b) => [b.label, b.sub, b.subTone])).toEqual([
      ['/srv/ci', 'Full about 25 Nov', 'warn'],
      ['/', undefined, undefined],
    ]);
    expect(panel(panels, 'look', 'notices').items[0]?.link).toEqual({
      kind: 'href',
      label: 'Set a schedule',
      href: '/things/server%3Athe-titan?guest=incus%3Acomputer-hazel&gtab=snapshots',
    });
  });

  it('kvm-lab (QEMU/KVM): its machines running first, stopped ones listed, pools and their hints', () => {
    const panels = build('kvm-lab');
    const t = panel(panels, 'guests', 'table');
    expect(t.title).toBe('Machines');
    expect(t.link?.label).toBe('See all');
    expect(t.rows.map((r) => r.cells.guest?.text)).toEqual([
      'debian-web',
      'win11',
      'pfsense',
      'alpine-test',
      'nixos-build',
    ]);
    expect(t.rows[0]?.cells.guest?.note).toBe('1 change at the next start');
    expect(t.rows[3]?.cells).toMatchObject({
      guest: { dot: 'off', href: '/things/server%3Akvm-lab?guest=libvirt%3Aalpine-test' },
      cpu: { text: '—', tone: 'muted' },
    });
    const pools = panel(view('kvm-lab').details, 'pools', 'bars');
    expect(pools.title).toBe('Storage pools');
    expect(pools.items.map((b) => [b.label, b.tone, b.sub])).toEqual([
      ['default', undefined, undefined],
      ['fast', 'warn', undefined],
      ['isos', 'warn', 'Not active'],
    ]);
    expect(panel(panels, 'look', 'notices').items.map((i) => i.link)).toEqual([
      {
        kind: 'href',
        label: 'Back up win11',
        href: '/things/server%3Akvm-lab?guest=libvirt%3Awin11&gtab=backups',
      },
      { kind: 'tab', label: 'See storage', tab: 'storage' },
    ]);
    expect(panel(view('kvm-lab').details, 'kind_facts', 'facts').title).toBe('QEMU/KVM');
  });

  it('the-falcon (plain Linux, no sensors, no guests): three tiles, its storage in details, a problem asks by name', () => {
    const panels = build('the-falcon', '24h', { assistant: 'Neo' });
    expect(layout(panels)).toEqual({
      top: ['figures'],
      chart: [['cpu:1', 'memory:1', 'network:1'], ['disk_io:3']],
      main: [],
      side: ['look'],
      bottom: [],
    });
    expect(view('the-falcon').details.map((p) => p.id)).toEqual(['storage']);
    const k = panel(panels, 'figures', 'kpis').items;
    expect(k.map((x) => x.key)).toEqual(['cpu', 'memory', 'storage']);
    expect([k[2]?.value, nb(k[2]?.sub)]).toEqual(['Filling up', 'Full about 9 Nov · 77 % in use']);
    const look = panel(panels, 'look', 'notices');
    expect(look.items[0]).toMatchObject({
      tone: 'warn',
      icon: 'disk',
      title: 'Disk “srv” full in about 3 weeks',
      link: {
        kind: 'ask',
        label: 'Ask Neo',
        question: 'Disk “srv” full in about 3 weeks. Can you look into it?',
      },
    });
    // Without the assistant's name the button still asks.
    expect(panel(build('the-falcon'), 'look', 'notices').items[0]?.link?.label).toBe('Ask about it');
    // With something to look at, Worth a look comes right after the figures for the phone's stack.
    expect(panels.map((p) => p.id).slice(0, 3)).toEqual(['figures', 'look', 'cpu']);
  });

  it('raspi (a Docker host): busiest apps, Worth a look calm and after the main column', () => {
    const panels = build('raspi');
    expect(panel(panels, 'guests', 'table').title).toBe('Busiest apps');
    const look = panel(panels, 'look', 'notices');
    expect(look).toMatchObject({ items: [], empty: 'Nothing needs a look.', place: 'side' });
    const ids = panels.map((p) => p.id);
    expect(ids.indexOf('look')).toBeGreaterThan(ids.indexOf('guests'));
    expect(view('raspi').verdict.sentence).toMatch(/^raspi is fine: \d+ apps? (is|are) running\.$/);
  });
});

describe('temporary machines and the verdict', () => {
  it('leaves CI jobs out of the busiest list and the verdict’s counts, however busy they are', () => {
    const d = fx['the-titan'].detail;
    const incus = d.workloads?.incus as NonNullable<NonNullable<HostServerDetail['workloads']>['incus']>;
    const model = incus.guests[0] as (typeof incus.guests)[number];
    const ci = {
      ...model,
      id: 'incus:ci-platform/ci-job-a8791974',
      name: 'ci-job-a8791974',
      project: 'ci-platform',
      state: 'running' as const,
      cpuPct: 99,
      self: false,
    };
    const withCi: HostServerDetail = {
      ...d,
      workloads: {
        ...d.workloads,
        incus: {
          ...incus,
          running: incus.running + 1,
          total: incus.total + 1,
          guests: [...incus.guests, ci],
        },
      },
    };
    const before = view('the-titan');
    const after = view('the-titan', '24h', { detail: withCi });
    const busy = panel(after.panels, 'guests', 'table');
    expect(busy.rows.map((r) => r.id)).not.toContain(ci.id);
    expect(busy.meta).toBe(panel(before.panels, 'guests', 'table').meta);
    expect(after.verdict.sentence).toBe(before.verdict.sentence);
    expect(dashboardGuests(withCi).map((g) => g.id)).not.toContain(ci.id);
  });

  it('says a fine server is fine, with what runs on it, from Worth a look’s own lines', () => {
    const v = view('raspi').verdict;
    expect(v.tone).toBe('ok');
    expect(v.sentence).toMatch(/^raspi is fine: /);
    // pve-02's lines are heads-ups only, but the hosts service says it runs warm: the verdict says so.
    expect(view('pve-02').verdict).toEqual({ tone: 'warn', sentence: 'pve-02 is running warm.' });
    // A problem on the page is the verdict's first words.
    expect(view('the-falcon').verdict.sentence).toContain('has a problem: Disk “srv” full in about 3 weeks.');
  });
});

describe('the Summary’s states', () => {
  it('keeps the chart cards without lines while the history loads, so nothing moves when it comes', () => {
    const loading = build('pve-02', '24h', { loading: true });
    const loaded = build('pve-02');
    expect(layout(loading)).toEqual(layout(loaded));
    const cpu = panel(loading, 'cpu', 'chart');
    expect(cpu.timestamps).toEqual([]);
    expect(cpu.stats).toBeUndefined();
    // The figures' meters are the live page's, so they are there while the history loads.
    expect(panel(loading, 'figures', 'kpis').items[0]?.meter).toEqual(
      panel(loaded, 'figures', 'kpis').items[0]?.meter,
    );
  });

  it('closes up a chart row once read when a chart has no point at all', () => {
    const f = fx['the-falcon'];
    const series = f.series('24h', serverDashboardSeries(f.detail));
    series.series.disk_read_mbs = series.series.disk_read_mbs?.map(() => null) ?? [];
    series.series.disk_write_mbs = series.series.disk_write_mbs?.map(() => null) ?? [];
    const panels = serverDashboard({ detail: f.detail, series, range: '24h', timeZone: TZ, now: NOW });
    expect(layout(panels).chart).toEqual([['cpu:1', 'memory:1', 'network:1']]);
  });

  it('shows dashes for an offline server, says it isn’t checking in, and when it was last heard', () => {
    const d = fx['pve-02'].detail;
    const offline: HostServerDetail = {
      ...d,
      server: { ...d.server, status: 'offline', agent: { ...d.server.agent, lastSyncSAgo: 7200 } },
    };
    const k = panel(build('pve-02', '24h', { detail: offline }), 'figures', 'kpis').items;
    expect([k[0]?.value, k[1]?.value, k[3]?.value]).toEqual(['—', '—', '—']);
    const head = serverDashboardHead(offline);
    expect([head.badge, head.tone]).toEqual(['Offline', 'bad']);
    expect(head.details.find((r) => r.label === 'Whombat’s helper')?.value).toContain('Last checked in 2');
    expect(head.details.map((r) => r.label)).not.toContain('Up');
    const v = view('pve-02', '24h', { detail: offline }).verdict;
    expect(v.tone).toBe('bad');
    expect(nb(v.sentence)).toContain('isn’t checking in');
    expect(nb(v.sentence)).toContain('2 h ago');
  });

  it('puts what is wrong right now in a banner across the top, and doesn’t say it twice', () => {
    const d = fx['pve-02'].detail;
    const alert = {
      id: 'al_tank',
      serverId: 'pve-02',
      severity: 'critical' as const,
      title: 'tank lost a disk',
      detail: 'The mirror runs on one disk now.',
      openedAt: new Date(NOW - 3600_000).toISOString(),
      rule: 'zfs.degraded',
      state: 'open' as const,
      section: 'storage',
      attention: true,
    };
    const withBanner: HostServerDetail = {
      ...d,
      server: { ...d.server, status: 'bad' },
      alerts: [alert],
      banner: { severity: 'critical', title: 'tank lost a disk', detail: alert.detail, section: 'storage' },
    };
    const panels = build('pve-02', '24h', { detail: withBanner });
    expect(panels[0]).toMatchObject({
      kind: 'notices',
      id: 'banner',
      place: 'top',
      items: [{ tone: 'bad', icon: 'disk', title: 'tank lost a disk', link: { kind: 'ask' } }],
    });
    expect(layout(panels).top).toEqual(['banner', 'figures']);
    expect(panel(panels, 'look', 'notices').items.map((i) => i.title)).not.toContain('tank lost a disk');
    // The badge is the condition word its Overview card says; the banner says what else is wrong.
    expect(serverDashboardHead(withBanner).badge).toBe('Running warm');
    expect(
      serverDashboardHead({ ...withBanner, server: { ...withBanner.server, statusNote: null } }).badge,
    ).toBe('1 to look at');
  });

  it('says when parity is broken and lists Unraid’s notes the hints leave out', () => {
    const d = fx.blackbox.detail;
    const u = d.unraid as NonNullable<HostServerDetail['unraid']>;
    const broken: HostServerDetail = {
      ...d,
      hints: [
        ...d.hints,
        {
          serverId: 'blackbox',
          kind: 'unraid.notification',
          severity: 'warning',
          entity: 'n1',
          title: 'Disk 2 is hot',
          detail: '',
          section: 'array',
        },
      ],
      unraid: {
        ...u,
        array: {
          ...u.array,
          disabled: 1,
          disks: u.array.disks.map((x) => (x.slot === 'parity' ? { ...x, status: 'disabled' as const } : x)),
        },
        notifications: ['n1', 'n2', 'n3'].map((id, i) => ({
          id,
          at: new Date(NOW - i * 3600_000).toISOString(),
          importance: i ? ('normal' as const) : ('warning' as const),
          event: 'Docker',
          subject: i === 1 ? 'Notice [BLACKBOX] - plex updated' : 'Disk 2 is hot',
          description: '',
        })),
      },
    };
    const panels = build('blackbox', '24h', { detail: broken });
    const space = panel(panels, 'figures', 'kpis').items.find((x) => x.key === 'storage');
    // Amber at most: red is only the pill's, for what isn't working.
    expect([space?.tone, nb(space?.sub)]).toEqual(['warn', 'Parity isn’t valid']);
    expect(panel(panels, 'array', 'bars').items[0]).toMatchObject({ value: 'disabled', tone: 'bad' });
    expect(panel(panels, 'array', 'bars').meta).toBe('Parity is disabled');
    const look = panel(panels, 'look', 'notices').items;
    expect(look.find((i) => i.title === 'Disk 2 is hot')?.link).toEqual({
      kind: 'tab',
      label: 'See details',
      tab: 'system',
    });
    expect(look.at(-1)).toMatchObject({
      id: 'unraid-notes',
      title: '2 notes from Unraid',
      detail: 'Plex updated',
      link: { kind: 'tab', tab: 'system' },
    });
  });
});

describe('the head (DS-01)', () => {
  it('has one badge; its versions, processor, memory, address and helper are Technical details', () => {
    const head = serverDashboardHead(fx['pve-02'].detail);
    expect(head).toMatchObject({
      kind: 'proxmox',
      name: 'pve-02',
      status: 'warn',
      tone: 'warn',
      // Its one hint, the warm CPU, is a heads-up (quiet-notices.md QN-02): the hub's own words.
      badge: 'Running warm',
    });
    expect(head.details.map((r) => [r.label, nb(r.value)])).toEqual([
      ['System', 'Proxmox VE 9.0.10'],
      ['Kernel', expect.any(String)],
      ['Processor', 'Ryzen 7 5700G, 8 cores / 16 threads'],
      ['Memory', '64 GB DDR4'],
      ['Up', '12 d 4 h'],
      ['Address', '10.100.0.12'],
      ['Whombat’s helper', expect.stringContaining('Checked in 6 s ago')],
      ['What Whombat may do', 'Full control'],
      ['Figures', 'Live, every 10 s'],
    ]);
    expect(head.details.find((r) => r.label === 'Address')?.mono).toBe(true);
    const labels = (id: DashboardFixtureId) => serverDashboardHead(fx[id].detail).details.map((r) => r.label);
    expect(serverDashboardHead(fx.blackbox.detail)).toMatchObject({ badge: 'Array started', tone: 'ok' });
    expect(serverDashboardHead(fx.blackbox.detail).details[0]?.value).toMatch(/^Unraid 7\.1/);
    expect(serverDashboardHead(fx['the-titan'].detail, { name: 'The Titan' }).name).toBe('The Titan');
    expect(serverDashboardHead(fx['the-titan'].detail).details[1]?.value).toMatch(/^Incus 6\.0/);
    expect(labels('kvm-lab')).toContain('Platform');
    expect(serverDashboardHead(fx.raspi.detail).details[1]).toEqual({ label: 'Platform', value: 'Docker' });
  });

  it('names what Whombat may do from the switches', () => {
    const rc = fx['pve-02'].detail.server.remoteControl;
    expect(serverControlLevel(rc)).toBe('full');
    expect(serverControlLevel({ ...rc, manage: false, hostShell: false, hostPower: false })).toBe('operate');
    expect(serverControlLevel({ console: false, power: false, diagnose: true })).toBe('watch');
  });
});

describe('ranges, series and links', () => {
  it('offers six ranges (five on the phone), 24 hours by default', () => {
    expect(SERVER_DASHBOARD_RANGES).toEqual(['1h', '6h', '24h', '7d', '30d', '90d']);
    expect(SERVER_DASHBOARD_PHONE_RANGES).not.toContain('90d');
    expect(parseDashboardRange('7d')).toBe('7d');
    expect(parseDashboardRange('2y')).toBe('24h');
    expect(parseDashboardRange('90d', SERVER_DASHBOARD_PHONE_RANGES)).toBe('24h');
    expect(SERVER_DASHBOARD_RANGES.map((r) => DASHBOARD_RANGE_WORDS[r]).join(' · ')).toBe(
      '1h · 6h · 24h · 7d · 30d · 90d',
    );
  });

  it('asks for the base series, every sensor and up to eight volumes', () => {
    expect(serverDashboardSeries(fx['pve-02'].detail)).toEqual([
      'cpu_pct',
      'mem_pct',
      'load1',
      'swap_pct',
      'net_rx_mbps',
      'net_tx_mbps',
      'disk_read_mbs',
      'disk_write_mbs',
      'temp_cpu_package_c',
      'temp_nvme_hottest_c',
      'temp_board_vrm_c',
      'vol_pct:storage:local-lvm',
      'vol_pct:storage:tank',
      'vol_pct:storage:local',
      'vol_pct:storage:pbs',
      'vol_pct:pool:tank',
    ]);
    expect(serverDashboardVolumeSeries(fx.blackbox.detail)).toEqual([
      'vol_pct:fs:/mnt/disk1',
      'vol_pct:fs:/mnt/disk2',
      'vol_pct:fs:/mnt/disk3',
      'vol_pct:fs:/mnt/cache',
    ]);
    expect(serverDashboardSeries(fx['the-falcon'].detail)).not.toContain('temp_max_c');
  });

  it('links to a server’s tabs, guests and consoles as app paths', () => {
    expect(serverTabHref('pve-02', 'storage')).toBe('/things/server%3Apve-02?tab=storage');
    expect(serverTabHref('pve-02', 'summary')).toBe('/things/server%3Apve-02');
    expect(serverGuestHref('pve-02', 'pve:131', 'backups')).toBe(
      '/things/server%3Apve-02?guest=pve%3A131&gtab=backups',
    );
    expect(serverConsoleHref('pve-02', 'host')).toBe('/things/server%3Apve-02?console=host');
    expect(serverDashboardTabs('unraid')).toContain('array');
    expect(serverDashboardTabs('unraid')).not.toContain('storage');
    expect(serverDashboardTabs('libvirt')).toContain('network');
  });
});
