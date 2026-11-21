/**
 * Boards and photos from pages (docs/decisions/desk-display.md DK-160, DK-162): the generic mapping (tiles named and
 * coloured by their rows, words only where a tile isn't fine, the worst first, how many past 48; one big picture at a
 * time, made large by the runtime), then the kinds that offer them, from their recorded answers through the widgets'
 * runtime: Portainer's containers, ESPHome's and UniFi's devices, GitHub Actions' repositories, Immich's photos.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESK_VIEW_TILES_MAX, type ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { actionsSnapshot, actionsView, repoOf } from '../../things/kinds/business/github-actions';
import { esphomeView, parseDevices } from '../../things/kinds/home/esphome';
import { ESPHOME_devices } from '../../things/kinds/home/fixtures/esphome';
import {
  PORTAINER_CONTAINERS,
  PORTAINER_ENDPOINTS,
  PORTAINER_STACKS,
} from '../../things/kinds/infra/fixtures/portainer';
import {
  parseContainers,
  parseEnvs,
  parseStacks,
  portainerView,
  SUMMARY_CONTAINERS,
} from '../../things/kinds/infra/portainer';
import {
  type ImmichSnapshot,
  immichView,
  parseFavourites,
  parseMemories,
} from '../../things/kinds/storage/immich';
import { fakePicture, fixture } from '../../things/kinds/storage/test-helpers';
import { type UnifiSnapshot, unifiDevice, unifiDeviceRows } from '../../things/kinds/unifi';
import { as, ctxAt, groupOn, NOW, pageOf, panelOn, pictureRef, TZ, widgetsOver } from './thing-testing';
import { boardView, photoView } from './thing-views';

const b = { id: 'w_1', title: 'Board' };

describe('a board from a panel', () => {
  const table = (n: number): Extract<ThingPagePanel, { kind: 'table' }> => ({
    kind: 'table',
    id: 'things',
    title: 'Things',
    meta: `${n} things`,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'state', label: 'State' },
      { key: 'go', label: '' },
    ],
    rows: Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      cells: {
        name: { text: `thing-${i}` },
        state:
          i === 7
            ? { text: 'Down', dot: 'bad' as const }
            : i === 3
              ? { text: 'Down for a very long while now', dot: 'warn' as const }
              : { text: 'Up', dot: 'ok' as const },
        go: { text: 'Restart', action: { kind: 'act', action: 'x', label: 'Restart' } as never },
      },
    })),
  });

  it('names a tile by its first words, colours it by its row, says words only where it isn’t fine', () => {
    const v = boardView(b, table(10), { panel: 'things', board: { value: 'state' } });
    if (v.kind !== 'board') throw new Error(v.kind);
    expect(v.head).toBe('10 things');
    expect(v.items[0]).toEqual({ label: 'thing-0', tone: 'ok' });
    expect(v.items[7]).toEqual({ label: 'thing-7', tone: 'bad', value: 'Down' });
    // Too long to carry whole: left out rather than cut.
    expect(v.items[3]).toEqual({ label: 'thing-3', tone: 'warn' });
    expect(v.count).toBeUndefined();
  });

  it('puts the worst first where asked, and says how many past 48', () => {
    const v = boardView(b, table(60), {
      panel: 'things',
      board: { value: 'state', worstFirst: true, values: 'all' },
    });
    if (v.kind !== 'board') throw new Error(v.kind);
    expect(v.items).toHaveLength(DESK_VIEW_TILES_MAX);
    expect(v.items.slice(0, 3).map((t) => [t.label, t.tone])).toEqual([
      ['thing-7', 'bad'],
      ['thing-3', 'warn'],
      ['thing-0', 'ok'],
    ]);
    expect(v.items[2]?.value).toBe('Up');
    expect(v.count).toBe(60);
  });

  it('makes tiles of a list and a bar list too, grey where they have no colour', () => {
    const v = boardView(b, {
      kind: 'list',
      id: 'l',
      title: 'L',
      items: [
        { id: 'a', title: 'web', tone: 'bad', right: '2 failing' },
        { id: 'b', title: 'api', right: 'No result' },
      ],
    });
    if (v.kind !== 'board') throw new Error(v.kind);
    expect(v.items).toEqual([
      { label: 'web', tone: 'bad', value: '2 failing' },
      { label: 'api', tone: 'off', value: 'No result' },
    ]);
  });
});

describe('a photo from a gallery', () => {
  const gallery = (n: number): Extract<ThingPagePanel, { kind: 'gallery' }> => ({
    kind: 'gallery',
    id: 'g',
    shape: 'square',
    title: 'G',
    items: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      title: `Photo ${i}`,
      sub: '2023',
      ...(i === 1 ? {} : { image: { ref: pictureRef(`p${i}`), alt: `p${i}`, shape: 'square' as const } }),
    })),
    empty: 'No photos.',
  });

  it('shows the pictures with their words under them, a dozen at most, every so often as asked', () => {
    const v = photoView(b, 'connection:con_x', gallery(20), { panel: 'g', every: 10 });
    if (v.kind !== 'photo') throw new Error(v.kind);
    expect(v.items).toHaveLength(12);
    expect(v.items[0]).toMatchObject({
      caption: 'Photo 0',
      time: '2023',
      image: { thing: 'connection:con_x' },
    });
    // The one without a picture is left out.
    expect(v.items[1]?.caption).toBe('Photo 2');
    expect(v.every).toBe(30);
    expect(v.empty).toBe('No photos.');
  });
});

/* The kinds ---------------------------------------------------------------------------------------------------------- */

