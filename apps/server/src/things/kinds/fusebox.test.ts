/**
 * Fusebox's page and tile from recorded answers (fusebox-page.md FP-02…FP-13): the pool and when it runs out, the
 * status, the points, the answers read defensively and the page's panels. Pure.
 */
import { type GatewayAccountUsage, ThingPageNotice, ThingPagePanel, usageStatus } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { mapFuseboxAccounts, parseFuseboxFaults, planWords } from '../../gateway/fusebox';
import type { RawPoint } from '../series';
import {
  type FuseboxInput,
  type FuseboxSnapshot,
  fuseboxView,
  monthQuery,
  parseAccountsMore,
  parseClients,
  parseMonth,
  parseOverview,
  routingWords,
  share,
  usd,
  whoUsed,
} from './fusebox';
import { FUSEBOX_CHECKS, type FuseboxLinesInput, fuseboxNotices } from './fusebox-lines';
import {
  fuseboxGlance,
  fuseboxPoints,
  fuseboxStatus,
  memberKey,
  poolOf,
  poolsOf,
  runOut,
  untilWords,
} from './fusebox-pool';
import { slotProblems } from './slots';

const H = 3600_000;
// Monday 15:00 in Amsterdam.
const now = new Date('2026-10-19T13:00:00Z');
const at = (hours: number) => new Date(now.getTime() + hours * H);
const TZ = 'Europe/Amsterdam';

function account(
  key: string,
  label: string,
  provider: 'claude' | 'codex',
  plan: string | null,
  week: number,
  weekResetH: number,
  five: number,
  fiveResetH: number,
  status: GatewayAccountUsage['status'] = 'ok',
  until: Date | null = null,
): GatewayAccountUsage {
  return {
    key,
    label,
    provider,
    plan,
    status,
    until: until ? until.toISOString() : null,
    windows: [
      {
        kind: 'five_hour',
        label: '5-hour',
        usedPct: five,
        resetsAt: at(fiveResetH).toISOString(),
        status: usageStatus(five),
      },
      {
        kind: 'seven_day',
        label: '7-day',
        usedPct: week,
        resetsAt: at(weekResetH).toISOString(),
        status: usageStatus(week),
      },
    ],
  };
}

const JOHN = `gwa_${'a'.repeat(24)}`;
const OPS = `gwa_${'b'.repeat(24)}`;
const DEV = `gwa_${'c'.repeat(24)}`;
const CODEX = `gwa_${'d'.repeat(24)}`;

/** Three Claude Ultra (`max_20x`) a little past halfway through their weeks, one Codex Pro early in its. */
const ACCOUNTS: GatewayAccountUsage[] = [
  account(JOHN, 'john@example.com', 'claude', 'max_20x', 81, 66, 41, 2),
  account(OPS, 'ops@example.com', 'claude', 'max_20x', 72, 68.5, 12, 3),
  account(DEV, 'dev@example.com', 'claude', 'max_20x', 51, 89, 0, 0),
  account(CODEX, 'john@example.com', 'codex', 'pro', 22, 118, 8, 4),
];

