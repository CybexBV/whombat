/**
 * The house's and the network's kinds as widgets, from their recorded answers (desk-display-server.md “Every
 * connection's widgets”): Home Assistant's favourites as on/off rows, a sensor as a figure and a camera; Protect's
 * cameras; UniFi's internet and devices; Pi-hole's and AdGuard's blocked today. Pure: the kinds' own builders, laid out
 * as a page, through the widgets' runtime.
 */
import type { DeskWidgetRef, DeskWidgetSpec, ThingControl, ThingPage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../connections/types';
import { localizeTree } from '../../i18n/phrases';
import {
  type AccessSnapshot,
  accessData,
  accessView,
  parseDevices as parseAccessDevices,
  parseDoors,
  parseOpenings,
} from '../../things/kinds/home/access';
import { dnsView, parseAdguard, parsePihole } from '../../things/kinds/home/dns';
import {
  ACCESS_devices,
  ACCESS_doors,
  ACCESS_logs,
  ACCESS_rules,
} from '../../things/kinds/home/fixtures/access';
import {
  ADGUARD_filtering,
  ADGUARD_stats,
  ADGUARD_status,
  ADGUARD_version,
} from '../../things/kinds/home/fixtures/adguard';
import {
  HA_energyPrefsLegacy,
  HA_energyStats,
  HA_forecastDaily,
  HA_houseAreas,
  HA_houseDevices,
  HA_houseEvent,
  HA_houseRegistry,
  HA_logbook,
} from '../../things/kinds/home/fixtures/ha-house';
import {
  HA_areas,
  HA_devices,
  HA_home,
  HA_registry,
  HA_security,
  HA_states,
  HA_unit,
} from '../../things/kinds/home/fixtures/homeassistant';
import {
  PIHOLE_blocking,
  PIHOLE_history,
  PIHOLE_lists,
  PIHOLE_messages,
  PIHOLE_summary,
  PIHOLE_topBlocked,
  PIHOLE_topClients,
  PIHOLE_version,
} from '../../things/kinds/home/fixtures/pihole';
import {
  PROTECT_cameras,
  PROTECT_events,
  PROTECT_info,
  PROTECT_nvr,
  PROTECT_profiles,
} from '../../things/kinds/home/fixtures/protect';
import {
  controlOf,
  controlsPanel,
  favouritesOf,
  parseLayout,
  pickEntities,
  statesOf,
} from '../../things/kinds/home/ha-controls';
import {
  daysOf,
  energyIds,
  energyOf,
  housePanels,
  parseHouse,
  pickWeather,
  runsOf,
} from '../../things/kinds/home/ha-house';
import { parseProtect, protectView } from '../../things/kinds/home/protect';
import { detectionOf, type KeptEvent } from '../../things/kinds/home/protect-events';
import { emptySnapshot, haView, NO_POINTS } from '../../things/kinds/homeassistant';
import { unifiDevice, unifiGateway, unifiView } from '../../things/kinds/unifi';
import { homeWidgetPrivate } from './home';
import { screenViews, viewPictures } from './resolve';
import { as, groupOn, NOW, pageOf, panelOn, pictureRef, TZ, viewsOn } from './thing-testing';

const row = (catalogId: string) =>
  ({
    id: `con_${catalogId}`,
    access: 'manage',
    label: catalogId,
    catalogId,
    fields: {},
  }) as unknown as CatalogConnectionRow;

function haPage(extra?: ThingControl) {
  const layout = parseLayout(HA_registry, HA_devices, HA_areas, HA_unit);
  const picked = pickEntities(
    favouritesOf({ value: HA_home.value }),
    favouritesOf({ value: HA_security.value }, ['favorite_entities', 'alert_entities']),
    layout,
  );
  const states = statesOf([HA_states]);
  const panel = controlsPanel(
    { readAt: NOW, pinned: picked.pinned, ids: picked.ids.filter((id) => states[id]), states, layout },
    {
      buttons: { row: row('homeassistant') },
      cameraImage: (id, alt) => ({ ref: pictureRef(`api/camera_proxy/${id}`, true), alt, shape: 'wide' }),
    },
  );
  if (extra && panel.kind === 'controls') panel.groups[0]?.items.push(extra);
  return pageOf(
    {
      kpis: [
        { key: 'version', label: 'Version', value: '2026.10.2' },
        {
          key: 'integrations',
          label: 'Integrations',
          value: '169',
          rest: 'of 171',
          sub: '2 not loading',
          tone: 'warn',
        },
      ],
      panels: [panel],
      refreshS: 10,
    },
    { catalogId: 'homeassistant', name: 'Home Assistant' },
  );
}

function piholePage(blocking: { on: boolean; until: Date | null } | null = null) {
  const read = parsePihole(
    {
      summary: PIHOLE_summary,
      topBlocked: PIHOLE_topBlocked,
      topClients: PIHOLE_topClients,
      history: PIHOLE_history,
      messages: PIHOLE_messages,
      version: PIHOLE_version,
      lists: PIHOLE_lists,
      blocking: PIHOLE_blocking,
    },
    NOW,
  );
  const s = blocking ? { ...read, blocking } : read;
  const view = dnsView(s, {
    now: NOW,
    timeZone: TZ,
    range: '24h',
    buttons: { row: row('pihole') },
    points: { queries: [], blocked: [] },
  });
  return pageOf({ ...view, notices: view.notices }, { catalogId: 'pihole', name: 'Pi-hole' });
}

function adguardPage() {
  const s = parseAdguard(
    { stats: ADGUARD_stats, status: ADGUARD_status, filtering: ADGUARD_filtering, version: ADGUARD_version },
    NOW,
  );
  const view = dnsView(s, {
    now: NOW,
    timeZone: TZ,
    range: '24h',
    buttons: { row: row('adguard') },
    points: { queries: [], blocked: [] },
  });
  return pageOf(view, { catalogId: 'adguard', name: 'AdGuard Home' });
}

function protectPage() {
  // Only the front door is a doorbell.
  const cameras = PROTECT_cameras.map((c, i) => (i ? { ...c, type: 'UVC G5 Bullet' } : c));
  const s = parseProtect({ info: PROTECT_info, cameras, nvr: PROTECT_nvr, profiles: PROTECT_profiles }, NOW);
  const by = new Map<string, KeptEvent>();
  for (const m of PROTECT_events) {
    const d = detectionOf(m);
    if (!d) continue;
    by.set(d.eventId, {
      eventId: d.eventId,
      at: d.at,
      kind: d.kind,
      device: d.device,
      title: 'Front Door',
      payload: { ...(d.detected.length ? { detected: d.detected } : {}) },
    });
  }
  const view = protectView(
    s,
    {
      now: NOW,
      timeZone: TZ,
      events: [...by.values()],
      offlineSince: new Map(),
      follow: { connected: true, failingSince: null },
    },
    {
      buttons: { row: row('unifi_protect') },
      picture: (id, alt) => ({ ref: pictureRef(`snapshot/${id}`, true), alt, shape: 'wide' }),
      openUrl: 'https://192.168.1.1/protect/dashboard',
    },
  );
  return pageOf(view, { catalogId: 'unifi_protect', name: 'UniFi Protect' });
}

function unifiPage() {
  const raw = [
    {
      id: 'gw',
      name: 'Gateway',
      model: 'UCG-Ultra',
      ipAddress: '10.100.0.1',
      state: 'ONLINE',
      features: ['switching'],
    },
    {
      id: 'ap1',
      name: 'Kitchen AP',
      model: 'U7-Pro',
      ipAddress: '10.100.0.21',
      state: 'ONLINE',
      features: ['accessPoint'],
    },
    {
      id: 'ap2',
      name: 'Garden AP',
      model: 'U6-Mesh',
      ipAddress: '10.100.0.22',
      state: 'OFFLINE',
      features: ['accessPoint'],
    },
  ];
  const devices = raw.map((d) => unifiDevice(d, { firmwareVersion: '7.0.66', firmwareUpdatable: false }));
  const s = {
    readAt: NOW,
    version: '9.1.120',
    devices,
    clients: 174,
    gateway: unifiGateway(devices[0] as ReturnType<typeof unifiDevice>, {
      uptimeSec: 1_036_800,
      cpuUtilizationPct: 12.4,
      memoryUtilizationPct: 48.1,
      uplink: { txRateBps: 40_200_000, rxRateBps: 312_400_000 },
    }),
  };
  const n = 288;
  const timestamps = Array.from({ length: n }, (_, i) =>
    new Date(NOW.getTime() - (n - i) * 300_000).toISOString(),
  );
  const wave = (base: number) =>
    Array.from({ length: n }, (_, i) => base + Math.round(Math.sin(i / 20) * base * 0.3));
  const view = unifiView({
    snapshot: s,
    points: { timestamps, down: wave(300), up: wave(40), cpuRaw: [] },
    history: null,
    now: NOW,
    timeZone: TZ,
    machineKnown: false,
  });
  return pageOf(view, { catalogId: 'unifi_network', name: 'UniFi' });
}

const ids = (items: { opts: Record<string, string> }[]) =>
  items.map((i) => (i.opts.item ? `${i.opts.panel}/${i.opts.item}` : (i.opts.panel ?? 'figures')));

describe('Home Assistant', () => {
  it('offers its favourites, each camera and each sensor or thermostat as a widget of its own', async () => {
    const group = await groupOn(haPage());
    expect(ids(group.items)).toEqual(
      expect.arrayContaining([
        'controls',
        'controls/camera.demo_camera',
        'controls/sensor.outside_temperature',
        'controls/climate.hvac',
      ]),
    );
    expect(group.items.find((i) => i.opts.item === 'camera.demo_camera')?.view).toBe('camera');
  });

  it('shows the favourites as rows that are on or off, with their room, private for the doors and locks', async () => {
    const got = await panelOn(haPage(), 'controls');
    const view = as(got, 'list');
    expect(view.title).toBe('Favourites');
    expect(view.rows.find((r) => r.title === 'Bed Light')).toMatchObject({ state: 'on', meta: 'Bedroom' });
    expect(view.rows.find((r) => r.title === 'AC')).toMatchObject({ state: 'off' });
    expect(view.rows.some((r) => r.meta === 'Other')).toBe(false);
    expect(view.rows.some((r) => r.title === 'Demo camera')).toBe(false);
    expect(view.head).toMatch(/^\d+ on$/);
    expect(got).toMatchObject({ private: true, refreshS: 10 });
  });

  it('counts only lamps and switches as on: an unlocked lock says so in words', async () => {
    const before = as(await panelOn(haPage(), 'controls'), 'list').head;
    const lock = {
      id: 'lock.front',
      label: 'Front door',
      icon: 'lock',
      on: true,
      state: 'Unlocked',
    } as ThingControl;
    const view = as(await panelOn(haPage(lock), 'controls'), 'list');
    expect(view.head).toBe(before);
    expect(view.rows.find((r) => r.title === 'Front door')).toMatchObject({ detail: 'Unlocked' });
    expect(view.rows.find((r) => r.title === 'Front door')?.state).toBeUndefined();
  });

  it('shows a sensor as a figure with its unit', async () => {
    const view = as(await panelOn(haPage(), 'controls', 'sensor.outside_temperature'), 'figures');
    expect(view.items[0]).toMatchObject({ value: '15.6', unit: '°C' });
  });

  it('shows a camera’s latest picture, private, every 10 seconds', async () => {
    const got = await panelOn(haPage(), 'controls', 'camera.demo_camera');
    const view = as(got, 'camera');
    expect(view.title).toBe('Demo camera');
    expect(view.image).toMatchObject({ thing: 'connection:con_homeassistant', shape: 'wide' });
    expect(got).toMatchObject({ private: true, refreshS: 10 });
  });
});

describe('Home Assistant on a locked screen', () => {
  const ctx = {
    buttons: { row: row('homeassistant') },
    cameraImage: () => undefined,
  };
  const control = (id: string, s: string, a: Record<string, unknown> = {}) =>
    controlOf(id, { s, a: { friendly_name: id, ...a } }, '°C', ctx, null);
  const pageWith = (...items: ReturnType<typeof control>[]) =>
    pageOf(
      {
        panels: [
          {
            kind: 'controls',
            id: 'controls',
            title: 'Controls',
            groups: [{ id: 'other', title: 'Other', items }],
          },
        ],
      },
      { catalogId: 'homeassistant', name: 'Home Assistant' },
    );

  it('keeps who is home, presence, motion and lock sensors private; a temperature isn’t', async () => {
    const page = pageWith(
      control('person.anna', 'home'),
      control('device_tracker.annas_phone', 'not_home'),
      control('binary_sensor.hall_motion', 'off', { device_class: 'motion' }),
      control('binary_sensor.office', 'on', { device_class: 'occupancy' }),
      control('binary_sensor.anna_home', 'on', { device_class: 'presence' }),
      control('binary_sensor.front_lock', 'on', { device_class: 'lock' }),
      control('sensor.hall_temperature', '21.5', { unit_of_measurement: '°C' }),
    );
    for (const id of [
      'person.anna',
      'device_tracker.annas_phone',
      'binary_sensor.hall_motion',
      'binary_sensor.office',
      'binary_sensor.anna_home',
      'binary_sensor.front_lock',
    ])
      expect((await panelOn(page, 'controls', id)).private, id).toBe(true);
    expect((await panelOn(page, 'controls', 'sensor.hall_temperature')).private).toBe(false);
    expect((await panelOn(page, 'controls')).private).toBe(true);
    const offered = (await groupOn(page)).items.find((i) => i.opts.item === 'binary_sensor.hall_motion');
    expect(offered?.private).toBe(true);
    const lights = pageWith(control('sensor.hall_temperature', '21.5', { unit_of_measurement: '°C' }));
    expect((await panelOn(lights, 'controls')).private).toBe(false);
  });

  it('keeps a Home widget private when it reads someone’s whereabouts or a lock', () => {
    expect(homeWidgetPrivate('homeassistant', { entity_id: 'person.anna' })).toBe(true);
    expect(homeWidgetPrivate('homeassistant', { entity_ids: ['sensor.power', 'lock.front_door'] })).toBe(
      true,
    );
    expect(homeWidgetPrivate('homeassistant', { entity_id: 'sensor.outside_temperature' })).toBe(false);
    expect(homeWidgetPrivate('todoist', {})).toBe(true);
    expect(homeWidgetPrivate('unifi_network', { entity_id: 'person.anna' })).toBe(false);
  });
});

describe('Pi-hole and AdGuard Home', () => {
  it('keep the top clients off a locked screen: device names say who is home', async () => {
    for (const page of [piholePage(), adguardPage()]) {
      expect((await panelOn(page, 'top-clients')).private).toBe(true);
      expect((await panelOn(page, 'top-blocked')).private).toBe(false);
    }
  });

  it('lead their figures with how much was blocked', async () => {
    for (const page of [piholePage(), adguardPage()]) {
      const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
      expect(as(got.get('w_fig'), 'figures').items[0]?.label).toBe('Blocked');
    }
  });

  it('chart the queries per hour, at most 120 points a line', async () => {
    const view = as(await panelOn(piholePage(), 'queries'), 'chart');
    expect(view.series.map((x) => x.label)).toEqual(['Answered', 'Blocked']);
    for (const x of view.series) expect(x.points.length).toBeLessThanOrEqual(120);
  });

  it('show the top blocked as rows with bars', async () => {
    const view = as(await panelOn(piholePage(), 'top-blocked'), 'list');
    expect(view.rows[0]).toMatchObject({ title: 'doubleclick.net', progress: 100 });
  });
});

describe('Ads kept out today', () => {
  it('is offered by Pi-hole and AdGuard Home: what was blocked since midnight and its share of the lookups', async () => {
    for (const page of [piholePage(), adguardPage()]) {
      expect(ids((await groupOn(page)).items).slice(0, 2)).toEqual(['figures', 'kept-out']);
      const got = await panelOn(page, 'kept-out');
      const view = as(got, 'figures');
      expect(view.title).toBe('Ads kept out today');
      expect(view.items[0]).toMatchObject({ unit: 'blocked', label: 'Kept out today' });
      expect(view.items[0]?.tone).toBeUndefined();
      expect(view.line).toMatch(/^\d+ % of [\d,]+ lookups$/);
      expect(view.spark?.length).toBeGreaterThanOrEqual(2);
      expect(got.private).toBe(false);
    }
    const pi = as(await panelOn(piholePage(), 'kept-out'), 'figures');
    expect(pi.items.map((f) => f.value)).toEqual(['15']);
  });

  it('turns red with the page’s words while blocking is off', async () => {
    const page = piholePage({ on: false, until: new Date('2026-10-21T20:30:00Z') });
    const view = as(await panelOn(page, 'kept-out'), 'figures');
    expect(view.items[0]?.tone).toBe('bad');
    expect(view.line).toContain('22:30');
  });

  it('isn’t offered without lookups by the hour', async () => {
    const page = piholePage();
    const without = {
      ...page,
      tabs: page.tabs.map((t) => ({ ...t, panels: t.panels.filter((p) => p.kind !== 'chart') })),
    };
    expect(ids((await groupOn(without)).items)).not.toContain('kept-out');
  });
});

describe('The doorbell and all cameras', () => {
  it('shows the doorbell first, with when it last rang', async () => {
    const page = protectPage();
    const group = await groupOn(page);
    const doorbell = group.items.find((i) => i.view === 'camera');
    expect(doorbell?.name).toBe('Front Door');
    const view = as(await panelOn(page, 'cameras', doorbell?.opts.item), 'camera');
    expect(view.event).toMatch(/^Rang at \d\d:\d\d$/);
    const other = group.items.filter((i) => i.view === 'camera')[1];
    expect(as(await panelOn(page, 'cameras', other?.opts.item), 'camera').event).toBeUndefined();
  });

  it('offers every camera side by side, private, every 10 seconds; an offline one says so once', async () => {
    const page = protectPage();
    expect((await groupOn(page)).items[1]).toMatchObject({
      name: 'All cameras',
      view: 'posters',
      private: true,
      opts: { panel: 'cameras' },
    });
    const got = await panelOn(page, 'cameras');
    const view = as(got, 'posters');
    expect(view.shape).toBe('wide');
    expect(view.items.map((i) => [i.title, !!i.image])).toEqual([
      ['Front Door', true],
      ['Office Entrance', true],
      ['Server Room', false],
    ]);
    expect(view.items[2]).toMatchObject({ detail: 'Offline' });
    expect(view.items[2]?.time).toBeUndefined();
    expect(got).toMatchObject({ private: true, refreshS: 10 });
  });
});

describe('UniFi Protect', () => {
  it('offers each camera with a picture as a camera widget, and its detections', async () => {
    const group = await groupOn(protectPage());
    const cameras = group.items.filter((i) => i.view === 'camera');
    expect(cameras.map((c) => c.name)).toEqual(['Front Door', 'Office Entrance']);
    expect(ids(group.items)).toContain('detections');
  });

  it('keeps cameras and detections off a locked screen', async () => {
    const page = protectPage();
    const group = await groupOn(page);
    const camera = group.items.find((i) => i.view === 'camera');
    const got = await panelOn(page, 'cameras', camera?.opts.item);
    expect(as(got, 'camera').image?.thing).toBe('connection:con_unifi_protect');
    expect(got).toMatchObject({ private: true, refreshS: 10 });
    expect((await panelOn(page, 'detections')).private).toBe(true);
  });

  it('keeps its figures off a locked screen while they say whether the alarm is on', async () => {
    const page = protectPage();
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items.map((i) => i.label)).toContain('Alarm');
    expect(got.get('w_fig')?.private).toBe(true);
    expect((await groupOn(page)).items[0]).toMatchObject({ type: 'figures', private: true });
  });
});