function portainerPage(extra = 0) {
  const many = Array.from({ length: extra }, (_, i) => ({
    ...(PORTAINER_CONTAINERS[1] as object),
    Id: `c0ffee${String(i).padStart(4, '0')}`,
    Names: [`/app-${String(i).padStart(2, '0')}`],
  }));
  const snapshot = {
    readAt: NOW,
    version: '2.45.2',
    update: null,
    envs: parseEnvs(PORTAINER_ENDPOINTS),
    containers: parseContainers([...PORTAINER_CONTAINERS, ...many], 3),
    stacks: parseStacks(PORTAINER_STACKS),
    imageStatus: false,
  };
  const row = { id: 'con_portainer', access: 'manage', fields: {} } as never;
  return pageOf(portainerView({ snapshot, url: 'https://portainer.lan', row }), {
    catalogId: 'portainer',
    name: 'Portainer',
  });
}

describe('Portainer: all containers', () => {
  it('offers every container as a board, the worst first, from the whole list past the Summary’s', async () => {
    const page = portainerPage(SUMMARY_CONTAINERS + 5);
    const group = await groupOn(page);
    expect(group.items.find((i) => i.opts.panel === 'all-containers')).toMatchObject({
      name: 'All containers',
      view: 'board',
    });
    expect(group.items.find((i) => i.opts.panel === 'all-containers')?.private).toBeUndefined();
    const got = await panelOn(page, 'all-containers');
    const v = as(got, 'board');
    const all = PORTAINER_CONTAINERS.length + SUMMARY_CONTAINERS + 5;
    expect(v.items).toHaveLength(all);
    expect(v.head).toBe(`${all} containers`);
    expect(v.items[0]).toEqual({ label: 'grafana', tone: 'bad', value: 'Unhealthy' });
    expect(v.items.at(-1)?.tone).toBe('ok');
    expect(v.items.filter((t) => t.tone === 'ok').every((t) => !t.value)).toBe(true);
  });
});