describe('the pool (FP-04)', () => {
  it('adds the subscriptions up and sees the week run out before the first reset', () => {
    const pool = poolOf(ACCOUNTS, 'claude', 'week', now);
    expect(pool?.used).toBeCloseTo(68, 0);
    expect(pool?.members.map((m) => m.key)).toEqual([JOHN, OPS, DEV]);
    expect(pool?.firstReset?.toISOString()).toBe(at(66).toISOString());
    const out = pool?.runsOut;
    expect(out?.before.toISOString()).toBe(at(66).toISOString());
    // About 44 hours from now: Wednesday morning, well before Thursday's reset.
    expect((out?.at.getTime() ?? 0) - now.getTime()).toBeGreaterThan(40 * H);
    expect((out?.at.getTime() ?? 0) - now.getTime()).toBeLessThan(48 * H);
  });

  it('says where a pool that lasts will be at its reset', () => {
    const pool = poolOf(ACCOUNTS, 'codex', 'week', now);
    expect(pool?.runsOut).toBeNull();
    expect(pool?.atFirstReset).toBeGreaterThan(70);
    expect(pool?.atFirstReset).toBeLessThan(78);
  });

  it('weighs Claude plans by price when every plan is known, else equally', () => {
    const mixed = [
      account(JOHN, 'a', 'claude', 'pro', 100, 50, 0, 0),
      account(OPS, 'b', 'claude', 'max_20x', 0, 50, 0, 0),
    ];
    expect(poolOf(mixed, 'claude', 'week', now)?.used).toBeCloseTo(100 / 11, 1);
    const unknown = [mixed[0] as GatewayAccountUsage, { ...(mixed[1] as GatewayAccountUsage), plan: null }];
    expect(poolOf(unknown, 'claude', 'week', now)?.used).toBe(50);
    // Ultra weighs the same under a new identifier; Max is 5.
    const ultra = [mixed[0] as GatewayAccountUsage, { ...(mixed[1] as GatewayAccountUsage), plan: 'ultra' }];
    expect(poolOf(ultra, 'claude', 'week', now)?.used).toBeCloseTo(100 / 11, 1);
    const max = [mixed[0] as GatewayAccountUsage, { ...(mixed[1] as GatewayAccountUsage), plan: 'max_5x' }];
    expect(poolOf(max, 'claude', 'week', now)?.used).toBeCloseTo(100 / 6, 1);
  });

  it('has no 5-hour pool while a subscription without that limit can take the rest (Fusebox 0.12)', () => {
    // An Ultra without the limit reports only its week.
    const free = {
      ...account(DEV, 'dev@example.com', 'claude', 'max_20x', 51, 89, 0, 0),
      noFiveHourLimit: true,
      windows: account(DEV, 'dev@example.com', 'claude', 'max_20x', 51, 89, 0, 0).windows.slice(1),
    };
    const mixed = [ACCOUNTS[0], ACCOUNTS[1], free, ACCOUNTS[3]] as GatewayAccountUsage[];
    expect(poolOf(mixed, 'claude', '5h', now)).toBeNull();
    expect(poolOf(mixed, 'claude', 'week', now)?.members).toHaveLength(3);
    // ChatGPT keeps its own 5 hours.
    expect(poolOf(mixed, 'codex', '5h', now)).not.toBeNull();
    // One model's pause leaves it the others: it still takes the rest.
    const opusBusy = { ...free, status: 'rate_limited' as const };
    expect(
      poolOf([ACCOUNTS[0], ACCOUNTS[1], opusBusy] as GatewayAccountUsage[], 'claude', '5h', now),
    ).toBeNull();
    // It can't when its week is used up, it is paused as a whole, signed out or off: then the pool is the
    // subscriptions that have the limit.
    const spent = {
      ...free,
      windows: [{ ...(free.windows[0] as GatewayAccountUsage['windows'][number]), usedPct: 100 }],
    };
    for (const a of [
      spent,
      { ...free, status: 'used_up' as const, paused: true },
      { ...free, status: 'rate_limited' as const, paused: true },
      { ...free, status: 'signin_expired' as const },
      { ...free, status: 'off' as const },
    ])
      expect(
        poolOf([ACCOUNTS[0], ACCOUNTS[1], a] as GatewayAccountUsage[], 'claude', '5h', now)?.members.map(
          (m) => m.key,
        ),
      ).toEqual([JOHN, OPS]);
    // Without the pool, each subscription's own 5 hours are still kept, so its chart has no gap when it returns.
    const points = fuseboxPoints(mixed, null, now);
    expect(Object.keys(points)).not.toContain('claude_5h');
    expect(points[memberKey(JOHN, '5h')]).toBe(41);
    expect(points[memberKey(OPS, '5h')]).toBe(12);
    expect(points[memberKey(DEV, 'week')]).toBe(51);
    expect(points).not.toHaveProperty(memberKey(DEV, '5h'));
  });

  it('tells a pause of one model from a pause of the whole account, from what Fusebox lists', () => {
    const H5 = at(2).toISOString();
    const WEEK = at(60).toISOString();
    const fusebox = (id: string, plan: string, over: Record<string, unknown> = {}) => ({
      id,
      provider: 'claude',
      email: `${id}@example.com`,
      disabled: false,
      quota: {
        plan,
        windows: [
          ...(plan === 'max_20x' ? [] : [{ name: '5h', used: 90, resets_at: H5 }]),
          { name: 'week', used: 30, resets_at: WEEK },
        ],
        ...(plan === 'max_20x' ? { no_five_hour_limit: true } : {}),
      },
      ...over,
    });
    const faults = parseFuseboxFaults([
      { key: 'rate:ultra', kind: 'rate_limit', provider: 'claude', account_id: 'ultra', until: H5 },
    ]);
    const read = (kinds: Record<string, string>) =>
      mapFuseboxAccounts(
        'cnx_1',
        [fusebox('max', 'max_5x'), fusebox('ultra', 'max_20x', { cooldown_kinds: kinds })],
        faults,
        now,
      );
    // Only Opus is busy: Fusebox's fault makes it look busy, yet it takes the rest of Claude.
    const opus = read({ 'claude-opus': 'rate_limit' });
    expect(opus[1]).toMatchObject({ status: 'rate_limited', noFiveHourLimit: true });
    expect(opus[1]).not.toHaveProperty('paused');
    expect(poolOf(opus, 'claude', '5h', now)).toBeNull();
    // Every model busy: the Max subscription's 5 hours are all there is.
    const all = read({ '*': 'rate_limit' });
    expect(all[1]?.paused).toBe(true);
    expect(poolOf(all, 'claude', '5h', now)?.members).toHaveLength(1);
    // A quota check isn't a pause.
    expect(read({ '*': 'checking' })[1]).not.toHaveProperty('paused');
  });

  it('leaves out subscriptions that are off and windows without a figure', () => {
    const off = ACCOUNTS.map((a) => (a.key === DEV ? { ...a, status: 'off' as const } : a));
    expect(poolOf(off, 'claude', 'week', now)?.members).toHaveLength(2);
    expect(poolOf([], 'claude', 'week', now)).toBeNull();
  });

  it('runs out when the need passes what is left before a renewal, and says when', () => {
    // 10 points an hour, 50 left, renewing in 10 hours: empty in 5.
    const got = runOut([{ weight: 1, left: 50, renews: at(10) }], 10 / H, now);
    expect(got?.at.toISOString()).toBe(at(5).toISOString());
    expect(got?.before.toISOString()).toBe(at(10).toISOString());
    // A renewal in time brings the room back.
    expect(runOut([{ weight: 1, left: 50, renews: at(4) }], 10 / H, now)).toBeNull();
    expect(runOut([{ weight: 1, left: 50, renews: null }], 10 / H, now)).toBeNull();
  });
});