describe('UniFi Access', () => {
  it('keeps its figures off a locked screen: unlocked doors and openings', async () => {
    const rules = new Map(Object.entries(ACCESS_rules).map(([id, r]) => [id, accessData(r)]));
    const s: AccessSnapshot = {
      readAt: NOW,
      doors: parseDoors(accessData(ACCESS_doors), rules),
      devices: parseAccessDevices(accessData(ACCESS_devices)),
      openings: parseOpenings(accessData(ACCESS_logs)),
      moreOpenings: false,
      openingsTotal: 2,
    };
    const view = accessView(
      s,
      { now: NOW, timeZone: TZ, openSince: new Map() },
      { row: row('unifi_access') },
    );
    const page = pageOf(view, { catalogId: 'unifi_access', name: 'UniFi Access' });
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items.map((i) => i.label)).toContain('Doors');
    expect(got.get('w_fig')?.private).toBe(true);
    expect((await panelOn(page, 'doors')).private).toBe(true);
    expect((await panelOn(page, 'today')).private).toBe(true);
  });
});

describe('UniFi Network', () => {
  it('leads its figures with the internet, and charts it', async () => {
    const page = unifiPage();
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items[0]).toMatchObject({
      label: 'Internet',
      value: '312 / 40 Mb/s',
    });
    const chart = as(await panelOn(page, 'internet'), 'chart');
    expect(chart).toMatchObject({ title: 'Internet', unit: 'Mb/s' });
    expect(chart.figure?.value).toBeTruthy();
    expect((await groupOn(page)).items[1]?.opts.panel).toBe('internet');
  });

  it('shows its devices with their state first', async () => {
    const view = as(await panelOn(unifiPage(), 'devices'), 'list');
    expect(view.rows.find((r) => r.title === 'Garden AP')).toMatchObject({
      tone: 'bad',
      detail: 'Offline · U6-Mesh',
    });
  });
});

