import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import {
  ADGUARD_CHECKS,
  adguardNames,
  busiestDevices,
  type DnsCtx,
  type DnsSnapshot,
  dnsButtons,
  dnsKpis,
  dnsNotices,
  dnsSkipped,
  dnsTrend,
  dnsVerdict,
  dnsView,
  hourly,
  hourWords,
  listRows,
  newer,
  PIHOLE_CHECKS,
  parseAdguard,
  parsePihole,
  twoHours,
} from './dns';
import {
  ADGUARD_clients,
  ADGUARD_filtering,
  ADGUARD_stats,
  ADGUARD_status,
  ADGUARD_statusOff,
  ADGUARD_statusPaused,
  ADGUARD_version,
} from './fixtures/adguard';
import {
  PIHOLE_blocking,
  PIHOLE_blockingOff,
  PIHOLE_blockingPaused,
  PIHOLE_history,
  PIHOLE_lists,
  PIHOLE_messages,
  PIHOLE_summary,
  PIHOLE_topBlocked,
  PIHOLE_topClients,
  PIHOLE_version,
} from './fixtures/pihole';

// The fixtures were read on 2026-10-21 around 19:40 UTC.
const ROW = {
  access: 'manage',
  label: 'Pi-hole',
  catalogId: 'pihole',
  fields: {},
} as unknown as CatalogConnectionRow;
const LOOK = { ...ROW, access: 'read' } as CatalogConnectionRow;
const NOW = new Date('2026-10-21T19:45:00Z');

const pihole = (over: Partial<Parameters<typeof parsePihole>[0]> = {}, now = NOW) =>
  parsePihole(
    {
      summary: PIHOLE_summary,
      topBlocked: PIHOLE_topBlocked,
      topClients: PIHOLE_topClients,
      history: PIHOLE_history,
      messages: PIHOLE_messages,
      version: PIHOLE_version,
      lists: PIHOLE_lists,
      blocking: PIHOLE_blocking,
      ...over,
    },
    now,
  );

const adguard = (over: Partial<Parameters<typeof parseAdguard>[0]> = {}) =>
  parseAdguard(
    {
      stats: ADGUARD_stats,
      status: ADGUARD_status,
      filtering: ADGUARD_filtering,
      version: ADGUARD_version,
      ...over,
    },
    NOW,
  );

const ctx = (over: Partial<DnsCtx> = {}): DnsCtx => ({
  now: NOW,
  timeZone: 'Europe/Amsterdam',
  range: '24h',
  buttons: { row: ROW },
  points: { queries: [], blocked: [] },
  ...over,
});

