/**
 * Fusebox's answers read (docs/decisions/ai-gateway.md AIG-02, AIG-03, AIG-11): accounts and faults mapped to the pool,
 * their labels, and Whombat's named client put into and taken out of `named-clients` with every other entry kept.
 */
import { describe, expect, it } from 'vitest';
import {
  accountStatus,
  faultsByKey,
  fuseboxProviderMark,
  fuseboxSignedIn,
  fuseboxToolName,
  fuseboxWindow,
  gatewayAccountKey,
  isOpenFusebox,
  mapFuseboxAccounts,
  mapFuseboxOtherSubscriptions,
  mergeFaults,
  newGatewayClientKey,
  parseFuseboxFaults,
  parseFuseboxSettings,
  refusedNamedClients,
  withoutClient,
  withWhombatClient,
} from './fusebox';

const NOW = new Date('2026-10-10T12:00:00Z');
const LATER = '2026-10-10T14:05:00Z';
const MONDAY = '2026-10-12T07:00:00Z';

/** One account as `GET /api/accounts` lists it (Fusebox's `Account::snapshot`). */
function account(over: Record<string, unknown> = {}) {
  return {
    id: 'claude-work.json',
    provider: 'claude',
    label: 'work',
    email: 'work@example.com',
    kind: 'oauth',
    disabled: false,
    cooldowns: {},
    quota: {
      windows: [
        { name: '5h', used: 42.25, resets_at: LATER },
        { name: 'week', used: 81, resets_at: MONDAY },
        { name: 'week opus', used: 100, resets_at: MONDAY, model: 'opus' },
        { name: 'week sonnet', used: 3, resets_at: MONDAY, model: 'sonnet' },
        { name: 'day', used: 10, resets_at: LATER },
      ],
      updated_at: '2026-10-10T11:59:00Z',
      plan: 'max',
    },
    ...over,
  };
}