/** Home Assistant's page with the house's panels after its favourites. */
function haHousePage() {
  const base = haPage();
  const read = {
    readAt: NOW,
    house: parseHouse([HA_houseEvent]),
    layout: parseLayout(HA_houseRegistry, HA_houseDevices, HA_houseAreas, '°C'),
    weather: null as ReturnType<typeof pickWeather>,
    days: null as ReturnType<typeof daysOf> | null,
    energy: null as ReturnType<typeof energyOf> | null,
    runs: null,
  };
  read.weather = pickWeather(read.house?.weather ?? []);
  read.days = daysOf(HA_forecastDaily.response, 'weather.forecast_home', TZ);
  const ids = energyIds(HA_energyPrefsLegacy);
  if (ids) read.energy = energyOf(ids, HA_energyStats, new Date('2026-10-20T22:00:00Z'), NOW);
  const house = housePanels(read, NOW, TZ);
  const [summary, ...tabs] = base.tabs;
  if (!summary) throw new Error('no summary');
  return { ...base, tabs: [{ ...summary, panels: [...summary.panels, ...house] }, ...tabs] };
}

describe('Home Assistant’s house', () => {
  it('offers Home now first, private, then the favourites, Weather, Rooms and Energy today', async () => {
    const group = await groupOn(haHousePage());
    const panels = group.items.filter((i) => i.type === 'panel' && !i.opts.item);
    expect(panels.slice(0, 5).map((i) => [i.opts.panel, i.view])).toEqual([
      ['home-now', 'list'],
      ['controls', 'list'],
      ['weather', 'figures'],
      ['rooms', 'list'],
      ['energy', 'chart'],
    ]);
    expect(panels.slice(0, 5).map((i) => i.name)).toEqual([
      'Home now',
      'Favourites',
      'Weather',
      'Rooms',
      'Energy today',
    ]);
    expect(panels[0]?.private).toBe(true);
    expect(panels.slice(2, 5).some((i) => i.private)).toBe(false);
  });

  it('shows Home now as rows under its line, off a locked screen, every 10 seconds', async () => {
    const got = await panelOn(haHousePage(), 'home-now');
    const view = as(got, 'list');
    expect(view.head).toBe('Back door open since 14:02');
    expect(view.rows[0]).toMatchObject({ title: 'Back door', meta: 'Open since 14:02', tone: 'warn' });
    expect(got).toMatchObject({ private: true, refreshS: 10 });
  });

  it('shows the weather as figures: now, then the days', async () => {
    const view = as(await panelOn(haHousePage(), 'weather'), 'figures');
    expect(view.title).toBe('Weather');
    expect(view.items.map((f) => f.value)).toEqual(['14', '16°/8°', '12°/6°', '13°/−1°']);
    expect(view.items[0]).toMatchObject({ unit: '°C', label: 'Partly cloudy' });
    expect(view.line).toContain('Partly cloudy');
  });

  it('shows the rooms with the inside and outside temperature as their line', async () => {
    const view = as(await panelOn(haHousePage(), 'rooms'), 'list');
    expect(view.head).toBe('Inside 18 °C · outside 14 °C');
    expect(view.rows[0]).toMatchObject({ title: 'Living room', meta: '21.6 °C · 48 %' });
  });

  it('draws today’s energy as lines with the day’s totals', async () => {
    const view = as(await panelOn(haHousePage(), 'energy'), 'chart');
    expect(view.figure).toMatchObject({ value: '10', rest: 'kWh used today' });
    expect(view.series.map((s) => s.label)).toEqual(['Used', 'From the sun', 'Back to the grid']);
    expect(view.unit).toBe('kWh');
    expect(view.foot?.map((f) => f.label)).toContain('From the sun');
  });
});