describe('Pi-hole', () => {
  it('reads the summary, lists, blocking and its version', () => {
    const s = pihole();
    expect(s.queries).toBe(32);
    expect(s.blocked).toBe(15);
    expect(s.blockedPct).toBeCloseTo(46.875);
    expect(s.clients).toBe(1);
    expect(s.domainsBlocked).toBe(71493);
    expect(s.blocking).toEqual({ on: true, until: null });
    expect(s.version).toBe('v6.5');
    expect(s.update).toBeNull();
    expect(s.lists).toHaveLength(1);
    expect(s.lists?.[0]).toMatchObject({ rules: 71493, enabled: true, failed: false });
    expect(s.lists?.[0]?.name).toBe('StevenBlack/hosts');
    expect(s.topBlocked?.[0]).toEqual({ domain: 'doubleclick.net', count: 3 });
    expect(s.gravityAt?.getTime()).toBe(1792611580_000);
  });

  it('turns ten-minute buckets into hours', () => {
    const s = pihole();
    const total = (PIHOLE_history.history as { total: number }[]).reduce((n, h) => n + h.total, 0);
    expect(s.hours?.reduce((n, h) => n + h.total, 0)).toBe(total);
    expect(s.hours?.every((h) => h.at.getUTCMinutes() === 0)).toBe(true);
    expect(hourly([{ at: new Date('2026-10-21T10:10:00Z'), total: 3, blocked: 1 }])).toEqual([
      { at: new Date('2026-10-21T10:00:00Z'), total: 3, blocked: 1 },
    ]);
  });

  it('says how long a pause lasts: a heads-up; off for good is red and only a person’s (QN-04)', () => {
    const paused = pihole({ blocking: PIHOLE_blockingPaused });
    expect(paused.blocking?.on).toBe(false);
    expect(paused.blocking?.until?.getTime()).toBe(NOW.getTime() + 300_000);
    const pn = dnsNotices(paused, ctx()).find((n) => n.id === 'blocking-off');
    expect(pn).toMatchObject({ tone: 'info', nature: 'fyi', check: 'dns.blocking_off', badge: 'Paused' });
    expect(pn?.title).toContain('21:50');
    // A new pause is a new line: its end is the episode.
    expect(pn?.episode).toBe(new Date(NOW.getTime() + 300_000).toISOString());
    expect(pn?.ignore?.lifts).toBe('newer');

    const off = pihole({ blocking: PIHOLE_blockingOff });
    expect(off.blocking).toEqual({ on: false, until: null });
    const on = dnsNotices(off, ctx()).find((n) => n.id === 'blocking-off');
    expect(on).toMatchObject({ tone: 'bad', nature: 'you', badge: 'Blocking off' });
    expect(on?.link).toBeUndefined();
    expect(on?.ignore).toEqual({ lifts: 'fixed', words: 'Until blocking is back on.' });
    // The head comes from the lines now.
    expect(dnsView(off, ctx()).status).toBeUndefined();
    expect(dnsKpis(off, ctx()).find((k) => k.key === 'blocked')?.tone).toBe('bad');
  });

  it('notices old lists, failed downloads, its messages and an update', () => {
    const later = new Date(NOW.getTime() + 9 * 86_400_000);
    const lists = { lists: [{ ...(PIHOLE_lists.lists[0] as object), status: 3 }] };
    const s = pihole(
      {
        lists,
        messages: {
          messages: [{ id: 7, timestamp: 1792611000, type: 'LOAD', plain: 'Long-term load above 4' }],
        },
        version: {
          version: {
            ...PIHOLE_version.version,
            core: { local: { version: 'v6.5' }, remote: { version: 'v6.6' } },
          },
        },
      },
      later,
    );
    const lines = dnsNotices(s, ctx({ now: later }));
    expect(lines.map((n) => [n.id, n.check, n.nature, n.tone])).toEqual([
      // Status 3: the old copy still blocks, a heads-up.
      ['list-failed-1', 'dns.list_failed', 'fyi', 'info'],
      ['lists-old', 'dns.lists_old', 'problem', 'warn'],
      // A load message says how it is used: a heads-up without an ask.
      ['message-7', 'dns.message', 'fyi', 'info'],
      ['update', 'dns.update', 'fyi', 'info'],
    ]);
    expect(lines[0]?.subject).toEqual({ id: 'list:1', name: 'StevenBlack/hosts' });
    expect(lines[0]?.link).toBeUndefined();
    // A problem asks with its own question (QN-S49).
    expect(lines[1]?.link).toMatchObject({ kind: 'ask' });
    expect(lines[2]?.link).toBeUndefined();
    expect(lines[3]?.episode).toBe('v6.6');
    expect(s.update).toBe('v6.6');
    expect(dnsKpis(s, ctx({ now: later })).find((k) => k.key === 'lists')?.tone).toBe('warn');
    expect(listRows(s, later)[0]?.cells.name?.dot).toBe('warn');
  });

  it('gives the four figures in order, and the chart stacked', () => {
    expect(dnsKpis(pihole(), ctx()).map((k) => [k.key, k.value])).toEqual([
      ['queries', '32'],
      ['blocked', '46.9 %'],
      ['clients', '1'],
      ['lists', '1'],
    ]);
    const chart = dnsTrend(pihole(), 'Europe/Amsterdam');
    expect(chart?.style).toBe('bars');
    expect(chart?.series.map((x) => x.key)).toEqual(['allowed', 'blocked']);
    expect(chart?.timestamps.length).toBe(chart?.series[0]?.values.length);
    expect(chart?.labels).toHaveLength(chart?.timestamps.length ?? 0);
  });

  it('names clients', () => {
    expect(busiestDevices(pihole())?.items[0]).toMatchObject({ label: 'localhost', person: true });
  });

  it('offers pause, resume and update with the access applied', () => {
    const on = dnsButtons(pihole(), { row: ROW });
    expect(on.map((b) => [b.action, b.value ?? null, !!b.confirm])).toEqual([
      ['pause', 300, false],
      ['pause', 1800, true],
      ['update-lists', null, false],
    ]);
    const off = dnsButtons(pihole({ blocking: PIHOLE_blockingOff }), { row: LOOK });
    expect(off.map((b) => b.action)).toEqual(['resume', 'update-lists']);
    expect(off.every((b) => !b.allowed && b.reason?.includes('Look only'))).toBe(true);
    expect(on.every((b) => b.allowed)).toBe(true);
  });

  it('a list that failed with nothing kept and a real message are problems, one line each (QN-03)', () => {
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    const lists = { lists: [{ ...(PIHOLE_lists.lists[0] as object), status: 4 }] };
    const messages = {
      messages: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        type: 'ADLIST',
        plain: `List ${i + 1} is bad`,
      })),
    };
    const lines = dnsNotices(pihole({ lists, messages }, later), ctx({ now: later }));
    expect(lines[0]).toMatchObject({
      check: 'dns.list_failed',
      nature: 'problem',
      tone: 'warn',
      link: { kind: 'ask' },
    });
    const said = lines.filter((n) => n.check === 'dns.message');
    expect(said).toHaveLength(3);
    expect(said[0]).toMatchObject({ nature: 'problem', subject: { id: 'message:1' }, link: { kind: 'ask' } });
    expect(said[2]).toMatchObject({ subject: { id: '+more', name: '8 more' }, ignore: { lifts: 'newer' } });
  });

  it('lists from last week aren’t old yet: Pi-hole rebuilds them weekly (QN-04)', () => {
    const eightDays = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(dnsNotices(pihole({}, eightDays), ctx({ now: eightDays })).map((n) => n.id)).not.toContain(
      'lists-old',
    );
  });

  it('leaves out of lifting the parts it couldn’t read (QN-S21)', () => {
    expect(dnsSkipped(pihole())).toEqual([]);
    expect(dnsSkipped(pihole({ messages: null, version: null, lists: null, blocking: null }))).toEqual([
      'dns.blocking_off',
      'dns.list_failed',
      'dns.message',
      'dns.update',
    ]);
    expect(dnsSkipped(adguard({ filtering: null }))).toEqual([
      'dns.list_failed',
      'dns.lists_old',
      'dns.filtering_off',
    ]);
    expect(PIHOLE_CHECKS.map((c) => c.check)).not.toContain('dns.not_running');
    expect(ADGUARD_CHECKS.map((c) => c.check)).not.toContain('dns.message');
  });
});

