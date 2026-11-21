/**
 * The storage and backup kinds as widgets, from their recorded answers (desk-display-server.md “Every connection's
 * widgets”): Synology's, TrueNAS's and QNAP's storage as bars with how soon it's full, Proxmox Backup Server's
 * backups. Their reads go through faked calls, as in the kinds' own tests; then the page through the widgets' runtime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocketReply } from '../../connections/socket/dialect';
import type { CatalogConnectionRow } from '../../connections/types';
import { forgetKindReads } from '../../things/kinds/read';
import { immichView, readImmich, readMemories } from '../../things/kinds/storage/immich';
import { StatusProblem } from '../../things/kinds/storage/net';
import { pbsView, readPbs } from '../../things/kinds/storage/pbs';
import { qnapView, readQnap } from '../../things/kinds/storage/qnap';
import { readSynology, synologyView } from '../../things/kinds/storage/synology';
import { fakePicture, fakeServices, fixture, fixtureText } from '../../things/kinds/storage/test-helpers';
import { readTrueNas, truenasView } from '../../things/kinds/storage/truenas';
import { as, groupOn, pageOf, panelOn, pictureRef, viewsOn } from './thing-testing';

const net = vi.hoisted(() => ({ readJson: vi.fn(), readText: vi.fn(), truenasCalls: vi.fn() }));
vi.mock('../../things/kinds/storage/net', async (orig) => ({
  ...(await orig<typeof import('../../things/kinds/storage/net')>()),
  readJson: net.readJson,
  readText: net.readText,
}));
vi.mock('../../things/kinds/storage/truenas-socket', async (orig) => ({
  ...(await orig<typeof import('../../things/kinds/storage/truenas-socket')>()),
  truenasCalls: net.truenasCalls,
}));

const now = new Date('2026-10-21T20:00:00Z');
const TZ = 'Europe/Amsterdam';
const services = fakeServices(now);
const rowOf = (catalogId: string, url: string) =>
  ({
    id: `con_${catalogId}`,
    catalogId,
    label: catalogId,
    access: 'write',
    baseUrl: url,
    fields: { url, username: 'whombat' },
    credentialVersion: 1,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  }) as unknown as CatalogConnectionRow;

afterEach(() => {
  net.readJson.mockReset();
  net.readText.mockReset();
  net.truenasCalls.mockReset();
  forgetKindReads(services);
});

async function pbsPage() {
  const files: Record<string, string> = {
    '/version': 'pbs-version.json',
    '/status/datastore-usage': 'pbs-datastore-usage.json',
    '/admin/verify': 'pbs-verify.json',
    '/admin/prune': 'pbs-prune.json',
    '/admin/sync': 'pbs-sync.json',
    '/admin/gc': 'pbs-gc.json',
    '/nodes/localhost/tasks': 'pbs-tasks.json',
    '/admin/datastore/tank/namespace': 'pbs-namespaces.json',
    '/admin/datastore/tank/snapshots': 'pbs-snapshots-tank.json',
    '/admin/datastore/tank/groups': 'pbs-groups-tank.json',
  };
  net.readJson.mockImplementation(
    async (_s, _r, _n, req: { path: string; query?: Record<string, string> }) => {
      const p = req.path.replace('/api2/json', '');
      if (p === '/admin/datastore/offsite/namespace') throw new StatusProblem('missing', 404);
      if (req.query?.ns && p.endsWith('/snapshots')) return { data: [] };
      const file = files[p];
      return file ? fixture(file) : { data: [] };
    },
  );
  const url = 'https://pbs.lan:8007';
  const row = rowOf('proxmox_backup', url);
  const s = await readPbs(services, row, now);
  const view = pbsView({ snapshot: s, now, timeZone: TZ, url, names: new Map(), buttons: { row } });
  return pageOf(view, { catalogId: 'proxmox_backup', name: 'Backups' });
}

async function synologyPage() {
  net.readJson.mockImplementation(
    async (_s, _r, _n, req: { path: string; query: Record<string, string> }) => {
      if (req.path === '/webapi/query.cgi') return fixture('synology-api-info.json');
      const { api, method } = req.query;
      if (api === 'SYNO.DSM.Info') return fixture('synology-dsm-info.json');
      if (api === 'SYNO.Storage.CGI.Storage') return fixture('synology-load-info.json');
      if (api === 'SYNO.Backup.Task' && method === 'list') return fixture('synology-backup-list.json');
      if (api === 'SYNO.Backup.Task' && method === 'status')
        return req.query.task_id === '3'
          ? fixture('synology-backup-status-3.json')
          : { success: false, error: { code: 103 } };
      if (api === 'SYNO.Core.SecurityScan.Status') return fixture('synology-security.json');
      if (api === 'SYNO.Core.Upgrade.Server') return fixture('synology-upgrade-check.json');
      return { success: false, error: { code: 102 } };
    },
  );
  const url = 'https://ds.lan:5001';
  const s = await readSynology(services, rowOf('synology', url), now, TZ);
  return pageOf(synologyView({ snapshot: s, now, timeZone: TZ, url }), {
    catalogId: 'synology',
    name: 'nas',
  });
}

async function qnapPage() {
  net.readText.mockImplementation(
    async (_s, _r, _n, req: { path: string; query: Record<string, string> }) => {
      if (req.path.endsWith('qsmart.cgi')) return fixtureText('qnap-smart.xml');
      if (req.path.endsWith('chartReq.cgi')) return fixtureText('qnap-volumes.xml');
      return fixtureText(req.query.sysHealth ? 'qnap-syshealth.xml' : 'qnap-sysinfo.xml');
    },
  );
  const url = 'https://qnap.lan';
  const s = await readQnap(services, rowOf('qnap', url), now);
  return pageOf(qnapView({ snapshot: s, url }), { catalogId: 'qnap', name: 'QNAP' });
}

async function truenasPage() {
  const answers: Record<string, string | null> = {
    'system.info': 'truenas-system-info.json',
    'alert.list': 'truenas-alert-list.json',
    'pool.query': 'truenas-pool-query.json',
    'disk.query': 'truenas-disk-query.json',
    'disk.temperatures': 'truenas-disk-temperatures.json',
    'app.query': 'truenas-app-query.json',
    'update.status': 'truenas-update-status.json',
    'replication.query': 'truenas-replication-query.json',
    'pool.snapshottask.query': 'truenas-snapshottask-query.json',
    'cloudsync.query': 'truenas-cloudsync-query.json',
    'update.check_available': 'truenas-update-check-available.json',
  };
  net.truenasCalls.mockImplementation(async (_s, _r, calls: { method: string }[]) =>
    calls.map((c): SocketReply => {
      const file = answers[c.method];
      return file
        ? { ok: true, result: fixture(file), output: [], stopped: false }
        : { ok: false, error: { code: -32601, message: 'Method not found' }, code: '-32601', output: [] };
    }),
  );
  const url = 'https://nas.lan';
  const row = rowOf('truenas', url);
  const s = await readTrueNas(services, row, now);
  return pageOf(truenasView({ snapshot: s, now, timeZone: TZ, url, buttons: { row } }), {
    catalogId: 'truenas',
    name: 'TrueNAS',
  });
}

async function immichPage() {
  const files: Record<string, string> = {
    '/api/server/storage': 'immich-server-storage.json',
    '/api/server/statistics': 'immich-server-statistics.json',
    '/api/queues': 'immich-queues.json',
    '/api/search/metadata': 'immich-search-metadata.json',
    '/api/memories': 'immich-memories.json',
  };
  net.readJson.mockImplementation(async (_s, _r, _n, req: { path: string }) => {
    const file = files[req.path];
    if (!file) throw new StatusProblem('missing', 404);
    return fixture(file);
  });
  const url = 'http://immich.lan:2283';
  const row = rowOf('immich', url);
  const [s, memories] = await Promise.all([
    readImmich(services, row, now),
    readMemories(services, row, now, TZ),
  ]);
  return pageOf(
    immichView({ snapshot: s, now, timeZone: TZ, url, buttons: { row }, picture: fakePicture, memories }),
    { catalogId: 'immich', name: 'Photos' },
  );
}

describe('All backed up', () => {
  it('says in one line how Proxmox Backup Server’s guests stand, with only what’s late or failed below', async () => {
    const got = await panelOn(await pbsPage(), 'backed-up');
    const view = as(got, 'list');
    expect(view).toMatchObject({ title: 'All backed up', head: '2 of 3 guests backed up' });
    expect(view.rows.map((r) => [r.title, r.tone])).toEqual([
      ['CT 131', 'bad'],
      ['VM 105', 'bad'],
      ['Verify · offsite', 'bad'],
      ['Garbage collection · offsite', 'bad'],
    ]);
    expect(view.rows[0]?.detail).toContain('3 days ago');
    expect(view.rows[3]?.detail).toMatch(/^Failed · \d+ h ago$/);
    expect(got.private).toBe(false);
  });

  it('does the same for Synology’s Hyper Backup and TrueNAS’s tasks', async () => {
    const syno = as(await panelOn(await synologyPage(), 'backed-up'), 'list');
    expect(syno.head).toBe('2 of 3 backups OK');
    expect(syno.rows.map((r) => [r.title, r.tone])).toEqual([['Photos offsite', 'bad']]);
    const tn = as(await panelOn(await truenasPage(), 'backed-up'), 'list');
    expect(tn.head).toBe('4 of 5 tasks OK');
    expect(tn.rows[0]).toMatchObject({ title: 'Replication tank/photos - offsite', tone: 'bad' });
    expect(tn.rows[0]?.detail).not.toContain('ssh');
  });

  it('is calm when everything is backed up', async () => {
    const page = await synologyPage();
    const fine = {
      ...page,
      tabs: page.tabs.map((t) => ({
        ...t,
        panels: t.panels.map((p) =>
          p.kind === 'gallery' && p.id === 'backups'
            ? { ...p, items: p.items.map(({ badge: _badge, ...i }) => ({ ...i, note: 'Backed up 2 h ago' })) }
            : p,
        ),
      })),
    };
    const view = as(await panelOn(fine, 'backed-up'), 'list');
    expect(view.head).toBe('All 3 backups OK');
    expect(view.rows).toEqual([]);
  });

  it('lists Synology’s Hyper Backup tasks with their last run', async () => {
    const view = as(await panelOn(await synologyPage(), 'backups'), 'list');
    expect(view.rows.map((r) => [r.title, r.tone ?? null])).toEqual([
      ['To C2', null],
      ['To USB', null],
      ['Photos offsite', 'bad'],
    ]);
  });

  it('isn’t offered by a NAS without backups to watch', async () => {
    const page = await qnapPage();
    expect((await groupOn(page)).items.map((i) => i.opts.panel)).not.toContain('backed-up');
  });
});

describe('On this day', () => {
  it('shows Immich’s photos from this day in earlier years as posters, private, offered first', async () => {
    const page = await immichPage();
    expect((await groupOn(page)).items[1]).toMatchObject({
      name: 'On this day',
      view: 'posters',
      private: true,
      opts: { panel: 'memories' },
    });
    const got = await panelOn(page, 'memories');
    const view = as(got, 'posters');
    expect(view.shape).toBe('square');
    expect(view.items[0]).toMatchObject({ title: '3 years ago · Texel', detail: '2023' });
    expect(view.items[0]?.image?.thing).toBe('connection:con_immich');
    expect(got.private).toBe(true);
  });
});

describe('Proxmox Backup Server', () => {
  it('offers All backed up first, then each guest’s last backup and the datastores', async () => {
    const group = await groupOn(await pbsPage());
    expect(group.items.slice(0, 4).map((i) => i.opts.panel ?? 'figures')).toEqual([
      'figures',
      'backed-up',
      'guests',
      'datastores',
    ]);
  });

  it('shows each guest with when it was last backed up, its namespace kept', async () => {
    const view = as(await panelOn(await pbsPage(), 'guests'), 'list');
    expect(view.title).toBe('Backups');
    expect(view.rows[0]).toMatchObject({ title: 'CT 131', meta: '3 days ago', tone: 'bad' });
    expect(view.rows.some((r) => r.detail?.startsWith('lab'))).toBe(true);
  });

  it('shows the datastores with how full and when they’re full, then the guests and backups', async () => {
    const view = as(await panelOn(await pbsPage(), 'datastores'), 'list');
    expect(view.rows[0]).toMatchObject({ title: 'tank', meta: '68 %' });
    expect(view.rows[0]?.detail).toMatch(/^Full in about \d+ months$/);
    expect(view.rows.map((r) => r.title)).toEqual(['tank', 'offsite', 'usb', 'Guests', 'Backups']);
  });

  it('lists the jobs, the failed ones in red', async () => {
    const view = as(await panelOn(await pbsPage(), 'jobs'), 'list');
    expect(view.rows.filter((r) => r.tone === 'bad').map((r) => r.title)).toEqual([
      'Verify · offsite',
      'Garbage collection · offsite',
    ]);
  });

  it('keeps Failed in 7 days while nothing failed: empty, not gone', async () => {
    const page = await pbsPage();
    const calm = {
      ...page,
      tabs: page.tabs.map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== 'failed') })),
    };
    expect((await groupOn(calm)).items.map((i) => i.opts.panel)).toContain('failed');
    const view = as(await panelOn(calm, 'failed'), 'list');
    expect(view).toMatchObject({ title: 'Failed in 7 days', rows: [] });
    expect(view.problem).toBeUndefined();
  });

  it('is read every 5 minutes, figures and panels alike', async () => {
    const page = await pbsPage();
    expect((await panelOn(page, 'guests')).refreshS).toBe(300);
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(got.get('w_fig')?.refreshS).toBe(300);
  });
});

describe('Paperless-ngx and Immich', () => {
  const paperless = pageOf(
    {
      notices: [
        {
          id: 'failed-1',
          tone: 'warn',
          icon: 'warn',
          title: 'tax-return-2025.pdf didn’t import',
          nature: 'you',
          check: 'paperless.import_failed',
        },
      ],
      panels: [
        {
          kind: 'table',
          id: 'failed',
          title: 'Failed imports',
          columns: [{ key: 'file', label: 'File' }],
          rows: [{ id: '1', cells: { file: { text: 'tax-return-2025.pdf' } } }],
        },
      ],
    },
    { catalogId: 'paperless', name: 'Paperless-ngx' },
  );

  it('keep file names and photos off a locked screen', async () => {
    expect((await panelOn(paperless, 'failed')).private).toBe(true);
    expect((await panelOn(paperless, 'notices')).private).toBe(true);
    const calm = {
      ...paperless,
      tabs: paperless.tabs.map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== 'failed') })),
    };
    const empty = await panelOn(calm, 'failed');
    expect(empty).toMatchObject({ private: true, view: { kind: 'list', rows: [] } });
  });

  it('read a photo every half hour', async () => {
    const immich = pageOf(
      {
        panels: [
          {
            kind: 'gallery',
            id: 'recent',
            title: 'Recent photos',
            shape: 'square',
            items: [
              { id: 'a', title: 'Beach', image: { ref: pictureRef('thumb/a'), alt: '', shape: 'square' } },
            ],
          },
        ],
      },
      { catalogId: 'immich', name: 'Immich' },
    );
    expect(await panelOn(immich, 'recent')).toMatchObject({ private: true, refreshS: 1800 });
  });
});

describe('Synology, QNAP and TrueNAS', () => {
  it('show their storage with how full each is, the full ones in colour, then the disks', async () => {
    const syno = as(await panelOn(await synologyPage(), 'storage'), 'list');
    expect(syno.rows.find((r) => r.title === 'Volume 1')).toMatchObject({ meta: '64 %' });
    expect(syno.rows.find((r) => r.title === 'Volume 2 · Scratch')?.tone).toBe('bad');
    expect(syno.rows.at(-1)).toMatchObject({ title: 'Disks', tone: 'bad' });
    const qnap = as(await panelOn(await qnapPage(), 'volumes'), 'list');
    expect(qnap.rows.find((r) => r.title === 'Backups')).toMatchObject({ meta: '92 %', tone: 'warn' });
    const tn = as(await panelOn(await truenasPage(), 'pools'), 'list');
    expect(tn.rows.find((r) => r.title === 'fast')).toMatchObject({ meta: '90 %', tone: 'bad' });
  });

  it('keep a nearly full volume’s colour among their figures', async () => {
    const got = await viewsOn(await qnapPage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    const view = got.get('w_fig')?.view;
    expect(view?.kind).toBe('figures');
    const figures = view?.kind === 'figures' ? view.items : [];
    expect(figures.find((f) => f.label === 'Backups')).toMatchObject({ value: '92 %', tone: 'warn' });
  });

  it('list TrueNAS’s apps, crashed first', async () => {
    const view = as(await panelOn(await truenasPage(), 'apps'), 'list');
    expect(view.rows.map((r) => r.title)).toEqual(['immich', 'minio', 'plex', 'nextcloud']);
    expect(view.rows[0]?.tone).toBe('bad');
  });

  it('offer their storage first', async () => {
    for (const [page, first] of [
      [await synologyPage(), 'storage'],
      [await qnapPage(), 'volumes'],
      [await truenasPage(), 'pools'],
    ] as const)
      expect((await groupOn(page)).items[1]?.opts.panel).toBe(first);
  });
});
