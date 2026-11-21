/** Grafana's page from real answers of Grafana 13.2.4 (service-dashboards.md SD-46). Pure. */
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import {
  GRAFANA_ALERTS,
  GRAFANA_DASHBOARDS,
  GRAFANA_DATASOURCES,
  GRAFANA_HEALTH,
  GRAFANA_HEALTH_ERROR,
  GRAFANA_HEALTH_NONE,
  GRAFANA_HEALTH_OK,
  GRAFANA_HISTORY,
  GRAFANA_RULES,
  GRAFANA_STARRED,
} from './fixtures/grafana';
import {
  GRAFANA_CHECKS,
  type GrafanaSnapshot,
  grafanaKpis,
  grafanaLink,
  grafanaNotices,
  grafanaSkipped,
  grafanaStatus,
  grafanaView,
  grafanaWeek,
  parseAlerts,
  parseHistory,
  parseRules,
  parseSources,
  parseStarred,
  sourceHealth,
} from './grafana';

const NOW = new Date('2026-10-21T20:47:30Z');
const BASE = 'https://grafana.home.example';
const TZ = 'Europe/Amsterdam';
const DAY = 86_400_000;

function snapshot(): GrafanaSnapshot {
  const health = [GRAFANA_HEALTH_NONE, GRAFANA_HEALTH_ERROR, GRAFANA_HEALTH_OK];
  const status = [500, 400, 200];
  const { firing, silenced } = parseAlerts(GRAFANA_ALERTS, BASE);
  const { pending, rules, errors } = parseRules(GRAFANA_RULES);
  return {
    readAt: NOW,
    version: GRAFANA_HEALTH.version,
    database: GRAFANA_HEALTH.database,
    firing,
    silenced,
    pending,
    rules,
    ruleErrors: errors,
    sources: parseSources(GRAFANA_DATASOURCES).map((s, i) => ({
      ...s,
      ...sourceHealth(status[i] as number, health[i]),
    })),
    starred: parseStarred(GRAFANA_STARRED, BASE),
    dashboards: GRAFANA_DASHBOARDS.length,
    // The recorded history, moved to the test's week: the firing yesterday.
    history: {
      ...parseHistory(GRAFANA_HISTORY),
      firings: [new Date(NOW.getTime() - DAY)],
      oldest: new Date(NOW.getTime() - DAY),
    },
  };
}