describe('AdGuard Home', () => {
  it('reads its stats, protection and filters', () => {
    const s = adguard();
    expect(s.queries).toBe(50);
    expect(s.blocked).toBe(16);
    expect(s.blockedPct).toBeCloseTo(32);
    expect(s.clients).toBe(1);
    expect(s.version).toBe('v0.107.79');
    expect(s.update).toBeNull();
    expect(s.blocking).toEqual({ on: true, until: null });
    expect(s.lists?.map((l) => [l.name, l.enabled])).toEqual([
      ['AdGuard DNS filter', true],
      ['AdAway Default Blocklist', false],
    ]);
    expect(s.hours).toHaveLength(24);
    expect(s.hours?.at(-1)?.total).toBe(50);
    expect(s.topBlocked?.[0]).toEqual({ domain: 'doubleclick.net', count: 6 });
  });

  it('knows a pause from protection off for good', () => {
    expect(adguard({ status: ADGUARD_statusPaused }).blocking?.until?.getTime()).toBe(NOW.getTime() + 299953);
    expect(adguard({ status: ADGUARD_statusOff }).blocking).toEqual({ on: false, until: null });
    const n = dnsNotices(adguard({ status: ADGUARD_statusOff }), ctx()).find((x) => x.id === 'blocking-off');
    expect(n?.tone).toBe('bad');
    expect(n?.title).toMatch(/^Protection/);
    expect(n?.badge).toBe('Protection off');
  });

  it('says the time its counts cover: its statistics’ interval, by the hour or by the day', () => {
    const sub = (s: DnsSnapshot, key: string) => dnsKpis(s, ctx()).find((k) => k.key === key)?.sub;
    expect(sub(adguard(), 'queries')).toBe('last 24 hours');
    const week = adguard({
      stats: { ...ADGUARD_stats, time_units: 'days', dns_queries: [5, 6, 7, 8, 9, 10, 5] },
    });
    expect(sub(week, 'queries')).toBe('last 7 days');
    expect(sub(week, 'clients')).toBe('last 7 days');
  });

  it('says an update only when the build checks for them', () => {
    expect(adguard({ version: { new_version: 'v0.107.80', can_autoupdate: true } }).update).toBe('v0.107.80');
    expect(adguard({ version: { disabled: true } }).update).toBeNull();
  });

  it('leaves out what it couldn’t read', () => {
    const s: DnsSnapshot = adguard({ stats: null, filtering: null });
    expect(s.queries).toBeNull();
    const view = dnsView(s, ctx());
    expect(view.kpis).toEqual([]);
    // Only whether it blocks: no counts, lists, lookups or devices.
    expect(view.panels.map((p) => p.id)).toEqual(['blocking-now']);
    expect(view.charts).toEqual([]);
    expect(slotProblems(view)).toEqual([]);
  });

  it('names the busiest devices as AdGuard knows them: a person’s name first, then its hosts file', () => {
    const names = adguardNames(ADGUARD_clients);
    expect(names.get('127.0.0.1')).toBe('Annas iPhone');
    expect(names.get('172.20.0.3')).toBe('53eac543bf1a');
    const people = busiestDevices(adguard({ clients: ADGUARD_clients }));
    expect(people?.items[0]).toMatchObject({ label: 'Annas iPhone', note: '127.0.0.1', value: '50' });
    // Without its clients' names, the address.
    expect(busiestDevices(adguard())?.items[0]?.label).toBe('127.0.0.1');
  });
});