describe('status, glance and points (FP-02, FP-03, FP-05)', () => {
  it('the head’s own words are only the fine ones: what isn’t fine is a line (QN-S23)', () => {
    expect(fuseboxStatus(ACCOUNTS)).toEqual({ status: 'ok', badge: 'All 4 subscriptions working' });
    const expired = ACCOUNTS.map((a) => (a.key === OPS ? { ...a, status: 'signin_expired' as const } : a));
    expect(fuseboxStatus(expired)).toEqual({ status: 'ok', badge: '3 of 4 subscriptions working' });
    const off = ACCOUNTS.map((a) => ({ ...a, status: 'off' as const }));
    expect(fuseboxStatus(off).badge).toBe('Every subscription is off');
  });

  it('gives the card each tool’s week and the subscriptions working, and the reason only when not fine', () => {
    const g = fuseboxGlance(ACCOUNTS, '0.7.0', now, TZ, {
      status: 'bad',
      reason: 'ChatGPT used up until 14:00',
    });
    expect(g.facts.map((f) => f.label)).toEqual(['Claude week', 'ChatGPT week', 'Subscriptions']);
    expect(g.facts[0]?.value).toBe('68 %');
    expect(g.facts[2]?.value).toBe('4 of 4');
    expect(g.line).toContain('0.7.0');
    expect(g).toMatchObject({ status: 'bad', reason: 'ChatGPT used up until 14:00' });
    const calm = fuseboxGlance([account(JOHN, 'a', 'claude', 'max_20x', 10, 150, 5, 4)], null, now, TZ);
    expect(calm.status).toBe('ok');
    expect(calm.reason).toBeUndefined();
  });

  it('keeps pools, each subscription and the request counters as points', () => {
    const points = fuseboxPoints(ACCOUNTS, { requests: 120, ok: 110, failed: 9 }, now);
    expect(Object.keys(points)).toEqual(
      expect.arrayContaining([
        'claude_week',
        'claude_5h',
        'codex_week',
        'codex_5h',
        memberKey(JOHN, 'week'),
        memberKey(JOHN, '5h'),
        'req_ok',
        'req_failed',
      ]),
    );
    expect(memberKey(JOHN, 'week')).toBe('fw_aaaaaaaa');
    expect(points.req_failed).toBe(9);
    expect(fuseboxPoints([], null, now)).toEqual({});
  });

  it('words plans, times, money and shares', () => {
    // Claude renamed Max 20x to Ultra and Max 5x to Max; the identifiers stayed.
    expect(planWords('max_20x')).toBe('Ultra');
    expect(planWords('ultra')).toBe('Ultra');
    expect(planWords('max_5x')).toBe('Max');
    expect(planWords('pro')).toBe('Pro');
    expect(planWords('some_new_plan')).toBe('Some new plan');
    expect(planWords(null)).toBeNull();
    expect(untilWords(at(2), now, TZ)).toBe('17:00');
    expect(untilWords(at(20), now, TZ)).toMatch(/^tomorrow /);
    expect(untilWords(at(66), now, TZ)).toMatch(/^Thu /);
    expect(usd(1906.4)).toBe('$ 1,906');
    expect(usd(4.2)).toBe('$ 4.20');
    expect(share(99.21)).toBe('99.2 %');
    expect(share(50)).toBe('50 %');
    expect(share(99.99)).toBe('100 %');
    expect(routingWords('least-used', true)).toContain('Most left');
    expect(routingWords('something-new', true)).toBeNull();
  });
});