/** Home Assistant's page as the kind builds it in slots, with the house's parts and their forecast. */
function haSlotsPage() {
  const controls = haPage().tabs[0]?.panels.find((p) => p.kind === 'controls');
  if (controls?.kind !== 'controls') throw new Error('no controls');
  const house = {
    readAt: NOW,
    house: parseHouse([HA_houseEvent]),
    layout: parseLayout(HA_houseRegistry, HA_houseDevices, HA_houseAreas, '°C'),
    weather: null as ReturnType<typeof pickWeather>,
    days: daysOf(HA_forecastDaily.response, 'weather.forecast_home', TZ),
    energy: null,
    runs: runsOf(HA_logbook),
  };
  house.weather = pickWeather(house.house?.weather ?? []);
  const view = haView(
    emptySnapshot(NOW),
    null,
    { now: NOW, timeZone: TZ, openUrl: 'http://10.100.0.5:8123', range: '24h', points: NO_POINTS },
    {
      controls,
      house,
      camera: (id, alt) => ({ ref: pictureRef(`api/camera_proxy/${id}`, true), alt, shape: 'wide' }),
    },
  );
  return pageOf(view, { catalogId: 'homeassistant', name: 'Home Assistant' });
}

describe('Home Assistant in slots', () => {
  it('keeps its widgets: Home now, Favourites, Weather as figures, Rooms; who’s home and the cameras private', async () => {
    const page = haSlotsPage();
    const group = await groupOn(page);
    const panels = group.items.filter((i) => i.type === 'panel' && !i.opts.item);
    const offered = new Map(panels.map((i) => [i.opts.panel, i]));
    expect(offered.get('home-now')).toMatchObject({ view: 'list', private: true });
    expect(offered.get('controls')).toMatchObject({ view: 'list' });
    expect(offered.get('weather')).toMatchObject({ view: 'figures', name: 'Weather' });
    expect(offered.get('people')).toMatchObject({ name: 'Who’s home', private: true });
    expect(offered.get('cameras')).toMatchObject({ private: true });
    // The page's own Weather list is the Weather widget, not a second one.
    expect(offered.has('forecast')).toBe(false);
    const weather = as(await panelOn(page, 'weather'), 'figures');
    expect(weather.items.map((f) => f.value)).toEqual(['14', '16°/8°', '12°/6°', '13°/−1°']);
    expect(weather.items[0]).toMatchObject({ unit: '°C', label: 'Partly cloudy' });
    // Its figures: what it has (the house's counts).
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items.map((f) => f.label)).toEqual([
      'Areas',
      'Devices',
      'Automations',
    ]);
  });
});