describe('the Summary in slots', () => {
  const ids = (view: ReturnType<typeof dnsView>) => view.panels.map((p) => [p.id, p.kind, p.span ?? null]);
  const panel = <K extends ThingPagePanel['kind']>(view: ReturnType<typeof dnsView>, id: string, kind: K) =>
    view.panels.find((p) => p.id === id && p.kind === kind) as Extract<ThingPagePanel, { kind: K }>;

  it('Pi-hole: blocking now with its pauses, lists and devices, the last 24 hours, the busiest devices', () => {
    const view = dnsView(pihole(), ctx());
    expect(slotProblems(view)).toEqual([]);
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(ids(view)).toEqual([
      ['blocking-now', 'list', 2],
      ['inventory', 'list', 1],
      ['queries', 'chart', 1],
      ['top-clients', 'bars', 1],
      ['top-blocked', 'bars', null],
    ]);
    expect(view.kpis).toEqual([]);
    expect(view.buttons).toEqual([]);
    const live = panel(view, 'blocking-now', 'list');
    expect(live.items.map((i) => [i.id, i.right, i.tone ?? null])).toEqual([
      ['blocking', 'On', 'ok'],
      ['blocked', '46.9 %', null],
    ]);
    expect(live.items[0]?.actions?.map((b) => [b.label, !!b.confirm])).toEqual([
      ['Pause 5 min', false],
      ['Pause 30 min', true],
    ]);
    expect(live.items[1]?.detail).toContain('15 of 32 lookups');
    const inv = panel(view, 'inventory', 'list');
    expect(inv.items.map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['lists', '1', '+1 this week'],
      ['clients', '1', 'active · 1 seen'],
    ]);
    expect(inv.items[0]?.detail).toContain('71,493 domains');
    expect(inv.items[0]?.actions?.map((b) => b.action)).toEqual(['update-lists']);
    const trend = panel(view, 'queries', 'chart');
    expect(trend.labels?.at(-1)).toBe('Now');
    expect(trend.labels?.every((l) => l.length <= 3)).toBe(true);
    expect(trend.figure).toMatchObject({ value: '32', rest: 'lookups' });
    expect(view.tabs.map((t) => [t.key, t.count])).toEqual([['lists', 1]]);
    expect(view.slots?.machine.map((l) => [l.label, l.value, l.sub])).toEqual([
      ['Pi-hole', 'v6.5', 'Up to date'],
    ]);
  });

  it('lists say what changed: none after a week, older than nine days, one that failed', () => {
    const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
    const note = (s: DnsSnapshot, now: Date) =>
      panel(dnsView(s, ctx({ now })), 'inventory', 'list').items[0]?.figure;
    expect(note(pihole({}, at(8)), at(8))).toEqual({ value: '1', note: 'All on' });
    expect(note(pihole({}, at(10)), at(10))).toMatchObject({ note: 'Getting old', tone: 'warn' });
    const s = pihole();
    const failed: DnsSnapshot = { ...s, lists: (s.lists ?? []).map((l) => ({ ...l, failed: true })) };
    expect(note(failed, NOW)).toMatchObject({ note: '1 failed to update', tone: 'warn' });
  });

  it('paused: Resume instead of the pauses, and Blocked says until when in amber', () => {
    const view = dnsView(pihole({ blocking: PIHOLE_blockingPaused }), ctx());
    const live = panel(view, 'blocking-now', 'list');
    expect(live.items[0]).toMatchObject({ right: 'Off until 21:50', tone: 'warn' });
    expect(live.items[0]?.actions?.map((b) => b.label)).toEqual(['Resume']);
    expect(live.items[1]?.figure).toMatchObject({ note: 'Blocking is off until 21:50', tone: 'warn' });
    // On Look only every button is refused.
    const look = panel(dnsView(pihole(), ctx({ buttons: { row: LOOK } })), 'blocking-now', 'list');
    expect(look.items[0]?.actions?.every((b) => !b.allowed)).toBe(true);
  });

  it('AdGuard Home: the same slots, rules instead of domains', () => {
    const view = dnsView(
      adguard({ clients: ADGUARD_clients }),
      ctx({ buttons: { row: { ...ROW, catalogId: 'adguard' } as CatalogConnectionRow } }),
    );
    expect(slotProblems(view)).toEqual([]);
    expect(ids(view).map((x) => x[0])).toEqual([
      'blocking-now',
      'inventory',
      'queries',
      'top-clients',
      'top-blocked',
    ]);
    const inv = panel(view, 'inventory', 'list');
    expect(inv.items[0]?.detail).toContain('190,469 rules');
    expect(inv.items[1]?.figure?.note).toBe('last 24 hours');
    expect(panel(view, 'blocking-now', 'list').items[0]?.title).toBe('Protection');
  });

  it('the last 24 hours in bars of two hours from an even hour, so midnight is between two', () => {
    // 2026-10-21 in Amsterdam is UTC + 2: 00:00 UTC is 02:00 there.
    const at = (h: number) => new Date(Date.UTC(2026, 9, 21, h));
    const hours = Array.from({ length: 24 }, (_, i) => ({ at: at(i), total: i, blocked: 1 }));
    const bars = twoHours(hours, 'Europe/Amsterdam');
    expect(bars).toHaveLength(12);
    expect(bars[0]).toEqual({ at: at(0), total: 1, blocked: 2 });
    expect(bars.at(-1)).toEqual({ at: at(22), total: 45, blocked: 2 });
    // Starting at an odd hour, that hour is a bar of its own.
    const odd = twoHours(hours.slice(1), 'Europe/Amsterdam');
    expect([odd.length, odd[0]?.total]).toEqual([12, 1]);
    expect(
      hourWords(
        odd.map((b) => b.at),
        'Europe/Amsterdam',
      )[1],
    ).toBe('04');
  });

  it('hours as short words, the last one now', () => {
    const at = [
      new Date('2026-10-21T12:00:00Z'),
      new Date('2026-10-21T13:00:00Z'),
      new Date('2026-10-21T14:00:00Z'),
    ];
    expect(hourWords(at, 'Europe/Amsterdam')).toEqual(['14', '15', 'Now']);
  });
});