describe('reading Fusebox (FP-12, FP-13)', () => {
  it('takes only the overview’s shown fields, never its keys or paths', () => {
    const o = parseOverview({
      version: '0.7.0',
      uptime_secs: 3600,
      routing: 'least-used',
      session_affinity: true,
      client_keys: ['sk-secret'],
      config_path: '/etc/fusebox/config.yaml',
      totals: { requests: 12, ok: 10, failed: 2 },
      models: 38,
    });
    expect(o).toMatchObject({ version: '0.7.0', uptimeS: 3600, totals: { ok: 10, failed: 2, requests: 12 } });
    expect(JSON.stringify(o)).not.toContain('sk-secret');
    // A build's suffix stays out of the card and the head, and in “Fusebox itself”.
    expect(parseOverview({ version: '0.7.0+gui.81f9ff128ba6' })).toMatchObject({
      version: '0.7.0',
      build: '0.7.0+gui.81f9ff128ba6',
    });
    expect(JSON.stringify(o)).not.toContain('/etc/fusebox');
    expect(parseOverview(null).totals).toBeNull();
  });

  it('reads this month, the clients and who used which window', () => {
    const month = parseMonth({
      facets: { clients: [{ id: 'laptop', label: 'John’s laptop' }] },
      combined: {
        totals: { estimated_cost_nanos: 1_906_000_000_000 },
        trends: {
          provider: [
            { date: '2026-10-18', group: 'anthropic', estimated_cost_nanos: 90_000_000_000 },
            { date: '2026-10-19', group: 'openai', estimated_cost_nanos: 10_000_000_000 },
            { date: 'nonsense', group: 'anthropic', estimated_cost_nanos: 1 },
          ],
        },
        breakdowns: { client: [{ id: 'laptop', observations: 40, estimated_cost_nanos: 5_000_000_000 }] },
      },
    });
    expect(month.usd).toBe(1906);
    expect(month.days.map((d) => d.tool)).toEqual(['claude', 'codex']);
    expect(month.clients[0]).toMatchObject({ id: 'laptop', label: 'John’s laptop', requests: 40, usd: 5 });

    const clients = parseClients({
      last_used: { laptop: '2026-10-19T12:58:00Z' },
      connected: [{ key: 'laptop', label: 'x' }],
    });
    expect(clients.connected.has('laptop')).toBe(true);
    expect(clients.lastUsed.get('laptop')?.toISOString()).toBe('2026-10-19T12:58:00.000Z');

    const more = parseAccountsMore(
      [
        {
          id: 'fb1',
          last_used: '2026-10-19T12:00:00Z',
          quota_attribution: {
            current: [
              { name: 'week', outside: 4, clients: [{ id: 'laptop', label: 'John’s laptop', points: 30 }] },
            ],
          },
        },
      ],
      (id) => `k-${id}`,
    );
    expect(more.get('k-fb1')?.shares[0]).toMatchObject({ window: 'week', outside: 4 });
  });

  it('asks for this month in the burrow’s zone, to tomorrow', () => {
    expect(monthQuery(now, TZ)).toEqual({ start: '2026-10-01', end: '2026-10-20', timezone: TZ });
  });
});

/* The page --------------------------------------------------------------------------------------------------------- */

/** A week of points every two hours, rising to `to`. */
function rising(key: string, to: number, hours = 7 * 24): [string, RawPoint[]] {
  const points: RawPoint[] = [];
  for (let h = hours; h >= 0; h -= 2) points.push({ at: at(-h), value: Math.max(0, to - (h / hours) * to) });
  return [key, points];
}

/** Two weeks of a counter every hour, growing by `perHour`: 24 × `perHour` a day. */
function counter(key: string, perHour: number): [string, RawPoint[]] {
  const points: RawPoint[] = [];
  for (let h = 14 * 24; h >= 0; h--) points.push({ at: at(-h), value: 1000 + (14 * 24 - h) * perHour });
  return [key, points];
}

const SNAPSHOT: FuseboxSnapshot = {
  readAt: now,
  overview: {
    version: '0.7.0',
    build: '0.7.0',
    uptimeS: 30 * 3600,
    routing: 'least-used',
    affinity: true,
    totals: { requests: 500, ok: 480, failed: 20 },
    models: 38,
  },
  accounts: ACCOUNTS,
  others: [],
  signedIn: new Set(),
  more: new Map([
    [
      JOHN,
      {
        lastUsed: at(-0.05),
        shares: [
          {
            window: 'week',
            outside: 6,
            clients: [
              { id: 'laptop', label: 'John’s laptop', points: 40 },
              { id: 'whombat-lumio-3fa2c1', label: 'Whombat (Lumio)', points: 30 },
            ],
          },
        ],
      },
    ],
  ]),
  faults: [],
  ids: new Map(),
  clients: { lastUsed: new Map([['whombat-lumio-3fa2c1', at(-0.03)]]), connected: new Set(['laptop']) },
  month: {
    usd: 1906,
    days: [
      { date: '2026-10-18', tool: 'claude', usd: 90 },
      { date: '2026-10-19', tool: 'claude', usd: 60 },
      { date: '2026-10-19', tool: 'codex', usd: 10 },
    ],
    clients: [
      { id: 'laptop', label: 'John’s laptop', requests: 900, usd: 980 },
      { id: 'whombat-lumio-3fa2c1', label: 'Whombat (Lumio)', requests: 400, usd: 412 },
    ],
  },
  history: { bytes: 412e6, growthPerDay: 6e6 },
};