describe('ESPHome: all devices', () => {
  it('shows each device: offline amber or red with its words, an older one “Update”', async () => {
    const [garden, kitchen] = ESPHOME_devices.configured as Record<string, unknown>[];
    const devices = parseDevices({
      configured: [
        {
          ...garden,
          runtime_state: { state: 'offline', offline_seconds: 1800, deployed_version: '2026.9.2' },
        },
        { ...kitchen, runtime_state: { state: 'online', deployed_version: '2026.10.0' } },
        {
          ...kitchen,
          configuration: 'porch.yaml',
          friendly_name: 'Porch',
          runtime_state: { state: 'online', deployed_version: '2026.9.2' },
          update_available: true,
        },
      ],
    });
    const s = { readAt: NOW, version: '2026.10.0', devices, jobs: [] };
    const page = pageOf(
      { ...esphomeView(s, { now: NOW, timeZone: TZ, buttons: { row: { access: 'read' } as never } }) },
      { catalogId: 'esphome', name: 'ESPHome' },
    );
    expect((await groupOn(page)).items[1]).toMatchObject({ opts: { panel: 'all-devices' }, view: 'board' });
    const v = as(await panelOn(page, 'all-devices'), 'board');
    expect(v.items.map((t) => [t.tone, t.value ?? null])).toEqual([
      ['warn', 'Offline'],
      ['warn', 'Update'],
      ['ok', null],
    ]);
    expect(v.items[1]?.label).toBe('Porch');
  });
});

describe('UniFi Network: all devices', () => {
  it('shows each access point and switch, offline red, a firmware update amber', async () => {
    const raw = [
      { id: 'gw', name: 'Gateway', model: 'UCG-Ultra', state: 'ONLINE', features: ['switching'] },
      { id: 'ap1', name: 'Kitchen AP', model: 'U7-Pro', state: 'ONLINE', features: ['accessPoint'] },
      { id: 'ap2', name: 'Garden AP', model: 'U6-Mesh', state: 'OFFLINE', features: ['accessPoint'] },
    ];
    const details: Record<string, unknown> = {
      gw: { firmwareVersion: '4.1.13', firmwareUpdatable: false },
      ap1: { firmwareVersion: '7.0.66', firmwareUpdatable: true },
      ap2: { firmwareVersion: '6.6.77', firmwareUpdatable: false },
    };
    const s = { devices: raw.map((d) => unifiDevice(d, details[d.id])) } as UnifiSnapshot;
    const devices: ThingPagePanel = {
      kind: 'table',
      id: 'devices',
      title: 'Devices',
      meta: '1 offline',
      columns: ['name', 'model', 'state', 'address', 'firmware'].map((key) => ({ key, label: key })),
      rows: unifiDeviceRows(s),
    };
    const page = pageOf({ panels: [devices] }, { catalogId: 'unifi_network', name: 'UniFi' });
    const v = as(await panelOn(page, 'all-devices'), 'board');
    expect(v.head).toBe('1 offline');
    expect(v.items.map((t) => [t.label, t.tone, t.value ?? null])).toEqual([
      ['Garden AP', 'bad', 'Offline'],
      ['Kitchen AP', 'warn', 'Update'],
      ['Gateway', 'ok', null],
    ]);
  });
});

const actionsFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../things/kinds/business/fixtures/github_actions', name),
      'utf8',
    ),
  );

/** acme/web (main failing) and acme/api (its main runs all passing). */
function actionsPage(repos: 1 | 2) {
  const web = repoOf(actionsFixture('repo.json'));
  const api = repoOf({
    ...(actionsFixture('repo.json') as object),
    full_name: 'acme/api',
    name: 'api',
    id: 77,
  });
  if (!web || !api) throw new Error('no repo');
  const main = actionsFixture('main.json') as { workflow_runs: Record<string, unknown>[] };
  const passing = {
    ...main,
    workflow_runs: main.workflow_runs.map((r) => ({ ...r, conclusion: 'success' })),
  };
  const both = repos === 2;
  const snapshot = actionsSnapshot(
    {
      repos: both ? [web, api] : [web],
      unseen: [],
      runs: new Map<string, unknown>([
        [web.fullName, actionsFixture('runs.json')],
        [api.fullName, { total_count: 0, workflow_runs: [] }],
      ]),
      main: new Map<string, unknown>([
        [web.fullName, main],
        [api.fullName, passing],
      ]),
      workflows: new Map<string, unknown>([
        [web.fullName, actionsFixture('workflows.json')],
        [api.fullName, actionsFixture('workflows.json')],
      ]),
      jobs: new Map(),
      runners: [],
    },
    NOW,
  );
  return pageOf(actionsView({ snapshot, now: NOW, timeZone: TZ }), {
    catalogId: 'github_actions',
    name: 'GitHub Actions',
  });
}