/** UniFi Access's page from its recorded answers, with today's openings (who came in by which door and how). */
function accessPage(): ThingPage {
  const rules = new Map(Object.entries(ACCESS_rules).map(([id, r]) => [id, accessData(r)]));
  const s: AccessSnapshot = {
    readAt: NOW,
    doors: parseDoors(accessData(ACCESS_doors), rules).map((d, i) => (i < 2 ? { ...d, locked: false } : d)),
    devices: parseAccessDevices(accessData(ACCESS_devices)),
    openings: parseOpenings(accessData(ACCESS_logs)),
    moreOpenings: false,
    openingsTotal: 2,
  };
  const view = accessView(s, { now: NOW, timeZone: TZ, openSince: new Map() }, { row: row('unifi_access') });
  return pageOf(view, { catalogId: 'unifi_access', name: 'UniFi Access' });
}

/** Every widget *Add a widget* offers for a page, placed on one screen and drawn locked in `locale`. */
async function lockedScreen(page: ThingPage, locale: string) {
  const group = await groupOn(page);
  const specs: DeskWidgetSpec[] = group.items.map((item, i) => ({
    id: `w_${i}`,
    type: item.type,
    ref: page.id as DeskWidgetRef,
    opts: item.opts,
  }));
  const resolved = await viewsOn(page, specs);
  return { specs, resolved, views: screenViews(specs, resolved, 'summary', undefined, locale) };
}