function input(over: Partial<FuseboxInput> = {}): FuseboxInput {
  return {
    snapshot: SNAPSHOT,
    points: new Map([
      rising('claude_week', 68),
      rising(memberKey(JOHN, 'week'), 81),
      rising(memberKey(OPS, 'week'), 72),
      rising(memberKey(DEV, 'week'), 51),
      rising('codex_week', 22),
      rising('claude_5h', 18),
      rising('req_ok', 4800),
      rising('req_failed', 200),
    ]),
    range: '7d',
    now,
    timeZone: TZ,
    switches: { claude: true, codex: false },
    turns: { claude: 31, codex: 0 },
    clientId: 'whombat-lumio-3fa2c1',
    url: 'https://10.100.0.235:8317',
    requestDays: new Map([counter('req_ok', 50), counter('req_failed', 1)]),
    ...over,
  };
}

const panelsOf = (v: ReturnType<typeof fuseboxView>) => [...(v.charts ?? []), ...v.panels];
const panel = (v: ReturnType<typeof fuseboxView>, id: string) => v.panels.find((p) => p.id === id);

describe('the page (FP-06…FP-11), in slots', () => {
  it('lays out the limits now, what goes through it, the requests this week and who used it most', () => {
    const v = fuseboxView(input());
    for (const p of panelsOf(v)) ThingPagePanel.parse(p);
    for (const n of v.notices) ThingPageNotice.parse(n);
    expect(slotProblems(v)).toEqual([]);
    expect(v.kpis).toEqual([]);
    expect(v.machine).toBe('after');
    expect(v.ownMachine).toBeUndefined();
    expect(v.panels.map((p) => [p.id, p.place])).toEqual([
      ['limits', 'chart'],
      ['gateway', 'chart'],
      ['week', 'chart'],
      ['people', 'chart'],
      ['claude-week', 'main'],
      ['codex-week', 'main'],
      ['subscriptions', 'main'],
      ['who-claude', 'main'],
      ['whombat', 'main'],
    ]);
    expect(v.actions).toEqual([]);
    expect(v.open?.url).toBe('https://10.100.0.235:8317');
    expect(v.status).toEqual({ status: 'ok', badge: 'All 4 subscriptions working' });
  });

  it('limits now: a row per pool with its share used, its reset or when it runs out', () => {
    const live = panel(fuseboxView(input()), 'limits');
    if (live?.kind !== 'gallery') throw new Error('no live rows');
    expect(live).toMatchObject({ look: 'rows', shape: 'square', meta: 'All 4 subscriptions working' });
    expect(live.items.map((i) => [i.id, i.title, i.sub, i.note, i.badge?.text ?? null])).toEqual([
      ['claude-week', 'Claude · week', '3 subscriptions', '68 % used', 'Runs out early'],
      ['claude-5h', 'Claude · 5 hours', '3 subscriptions', '18 % used', null],
      ['codex-week', 'ChatGPT · week', '1 subscription', '22 % used', null],
    ]);
    expect(live.items[0]?.noteEnd).toMatch(/^out about /);
    expect(live.items[2]?.noteEnd).toMatch(/^resets /);
    expect(live.items[0]?.progress).toBeCloseTo(0.68, 1);
  });

  it('through Fusebox: subscriptions, clients, requests this month and what it is worth', () => {
    const inv = panel(fuseboxView(input()), 'gateway');
    if (inv?.kind !== 'list') throw new Error('no inventory');
    expect(inv.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Subscriptions', '4', 'All working'],
      ['Clients', '2', '1 connected now'],
      // The counters reach two weeks back at 51 an hour: 336 hours of it; this week is 160 of them.
      ['Requests this month', '17,136', '+8,160 this week'],
      ['Worth this month', '$ 1,906', '+$ 160 this week'],
    ]);
    expect(inv.items.find((i) => i.id === 'requests')?.url).toBe('https://10.100.0.235:8317/#/requests');
    // Without the counters' days: since it started.
    const none = panel(fuseboxView(input({ requestDays: null })), 'gateway');
    expect(none?.kind === 'list' && none.items.find((i) => i.id === 'requests')?.figure).toEqual({
      value: '500',
      note: 'since it started',
    });
  });

  it('requests this week per day from the counters, and who used it most this month', () => {
    const v = fuseboxView(input());
    const week = panel(v, 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    expect(week.series[0]?.values.slice(0, 6)).toEqual([1224, 1224, 1224, 1224, 1224, 1224]);
    expect(week).toMatchObject({ title: 'Requests this week', meta: '98 % worked' });
    expect(week.stats?.[0]?.[0]?.text).toMatch(/%$/);
    const who = panel(v, 'people');
    if (who?.kind !== 'bars') throw new Error('no people');
    expect(who.items.map((b) => [b.label, b.note ?? null, b.value, b.sub])).toEqual([
      ['John’s laptop', null, '$ 980', '900 requests'],
      ['This Whombat', 'Whombat (Lumio)', '$ 412', '400 requests'],
    ]);
    // Every client stays in reach: past eight, a table of them all below the slots.
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      label: `Laptop ${i}`,
      requests: 10 + i,
      usd: i,
    }));
    const all = fuseboxView(
      input({
        snapshot: {
          ...SNAPSHOT,
          month: { ...(SNAPSHOT.month as NonNullable<FuseboxSnapshot['month']>), clients: many },
        },
      }),
    );
    const table = panel(all, 'clients');
    expect(table?.kind === 'table' && table.rows).toHaveLength(10);
    expect(
      panel(all, 'people')?.kind === 'bars' && (panel(all, 'people') as { items: unknown[] }).items,
    ).toHaveLength(8);
  });

  it('its own lines in the machine card: version, new sessions, usage history, models, up', () => {
    const v = fuseboxView(input());
    expect(v.slots?.machine.map((b) => [b.label, b.value, b.sub ?? null])).toEqual([
      ['Fusebox', '0.7.0', null],
      ['New sessions', 'Most left first · sessions stay', null],
      ['Usage history', '412 MB', '+ 6 MB a day'],
      ['Models', '38', null],
      ['Up', '30 h', null],
    ]);
  });

  it('names each plan and says a subscription has no 5-hour limit instead of a blank', () => {
    const named = ACCOUNTS.map((a) =>
      a.key === DEV
        ? { ...a, planName: 'Ultra', noFiveHourLimit: true, windows: a.windows.slice(1) }
        : a.key === OPS
          ? { ...a, planName: undefined }
          : a,
    );
    const v = fuseboxView(input({ snapshot: { ...SNAPSHOT, accounts: named } }));
    const subs = v.panels.find((p) => p.id === 'subscriptions');
    const rows = subs?.kind === 'table' ? subs.rows : [];
    const row = (key: string) => rows.find((r) => r.id === key)?.cells;
    expect(row(DEV)?.subscription?.note).toBe('Claude · Ultra');
    expect(row(DEV)?.five).toMatchObject({ text: 'No limit', tone: 'muted' });
    // Rows kept from before the poller named plans fall back to the identifier's words.
    expect(row(OPS)?.subscription?.note).toBe('Claude · Ultra');
    expect(row(JOHN)?.five?.text).toBe('41 %');
    // Without a combined 5 hours, its row is left out.
    const live = panel(v, 'limits');
    expect(live?.kind === 'gallery' && live.items.some((i) => i.id === 'claude-5h')).toBe(false);
  });

  it('lists every subscription Fusebox does: one that is off, and other tools’ with their marks', () => {
    const OFF = `gwa_${'e'.repeat(24)}`;
    const META = `gwa_${'f'.repeat(24)}`;
    const off: GatewayAccountUsage = {
      key: OFF,
      label: 'old@example.com',
      provider: 'claude',
      plan: null,
      status: 'off',
      until: null,
      windows: [],
    };
    const snapshot: FuseboxSnapshot = {
      ...SNAPSHOT,
      accounts: [...ACCOUNTS, off],
      signedIn: new Set([JOHN, OPS, DEV, CODEX, OFF]),
      others: [
        {
          key: META,
          label: 'muse@example.com',
          provider: 'meta',
          plan: 'Muse Code Max',
          noFiveHourLimit: false,
          status: 'ok',
          until: null,
          windows: [
            { kind: 'five_hour', label: '5-hour', usedPct: 3, resetsAt: null, status: 'ok' },
            { kind: 'seven_day', label: '7-day', usedPct: 1, resetsAt: null, status: 'ok' },
          ],
        },
      ],
    };
    const v = fuseboxView(input({ snapshot }));
    const subs = panel(v, 'subscriptions');
    if (subs?.kind !== 'table') throw new Error('no subscriptions');
    expect(subs.meta).toBe('5 of 6 working');
    const cells = (key: string) => subs.rows.find((r) => r.id === key)?.cells;
    expect(cells(OFF)?.subscription).toMatchObject({
      text: 'old@example.com',
      note: 'Claude',
      mark: 'claude',
    });
    expect(cells(OFF)?.status?.text).toBe('Off in Fusebox');
    expect(cells(CODEX)?.subscription?.mark).toBe('openai');
    expect(cells(META)?.subscription).toMatchObject({ note: 'Meta · Muse Code Max', mark: 'meta' });
    expect(cells(META)?.five?.text).toBe('3 %');
    // The other tools count in Through Fusebox and in the facts; the pools stay Claude's and ChatGPT's.
    const inv = panel(v, 'gateway');
    expect(inv?.kind === 'list' && inv.items[0]?.figure?.value).toBe('6');
    expect(JSON.stringify(v.facts[0])).toContain('1 Meta');
    expect(panel(v, 'limits')?.kind === 'gallery').toBe(true);
  });

  it('draws the forecast only when it is within the range ahead (FP-S03)', () => {
    const week = (range: FuseboxInput['range']) => {
      const c = panel(fuseboxView(input({ range })), 'claude-week');
      return c?.kind === 'chart' ? c : undefined;
    };
    expect(week('7d')?.forecast?.value).toBe(100);
    expect(week('24h')?.forecast).toBeUndefined();
    expect(week('7d')?.series[0]?.color).toBe('amber');
    expect(week('7d')?.series).toHaveLength(4);
  });

  it('names Whombat’s own client and pools who used the week', () => {
    const pool = poolOf(ACCOUNTS, 'claude', 'week', now);
    const bars = pool ? whoUsed(SNAPSHOT, pool, 'whombat-lumio-3fa2c1') : [];
    expect(bars.map((b) => b.label)).toEqual(['John’s laptop', 'This Whombat', 'Outside Fusebox']);
    // One of three equal subscriptions reported: a third of its points count for the pool.
    expect(bars[0]?.value).toBe('13 %');
  });

  it('says what is worth a look: the week running out, failing requests, expired sign-ins', () => {
    const v = fuseboxView(input());
    // The counters grew slowly over the week: nothing failing in the last hour.
    expect(v.notices.map((n) => n.id)).toEqual(['runs-out-claude']);
    expect(v.notices[0]).toMatchObject({ nature: 'fyi', tone: 'info' });
    expect(v.notices[0]?.link).toBeUndefined();
    const lastHour = (key: string, from: number, to: number): [string, RawPoint[]] => [
      key,
      [
        { at: at(-1.5), value: from },
        { at: at(-0.5), value: from + (to - from) / 2 },
        { at: now, value: to },
      ],
    ];
    const failing = fuseboxView(
      input({
        range: '24h',
        points: new Map([lastHour('req_ok', 1000, 1400), lastHour('req_failed', 50, 90)]),
      }),
    );
    expect(failing.notices.find((n) => n.id === 'failing')).toMatchObject({
      nature: 'problem',
      check: 'fusebox.failing',
      title: '40 requests failed in the last hour',
    });
    const expired = ACCOUNTS.map((a) => (a.key === OPS ? { ...a, status: 'signin_expired' as const } : a));
    const w = fuseboxView(input({ snapshot: { ...SNAPSHOT, accounts: expired } }));
    expect(w.notices[0]).toMatchObject({ id: `signin-${OPS}`, tone: 'bad', link: { kind: 'url' } });
  });

  it('leaves out what it can’t read: no points, no month, no clients, no history', () => {
    const v = fuseboxView(
      input({
        points: new Map(),
        requestDays: new Map(),
        snapshot: { ...SNAPSHOT, month: null, clients: null, history: null },
      }),
    );
    expect(slotProblems(v)).toEqual([]);
    const ids = v.panels.map((p) => p.id);
    expect(ids).not.toContain('week');
    expect(ids).not.toContain('people');
    expect(ids).not.toContain('claude-week');
    const inv = panel(v, 'gateway');
    expect(inv?.kind === 'list' && inv.items.map((i) => i.title)).toEqual(['Subscriptions', 'Requests']);
    expect(v.slots?.machine.some((b) => b.id === 'history')).toBe(false);
  });
});