describe('Fusebox accounts → the pool (AIG-11)', () => {
  it('maps windows to the usage meters, Fusebox’s own name for any other', () => {
    const [a] = mapFuseboxAccounts('cnx_1', [account()], [], NOW);
    expect(a?.windows).toEqual([
      {
        kind: 'five_hour',
        label: '5-hour',
        usedPct: 42.3,
        resetsAt: '2026-10-10T14:05:00.000Z',
        status: 'ok',
      },
      {
        kind: 'seven_day',
        label: '7-day',
        usedPct: 81,
        resetsAt: '2026-10-12T07:00:00.000Z',
        status: 'warning',
      },
      {
        kind: 'seven_day_opus',
        label: '7-day Opus',
        usedPct: 100,
        resetsAt: '2026-10-12T07:00:00.000Z',
        status: 'limited',
      },
      {
        kind: 'seven_day_sonnet',
        label: '7-day Sonnet',
        usedPct: 3,
        resetsAt: '2026-10-12T07:00:00.000Z',
        status: 'ok',
      },
      { kind: 'other', label: 'day', usedPct: 10, resetsAt: '2026-10-10T14:05:00.000Z', status: 'ok' },
    ]);
    expect(a).toMatchObject({
      label: 'work@example.com',
      provider: 'claude',
      plan: 'max',
      status: 'ok',
      until: null,
      key: gatewayAccountKey('cnx_1', 'claude-work.json'),
    });
    // The key is a hash of Fusebox's id, never the id.
    expect(a?.key).not.toContain('claude-work');
  });

  it('names the plan as the provider does, else from its identifier (Fusebox 0.12)', () => {
    const quota = (q: Record<string, unknown>) => account({ quota: { windows: [], ...q } });
    const [ultra, renamed, plus, none] = mapFuseboxAccounts(
      'cnx_1',
      [
        quota({ plan: 'max_20x', plan_name: 'Ultra' }),
        quota({ plan: 'max_5x' }),
        quota({ plan: 'plus', plan_name: '  ' }),
        quota({}),
      ].map((a, i) => ({ ...a, id: `a${i}` })),
      [],
      NOW,
    );
    expect(ultra).toMatchObject({ plan: 'max_20x', planName: 'Ultra' });
    expect(renamed).toMatchObject({ plan: 'max_5x', planName: 'Max' });
    expect(plus).toMatchObject({ plan: 'plus', planName: 'Plus' });
    expect(none?.plan).toBeNull();
    expect(none).not.toHaveProperty('planName');
  });

  it('marks an account the provider confirmed has no 5-hour limit and keeps no 5-hour window for it', () => {
    const [free, limited] = mapFuseboxAccounts(
      'cnx_1',
      [
        account({ id: 'ultra', quota: { ...account().quota, plan: 'max_20x', no_five_hour_limit: true } }),
        account({ id: 'max', quota: { ...account().quota, no_five_hour_limit: 'yes' } }),
      ],
      [],
      NOW,
    );
    expect(free?.noFiveHourLimit).toBe(true);
    expect(free?.windows.map((w) => w.kind)).not.toContain('five_hour');
    expect(free?.windows.map((w) => w.kind)).toContain('seven_day');
    // Only a real true counts; anything else leaves the limit and its window as they are.
    expect(limited).not.toHaveProperty('noFiveHourLimit');
    expect(limited?.windows[0]?.kind).toBe('five_hour');
  });

  it('names a model’s own week as a person’s own sign-in does, even while another limit binds (Fusebox 0.15)', () => {
    expect(fuseboxWindow({ name: 'week fable', used: 61, resets_at: MONDAY, model: 'fable' }, NOW)).toEqual({
      kind: 'other',
      label: 'Fable 7-day',
      usedPct: 61,
      resetsAt: '2026-10-12T07:00:00.000Z',
      status: 'ok',
      windowMinutes: 10_080,
    });
    // The kinds Whombat has its own meters for keep them; any other name stays Fusebox's.
    expect(fuseboxWindow({ name: 'week opus', used: 5, resets_at: MONDAY }, NOW)?.kind).toBe(
      'seven_day_opus',
    );
    expect(fuseboxWindow({ name: 'weekly cowork', used: 5, resets_at: MONDAY }, NOW)).not.toHaveProperty(
      'windowMinutes',
    );
  });

  it('drops windows whose reset has passed and unreadable ones', () => {
    expect(fuseboxWindow({ name: '5h', used: 90, resets_at: '2026-10-10T11:00:00Z' }, NOW)).toBeNull();
    expect(fuseboxWindow({ used: 90 }, NOW)).toBeNull();
    expect(fuseboxWindow({ name: 'week', used: 'lots' }, NOW)).toMatchObject({ usedPct: null, status: 'ok' });
  });

  it('keeps only Claude and Codex accounts, Claude first, labels falling back to Fusebox’s', () => {
    const list = mapFuseboxAccounts(
      'cnx_1',
      [
        account({ id: 'codex-a', provider: 'codex', email: null, label: 'team chatgpt', quota: {} }),
        account({ id: 'gem', provider: 'gemini' }),
        account({ id: 'claude-b', email: null, label: null }),
        'nonsense',
        account({ id: 'kimi', provider: 'kimi' }),
      ],
      [],
      NOW,
    );
    expect(list.map((a) => [a.provider, a.label])).toEqual([
      ['claude', 'Claude account 1'],
      ['codex', 'team chatgpt'],
    ]);
    expect(mapFuseboxAccounts('cnx_1', { not: 'a list' }, [], NOW)).toEqual([]);
  });

  it('takes the status from disabled and the faults (used up, busy, sign-in expired)', () => {
    const faults = parseFuseboxFaults([
      { key: 'quota:a', kind: 'quota', provider: 'claude', account_id: 'a', until: MONDAY, title: 'x' },
      { key: 'rate:b', kind: 'rate_limit', provider: 'claude', account_id: 'b', until: LATER },
      { key: 'signin:c', kind: 'signin', provider: 'codex', account_id: 'c', until: null },
      { key: 'provider:claude', kind: 'provider', provider: 'claude', account_id: null, until: LATER },
      { kind: 'quota' },
      42,
    ]);
    expect(faults).toHaveLength(4);
    const list = mapFuseboxAccounts(
      'cnx_1',
      [
        account({ id: 'a' }),
        account({ id: 'b' }),
        account({ id: 'c', provider: 'codex' }),
        account({ id: 'd', disabled: true }),
      ],
      faults,
      NOW,
    );
    expect(list.map((a) => [a.status, a.until])).toEqual([
      ['used_up', '2026-10-12T07:00:00.000Z'],
      ['rate_limited', '2026-10-10T14:05:00.000Z'],
      ['off', null],
      ['signin_expired', null],
    ]);
    expect(accountStatus(false, [])).toEqual({ status: 'ok', until: null });
  });

  it('counts an API key out of credit (Fusebox 0.13) as used up and paused until Fusebox tries it again', () => {
    const faults = parseFuseboxFaults([
      { key: 'credit:k', kind: 'credit', provider: 'claude', account_id: 'k', until: LATER },
    ]);
    const key = account({ id: 'k', email: null, label: 'anthropic-key', kind: 'api-key', quota: {} });
    const [read] = mapFuseboxAccounts('cnx_1', [{ ...key, cooldown_kinds: { '*': 'credit' } }], faults, NOW);
    expect(read).toMatchObject({
      label: 'anthropic-key',
      status: 'used_up',
      until: LATER.replace('Z', '.000Z'),
    });
    expect(read?.paused).toBe(true);
    expect(read?.outOfCredit).toBe(true);
    // A used-up subscription window says when it is back, before a credit pause does.
    const both = parseFuseboxFaults([
      { key: 'credit:k', kind: 'credit', provider: 'claude', account_id: 'k', until: LATER },
      { key: 'quota:k', kind: 'quota', provider: 'claude', account_id: 'k', until: MONDAY },
    ]);
    expect(accountStatus(false, both)).toEqual({ status: 'used_up', until: '2026-10-12T07:00:00.000Z' });
    const [spent] = mapFuseboxAccounts('cnx_1', [key], both, NOW);
    expect(spent).not.toHaveProperty('outOfCredit');
  });

  it('still counts the faults dismissed in Fusebox’s dashboard, once each, with no cap of their own', () => {
    const shown = parseFuseboxFaults([
      { key: 'rate:b', kind: 'rate_limit', provider: 'claude', account_id: 'b', until: LATER },
    ]);
    const dismissed = parseFuseboxFaults([
      { key: 'signin:c', kind: 'signin', provider: 'codex', account_id: 'c', until: null },
      { key: 'rate:b', kind: 'rate_limit', provider: 'claude', account_id: 'b', until: LATER },
    ]);
    const faults = mergeFaults(shown, dismissed, shown);
    expect(faults.map((f) => f.key)).toEqual(['rate:b', 'signin:c']);
    const list = mapFuseboxAccounts('cnx_1', [account({ id: 'c', provider: 'codex' })], faults, NOW);
    expect(list.map((a) => a.status)).toEqual(['signin_expired']);
    // A full list of faults doesn't push a dismissed one out.
    const many = parseFuseboxFaults(
      Array.from({ length: 500 }, (_, i) => ({ key: `rate:${i}`, kind: 'rate_limit', provider: 'claude' })),
    );
    const provider = parseFuseboxFaults([{ key: 'provider:claude', kind: 'provider', provider: 'claude' }]);
    expect(mergeFaults(many, provider).at(-1)?.key).toBe('provider:claude');
    // Only the order changed: the same faults.
    expect(faultsByKey(mergeFaults(dismissed, shown))).toEqual(faultsByKey(faults));
  });

  it('keeps at most 64 accounts', () => {
    const many = Array.from({ length: 80 }, (_, i) => account({ id: `a${i}` }));
    expect(mapFuseboxAccounts('cnx_1', many, [], NOW)).toHaveLength(64);
  });
});

