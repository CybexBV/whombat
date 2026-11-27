/** A server's Summary and the host helpers around it, in Dutch; English stays as it was without a locale. */
import type { HostDisk, HostHint, ThingPagePanel } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { checkNumber, ipConfigWords, macError, tagError } from './config';
import {
  dashboardGuests,
  guestsWord,
  serverDashboard,
  serverDashboardHead,
  serverDashboardKind,
  serverDashboardSeries,
  serverDashboardView,
  serverDashboardVolumeSeries,
  serverPageVerdict,
} from './dashboard';
import { DASHBOARD_FIXTURE_IDS, type DashboardFixtureId, dashboardFixtures } from './dashboard-fixtures';
import { hintFixes } from './hints';
import { firewallActionWord, TASK_STATUS_WORDS, taskStatusWords, taskTypes, taskTypeText } from './lifecycle';
import { diskHealth, diskUsageSkipNote, forecastWords } from './space';
import { cpuLine } from './tiles';

const TZ = 'Europe/Amsterdam';
const NOW = Date.parse('2026-10-18T16:00:00Z');
const fx = dashboardFixtures(NOW);

function input(id: DashboardFixtureId) {
  const f = fx[id];
  const detail = f.detail;
  return {
    detail,
    series: f.series('24h', serverDashboardSeries(detail)),
    volumes: f.series('30d', serverDashboardVolumeSeries(detail)),
    guests: Object.fromEntries(dashboardGuests(detail).map((g) => [g.id, f.guestSeries(g.id, '24h')])),
    range: '24h' as const,
    timeZone: TZ,
    now: NOW,
  };
}

function find<K extends ThingPagePanel['kind']>(panels: readonly ThingPagePanel[], id: string, kind: K) {
  const p = panels.find((x) => x.id === id);
  if (!p || p.kind !== kind) throw new Error(`no ${kind} panel ${id}`);
  return p as Extract<ThingPagePanel, { kind: K }>;
}

const byKind = (kind: string): DashboardFixtureId =>
  DASHBOARD_FIXTURE_IDS.find((id) => serverDashboardKind(fx[id].detail) === kind) ?? 'pve-02';

describe('the Summary in Dutch', () => {
  it('stays English without a locale, the same as with English asked for', () => {
    for (const id of DASHBOARD_FIXTURE_IDS) {
      expect(serverDashboardView({ ...input(id), locale: 'en' })).toEqual(serverDashboardView(input(id)));
      expect(serverDashboard(input(id), 'en-GB')).toEqual(serverDashboard(input(id)));
      expect(serverDashboardHead(fx[id].detail, {}, 'en')).toEqual(serverDashboardHead(fx[id].detail));
    }
  });

  it('says the figures, charts and Worth a look in Dutch', () => {
    for (const id of DASHBOARD_FIXTURE_IDS) {
      const panels = serverDashboard(input(id), 'nl-NL');
      const figures = find(panels, 'figures', 'kpis');
      expect(figures.items.map((k) => k.label)).toEqual(expect.arrayContaining(['Processor', 'Geheugen']));
      const memory = find(panels, 'memory', 'chart');
      expect(memory.title).toBe('Geheugen');
      const look = panels.find((p) => p.id === 'look');
      if (look?.kind === 'notices') expect(look.title).toBe('Even naar kijken');
    }
  });

  it('names the busiest table, its columns and range in Dutch', () => {
    const id = byKind('proxmox');
    const t = find(serverDashboard(input(id), 'nl'), 'guests', 'table');
    expect(t.columns.map((c) => c.label)).toEqual(['Naam', 'CPU', 'Geheugen', '24 u']);
    expect(t.meta).toContain(' van ');
    expect(t.meta).toContain('actief');
    expect(t.link?.label).toBe('Alles bekijken');
  });

  it('writes Technical details in Dutch', () => {
    const id = byKind('proxmox');
    const labels = serverDashboardHead(fx[id].detail, {}, 'nl').details.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['Systeem', 'Whombats helper', 'Wat Whombat mag doen']));
    const processor = serverDashboardHead(fx[id].detail, {}, 'nl').details.find(
      (r) => r.label === 'Processor',
    );
    if (processor) expect(processor.value).toMatch(/kern/);
  });

  it('asks the assistant in Dutch', () => {
    const id = byKind('proxmox');
    const view = serverDashboardView({ ...input(id), assistant: 'Neo', locale: 'nl' });
    const links = view.panels.flatMap((p) => (p.kind === 'notices' ? p.items.map((i) => i.link) : []));
    for (const l of links) if (l?.kind === 'ask') expect(l.label).toBe('Vraag Neo');
  });

  it('gives the verdict in Dutch', () => {
    const id = byKind('proxmox');
    const en = serverPageVerdict(fx[id].detail, { now: NOW });
    const nl = serverPageVerdict(fx[id].detail, { now: NOW, locale: 'nl' });
    expect(nl.tone).toBe(en.tone);
  });

  it('calls what runs on a server apps or machines', () => {
    expect(guestsWord('docker')).toBe('Apps');
    expect(guestsWord('proxmox')).toBe('Machines');
    expect(guestsWord('proxmox', 'nl')).toBe('Machines');
  });

  it('counts cores in Dutch', () => {
    expect(cpuLine({ model: 'AMD Ryzen 7', cores: 8, threads: 16 }, 'nl')?.detail).toBe(
      '8 kernen · 16 threads',
    );
    expect(cpuLine({ model: 'AMD Ryzen 7', cores: 1, threads: 0 })?.detail).toBe('1 core');
  });
});

