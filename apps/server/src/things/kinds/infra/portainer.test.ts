/** Portainer's page from real answers of Portainer CE 2.45.2 (service-dashboards.md SD-44). Pure. */
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import {
  PORTAINER_CONTAINERS,
  PORTAINER_ENDPOINT_COUNTED,
  PORTAINER_ENDPOINTS,
  PORTAINER_ENDPOINTS_DOWN,
  PORTAINER_STACKS,
  PORTAINER_STATUS,
  PORTAINER_VERSION,
} from './fixtures/portainer';
import { buttonsOf } from './fixtures/row';
import {
  containerRows,
  healthOf,
  imageStatusOf,
  PORTAINER_CHECKS,
  type PortainerSnapshot,
  parseContainers,
  parseEnvs,
  parseStacks,
  portainerKpis,
  portainerNotices,
  portainerSkipped,
  portainerStatus,
  portainerView,
  restartButton,
  stacksOf,
} from './portainer';

const NOW = new Date('2026-10-21T19:45:00Z');
const URL = 'https://portainer.home.example:9443';

function snapshot(envs: unknown = PORTAINER_ENDPOINTS): PortainerSnapshot {
  return {
    readAt: NOW,
    version: PORTAINER_STATUS.Version,
    update: PORTAINER_VERSION.UpdateAvailable ? PORTAINER_VERSION.LatestVersion : null,
    envs: parseEnvs(envs),
    containers: parseContainers(PORTAINER_CONTAINERS, 3),
    stacks: parseStacks(PORTAINER_STACKS),
    imageStatus: false,
    edition: PORTAINER_VERSION.ServerEdition,
    support: PORTAINER_VERSION.VersionSupport,
  };
}

describe('portainer reading', () => {
  it('reads environments: an Edge agent that never checked in waits, a Docker one is up or down', () => {
    expect(parseEnvs(PORTAINER_ENDPOINTS).map((e) => [e.id, e.type, e.docker, e.up, e.waiting])).toEqual([
      [2, 'Edge agent', false, false, true],
      [3, 'Docker', true, true, false],
    ]);
    expect(parseEnvs(PORTAINER_ENDPOINTS)[1]?.counts).toEqual({
      running: 3,
      stopped: 1,
      healthy: 0,
      unhealthy: 0,
      total: 5,
    });
    expect(parseEnvs(PORTAINER_ENDPOINTS_DOWN)[1]?.up).toBe(false);
  });

  it('reads containers with their health, state and Compose project', () => {
    const cs = parseContainers(PORTAINER_CONTAINERS, 3);
    expect(cs.map((c) => [c.name, c.state, c.health, c.project])).toEqual([
      ['portainer', 'running', null, null],
      ['nextcloud-app', 'running', null, 'nextcloud'],
      ['grafana', 'running', 'unhealthy', 'monitoring'],
      ['portainer-old', 'created', null, null],
      ['nextcloud-db', 'exited', null, 'nextcloud'],
    ]);
    expect(healthOf({ Status: 'Up 3 hours (healthy)' })).toBe('healthy');
    expect(healthOf({ Status: 'Up 5 seconds (health: starting)' })).toBe('starting');
    expect(imageStatusOf({ Status: 'outdated', Message: '' })).toBe('outdated');
    expect(imageStatusOf('404 page not found')).toBeNull();
  });

  it('finds stacks Portainer didn’t make from their Compose labels', () => {
    const stacks = stacksOf(snapshot());
    expect(stacks.map((s) => [s.name, s.id, s.containers.length])).toEqual([
      ['nextcloud', null, 2],
      ['monitoring', null, 1],
    ]);
  });
});