describe('GitHub Actions: every repository', () => {
  it('shows each repository’s default branch, the failing one first with how many fail', async () => {
    const page = actionsPage(2);
    const v = as(await panelOn(page, 'repositories'), 'board');
    expect(v.head).toBe('1 of 2 failing');
    expect(v.items).toEqual([
      { label: 'web', tone: 'bad', value: '1 failing' },
      { label: 'api', tone: 'ok' },
    ]);
    expect((await groupOn(page)).items.find((i) => i.opts.panel === 'repositories')?.view).toBe('board');
  });

  it('isn’t offered for one repository: its last runs say it all', async () => {
    const group = await groupOn(actionsPage(1));
    expect(group.items.map((i) => i.opts.panel)).not.toContain('repositories');
  });
});

describe('Immich: photos', () => {
  const snapshot: ImmichSnapshot = {
    readAt: NOW,
    version: null,
    latest: null,
    counts: null,
    disk: null,
    people: [],
    queues: null,
    queueApi: null,
    integrity: null,
    recent: null,
  };
  const page = pageOf(
    immichView({
      snapshot,
      now: NOW,
      timeZone: TZ,
      url: 'http://immich.lan',
      buttons: { row: { access: 'read' } as never },
      picture: fakePicture,
      memories: parseMemories(fixture('immich-memories.json')),
      favourites: parseFavourites(fixture('immich-search-random.json')),
    }),
    { catalogId: 'immich', name: 'Photos' },
  );

  it('offers this day’s photos and the favourites as photo frames, private, beside the posters', async () => {
    const items = (await groupOn(page)).items;
    expect(items.map((i) => [i.opts.panel ?? i.type, i.view])).toEqual(
      expect.arrayContaining([
        ['memories', 'posters'],
        ['memories-photo', 'photo'],
        ['favourites-photo', 'photo'],
      ]),
    );
    expect(items.filter((i) => i.view === 'photo').every((i) => i.private)).toBe(true);
  });

  it('draws them big: the runtime’s large pictures, “3 years ago · Texel” under one, slowly', async () => {
    const { widgets } = widgetsOver(new Map([[page.id, page]]), { largeImage: (ref) => `L${ref}` });
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_day', type: 'panel', ref: 'connection:con_immich', opts: { panel: 'memories-photo' } },
      { id: 'w_fav', type: 'panel', ref: 'connection:con_immich', opts: { panel: 'favourites-photo' } },
    ]);
    const day = as(got.get('w_day'), 'photo');
    expect(day.title).toBe('A photo from this day');
    expect(day.items[0]).toMatchObject({ caption: '3 years ago · Texel', time: '2023' });
    expect(day.items.every((i) => i.image.ref.startsWith('L'))).toBe(true);
    expect(got.get('w_day')).toMatchObject({ private: true, refreshS: 1800 });
    const fav = as(got.get('w_fav'), 'photo');
    expect(fav.items.map((i) => [i.caption, i.time ?? null])).toEqual([
      ['Texel', 'June 2019'],
      ['December 2024', null],
    ]);
  });

  it('leaves out a picture that can’t be made large', async () => {
    const { widgets } = widgetsOver(new Map([[page.id, page]]), { largeImage: () => '' });
    const got = await widgets.resolve(ctxAt(), [
      { id: 'w_fav', type: 'panel', ref: 'connection:con_immich', opts: { panel: 'favourites-photo' } },
    ]);
    expect(as(got.get('w_fav'), 'photo').items).toEqual([]);
  });
});
