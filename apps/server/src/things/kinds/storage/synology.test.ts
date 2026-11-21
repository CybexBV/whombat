/**
 * Synology DSM's page from DSM 7's answers as community libraries record them (service-dashboards.md SD-52; DSM's Web
 * API is undocumented, see n4s4.github.io/synology-api): the APIs asked first, pools, volumes and disks, Hyper Backup
 * (a task's own status when the list says nothing), Security Advisor, the DSM update, and a user DSM won't show storage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import type { KindNotice } from './lines';
import {
  backupResult,
  healthOf,
  healthWord,
  lateness,
  parseApiInfo,
  parseSecurity,
  parseStorage,
  parseUpgrade,
  raidWords,
  readSynology,
  SYNOLOGY_CHECKS,
  SYNOLOGY_KIND,
  type SynoBackup,
  type SynologySnapshot,
  synoData,
  synologySkipped,
  synologyView,
  synoTime,
} from './synology';
import { checked, fakeServices, fixture, panel } from './test-helpers';

const net = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock('./net', async (orig) => ({ ...(await orig<typeof import('./net')>()), readJson: net.readJson }));

const now = new Date('2026-10-21T20:00:00Z');
const TZ = 'Europe/Amsterdam';
const url = 'https://ds.lan:5001';
const row = {
  id: 'con_syno',
  catalogId: 'synology',
  label: 'Synology',
  access: 'read',
  baseUrl: url,
  fields: { url, username: 'whombat' },
  credentialVersion: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as CatalogConnectionRow;
const services = fakeServices(now);

function answering({ storageRefused = false } = {}) {
  net.readJson.mockImplementation(
    async (_s, _r, _n, req: { path: string; query: Record<string, string> }) => {
      if (req.path === '/webapi/query.cgi') return fixture('synology-api-info.json');
      const { api, method } = req.query;
      if (api === 'SYNO.DSM.Info') return fixture('synology-dsm-info.json');
      if (api === 'SYNO.Storage.CGI.Storage')
        return fixture(storageRefused ? 'synology-error-105.json' : 'synology-load-info.json');
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
}

async function snapshot(opts: Parameters<typeof answering>[0] = {}): Promise<SynologySnapshot> {
  forgetKindReads(services);
  answering(opts);
  return readSynology(services, row, now, TZ);
}

const view = (s: SynologySnapshot) => checked(synologyView({ snapshot: s, now, timeZone: TZ, url }));

afterEach(() => net.readJson.mockReset());

describe('reading Synology (SD-52)', () => {
  it('asks which APIs this DSM has, then each at a version it knows', async () => {
    const info = parseApiInfo(fixture('synology-api-info.json'), {
      'SYNO.Core.Upgrade.Server': 2,
      'SYNO.Missing': 1,
      'SYNO.DSM.Info': 2,
    });
    expect([...info.keys()]).toEqual(['SYNO.Core.Upgrade.Server', 'SYNO.DSM.Info']);
    expect(info.get('SYNO.Core.Upgrade.Server')?.version).toBe(2);
    await snapshot();
    const asked = net.readJson.mock.calls.map(
      (c) => `${c[3].query.api}.${c[3].query.method}@${c[3].query.version}`,
    );
    expect(asked[0]).toBe('SYNO.API.Info.query@1');
    expect(asked).toContain('SYNO.Storage.CGI.Storage.load_info@1');
    // Only the task the list says nothing of is asked for its status.
    expect(asked.filter((a) => a.startsWith('SYNO.Backup.Task.status'))).toHaveLength(1);
  });

  it('reads pools, volumes and disks, the worse of a disk’s state and SMART', () => {
    const st = parseStorage(synoData(fixture('synology-load-info.json')));
    expect(st.pools.map((p) => [p.label, p.status, raidWords(p.raid ?? '')])).toEqual([
      ['Storage Pool 1', 'normal', 'SHR'],
      ['Storage Pool 2', 'degrade', 'Basic'],
    ]);
    expect(st.volumes.map((v) => [v.label, v.pool, v.total])).toEqual([
      ['Volume 1', 'Storage Pool 1', 7672165273600],
      ['Volume 2 · Scratch', 'Storage Pool 2', 3835000000000],
    ]);
    expect(st.disks.map((d) => [d.label, d.status, d.ssd])).toEqual([
      ['Drive 1', 'normal', false],
      ['Drive 2', 'warning', false],
      ['Drive 3', 'normal', false],
      ['M.2 Drive 1', 'normal', true],
    ]);
    expect(() => synoData(fixture('synology-error-105.json'))).toThrow();
    expect([healthOf('normal'), healthOf('degrade'), healthOf('repairing'), healthOf('attention')]).toEqual([
      'ok',
      'bad',
      'busy',
      'warn',
    ]);
    expect(healthWord('degrade')).toBe('Degraded');
  });

  it('reads Hyper Backup’s times in the box’s zone and its results', async () => {
    expect(synoTime('2026/10/21 03:00', TZ)?.toISOString()).toBe('2026-10-21T01:00:00.000Z');
    expect(synoTime('2026/01/21 03:00', TZ)?.toISOString()).toBe('2026-01-21T02:00:00.000Z');
    expect(synoTime('not a time', TZ)).toBeNull();
    expect([
      backupResult('done', 'none'),
      backupResult('failed', null),
      backupResult(null, 'backup'),
    ]).toEqual(['ok', 'failed', 'running']);
    const s = await snapshot();
    expect(s.backups?.map((b) => [b.name, b.result])).toEqual([
      ['To C2', 'ok'],
      ['To USB', 'ok'],
      ['Photos offsite', 'failed'],
    ]);
    expect(s.backups?.[2]?.last?.toISOString()).toBe('2026-10-21T03:10:00.000Z');
  });

  it('reads Security Advisor and the DSM update', () => {
    expect(parseSecurity(synoData(fixture('synology-security.json')))).toMatchObject({
      risks: 1,
      warnings: 2,
    });
    expect(parseUpgrade(synoData(fixture('synology-upgrade-check.json')))).toEqual({
      available: true,
      version: 'DSM 7.3-81180',
    });
    expect(parseUpgrade({ available: false })).toEqual({ available: false, version: null });
    expect(parseUpgrade({})).toBeNull();
  });
});

describe('Synology’s page (SD-52)', () => {
  it('is in slots: Hyper Backup, Storage, DSM’s lines and the disks below, no row of figures', async () => {
    const v = view(await snapshot());
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual(['backups', 'storage', 'disks']);
    expect(panel(v, 'disks', 'table')?.rows.find((r) => r.id === 'sata3')?.cells.temp?.tone).toBe('bad');
    // DSM is its own machine, but its figures need a call not checked yet: only its lines, as “… itself”.
    expect(v.slots?.own).toBeUndefined();
    expect(v.slots?.machine.map((b) => [b.label, b.value, b.sub ?? null])).toEqual([
      ['DSM', '7.2.2-72806 Update 3', 'DSM 7.3-81180 is out'],
      ['Temperature', '45 °C', null],
      ['Security Advisor', '1 risk', null],
      ['Memory', '20 GB', null],
      ['Up', '3 weeks', null],
    ]);
    expect(v.facts.length).toBe(2);
  });

  it('shows each Hyper Backup task in Live with its last run, its next and what is wrong', async () => {
    const live = panel(view(await snapshot()), 'backups', 'gallery');
    expect(live).toMatchObject({ title: 'Hyper Backup', look: 'rows', meta: '3 tasks · last ran 17 h ago' });
    expect(live?.items.map((i) => [i.title, i.sub, i.note, i.badge?.text ?? null])).toEqual([
      ['To C2', 'To the cloud', 'Backed up 19 h ago', null],
      // Its next run is tomorrow: not late by its own schedule (QN-S43).
      ['To USB', 'To a local folder or USB disk', 'Backed up 5 days ago', null],
      ['Photos offsite', 'To another NAS', 'Ran 17 h ago', 'Failed'],
    ]);
    expect(live?.items[0]?.noteEnd).toBe('Next tomorrow 03:00');
  });

  it('counts each volume in Storage with its pool’s state, and the disks', async () => {
    const storage = panel(view(await snapshot()), 'storage', 'list');
    expect(storage).toMatchObject({ title: 'Storage', look: 'counts', meta: '8.6 of 12 TB' });
    expect(
      storage?.items.map((i) => [i.title, i.detail, i.figure?.value, i.figure?.note, i.tone ?? null]),
    ).toEqual([
      ['Volume 1', 'SHR · Btrfs · Healthy', '64 %', '2.8 TB free', null],
      ['Volume 2 · Scratch', 'Basic · ext4 · Crashed', '96 %', '135 GB free', 'bad'],
      // sata3 at 61 °C is worse than sata2's warning.
      ['Disks', undefined, '4', '1 runs too hot', 'bad'],
    ]);
  });

  it('says what is wrong, worst first; read only', async () => {
    const v = view(await snapshot());
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      // Volume 2's crash gives way to its pool's line (QN-S46).
      ['pool-reuse_2', 'bad'],
      ['full-volume_2', 'bad'],
      ['hot-sata3', 'bad'],
      ['backup-3', 'bad'],
      ['disk-sata2', 'warn'],
      ['security', 'warn'],
      ['update', 'info'],
    ]);
    expect(v.notices.every((n) => n.action === undefined)).toBe(true);
  });

  it('names each line’s check, item, kind and how an Ignore ends (QN-01…QN-03)', async () => {
    const v = view(await snapshot());
    const line = (id: string) => v.notices.find((n) => n.id === id) as KindNotice;
    expect(line('pool-reuse_2')).toMatchObject({
      check: 'synology.storage',
      subject: { id: 'pool:reuse_2' },
      nature: 'problem',
      ignore: { lifts: 'fixed' },
      episode: 'degrade',
    });
    expect(line('pool-reuse_2').detail).toContain('Volume 2');
    expect(line('full-volume_2')).toMatchObject({
      check: 'synology.volume_full',
      subject: { id: 'volume:volume_2' },
      nature: 'problem',
      band: 95,
      link: { kind: 'ask' },
    });
    // The fixture hides serials as “x”: the slot stands in.
    expect(line('disk-sata2')).toMatchObject({
      check: 'synology.disk',
      subject: { id: 'disk:sata2' },
      nature: 'you',
    });
    expect(line('hot-sata3')).toMatchObject({ check: 'synology.disk_temp', nature: 'you', confirm: 2 });
    expect(line('backup-3')).toMatchObject({
      check: 'synology.backup_failed',
      subject: { id: 'task:3' },
      ignore: { lifts: 'newer' },
    });
    expect(line('security')).toMatchObject({ nature: 'you', band: 1, ignore: { lifts: 'fixed' } });
    expect(line('security').episode).toBeUndefined();
    expect(line('update')).toMatchObject({ nature: 'fyi', episode: 'DSM 7.3-81180' });
    for (const n of v.notices as KindNotice[]) {
      expect(SYNOLOGY_CHECKS.map((c) => c.check)).toContain(n.check);
      expect(n.ignore?.words.length).toBeLessThanOrEqual(60);
      expect(n.badge?.length ?? 0).toBeLessThanOrEqual(40);
      // Only problems ask the assistant (QN-02).
      if (n.link?.kind === 'ask') expect(n.nature).toBe('problem');
    }
  });

  it('keys disks on their serial when DSM tells them apart (QN-S42)', () => {
    const data = fixture('synology-load-info.json') as { data: { disks: Record<string, unknown>[] } };
    const disks = data.data.disks.map((d, i) => ({ ...d, serial: `ZR50${i}ABC` }));
    const st = parseStorage({ ...data.data, disks });
    expect(st.disks.map((d) => d.serial)).toEqual(['ZR500ABC', 'ZR501ABC', 'ZR502ABC', 'ZR503ABC']);
  });

  it('a warm disk is a heads-up, a hot one only you (QN-04)', async () => {
    const s = await snapshot();
    const disks = s.storage?.disks.map((d) => (d.id === 'sata3' ? { ...d, temp: 56 } : d)) ?? [];
    const v = view({ ...s, storage: s.storage && { ...s.storage, disks } });
    expect(v.notices.find((n) => n.id === 'hot-sata3')).toMatchObject({ tone: 'warn', nature: 'fyi' });
    expect(v.status?.badge).not.toContain('Drive 3');
  });

  it('a nearly full volume with a terabyte free is a heads-up (QN-S41)', async () => {
    const s = await snapshot();
    const volumes =
      s.storage?.volumes.map((x) =>
        x.id === 'volume_2' ? { ...x, total: 20e12, used: 17.4e12, status: 'normal' } : x,
      ) ?? [];
    const v = view({ ...s, storage: s.storage && { ...s.storage, volumes } });
    expect(v.notices.find((n) => n.id === 'full-volume_2')).toMatchObject({
      tone: 'warn',
      nature: 'fyi',
      band: 85,
    });
    expect(v.notices.find((n) => n.id === 'full-volume_2')?.link).toBeUndefined();
  });

  it('late follows the task’s own schedule (QN-S43)', () => {
    const task = (last: string, next: string | null): SynoBackup => ({
      id: '9',
      name: 'Weekly',
      result: 'ok',
      last: new Date(last),
      next: next ? new Date(next) : null,
    });
    // Weekly: three days after the last run, the next is still four days away.
    expect(lateness(task('2026-10-18T03:00:00Z', '2026-10-25T03:00:00Z'), now)).toBeNull();
    // The planned run passed without a backup.
    expect(lateness(task('2026-10-14T03:00:00Z', '2026-10-21T03:00:00Z'), now)).toBe('late');
    // Nothing planned: a heads-up after two days.
    expect(lateness(task('2026-10-18T03:00:00Z', null), now)).toBe('unscheduled');
    // A month and more: late whatever the schedule says.
    expect(lateness(task('2026-09-01T03:00:00Z', '2026-10-25T03:00:00Z'), now)).toBe('late');
    expect(lateness({ ...task('2026-10-14T03:00:00Z', null), result: 'running' }, now)).toBeNull();
  });

  it('a late task’s line keeps its run as the episode and says it short in the head', async () => {
    const s = await snapshot();
    const backups = (s.backups ?? []).map((b) =>
      b.id === '2' ? { ...b, next: new Date('2026-10-20T03:00:00Z') } : b,
    );
    const v = view({ ...s, backups });
    const late = v.notices.find((n) => n.id === 'late-2') as KindNotice;
    expect(late).toMatchObject({
      check: 'synology.backup_late',
      nature: 'problem',
      episode: backups.find((b) => b.id === '2')?.last?.toISOString(),
      link: { kind: 'ask' },
    });
    expect(late.badge).toMatch(/late$/);
  });

  it('a cancelled run is a heads-up, a partial one a problem', async () => {
    expect(backupResult('cancelled', null)).toBe('cancelled');
    expect(backupResult('partial', null)).toBe('partial');
    const s = await snapshot();
    const backups = (s.backups ?? []).map((b) => (b.id === '1' ? { ...b, result: 'cancelled' as const } : b));
    const v = view({ ...s, backups });
    expect(v.notices.find((n) => n.id === 'partial-1')).toMatchObject({ tone: 'info', nature: 'fyi' });
  });

  it('suggestions alone are a heads-up and leave the head calm', async () => {
    const s = await snapshot();
    const v = view({ ...s, storage: null, backups: [], security: { risks: 0, warnings: 3, at: null } });
    expect(v.notices.find((n) => n.id === 'security')).toMatchObject({ nature: 'fyi', band: 3 });
    expect(v.status?.status).toBe('ok');
  });

  it('skips the checks of what it couldn’t read (QN-11)', async () => {
    const s = await snapshot();
    expect(synologySkipped(s)).toEqual([]);
    expect(synologySkipped({ ...s, storage: null, security: null })).toEqual([
      'synology.storage',
      'synology.volume_full',
      'synology.disk',
      'synology.disk_temp',
      'synology.storage_refused',
      'synology.security',
    ]);
    expect(synologySkipped({ ...s, backupsCapped: true })).toContain('synology.backup_late');
    const refused = await snapshot({ storageRefused: true });
    expect(synologySkipped(refused)).not.toContain('synology.storage_refused');
  });

  it('says why storage is missing for a user that isn’t an administrator', async () => {
    const s = await snapshot({ storageRefused: true });
    expect(s.storage).toBeNull();
    const v = view(s);
    expect(v.notices.map((n) => n.id)).toContain('storage-refused');
    expect(panel(v, 'storage', 'list')).toBeUndefined();
    expect(panel(v, 'backups', 'gallery')?.items).toHaveLength(3);
  });

  it('gives the card Volumes and Last backup, and the health pass the same lines', async () => {
    answering();
    forgetKindReads(services);
    const seen = await SYNOLOGY_KIND.seen?.(services, row, now, TZ);
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Volumes', 'Last backup']);
    expect(seen?.glance.status).toBe('bad');
    expect(seen?.notices?.map((n) => n.id)).toEqual(view(await snapshot()).notices.map((n) => n.id));
    expect(seen?.skipped).toBeUndefined();
    expect(seen?.glance.facts?.[1]).toMatchObject({ value: 'Failed' });
    expect(seen?.points.nas_used_gb).toBe(8610);
    expect(SYNOLOGY_KIND.checks).toBe(SYNOLOGY_CHECKS);
  });
});