describe('every subscription Fusebox lists', () => {
  const meta = account({
    id: 'meta-a.json',
    provider: 'meta',
    email: 'muse@example.com',
    quota: {
      plan_name: 'Muse Code Max',
      windows: [
        { name: '5h', used: 3, resets_at: LATER },
        { name: 'week', used: 1, resets_at: MONDAY },
      ],
    },
  });
  const body = [
    account(),
    account({ id: 'claude-off.json', email: 'off@example.com', disabled: true, quota: {} }),
    meta,
    account({ id: 'meta-new.json', provider: 'meta', email: 'new@example.com', quota: {} }),
    account({
      id: 'kimi-key',
      provider: 'kimi',
      kind: 'api-key',
      email: undefined,
      label: 'kimi',
      quota: {},
    }),
    account({
      id: 'devin.json',
      provider: 'devin',
      email: 'devin@example.com',
      quota: { limits: [{ id: 'acu', name: 'Credits', scope: { kind: 'account' }, used_percent: 40 }] },
    }),
  ];

  it('lists the other tools’ subscriptions in Fusebox’s order, as its dashboard does', () => {
    const subs = mapFuseboxOtherSubscriptions('con_1', body, [], NOW);
    expect(subs.map((s) => [s.provider, s.label, s.plan])).toEqual([
      ['meta', 'muse@example.com', 'Muse Code Max'],
      // Signed in to Meta but no reading yet: still a subscription.
      ['meta', 'new@example.com', null],
      ['devin', 'devin@example.com', null],
    ]);
    expect(subs[0]?.windows.map((w) => [w.kind, w.usedPct])).toEqual([
      ['five_hour', 3],
      ['seven_day', 1],
    ]);
    expect(subs[2]?.windows.map((w) => [w.label, w.usedPct])).toEqual([['Credits', 40]]);
    expect(subs[0]?.key).toBe(gatewayAccountKey('con_1', 'meta-a.json'));
  });

  it('takes the status from disabled and the faults, as the pools’ accounts do', () => {
    const off = mapFuseboxOtherSubscriptions('con_1', [{ ...meta, disabled: true }], [], NOW);
    expect(off[0]?.status).toBe('off');
    const used = mapFuseboxOtherSubscriptions(
      'con_1',
      [meta],
      [{ key: 'q', kind: 'quota', provider: 'meta', accountId: 'meta-a.json', until: MONDAY }],
      NOW,
    );
    expect(used[0]).toMatchObject({ status: 'used_up', until: MONDAY });
  });

  it('knows the Claude and ChatGPT accounts it signs in to, also one that is off and unread', () => {
    const keys = fuseboxSignedIn('con_1', body);
    expect([...keys]).toEqual([
      gatewayAccountKey('con_1', 'claude-work.json'),
      gatewayAccountKey('con_1', 'claude-off.json'),
    ]);
  });

  it('names each tool and its mark as Fusebox’s dashboard does', () => {
    expect(['claude', 'codex', 'meta', 'xai', 'antigravity'].map(fuseboxToolName)).toEqual([
      'Claude',
      'ChatGPT',
      'Meta',
      'Grok',
      'Antigravity',
    ]);
    expect(['claude', 'codex', 'meta', 'antigravity'].map(fuseboxProviderMark)).toEqual([
      'claude',
      'openai',
      'meta',
      'antigravity',
    ]);
  });
});

