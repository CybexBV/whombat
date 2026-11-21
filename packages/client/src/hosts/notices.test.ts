import type { HostAlert, HostHint, HostServerDetail, ThingPagePanel } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { lookCount, serverDashboard, serverDashboardHead } from './dashboard';
import { dashboardFixtures } from './dashboard-fixtures';
import {
  alertCounts,
  alertNoticeParts,
  alertQuiet,
  hintCounts,
  hintEntity,
  hintNoticeParts,
  serverNoticeOptions,
  withoutServerNotices,
  withServerNoticeQuiet,
} from './notices';

const TZ = 'Europe/Amsterdam';
const NOW = Date.parse('2026-10-18T16:00:00Z');
const AT = new Date(NOW - 3600_000).toISOString();
const fx = dashboardFixtures(NOW);

const tank: HostAlert = {
  id: 'al_tank',
  serverId: 'pve-02',
  severity: 'critical',
  title: 'tank lost a disk',
  detail: 'The mirror runs on one disk now.',
  openedAt: AT,
  rule: 'pool.degraded',
  state: 'open',
  section: 'storage',
  attention: true,
  entity: 'pool:tank',
  key: 'pool.degraded:pool:tank',
};

const hot: HostAlert = {
  ...tank,
  id: 'al_hot',
  severity: 'warning',
  title: 'pve-02 runs hot',
  rule: 'sensor.temp_high',
  section: 'sensors',
  entity: 'sensor:coretemp-0',
};

const memory: HostHint = {
  serverId: 'pve-02',
  kind: 'memory.low',
  severity: 'warning',
  entity: 'host',
  title: 'Memory is running low',
  detail: '',
  // No tab of its own: nothing leads to a fix.
  section: '',
};

const ignoredByJohn = {
  state: 'ignored' as const,
  words: 'until it’s whole again',
  by: { id: 'prn_john', name: 'John' } as never,
  at: AT,
};

describe('a server’s line (QN-01…QN-03, QN-23; AP-4810)', () => {
  it('takes its check, kind and item from the hosts service’s rule and entity', () => {
    expect(alertNoticeParts(tank)).toEqual({
      nature: 'you',
      check: 'host.pool.degraded',
      subject: { id: 'pool:tank', name: 'tank' },
    });
    expect(alertNoticeParts(hot, { quiet: true })).toMatchObject({
      nature: 'problem',
      check: 'host.sensor.temp_high',
      subject: { id: 'sensor:coretemp-0' },
      ignore: { lifts: 'fixed', words: 'Until it cools down.' },
    });
    // Not per item: no subject; the server as a whole.
    expect(hintNoticeParts(memory).subject).toBeUndefined();
    // A guest is named by its name.
    const g = alertNoticeParts(
      { ...tank, rule: 'guest.restart_loop', entity: 'pve:131' },
      { guests: [{ id: 'pve:131', name: 'homeassistant' }] },
    );
    expect(g.subject).toEqual({ id: 'pve:131', name: 'homeassistant' });
    // A sensor by its label.
    const names = serverNoticeOptions({ sensors: [{ id: 'coretemp-0', label: 'CPU package' } as never] }, []);
    expect(alertNoticeParts(hot, names).subject).toEqual({ id: 'sensor:coretemp-0', name: 'CPU package' });
  });

  it('reads a hint’s entity from its id when an older field is empty, and its kind by severity', () => {
    expect(hintEntity({ kind: 'disk.space', entity: '', id: 'disk.space:fs:/srv' })).toBe('fs:/srv');
    const pool = { ...memory, kind: 'incus.pool_full', entity: 'pool:default' };
    expect(hintNoticeParts({ ...pool, severity: 'warning' }).nature).toBe('problem');
    expect(hintNoticeParts({ ...pool, severity: 'info' }).nature).toBe('fyi');
  });

  it('is quiet from the runtime, or from an older runtime’s acknowledgement', () => {
    expect(alertNoticeParts({ ...tank, quiet: ignoredByJohn }).quiet).toEqual(ignoredByJohn);
    const acked = { ...tank, acknowledged: { at: AT, by: 'hub', note: '', until: null } };
    expect(alertQuiet(acked)).toMatchObject({ state: 'ignored', words: 'until it’s whole again' });
    const snoozed = { ...tank, acknowledged: { at: AT, by: 'hub', note: '', until: '2026-10-19T07:00:00Z' } };
    expect(alertQuiet(snoozed, { timeZone: TZ, now: NOW })).toMatchObject({
      state: 'snoozed',
      words: 'until tomorrow 09:00',
    });
  });

  it('counts only what asks for a look: not quiet, muted, suppressed or a heads-up', () => {
    expect(alertCounts(tank)).toBe(true);
    expect(alertCounts({ ...tank, quiet: ignoredByJohn, attention: false })).toBe(false);
    expect(alertCounts({ ...tank, muted: true, attention: false })).toBe(false);
    expect(alertCounts({ ...tank, suppressedBy: 'pve-01', attention: false })).toBe(false);
    expect(hintCounts(memory)).toBe(true);
    expect(hintCounts({ ...memory, kind: 'sensor.near_limit' })).toBe(false);
    expect(hintCounts({ ...memory, quiet: { ...ignoredByJohn, words: 'until it gets worse' } })).toBe(false);
  });
});

