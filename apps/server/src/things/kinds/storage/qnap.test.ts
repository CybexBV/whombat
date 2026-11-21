/**
 * QNAP's page from QTS's XML as python-qnapstats reads it (service-dashboards.md SD-53; fixtures in QTS 5's shapes):
 * volumes and how full, disks with health and temperature (empty bays left out), the box's warmth and health.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { RawPoint } from '../../series';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import type { KindNotice } from './lines';
import { StatusProblem } from './net';
import {
  diskHealth,
  parseDisks,
  parseHealth,
  parseSystem,
  parseVolumes,
  QNAP_CHECKS,
  QNAP_KIND,
  type QnapSnapshot,
  type QnapSystem,
  qnapSkipped,
  qnapView,
  readQnap,
  warmth,
  xmlBlocks,
} from './qnap';
import { checked, fakeServices, fixtureText, panel } from './test-helpers';

const net = vi.hoisted(() => ({ readText: vi.fn() }));
vi.mock('./net', async (orig) => ({ ...(await orig<typeof import('./net')>()), readText: net.readText }));

const now = new Date('2026-10-21T20:00:00Z');
const url = 'https://qnap.lan';
const row = {
  id: 'con_qnap',
  catalogId: 'qnap',
  label: 'QNAP',
  access: 'read',
  baseUrl: url,
  fields: { url, username: 'whombat' },
  credentialVersion: 1,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as CatalogConnectionRow;
const services = fakeServices(now);

function answering(missing: string[] = []) {
  net.readText.mockImplementation(
    async (_s, _r, _n, req: { path: string; query: Record<string, string> }) => {
      if (missing.includes(req.path)) throw new StatusProblem('missing', 404);
      if (req.path.endsWith('qsmart.cgi')) return fixtureText('qnap-smart.xml');
      if (req.path.endsWith('chartReq.cgi')) return fixtureText('qnap-volumes.xml');
      return fixtureText(req.query.sysHealth ? 'qnap-syshealth.xml' : 'qnap-sysinfo.xml');
    },
  );
}

async function snapshot(missing: string[] = []): Promise<QnapSnapshot> {
  forgetKindReads(services);
  answering(missing);
  return readQnap(services, row, now);
}

const view = (s: QnapSnapshot, space: RawPoint[] = []) =>
  checked(qnapView({ snapshot: s, url, now, timeZone: 'UTC', space }));

afterEach(() => net.readText.mockReset());

describe('reading QNAP (SD-53)', () => {
  it('reads the system: model, firmware, temperatures, uptime', () => {
    expect(parseSystem(fixtureText('qnap-sysinfo.xml'))).toEqual({
      name: 'NAS-Home',
      model: 'TS-453D',
      firmware: '5.2.1 (20240902)',
      systemC: 41,
      cpuC: 52,
      uptimeS: 12 * 86400 + 3 * 3600 + 14 * 60 + 15,
      cpuPct: 7.1,
      memoryTotalMb: 7841.7,
      memoryFreeMb: 5120.2,
    });
    expect(parseHealth(fixtureText('qnap-syshealth.xml'))).toBe('warning');
  });

  it('reads the disks in their bays, leaving empty bays out', () => {
    const disks = parseDisks(fixtureText('qnap-smart.xml'));
    expect(disks.map((d) => [d.label, d.health, d.tempC, d.ssd])).toEqual([
      ['Disk 1', 'OK', 34, false],
      ['Disk 2', 'Warning', 57, false],
      ['Disk 4', 'Abnormal', 38, true],
    ]);
    expect([diskHealth('OK'), diskHealth('Warning'), diskHealth('Abnormal')]).toEqual(['ok', 'warn', 'bad']);
  });

  it('reads volumes with their labels, leaving QTS’s own out', () => {
    expect(parseVolumes(fixtureText('qnap-volumes.xml')).map((v) => [v.label, v.total])).toEqual([
      ['DataVol1', 7651758436352],
      ['Backups', 3825879218176],
    ]);
    expect(xmlBlocks('<a><b>1</b><b>2</b></a>', 'b')).toEqual(['1', '2']);
  });

  it('keeps what answered when a part doesn’t', async () => {
    const s = await snapshot(['/cgi-bin/disk/qsmart.cgi']);
    expect(s.disks).toBeNull();
    expect(s.volumes).toHaveLength(2);
    expect(panel(view(s), 'volumes', 'list')?.items.map((i) => i.id)).toEqual(['volume-1', 'volume-2']);
  });

  it('refuses an answer that isn’t QTS’s', async () => {
    forgetKindReads(services);
    net.readText.mockResolvedValue('<html>login</html>');
    await expect(readQnap(services, row, now)).rejects.toThrow(/can’t read/);
  });
});

describe('QNAP’s page (SD-53)', () => {
  it('is in slots: Storage with each volume and the disks, no row of figures', async () => {
    const v = view(await snapshot());
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    const storage = panel(v, 'volumes', 'list');
    expect(storage).toMatchObject({ title: 'Storage', look: 'counts', meta: '8.4 of 11 TB' });
    expect(storage?.items.map((i) => [i.title, i.figure?.value, i.figure?.note, i.tone ?? null])).toEqual([
      ['DataVol1', '63 %', '2.8 TB free', null],
      ['Backups', '92 %', '306 GB free', 'warn'],
      ['Disks', '3', '1 needs replacing', 'bad'],
    ]);
    // QTS tells nothing that happens now: no Live.
    expect(v.panels.map((p) => p.id)).toEqual(['volumes', 'disks']);
  });

  it('draws the disks below, and the box itself in the machine card with its own figures', async () => {
    const v = view(await snapshot());
    expect(
      panel(v, 'disks', 'table')?.rows.map((r) => [r.id, r.cells.health?.dot, r.cells.temp?.tone ?? null]),
    ).toEqual([
      ['1', 'ok', null],
      ['2', 'warn', 'warn'],
      ['4', 'bad', null],
    ]);
    expect(v.slots?.own?.name).toBe('NAS-Home');
    expect(v.slots?.own?.figures).toMatchObject({ cpuPct: 7.1, diskUsedGb: null });
    expect(v.slots?.own?.figures.memoryUsedGb).toBeCloseTo(2.66, 1);
    expect(v.slots?.machine.map((b) => [b.label, b.value, b.sub ?? null])).toEqual([
      ['QTS', '5.2.1', 'Build 20240902'],
      ['Temperature', '41 °C', 'Processor 52 °C'],
      ['System health', 'Warning', null],
      ['Up', '12 days', null],
    ]);
  });

  it('shows the space added each day from Whombat’s readings, once it has two days', async () => {
    const s = await snapshot();
    const at = (daysAgo: number, gb: number) => ({
      at: new Date(now.getTime() - daysAgo * 86_400_000),
      value: gb,
    });
    const two = view({ ...s }, [at(1, 9_000)]);
    expect(panel(two, 'week', 'chart')).toBeUndefined();
    const week = view(s, [at(3, 9_900), at(2, 9_950), at(1, 9_950), at(0, 10_040)]);
    const chart = panel(week, 'week', 'chart');
    expect(chart).toMatchObject({ title: 'Space used', figure: { value: '+140 GB', rest: 'this week' } });
    expect(chart?.series[0]?.values.slice(-3)).toEqual([50, 0, 90]);
    expect(slotProblems(week)).toEqual([]);
  });

  it('says what is wrong: a disk, a volume nearly full, its health, the warmth', async () => {
    const s = await snapshot();
    const v = view(s);
    // QTS's health word gives way to the disk lines that explain it (QN-04).
    expect(v.notices.map((n) => [n.id, n.tone])).toEqual([
      ['disk-4', 'bad'],
      ['full-2', 'warn'],
      ['disk-2', 'warn'],
      ['hot-2', 'warn'],
    ]);
    expect(view({ ...s, disks: [] }).notices.map((n) => n.id)).toEqual(['full-2', 'health']);
    const warm = view({ ...s, system: { ...(s.system as QnapSystem), systemC: 72 } });
    expect(warm.notices[0]).toMatchObject({ id: 'disk-4' });
    expect(warm.notices.find((n) => n.id === 'warm')?.tone).toBe('bad');
    expect(warmth({ name: null, model: null, firmware: null, systemC: 40, cpuC: 88, uptimeS: null })).toBe(
      'warn',
    );
  });

  it('gives the card Volumes and Disks', async () => {
    answering();
    forgetKindReads(services);
    const seen = await QNAP_KIND.seen?.(services, row, now, 'UTC');
    expect(seen?.glance.facts?.map((f) => f.label)).toEqual(['Volumes', 'Disks']);
    expect(seen?.glance.line).toBe('NAS · QTS 5.2.1');
    expect(seen?.glance.status).toBe('bad');
    // The used space of every volume, for the week's Trend.
    expect(seen?.points.nas_used_gb).toBeCloseTo(8366.1, 1);
  });
});

describe('QNAP’s lines as Whombat watches them (quiet-notices.md QN-01…QN-04)', () => {
  const lines = (s: QnapSnapshot) => view(s).notices as KindNotice[];
  const line = (s: QnapSnapshot, id: string) => lines(s).find((n) => n.id === id);

  it('gives every line its check, kind of line and how an Ignore ends; the checks list them all', async () => {
    const s = await snapshot();
    const warm = { ...s, disks: [], system: { ...(s.system as QnapSystem), systemC: 72 } };
    const checks = new Set(QNAP_CHECKS.map((c) => c.check));
    expect(QNAP_KIND.checks).toBe(QNAP_CHECKS);
    for (const n of [...lines(s), ...lines(warm), ...lines({ ...s, disks: [] })]) {
      expect(checks.has(n.check)).toBe(true);
      expect(n.ignore?.words.length).toBeLessThanOrEqual(60);
      if (n.episode !== undefined) expect(n.episode).not.toMatch(/^\d+$/);
      if (n.badge !== undefined) expect(n.badge.length).toBeLessThanOrEqual(40);
      if (n.nature !== 'problem') expect(n.link?.kind).not.toBe('ask');
    }
    expect(line(s, 'full-2')).toMatchObject({
      check: 'qnap.volume_full',
      subject: { id: 'volume:2', name: 'Backups' },
      nature: 'problem',
      band: 85,
      link: { kind: 'ask' },
    });
  });

  it('keys a disk on its serial, else its bay; a failing disk is only you, one QTS can’t read a heads-up', async () => {
    const s = await snapshot();
    expect(line(s, 'disk-4')).toMatchObject({
      check: 'qnap.disk',
      subject: { id: 'disk:S6PXXX' },
      nature: 'you',
      episode: 'abnormal',
      link: { kind: 'url' },
    });
    expect(line(s, 'disk-2')).toMatchObject({ nature: 'you', tone: 'warn' });
    const unknown = {
      ...s,
      disks: (s.disks ?? []).map((d) => (d.id === '2' ? { ...d, health: 'Unknown', serial: null } : d)),
    };
    expect(line(unknown, 'disk-2')).toMatchObject({
      tone: 'info',
      nature: 'fyi',
      subject: { id: 'disk:bay2' },
    });
  });

  it('makes warm disks and a warm box heads-ups and hot ones only you, after two passes', async () => {
    const s = await snapshot();
    expect(line(s, 'hot-2')).toMatchObject({ check: 'qnap.disk_temp', nature: 'fyi', confirm: 2 });
    const box = (systemC: number) => line({ ...s, system: { ...(s.system as QnapSystem), systemC } }, 'warm');
    expect(box(62)).toMatchObject({ tone: 'warn', nature: 'fyi', confirm: 2 });
    expect(box(72)).toMatchObject({ tone: 'bad', nature: 'you', link: { kind: 'url' } });
  });

  it('skips the checks of the parts that didn’t answer', async () => {
    expect(qnapSkipped(await snapshot())).toEqual([]);
    const s = await snapshot(['/cgi-bin/disk/qsmart.cgi', '/cgi-bin/management/chartReq.cgi']);
    expect(qnapSkipped(s)).toEqual(['qnap.volume_full', 'qnap.disk', 'qnap.disk_temp']);
    answering(['/cgi-bin/disk/qsmart.cgi']);
    forgetKindReads(services);
    const seen = await QNAP_KIND.seen?.(services, row, now, 'UTC');
    expect(seen?.skipped).toEqual(['qnap.disk', 'qnap.disk_temp']);
  });
});
