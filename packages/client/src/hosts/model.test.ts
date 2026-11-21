import {
  HostFleet,
  HostGuestConfig,
  HostGuestDetail,
  HostGuestPage,
  HostSeries,
  HostServerDetail,
  HostServerSettings,
  HostsStatus,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { secondsAbove, tempScale, timeTicks } from './chart';
import { createHostsFixtures } from './fixtures';
import { serverHasNetworkTab } from './libvirt';
import {
  busiestGuests,
  detailGuests,
  filterGuests,
  fleetLine,
  guestKind,
  guestKindMatches,
  guestRow,
  guestTabs,
  powerActions,
  serverHeader,
  serverKpis,
  serverRows,
  serverWatch,
  shortOs,
  storageTotals,
  temperatureChart,
} from './model';
import { agentSwitchesLine, andWords } from './system';

const NOW = Date.parse('2026-10-17T12:02:00Z');
const { handle } = createHostsFixtures(NOW);
const get = (path: string, query: Record<string, string> = {}) =>
  handle({ method: 'GET', path, query, body: {} });

describe('the fixture world', () => {
  it('answers in the contracts’ shapes', () => {
    expect(HostsStatus.safeParse(get('/status')?.body).success).toBe(true);
    expect(HostFleet.safeParse(get('/fleet')?.body).error).toBeUndefined();
    for (const id of ['pve-02', 'pve-01', 'thetitan', 'blackbox', 'the-falcon'])
      expect(HostServerDetail.safeParse(get(`/servers/${id}`)?.body).error).toBeUndefined();
    expect(
      HostSeries.safeParse(get('/servers/pve-02/metrics', { series: 'temp_cpu_package_c' })?.body).error,
    ).toBeUndefined();
    expect(HostGuestPage.safeParse(get('/guests', { server: 'pve-02' })?.body).error).toBeUndefined();
    expect(HostGuestDetail.safeParse(get('/servers/pve-02/guests/pve:118')?.body).error).toBeUndefined();
    const cfg = get('/servers/pve-02/manage', { op: 'config.get', guestId: 'pve:118' })?.body as {
      config: unknown;
    };
    expect(HostGuestConfig.safeParse(cfg.config).error).toBeUndefined();
    expect(HostServerSettings.safeParse(get('/servers/pve-02/settings')?.body).error).toBeUndefined();
  });
});

describe('Home’s Servers card', () => {
  const fleet = HostFleet.parse(get('/fleet')?.body);

  it('says the mock’s line', () => {
    expect(fleetLine(fleet.servers)).toBe('5 online · 66 of 133 running');
  });

  it('puts problems first and reads as the mock', () => {
    const rows = serverRows(fleet.servers);
    expect(rows.map((r) => r.name)).toEqual(['blackbox', 'pve-02', 'pve-01', 'the-falcon', 'thetitan']);
    const pve02 = rows[1];
    expect(pve02?.subtitle).toBe('Proxmox VE 9.2 · Ryzen AI MAX+ PRO');
    expect(pve02?.cpuText).toBe('10 %');
    expect(pve02?.memoryText).toBe('76 / 118 GB');
    expect(pve02?.tempText).toBe('75 °C');
    expect(pve02?.tempTone).toBe('warn');
    expect(pve02?.guestsText).toBe('19 / 23');
    expect(rows[3]?.guestsText).toBe('none');
    expect(rows[0]?.tone).toBe('bad');
  });

  it('shortens versions in the second line', () => {
    expect(shortOs('Proxmox VE 9.2.11')).toBe('Proxmox VE 9.2');
    expect(shortOs('Debian GNU/Linux 13')).toBe('Debian 13');
  });
});

describe('a server’s page', () => {
  const d = HostServerDetail.parse(get('/servers/pve-02')?.body);
  const history = HostSeries.parse(
    get('/servers/pve-02/metrics', { series: 'temp_cpu_package_c', range: '24h' })?.body,
  );

  it('has the mock’s header', () => {
    const h = serverHeader(d);
    expect(h.badge).toBe('Running hot');
    expect(h.tone).toBe('warn');
    expect(h.facts.map((f) => f.map((p) => p.text).join(''))).toEqual([
      'Proxmox VE 9.2.11',
      'Ryzen AI MAX+ PRO · 32 threads',
      'Up 23 days',
    ]);
  });

  it('has the five figures', () => {
    const k = serverKpis(d, history);
    expect(k.map((x) => [x.label, x.value, x.rest ?? '', x.sub])).toEqual([
      ['CPU', '10 %', '', '32 threads'],
      ['Memory', '76', '/ 118 GB', '64 % used'],
      ['Hottest', '75 °C', '', expect.stringMatching(/^warm for \d+ h$/)],
      ['Storage', '871 GB', '/ 2 TB', '44 % used'],
      ['Guests', '19', 'running', '6 VMs · 13 CTs'],
    ]);
    expect(k[2]?.tone).toBe('warn');
  });

  it('charts the CPU with the warm line', () => {
    const c = temperatureChart(d);
    expect(c).toMatchObject({ title: 'CPU temperature', key: 'temp_cpu_package_c', warm: 72 });
    expect(c?.meta).toBe('last 24 h · dashed line: warm from 72 °C');
    const scale = tempScale(history.series.temp_cpu_package_c ?? [], 72);
    expect(scale.ticks).toEqual([40, 60, 80]);
    const ticks = timeTicks(history.timestamps, '24h', 'Europe/Amsterdam').map((t) => t.label);
    expect(ticks).toHaveLength(5);
    expect(ticks[0]).toMatch(/^Fri \d\d:\d\d$/);
    expect(ticks[4]).toBe('Now');
  });

  it('lists the busiest guests', () => {
    const rows = busiestGuests(detailGuests(d)).map(guestRow);
    expect(rows.map((r) => [r.name, r.kindText, r.stateText, r.cpuText, r.memoryText])).toEqual([
      ['cli-proxy-api', 'CT 140', 'Running', '13.6 %', '3.1 / 4 GB'],
      ['arnica-prod-nest-01', 'VM 118', 'Running', '9.2 %', '3.8 / 4 GB'],
      ['AgentDVR', 'CT 141', 'Running', '8.7 %', '1.2 / 2 GB'],
      ['homeassistant', 'CT 131', 'Running', '2.4 %', '1.9 / 4 GB'],
    ]);
    expect(rows[1]?.note).toEqual({ text: 'restart to apply 1 change', tone: 'warn' });
    expect(rows[0]?.note).toEqual({ tags: ['api'] });
  });

  it('counts how long it has been warm', () => {
    expect(secondsAbove(history, 'temp_cpu_package_c', 72.25)).toBeGreaterThan(10 * 3600);
    expect(secondsAbove(history, 'temp_cpu_package_c', 200)).toBe(0);
  });

  it('adds up storage from the guests’ storages', () => {
    expect(storageTotals(d)).toEqual({ usedGb: 871, totalGb: 2000 });
  });

  it('lists what needs a look', () => {
    const rows = serverWatch(d.alerts ?? [], d.hints, 'pve-02');
    expect(rows[0]).toMatchObject({ tone: 'warn', title: 'CPU package at 74 °C' });
  });
});

describe('guests', () => {
  it('get tabs by platform and switches', () => {
    const rc = { console: true, power: true, manage: true };
    expect(guestTabs({ platform: 'pve', kind: 'vm' }, rc, { cloudInit: true })).toEqual([
      'summary',
      'hardware',
      'options',
      'cloudinit',
      'snapshots',
      'backups',
      'firewall',
      'tasks',
    ]);
    expect(guestTabs({ platform: 'pve', kind: 'container' }, rc, { cluster: true })).toEqual([
      'summary',
      'hardware',
      'options',
      'snapshots',
      'backups',
      'firewall',
      'replication',
      'tasks',
    ]);
    expect(guestTabs({ platform: 'pve', kind: 'container' }, { ...rc, manage: false })).toEqual([
      'summary',
      'snapshots',
    ]);
    expect(guestTabs({ platform: 'docker', kind: 'container' }, rc)).toEqual(['summary']);
  });

  it('offer power actions that ask before stopping', () => {
    const on = powerActions({ state: 'running', platform: 'pve', kind: 'vm', name: 'web' });
    expect(on.map((a) => a.label)).toEqual(['Shut down', 'Restart', 'Pause', 'Force stop']);
    expect(on.filter((a) => a.confirm).map((a) => a.action)).toEqual(['shutdown', 'reboot', 'force_stop']);
    expect(
      powerActions({ state: 'stopped', platform: 'pve', kind: 'vm', name: 'web' }).map((a) => a.action),
    ).toEqual(['start']);
  });
});

describe('guestKind (less-is-more.md AP-1755)', () => {
  it('draws Docker, Linux Containers or a screen, with the words for the tooltip', () => {
    expect(guestKind({ platform: 'docker', kind: 'container' })).toEqual({
      glyph: 'docker',
      label: 'Docker container',
      id: null,
    });
    expect(guestKind({ platform: 'incus', kind: 'container' })).toEqual({
      glyph: 'lxc',
      label: 'Incus container',
      id: null,
    });
    expect(guestKind({ platform: 'incus', kind: 'vm' })).toEqual({
      glyph: 'vm',
      label: 'Incus VM',
      id: null,
    });
    expect(guestKind({ platform: 'libvirt', kind: 'vm' })).toEqual({
      glyph: 'vm',
      label: 'QEMU/KVM VM',
      id: null,
    });
    expect(guestKind({ platform: 'pve', kind: 'container', vmid: 140 })).toEqual({
      glyph: 'lxc',
      label: 'Proxmox container 140',
      id: '140',
    });
    expect(guestKind({ platform: 'pve', kind: 'vm', vmid: 118 })).toEqual({
      glyph: 'vm',
      label: 'Proxmox VM 118',
      id: '118',
    });
  });

  it('lets a search find guests by their kind', () => {
    expect(guestKindMatches({ platform: 'docker', kind: 'container' }, 'docker')).toBe(true);
    expect(guestKindMatches({ platform: 'incus', kind: 'vm' }, 'VM')).toBe(true);
    expect(guestKindMatches({ platform: 'pve', kind: 'container', vmid: 140 }, 'ct')).toBe(true);
    expect(guestKindMatches({ platform: 'docker', kind: 'container' }, 'incus')).toBe(false);
    expect(guestKindMatches({ platform: 'incus', kind: 'container' }, 'lxc')).toBe(true);
    expect(guestKindMatches({ platform: 'libvirt', kind: 'vm' }, 'kvm')).toBe(true);
  });

  it('takes whole kind words only, so half a name doesn’t list every guest of a kind', () => {
    expect(guestKindMatches({ platform: 'pve', kind: 'vm', vmid: 118 }, 'pro')).toBe(false);
    expect(guestKindMatches({ platform: 'incus', kind: 'container' }, 'con')).toBe(false);
    expect(guestKindMatches({ platform: 'incus', kind: 'vm' }, 'incus vm')).toBe(true);
    expect(guestKindMatches({ platform: 'incus', kind: 'container' }, 'incus vm')).toBe(false);
  });

  it('finds guests by kind in a server’s guest search', () => {
    const d = HostServerDetail.parse(get('/servers/thetitan')?.body);
    const all = detailGuests(d);
    const docker = filterGuests(all, 'all', 'docker');
    expect(docker.length).toBeGreaterThan(0);
    expect(docker.every((g) => g.platform === 'docker' || /docker/i.test(g.name))).toBe(true);
    const vms = filterGuests(all, 'all', 'VM');
    expect(vms.some((g) => g.kind === 'vm')).toBe(true);
    expect(vms.every((g) => g.kind === 'vm' || /vm/i.test(g.name))).toBe(true);
  });
});

describe('the System tab, less is more (AP-1765, AP-1767)', () => {
  it('knows which servers list their interfaces on a Network tab', () => {
    const page = (path: string) => HostServerDetail.parse(get(path)?.body);
    expect(serverHasNetworkTab(page('/servers/thetitan'))).toBe(true);
    expect(serverHasNetworkTab(page('/servers/pve-02'))).toBe(false);
  });

  it('folds the agent’s switches behind one line, open when the server blocks one', () => {
    const sw = (label: string, on = true, blocked = false) => ({ label, on, blocked });
    expect(agentSwitchesLine([sw('Consoles'), sw('Guests’ power')], 'pve-01')).toEqual({
      text: 'All 2 allowed',
      attention: false,
    });
    expect(
      agentSwitchesLine([sw('Consoles'), sw('Shell on the server', false), sw('Server’s power', false)], 'x'),
    ).toEqual({ text: '1 of 3 allowed · Shell on the server and Server’s power off', attention: false });
    expect(agentSwitchesLine([sw('A', false), sw('B', false), sw('C', false), sw('D')], 'x').text).toBe(
      '1 of 4 allowed',
    );
    expect(agentSwitchesLine([sw('A', false), sw('B', false)], 'x').text).toBe(
      'Nothing allowed: Whombat only watches',
    );
    expect(agentSwitchesLine([sw('Consoles'), sw('Shell on the server', false, true)], 'pve-01')).toEqual({
      text: 'Shell on the server is switched off on pve-01 itself',
      attention: true,
    });
    expect(andWords(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