function notices(panels: readonly ThingPagePanel[], id: string) {
  const p = panels.find((x) => x.id === id);
  return p?.kind === 'notices' ? p.items : [];
}

function summary(detail: HostServerDetail, quiet = false) {
  return serverDashboard({ detail, range: '24h', timeZone: TZ, now: NOW, quiet });
}

describe('the Summary’s Worth a look (QN-02, QN-14, QN-S49; AP-4811, AP-4812)', () => {
  const base = fx['pve-02'].detail;

  it('puts what asks first, heads-ups after, quiet lines last; links by kind', () => {
    const d: HostServerDetail = {
      ...base,
      alerts: [{ ...tank, quiet: ignoredByJohn, attention: false }, hot],
      hints: [...base.hints, memory],
    };
    const items = notices(summary(d, true), 'look');
    expect(items.map((n) => [n.title, n.nature, !!n.quiet])).toEqual([
      ['pve-02 runs hot', 'problem', false],
      ['Memory is running low', 'problem', false],
      ['CPU package at 79 °C', 'fyi', false],
      ['Storage “local-lvm” full in about 5 months', 'fyi', false],
      ['3 updates waiting', 'fyi', false],
      ['tank lost a disk', 'you', true],
    ]);
    const by = Object.fromEntries(items.map((n) => [n.title, n]));
    expect(by['pve-02 runs hot']?.link?.kind).toBe('ask');
    // A problem with no way to fix it asks with its own question.
    expect(by['Memory is running low']?.link?.kind).toBe('ask');
    // A heads-up never asks; a quiet line keeps no link.
    expect(by['CPU package at 79 °C']?.link?.kind).not.toBe('ask');
    expect(by['tank lost a disk']?.link).toBeUndefined();
    expect(by['pve-02 runs hot']?.ignore?.words).toBe('Until it cools down.');
    expect(lookCount(d)).toBe(2);
  });

  it('gives Ignore only to who may quiet the server', () => {
    const d: HostServerDetail = { ...base, alerts: [hot] };
    expect(notices(summary(d), 'look').every((n) => !n.ignore)).toBe(true);
    expect(notices(summary(d, true), 'look')[0]?.ignore).toBeTruthy();
  });

  it('matches the banner to its alert by id, quiets it with the alert, and leaves it out once quiet', () => {
    const banner = {
      severity: 'critical' as const,
      title: 'Storage needs you',
      detail: '',
      section: null,
      alertId: 'al_tank',
      rule: 'pool.degraded',
    };
    const d: HostServerDetail = {
      ...base,
      server: { ...base.server, status: 'bad' },
      alerts: [tank, hot],
      banner,
    };
    const top = notices(summary(d, true), 'banner')[0];
    expect(top).toMatchObject({ check: 'host.pool.degraded', subject: { id: 'pool:tank' }, nature: 'you' });
    expect(top?.link?.kind).not.toBe('ask');
    expect(notices(summary(d, true), 'look').map((n) => n.title)).not.toContain('tank lost a disk');
    const quiet = { ...d, alerts: [{ ...tank, quiet: ignoredByJohn, attention: false }, hot] };
    expect(notices(summary(quiet, true), 'banner')).toEqual([]);
    expect(serverDashboardHead({ ...quiet, server: { ...quiet.server, statusNote: null } }).badge).toBe(
      '1 to look at',
    );
  });
});

describe('the server’s page the moment it changes (AP-4814)', () => {
  const d: HostServerDetail = { ...fx['pve-02'].detail, alerts: [tank, hot], hints: [memory] };

  it('quiets an alert or a hint at once, and takes it back', () => {
    const q = withServerNoticeQuiet(d, { check: 'host.pool.degraded', subject: 'pool:tank' }, ignoredByJohn);
    expect(q.alerts?.find((a) => a.id === 'al_tank')).toMatchObject({
      quiet: ignoredByJohn,
      attention: false,
    });
    expect(q.alerts?.find((a) => a.id === 'al_hot')?.quiet).toBeUndefined();
    const back = withServerNoticeQuiet(q, { check: 'host.pool.degraded', subject: 'pool:tank' }, null);
    expect(back.alerts?.find((a) => a.id === 'al_tank')).toMatchObject({
      attention: true,
      acknowledged: null,
    });
    const h = withServerNoticeQuiet(d, { check: 'host.hint.memory.low' }, ignoredByJohn);
    expect(h.hints[0]?.quiet).toEqual(ignoredByJohn);
  });

  it('leaves out the lines of a check it stops watching, for one item or all', () => {
    expect(withoutServerNotices(d, 'host.pool.degraded', 'pool:tank').alerts?.map((a) => a.id)).toEqual([
      'al_hot',
    ]);
    expect(withoutServerNotices(d, 'host.pool.degraded', 'pool:other').alerts).toHaveLength(2);
    expect(withoutServerNotices(d, 'host.hint.memory.low').hints).toEqual([]);
  });
});