describe('versions', () => {
  it('compares them', () => {
    expect(newer('v6.5', 'v6.6')).toBe(true);
    expect(newer('v6.5', 'v6.5')).toBe(false);
    expect(newer('2026.10.0', '2026.9.1')).toBe(false);
    expect(newer(null, 'v1')).toBe(false);
  });
});

describe('DNS verdicts and Ask chips', () => {
  it('gives a verdict and Ask chips for both Pi-hole and AdGuard Home', () => {
    const pv = dnsView(pihole(), ctx());
    expect(pv.verdict).toMatch(/Pi-hole is blocking fine.*46\.9 %/);
    expect(pv.panels.find((p) => p.id === 'blocking-now')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    expect(pv.panels.find((p) => p.id === 'inventory')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    expect(pv.panels.find((p) => p.id === 'top-blocked')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    for (const p of pv.panels) ThingPagePanel.parse(p);

    const av = dnsView(adguard(), ctx());
    expect(av.verdict).toMatch(/AdGuard Home is blocking fine/);
    expect(av.panels.find((p) => p.id === 'blocking-now')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    expect(av.panels.find((p) => p.id === 'inventory')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    expect(av.panels.find((p) => p.id === 'top-blocked')?.ask?.questions.length).toBeGreaterThanOrEqual(2);
    for (const p of av.panels) ThingPagePanel.parse(p);

    expect(dnsVerdict(pihole({ blocking: PIHOLE_blockingPaused }), 'Europe/Amsterdam')).toContain(
      'Blocking is off until',
    );
    expect(dnsVerdict(adguard({ status: ADGUARD_statusOff }), 'Europe/Amsterdam')).toContain(
      'Protection is off',
    );
  });
});