describe('a locked screen, in English and in Dutch', () => {
  const pages = (page: ThingPage) => [
    { how: 'English page', page },
    // A page already said in Dutch must be kept off the same way: privacy never reads its words.
    { how: 'Dutch page', page: localizeTree(page, 'nl-NL') },
  ];

  it('shows nobody who came in, no unlocked doors and no way in from UniFi Access', async () => {
    const page = accessPage();
    // The page itself does say them: the lock is what keeps them off.
    expect(JSON.stringify(page)).toContain('Anna de Vries');
    expect(JSON.stringify(page)).toContain('kept unlocked');
    for (const { how, page: shown } of pages(page))
      for (const locale of ['en-GB', 'nl-NL']) {
        const { views, resolved, specs } = await lockedScreen(shown, locale);
        expect(views.length, `${how} ${locale}`).toBe(resolved.size);
        const said = JSON.stringify(views);
        expect(said, `${how} ${locale}`).not.toMatch(/Anna|de Vries/);
        expect(said, `${how} ${locale}`).not.toMatch(/kept unlocked|unlocked|ontgrendeld|niet op slot/i);
        expect(said, `${how} ${locale}`).not.toMatch(/\b(card|PIN|phone wallet|remotely|kaart|pincode)\b/);
        expect(said, `${how} ${locale}`).not.toMatch(/Main Door|A2 Door|Door 3855/);
        // Every widget that shows a person or a door is locked, whatever words it has.
        for (const panel of ['people', 'inventory', 'doors', 'today']) {
          const spec = specs.find((x) => x.opts?.panel === panel && !x.opts.item);
          expect(spec && resolved.get(spec.id)?.private, `${panel} ${how} ${locale}`).toBe(true);
        }
      }
  });

  it('shows nobody’s whereabouts, no lock and no camera from Home Assistant', async () => {
    const page = haHousePage();
    expect(JSON.stringify(page)).toMatch(/Anna/);
    for (const { how, page: shown } of pages(page))
      for (const locale of ['en-GB', 'nl-NL']) {
        const { views } = await lockedScreen(shown, locale);
        const said = JSON.stringify(views);
        expect(said, `${how} ${locale}`).not.toMatch(/Anna|\bSam\b|\bWork\b/);
        expect(said, `${how} ${locale}`).not.toMatch(/\b(Locked|Unlocked|Op slot|Niet op slot)\b/);
        expect(viewPictures(views).size, `${how} ${locale}`).toBe(0);
      }
  });
});