describe('portainer page', () => {
  it('has figures without the image one in Community Edition', () => {
    const kpis = portainerKpis(snapshot());
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value, k.tone ?? null])).toEqual([
      ['running', '3', null],
      ['stopped', '1', 'warn'],
      ['unhealthy', '1', 'bad'],
    ]);
    const withImages = { ...snapshot(), imageStatus: true };
    expect(portainerKpis(withImages).map((k) => k.key)).toContain('images');
  });

  it('says what is worth a look', () => {
    const notices = portainerNotices(snapshot(), URL);
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.id.replace(/-[0-9a-f]{12}$/, ''), n.tone])).toEqual([
      ['unhealthy-3', 'bad'],
      ['stopped-3', 'warn'],
    ]);
    expect(notices[1]?.detail).toContain('code 1');
    // Keyed by environment and name: Docker's id changes when a container is made again (QN-S3x).
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id])).toEqual([
      ['portainer.unhealthy', 'problem', `container:3/${notices[0]?.title.split(' ')[0]}`],
      ['portainer.stopped', 'problem', `container:3/${notices[1]?.title.split(' ')[0]}`],
    ]);
    for (const n of notices) expect(PORTAINER_CHECKS.map((c) => c.check)).toContain(n.check);
    // The lines decide warn and bad (QN-S30).
    expect(portainerStatus(snapshot())).toEqual({ status: 'ok', badge: '3 running' });
    const down = snapshot(PORTAINER_ENDPOINTS_DOWN);
    expect(portainerNotices(down, URL)[0]).toMatchObject({
      id: 'env-down-3',
      tone: 'bad',
      check: 'portainer.env_down',
      subject: { id: 'env:3' },
      badge: 'office-docker is down',
    });
  });

  it('makes a container that finished or was stopped a heads-up', () => {
    const s = snapshot();
    const exited = s.containers?.find((c) => c.state === 'exited');
    if (!exited) throw new Error('container');
    for (const code of ['0', '137', '143']) {
      exited.status = `Exited (${code}) 2 minutes ago`;
      const line = portainerNotices(s, URL).find((n) => n.check === 'portainer.stopped');
      expect(line).toMatchObject({ nature: 'fyi', tone: 'info' });
      expect(line?.link).toBeUndefined();
    }
    exited.status = 'Exited (2) 2 minutes ago';
    expect(portainerNotices(s, URL).find((n) => n.check === 'portainer.stopped')).toMatchObject({
      nature: 'problem',
      link: { kind: 'ask' },
    });
  });

  it('counts unhealthy containers of an environment it didn’t list, and says what it couldn’t read', () => {
    const s = snapshot();
    expect(portainerSkipped(s)).toEqual([]);
    const edge = s.envs[0];
    if (!edge) throw new Error('env');
    Object.assign(edge, {
      up: true,
      waiting: false,
      counts: { running: 2, stopped: 0, healthy: 0, unhealthy: 2, total: 2 },
    });
    expect(portainerNotices(s, URL).find((n) => n.id === `unhealthy-env-${edge.id}`)).toMatchObject({
      check: 'portainer.unhealthy',
      subject: { id: `env:${edge.id}` },
      band: 2,
      title: expect.stringContaining('2 containers'),
    });
    // An Edge agent is never listed: its containers don't make the check unread.
    expect(portainerSkipped(s)).toEqual([]);
    expect(portainerSkipped({ ...s, listed: [] })).toEqual([
      'portainer.unhealthy',
      'portainer.stopped',
      'portainer.images',
    ]);
    expect(portainerSkipped({ ...s, containers: null, imagesPartial: true, versionUnread: true })).toEqual([
      'portainer.unhealthy',
      'portainer.stopped',
      'portainer.images',
      'portainer.images',
      'portainer.updates',
    ]);
  });

  it('lists problems first, each with Restart✱', () => {
    const ctx = buttonsOf('portainer');
    const rows = containerRows(snapshot(), ctx);
    expect(rows.map((r) => r.cells.name?.text)).toEqual([
      'grafana',
      'nextcloud-db',
      'nextcloud-app',
      'portainer',
      'portainer-old',
    ]);
    expect(rows[1]?.cells.state?.text).toBe('Stopped with an error');
    expect(rows[0]?.cells.restart?.action).toMatchObject({ action: 'restart', allowed: true });
    const c = snapshot().containers?.[0];
    if (!c) throw new Error('container');
    expect(restartButton(ctx, c).target).toBe(`3:${c.id}`);
  });

  it('is in slots: its stacks now beside what it holds, the containers below', () => {
    const view = portainerView({ snapshot: snapshot(), url: URL, ...buttonsOf('portainer') });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    // One environment is listed beside the Edge agent: two, so the list stays.
    expect(view.panels.map((p) => p.id)).toEqual(['stacks', 'inventory', 'containers', 'environments']);
    expect(view.notices[0]?.action).toMatchObject({ action: 'restart', allowed: true });
    const live = view.panels[0];
    if (live?.kind !== 'gallery') throw new Error('live');
    // The unhealthy stack first, then the one with a stopped container, then what is in no stack.
    expect(live.items.map((i) => [i.title, i.note ?? null, i.badge?.text ?? null])).toEqual([
      ['monitoring', '1 of 1 running', 'Unhealthy'],
      ['nextcloud', '1 of 2 running', '1 stopped'],
      ['Other containers', '1 of 2 running', null],
    ]);
    expect(live.items[0]?.sub).toBe('office-docker · 1 container');
    expect(live.meta).toBe('2 stacks · 3 of 5 containers run');
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('inventory');
    // The recorded environment's snapshot counts no images or volumes yet; the Edge agent never checked in.
    expect(inv.items.map((i) => [i.id, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['containers', '5', '1 unhealthy'],
      ['images', '0', null],
      ['volumes', '0', null],
      ['environments', '2', '1 not checked in yet'],
    ]);
    expect(view.slots?.machine).toEqual([
      {
        id: 'portainer-version',
        label: 'Portainer',
        note: 'CE · LTS',
        value: '2.45.2',
        pct: null,
        sub: 'Up to date',
        subTone: 'ok',
      },
      { id: 'docker-version', label: 'Docker', value: '28.5.2', pct: null },
    ]);
    // Beside stacks the Summary keeps the containers' table (the desk's board reads it); 5 need no tab.
    expect(view.tabs).toEqual([]);
  });

  it('counts images and volumes from the snapshots, says an update is out', () => {
    const s = { ...snapshot([PORTAINER_ENDPOINT_COUNTED]), update: '2.46.0' };
    expect(s.envs[0]).toMatchObject({ images: 94, volumes: 113, dockerVersion: '29.9.2' });
    const view = portainerView({ snapshot: s, url: URL, ...buttonsOf('portainer') });
    const inv = view.panels.find((p) => p.id === 'inventory');
    expect(inv?.kind === 'list' && inv.items.map((i) => [i.id, i.figure?.value])).toEqual([
      ['containers', '5'],
      ['images', '94'],
      ['volumes', '113'],
      ['environments', '1'],
    ]);
    expect(view.slots?.machine[0]?.sub).toBe('Version 2.46.0 is out');
    // One environment: no list of them.
    expect(view.panels.map((p) => p.id)).not.toContain('environments');
    // The card keeps its figures.
    expect(portainerKpis(s).map((k) => k.key)).toEqual(['running', 'stopped', 'unhealthy']);
  });

  it('lists the containers in Live without stacks, each with Restart, and every container in its tab', () => {
    const loose = parseContainers(PORTAINER_CONTAINERS, 3).map((c) => ({ ...c, project: null }));
    const s = { ...snapshot(), containers: loose };
    const view = portainerView({ snapshot: s, url: URL, ...buttonsOf('portainer') });
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['now', 'inventory', 'environments']);
    const live = view.panels[0];
    if (live?.kind !== 'gallery') throw new Error('live');
    expect(live.items.map((i) => [i.title, i.badge?.text ?? null, i.noteEnd ?? null])).toEqual([
      ['grafana', 'Unhealthy', 'Up 2 hours'],
      ['nextcloud-db', 'Stopped with an error', 'Exited (1) 2 minutes ago'],
      ['nextcloud-app', null, 'Up 2 minutes'],
      ['portainer', null, 'Up 2 minutes'],
      ['portainer-old', 'Created', 'Created'],
    ]);
    expect(live.items[0]?.actions?.[0]).toMatchObject({ action: 'restart' });
    // The desk's board reads the whole table in the tab.
    expect(view.tabs.map((t) => [t.key, t.panels[0]?.id, t.count])).toEqual([
      ['containers', 'containers', 5],
    ]);
  });
});