describe('Whombat’s named client (AIG-02, AIG-03)', () => {
  const others = [
    { id: 'laptop', label: 'Laptop', key: 'sk-laptop', extra: true },
    { id: 'whombat-lumio-bv', label: 'Whombat · Old', key: 'wbgw_old' },
    { id: 'phone', label: 'Phone', key: 'sk-phone' },
  ];
  const ours = { id: 'whombat-lumio-bv', label: 'Whombat · Lumio BV', key: 'wbgw_new' };

  it('replaces its own entry in place and leaves every other one as read', () => {
    expect(withWhombatClient(others, ours)).toEqual([others[0], ours, others[2]]);
  });

  it('keeps what the person set on its entry (a model map, models, limits) but not an expiry already past', () => {
    const set = {
      id: 'whombat-lumio-bv',
      label: 'Whombat · Old',
      key: 'wbgw_old',
      'model-map': { 'claude-opus-*': 'claude-sonnet-5-5' },
      models: ['claude-*'],
      'usd-per-month': 50,
      expires: '2026-10-01',
    };
    const [entry] = withWhombatClient([set], ours, NOW) as Record<string, unknown>[];
    expect(entry).toMatchObject({
      ...ours,
      'model-map': set['model-map'],
      models: set.models,
      'usd-per-month': 50,
    });
    expect(entry).not.toHaveProperty('expires');
    // An expiry still ahead stays.
    const ahead = withWhombatClient([{ ...set, expires: '2026-10-10' }], ours, NOW) as Record<
      string,
      unknown
    >[];
    expect(ahead[0]?.expires).toBe('2026-10-10');
  });

  it('adds it at the end when it isn’t there', () => {
    expect(withWhombatClient([others[0]], ours)).toEqual([others[0], ours]);
    expect(withWhombatClient([], ours)).toEqual([ours]);
  });

  it('takes only its own entry out', () => {
    expect(withoutClient(others, 'whombat-lumio-bv')).toEqual([others[0], others[2]]);
    expect(withoutClient(others, 'nobody')).toEqual(others);
  });

  it('reads the settings answer and tells an open Fusebox (no keys, no named clients)', () => {
    const settings = parseFuseboxSettings({
      revision: 'r1',
      values: { 'named-clients': [], 'api-keys': [], port: 8317 },
    });
    expect(settings).toEqual({ revision: 'r1', namedClients: [], apiKeys: [] });
    expect(settings && isOpenFusebox(settings)).toBe(true);
    const keyed = parseFuseboxSettings({ revision: 'r2', values: { 'api-keys': ['sk-1'] } });
    expect(keyed).toEqual({ revision: 'r2', namedClients: null, apiKeys: ['sk-1'] });
    expect(keyed && isOpenFusebox(keyed)).toBe(false);
    expect(parseFuseboxSettings({ values: {} })).toBeNull();
    expect(parseFuseboxSettings('nope')).toBeNull();
  });

  it('knows an older Fusebox by a 400 naming named-clients', () => {
    expect(refusedNamedClients(400, { error: 'unknown field `named-clients`' })).toBe(true);
    expect(refusedNamedClients(400, 'unknown setting named_clients')).toBe(true);
    expect(refusedNamedClients(400, { error: 'request-retry must be positive' })).toBe(false);
    expect(refusedNamedClients(409, { error: 'named-clients' })).toBe(false);
  });

  it('makes wbgw_ keys of 32 random bytes', () => {
    const key = newGatewayClientKey();
    expect(key).toMatch(/^wbgw_[A-Za-z0-9_-]{43}$/);
    expect(newGatewayClientKey()).not.toBe(key);
  });
});