describe('grafana', () => {
  it('reads firing alerts with their page on the connection’s address', () => {
    const { firing, silenced } = parseAlerts(GRAFANA_ALERTS, BASE);
    expect(silenced).toBe(0);
    expect(firing).toHaveLength(1);
    expect(firing[0]).toMatchObject({
      id: '1a6b2e0dbf55c214',
      rule: 'disk-full',
      calm: false,
      name: 'Disk almost full',
      folder: 'Homelab',
      critical: true,
      url: `${BASE}/alerting/grafana/disk-full/view`,
    });
    expect(grafanaLink('https://grafana.example.com/x', BASE, null)).toBe('https://grafana.example.com/x');
    expect(grafanaLink(null, BASE, '/alerting/list')).toBe(`${BASE}/alerting/list`);
  });

  it('reads pending rules and counts alerting ones', () => {
    expect(parseRules(GRAFANA_RULES)).toEqual({
      pending: [{ name: 'Backup is late', folder: 'Homelab' }],
      rules: 2,
      errors: 0,
    });
  });

  it('tells working, failing and unchecked data sources apart', () => {
    expect(sourceHealth(200, GRAFANA_HEALTH_OK).health).toBe('ok');
    expect(sourceHealth(400, GRAFANA_HEALTH_ERROR).health).toBe('failing');
    expect(sourceHealth(500, GRAFANA_HEALTH_NONE).health).toBe('unknown');
    expect(sourceHealth(404, null).health).toBe('unknown');
  });

  it('has four figures and a line per firing alert', () => {
    const s = snapshot();
    const kpis = grafanaKpis(s);
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value, k.rest ?? null, k.tone ?? null])).toEqual([
      ['firing', '1', null, 'bad'],
      ['pending', '1', null, null],
      ['sources', '2', 'of 3', 'warn'],
      ['version', '13.2.4', null, null],
    ]);
    const notices = grafanaNotices(s, BASE, NOW);
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.id, n.tone])).toEqual([
      ['alert-disk-full', 'bad'],
      ['source-prom-down', 'warn'],
    ]);
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id, n.ignore?.lifts])).toEqual([
      ['grafana.alert', 'problem', 'rule:disk-full', 'newer'],
      ['grafana.source', 'problem', 'source:prom-down', 'fixed'],
    ]);
    expect(notices[0]).toMatchObject({ link: { kind: 'ask' }, badge: 'Disk almost full firing' });
    expect(notices[0]?.episode).toMatch(/^[0-9a-f]{8}$/);
    for (const n of notices) expect(GRAFANA_CHECKS.map((c) => c.check)).toContain(n.check);
    // The lines decide warn and bad (QN-S30): the head says what fires.
    expect(grafanaStatus(s)).toEqual({ status: 'ok', badge: '1 alert firing' });
  });

  it('makes one line per rule, a heads-up for calm severities, and a new firing a new episode', () => {
    const s = snapshot();
    const a = s.firing?.[0];
    if (!a) throw new Error('alert');
    const twice = { ...s, firing: [a, { ...a, id: 'f2', since: NOW }] };
    const lines = grafanaNotices(twice, BASE, NOW).filter((n) => n.check === 'grafana.alert');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toContain('2 of them');
    expect(lines[0]?.episode).not.toBe(grafanaNotices(s, BASE, NOW)[0]?.episode);
    const calm = { ...s, firing: [{ ...a, calm: true }] };
    expect(grafanaNotices(calm, BASE, NOW)[0]).toMatchObject({
      nature: 'fyi',
      tone: 'info',
      link: { kind: 'url' },
    });
    expect(
      parseAlerts(
        [{ fingerprint: 'x', status: { state: 'active' }, labels: { alertname: 'DatasourceNoData' } }],
        BASE,
      ).firing[0]?.calm,
    ).toBe(true);
    const many = {
      ...s,
      firing: Array.from({ length: 11 }, (_, i) => ({
        ...a,
        id: `f${i}`,
        rule: `r${i}`,
        name: `Alert ${i}`,
      })),
    };
    const all = grafanaNotices(many, BASE, NOW).filter((n) => n.check === 'grafana.alert');
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({
      id: 'alerts-more',
      subject: { id: '+more', name: '9 more' },
      tone: 'bad',
    });
  });

  it('says which checks it couldn’t read', () => {
    const s = snapshot();
    expect(grafanaSkipped(s)).toEqual([]);
    expect(grafanaSkipped({ ...s, database: null, firing: null, sources: null })).toEqual([
      'grafana.database',
      'grafana.alert',
      'grafana.source',
    ]);
  });

  it('is a warn line for an alert that isn’t critical, and calm with nothing firing', () => {
    const s = snapshot();
    const warn = { ...s, firing: (s.firing ?? []).map((a) => ({ ...a, critical: false })) };
    expect(grafanaNotices(warn, BASE, NOW)[0]?.tone).toBe('warn');
    const calm = { ...s, firing: [], sources: (s.sources ?? []).filter((d) => d.health !== 'failing') };
    expect(grafanaNotices(calm, BASE, NOW)).toEqual([]);
    expect(grafanaStatus(calm).status).toBe('ok');
  });

  it('reads when an alert started firing from its state history', () => {
    const h = parseHistory(GRAFANA_HISTORY);
    // Normal → Alerting is a firing; Pending, Error and back to Normal aren't.
    expect(h.firings.map((d) => d.toISOString())).toEqual(['2026-11-04T19:24:20.000Z']);
    expect(h).toMatchObject({ changes: 5, full: false, oldest: new Date(1793820230000) });
    expect(
      parseHistory([{ time: 1, newState: 'Alerting (NoData)', prevState: 'Pending' }]).firings,
    ).toHaveLength(1);
    expect(
      parseHistory([{ time: 1, newState: 'Alerting', prevState: 'Alerting (Error)' }]).firings,
    ).toHaveLength(0);
    expect(parseHistory(GRAFANA_HISTORY, 5).full).toBe(true);
  });

  it('is in slots: what fires now, what Grafana holds, the week’s firings, starred dashboards below', () => {
    const view = grafanaView({ snapshot: snapshot(), url: BASE, now: NOW, timeZone: TZ });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['firing', 'inventory', 'week', 'starred']);
    const live = view.panels[0];
    if (live?.kind !== 'gallery') throw new Error('live');
    // The firing alert first with how long, then the rule about to fire, quiet.
    expect(live.items.map((i) => [i.title, i.badge?.text, i.noteEnd ?? null, i.paused ?? false])).toEqual([
      ['Disk almost full', 'Critical', 'for 1 h', false],
      ['Backup is late', 'About to fire', null, true],
    ]);
    expect(live.meta).toBe('1 firing · 1 about to fire');
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('inventory');
    expect(inv.items.map((i) => [i.id, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['rules', '2', '1 firing'],
      ['sources', '3', '1 failing'],
      ['dashboards', '2', '1 starred'],
    ]);
    expect(inv.items[0]?.url).toBe(`${BASE}/alerting/list`);
    const week = view.panels[2];
    if (week?.kind !== 'chart') throw new Error('week');
    expect(week.series[0]?.values).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(week.figure).toEqual({ value: '1', rest: 'firing this week' });
    // The history doesn't reach into the week before: no change.
    expect(week.stats).toBeUndefined();
    expect(view.slots?.machine.map((l) => [l.label, l.value])).toEqual([
      ['Grafana', '13.2.4'],
      ['Database', 'Fine'],
    ]);
  });

  it('says nothing fired, the change on the week before, and leaves the week out without any history', () => {
    const oldest = new Date(NOW.getTime() - 13 * DAY);
    const before = [8, 9, 10].map((d) => new Date(NOW.getTime() - d * DAY));
    const quiet = grafanaWeek({ firings: before, changes: 6, oldest, full: false }, NOW, TZ);
    expect(quiet?.figure).toEqual({ value: 'None', rest: 'fired this week' });
    const now = [new Date(NOW.getTime() - DAY), ...before];
    const twice = grafanaWeek(
      {
        firings: [now[0] as Date, new Date(NOW.getTime() - 2 * DAY), ...before.slice(0, 1)],
        changes: 6,
        oldest,
        full: false,
      },
      NOW,
      TZ,
    );
    expect(twice?.stats?.[0]?.[0]?.text).toBe('+100 %');
    expect(grafanaWeek({ firings: [], changes: 0, oldest: null, full: false }, NOW, TZ)).toBeNull();
    expect(grafanaWeek(null, NOW, TZ)).toBeNull();
    // A full answer: the days before its oldest change have no bar.
    const full = grafanaWeek(
      { firings: [], changes: 1000, oldest: new Date(NOW.getTime() - 2 * DAY), full: true },
      NOW,
      TZ,
    );
    expect(full?.series[0]?.values.slice(0, 4)).toEqual([null, null, null, null]);
  });

  it('keeps the card’s Firing figure and draws a calm page with nothing firing', () => {
    const s = { ...snapshot(), firing: [], pending: [] };
    const view = grafanaView({ snapshot: s, url: BASE, now: NOW, timeZone: TZ });
    expect(slotProblems(view)).toEqual([]);
    const live = view.panels.find((p) => p.id === 'firing');
    expect(live?.kind === 'gallery' && [live.items.length, live.empty]).toEqual([0, 'Nothing is firing.']);
    expect(grafanaKpis(s)[0]).toMatchObject({ key: 'firing', value: '0' });
    const down = grafanaView({ snapshot: { ...s, database: 'failing' }, url: BASE, now: NOW, timeZone: TZ });
    expect(down.slots?.machine[1]).toMatchObject({ value: 'Can’t reach it', tone: 'bad' });
  });
});