describe('the host helpers in Dutch', () => {
  it('says a guest setting’s errors in Dutch', () => {
    expect(checkNumber('', {}, 'nl').error).toBe('Vul dit in.');
    expect(checkNumber('12', { max: 10 }, 'nl').error).toContain('10');
    expect(checkNumber('', {}).error).toBe('Fill this in.');
    expect(macError('nope', 'nl')).toContain('MAC-adres');
    expect(tagError('!', 'nl')).toContain('tag');
    expect(['!'].map(tagError)[0]).toContain('A tag');
    expect(ipConfigWords(undefined, 'nl')).toBe('Niet ingesteld');
  });

  it('names a hint’s button in Dutch', () => {
    const hint = { kind: 'storage.overcommit', section: '#storage', detail: '' } as HostHint;
    expect(hintFixes(hint, [], 'nl')[0]?.label).toBe('Opslag openen');
    expect(hintFixes(hint, [])[0]?.label).toBe('Open Storage');
  });

  it('names tasks and their state in Dutch, English unchanged', () => {
    expect(taskTypeText('vzdump', 'nl')).toBe('Back-up');
    expect(taskTypeText('vzdump')).toBe('Backup');
    expect(taskTypeText('weird', 'nl')).toBe('weird');
    expect(taskTypes('nl').qmstart).toBe('Starten');
    expect(taskStatusWords('nl').error).toBe('Mislukt');
    expect(TASK_STATUS_WORDS).toEqual({
      running: 'Running',
      ok: 'Done',
      warning: 'Done, with warnings',
      error: 'Failed',
    });
    expect(firewallActionWord('ACCEPT', 'nl')).toBe('Toestaan');
  });

  it('says a disk’s health and a forecast in Dutch', () => {
    const d = { device: 'nvme0n1', model: 'x', wearPct: 4, tempC: 38 } as HostDisk;
    expect(diskHealth(d, 'nl').text).toBe('Gezond');
    expect(diskHealth(d).text).toBe('Healthy');
    expect(diskUsageSkipNote({ ok: false, code: 'spun_down', skippedSpunDown: ['sda'] }, 'nl')).toContain(
      'sda',
    );
    const f = { fullInDays: 150, fullAt: new Date(NOW + 150 * 86_400_000).toISOString(), words: 'Full in x' };
    expect(forecastWords(f, TZ, 'nl')).toContain('maanden');
    expect(forecastWords(f, TZ)).toBe('Full in x');
  });
});