describe('what Whombat watches (quiet-notices.md QN-01, QN-11, QN-S23)', () => {
  const lines = (over: Partial<FuseboxLinesInput> = {}) => {
    const accounts = over.accounts ?? ACCOUNTS;
    return fuseboxNotices({
      accounts,
      pools: poolsOf(accounts, now),
      faults: [],
      ids: new Map(),
      labels: new Map(accounts.map((a) => [a.key, a.label])),
      lastHour: null,
      switches: { claude: true, codex: true },
      url: 'https://fusebox.lan',
      now,
      timeZone: TZ,
      ...over,
    });
  };
  const codexUsedUp = (until: Date | null) =>
    ACCOUNTS.map((a) =>
      a.provider === 'codex' ? { ...a, status: 'used_up' as const, until: until?.toISOString() ?? null } : a,
    );

  it('a week that runs out early is a heads-up: no ask, Ignore until the week resets', () => {
    const [week] = lines();
    const pool = poolOf(ACCOUNTS, 'claude', 'week', now);
    expect(week).toMatchObject({
      check: 'fusebox.week_runs_out',
      nature: 'fyi',
      tone: 'info',
      subject: { id: 'tool:claude', name: 'Claude' },
      ignore: {
        lifts: 'period',
        words: 'Until the week resets.',
        until: pool?.runsOut?.before.toISOString(),
      },
      badge: 'Claude’s week runs out early',
    });
    expect(week?.link).toBeUndefined();
  });

  it('used up and an expired sign-in are only yours: where it’s done, no agent', () => {
    const [up] = lines({ accounts: codexUsedUp(at(20)) });
    expect(up).toMatchObject({
      check: 'fusebox.used_up',
      nature: 'you',
      tone: 'bad',
      subject: { id: 'tool:codex', name: 'ChatGPT' },
      link: { kind: 'url', url: 'https://fusebox.lan' },
      ignore: { lifts: 'period', words: 'Until it resets.', until: at(20).toISOString() },
    });
    expect(up?.badge).toContain('ChatGPT used up');
    expect((up?.badge ?? '').length).toBeLessThanOrEqual(40);
    // Without a reset time it lasts until it has room again.
    expect(lines({ accounts: codexUsedUp(null) })[0]?.ignore).toEqual({
      lifts: 'fixed',
      words: 'Until it has room again.',
    });
    const expired = ACCOUNTS.map((a) => (a.key === OPS ? { ...a, status: 'signin_expired' as const } : a));
    const signin = lines({ accounts: expired }).find((n) => n.check === 'fusebox.signin');
    expect(signin).toMatchObject({
      nature: 'you',
      subject: { id: `account:${OPS}`, name: 'ops@example.com' },
      link: { kind: 'url', label: 'Sign in again' },
      ignore: { lifts: 'fixed', words: 'Until someone signs in again.' },
    });
    for (const n of lines({ accounts: [...expired, ...codexUsedUp(at(20))] }))
      if (n.nature !== 'problem') expect(n.link?.kind).not.toBe('ask');
  });

  it('an API key out of credit is yours: its own line, not “used up until”, off from the start', () => {
    const KEY = `gwa_${'e'.repeat(24)}`;
    const key: GatewayAccountUsage = {
      key: KEY,
      label: 'anthropic-key',
      provider: 'claude',
      plan: null,
      status: 'used_up',
      until: at(0.5).toISOString(),
      windows: [],
    };
    const fault = { key: 'credit:k', kind: 'credit', provider: 'claude', accountId: 'k', until: key.until };
    const all = lines({ accounts: [...ACCOUNTS, key], faults: [fault, fault], ids: new Map([['k', KEY]]) });
    const credit = all.filter((n) => n.check === 'fusebox.credit');
    expect(credit).toHaveLength(1);
    expect(credit[0]).toMatchObject({
      nature: 'you',
      tone: 'bad',
      subject: { id: `account:${KEY}`, name: 'anthropic-key' },
      link: { kind: 'url', url: 'https://fusebox.lan' },
      ignore: { lifts: 'fixed' },
    });
    expect(credit[0]?.title).toContain('anthropic-key');
    expect((credit[0]?.badge ?? '').length).toBeLessThanOrEqual(40);
    expect(all.some((n) => n.check === 'fusebox.subscription_used_up')).toBe(false);
    expect(FUSEBOX_CHECKS.find((c) => c.check === 'fusebox.credit')?.startsOn).toBe(false);
  });

  it('refused usage checks (Fusebox 0.14) have their own words, not “answers with an error”', () => {
    const fault = {
      key: 'usage-refused:ops.json',
      kind: 'error',
      provider: 'claude',
      accountId: 'ops.json',
      until: null,
    };
    const all = lines({ faults: [fault], ids: new Map([['ops.json', OPS]]) });
    const refused = all.filter((n) => n.subject?.id === 'fault:usage-refused:ops.json');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      check: 'fusebox.fault',
      nature: 'problem',
      tone: 'warn',
      subject: { name: 'ops@example.com' },
      link: { kind: 'url', url: 'https://fusebox.lan' },
      ignore: { lifts: 'fixed' },
    });
    expect(refused[0]?.title).toContain('ops@example.com');
    expect(refused[0]?.title).not.toContain('answers with an error');
    expect((refused[0]?.badge ?? '').length).toBeLessThanOrEqual(40);
    // Another account error still reads as one.
    const other = lines({ faults: [{ ...fault, key: 'error:ops.json' }], ids: new Map([['ops.json', OPS]]) });
    expect(other.find((n) => n.check === 'fusebox.fault')?.title).toContain('answers with an error');
  });

  it('failing requests and Fusebox’s faults are problems; what is off or used up alone is a heads-up', () => {
    const quiet = ACCOUNTS.map((a) => ({ ...a, windows: [] }));
    const all = lines({
      accounts: [
        quiet[0] as GatewayAccountUsage,
        { ...(quiet[1] as GatewayAccountUsage), status: 'used_up', until: at(3).toISOString() },
        { ...(quiet[2] as GatewayAccountUsage), status: 'off' },
        quiet[3] as GatewayAccountUsage,
      ],
      lastHour: { ok: 400, failed: 40 },
      faults: [
        { key: 'storage', kind: 'storage', provider: 'fusebox', accountId: null, until: null },
        { key: 'provider:codex', kind: 'error', provider: 'codex', accountId: null, until: null },
      ],
    });
    expect(all.map((n) => [n.check, n.nature, n.tone, n.subject?.id ?? null])).toEqual([
      ['fusebox.failing', 'problem', 'warn', null],
      ['fusebox.storage', 'problem', 'warn', null],
      ['fusebox.fault', 'problem', 'warn', 'fault:provider:codex'],
      ['fusebox.subscription_used_up', 'fyi', 'info', `account:${OPS}`],
      ['fusebox.subscription_off', 'fyi', 'info', `account:${DEV}`],
    ]);
    // Fewer than ten failures, or under 2 %: no line.
    expect(lines({ lastHour: { ok: 400, failed: 9 } }).some((n) => n.check === 'fusebox.failing')).toBe(
      false,
    );
    expect(lines({ lastHour: { ok: 4000, failed: 40 } }).some((n) => n.check === 'fusebox.failing')).toBe(
      false,
    );
    const checks = new Set(FUSEBOX_CHECKS.map((c) => c.check));
    for (const n of all) expect(checks.has(n.check)).toBe(true);
  });
});
