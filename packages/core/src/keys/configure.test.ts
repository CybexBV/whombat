import { describe, expect, it } from 'vitest';
import type { Grant } from '../domain/grant.js';
import {
  ALL_KEY_OPTIONS,
  agentDefaultGrants,
  configureGrants,
  configureKeyState,
  configureKeyTiers,
  decide,
  describeGrantChange,
  diffGrants,
  KEY_TIER_ROWS,
  keyRowTier,
  RISK_KEY_OPTIONS,
  withKeyRowTier,
} from './index.js';

const AGENT = 'prn_dusty';
// A narrow set as the mock's developer held it (AG0: a stale `merge.main: cannot`, `deploy: cannot`).
const developer: Grant[] = [
  { agentId: AGENT, keyId: 'branch.feature.readwrite', tier: 'can' },
  { agentId: AGENT, keyId: 'tests.run', tier: 'can' },
  { agentId: AGENT, keyId: 'pr.open', tier: 'can' },
  { agentId: AGENT, keyId: 'branch.shared.push', tier: 'ask' },
  { agentId: AGENT, keyId: 'merge.main', tier: 'cannot' },
  { agentId: AGENT, keyId: 'deploy', tier: 'cannot' },
];
const defaults = agentDefaultGrants(AGENT);
const strip = (grants: readonly Grant[]) => grants.map(({ agentId: _agentId, ...g }) => g);

describe('configureKeyState', () => {
  it('turns on the switches held at can, and a row when it reads On', () => {
    const state = configureKeyState(
      [
        ...developer.filter((g) => g.keyId !== 'deploy'),
        { agentId: AGENT, keyId: 'pr.comment', tier: 'ask' },
        { agentId: AGENT, keyId: 'deploy', tier: 'can' },
      ],
      [...RISK_KEY_OPTIONS, ...ALL_KEY_OPTIONS],
    );
    expect(state).toMatchObject({
      deploy: true,
      merge: false,
      'branch.main.push': false,
      'refunds.issue': false,
      'pr.comment': false,
      'branch.feature.readwrite': true,
      'tests.run': true,
      'pr.open': true,
      'branch.shared.push': false,
      'web.browse': false,
    });
    // Retired keys (CT-824) have no switch.
    expect(state).not.toHaveProperty('packs.tool.write');
    expect(Object.keys(state)).toHaveLength(RISK_KEY_OPTIONS.length + ALL_KEY_OPTIONS.length);
  });
});

describe('configureGrants (All keys)', () => {
  const opts = ALL_KEY_OPTIONS;
  const base = configureKeyState(developer, opts);

  it('changes nothing when nothing was toggled', () => {
    expect(configureGrants(developer, { baseKeys: base, keys: base }, opts)).toBeNull();
  });

  it('applies only the toggled rows and keeps every other grant as held', () => {
    const next = configureGrants(
      developer,
      {
        baseKeys: base,
        keys: { ...base, 'pr.open': false, 'web.browse': true },
      },
      opts,
    );
    const expected = strip(developer).filter((g) => g.keyId !== 'pr.open');
    expect(next).toEqual([...expected, { keyId: 'web.browse', tier: 'can' }]);
    // The held ask / cannot keys (and Deploy at cannot) are untouched.
    expect(next?.find((g) => g.keyId === 'deploy')).toEqual({ keyId: 'deploy', tier: 'cannot' });
    expect(next?.find((g) => g.keyId === 'branch.shared.push')).toEqual({
      keyId: 'branch.shared.push',
      tier: 'ask',
    });
  });

  it('raises a key held at ask to can when its row is switched on, keeping its scope', () => {
    const held: Grant[] = [
      { agentId: AGENT, keyId: 'pr.open', tier: 'ask', scope: { repos: ['burrow-hq/web'] } },
    ];
    const baseKeys = configureKeyState(held, opts);
    expect(baseKeys['pr.open']).toBe(false);
    expect(configureGrants(held, { baseKeys, keys: { ...baseKeys, 'pr.open': true } }, opts)).toEqual([
      { keyId: 'pr.open', tier: 'can', scope: { repos: ['burrow-hq/web'] } },
    ]);
  });

  it('reads and writes a switch at the key’s cap: sending mail is on when it asks', () => {
    const held: Grant[] = [{ agentId: AGENT, keyId: 'mail.send', tier: 'ask' }];
    const baseKeys = configureKeyState(held, opts);
    expect(baseKeys['mail.send']).toBe(true);
    const off = configureGrants(held, { baseKeys, keys: { ...baseKeys, 'mail.send': false } }, opts);
    expect(off).toEqual([]);
    const none = configureKeyState([], opts);
    expect(configureGrants([], { baseKeys: none, keys: { ...none, 'mail.send': true } }, opts)).toEqual([
      { keyId: 'mail.send', tier: 'ask' },
    ]);
  });

  it('applies the edits to the grants held now, keeping a change made elsewhere since the modal opened', () => {
    const now: Grant[] = [...developer, { agentId: AGENT, keyId: 'messages.search', tier: 'can' }];
    const next = configureGrants(now, { baseKeys: base, keys: { ...base, 'pr.open': false } }, opts);
    expect(next?.some((g) => g.keyId === 'messages.search')).toBe(true);
    expect(next?.some((g) => g.keyId === 'pr.open')).toBe(false);
  });
});

describe('a single key in three states (All keys: changing connected services)', () => {
  const opts = ALL_KEY_OPTIONS;
  const held = defaults;
  const save = (grants: Grant[], tier: Grant['tier']) => {
    const baseTiers = configureKeyTiers(grants, opts);
    const keys = configureKeyState(grants, opts);
    return configureGrants(
      grants,
      {
        baseKeys: keys,
        keys,
        baseTiers,
        tiers: { ...baseTiers, 'connections.write': tier },
      },
      opts,
    );
  };

  it('reads its tier and writes the one chosen, keeping every other grant', () => {
    // “Change things in connected services” (CT-270), On since 0.57; trashing mail and files beside it, at Ask.
    expect(configureKeyTiers(held, opts)).toEqual({
      'settings.change': 'ask',
      'mail.delete': 'ask',
      'files.delete': 'ask',
      'connections.write': 'can',
    });
    expect(configureKeyTiers([], opts)).toEqual({
      'settings.change': 'cannot',
      'mail.delete': 'cannot',
      'files.delete': 'cannot',
      'connections.write': 'cannot',
    });
    expect(save(held, 'can')).toBeNull();
    const ask = save(held, 'ask');
    expect(ask?.find((g) => g.keyId === 'connections.write')).toEqual({
      keyId: 'connections.write',
      tier: 'ask',
    });
    expect(ask).toHaveLength(held.length);
    const off = save(held, 'cannot');
    expect(off?.find((g) => g.keyId === 'connections.write')?.tier).toBe('cannot');
    const added = save([], 'can');
    expect(added).toEqual([{ keyId: 'connections.write', tier: 'can' }]);
  });
});

describe('Merge and Deploy rows in Keys (MD-02, CT-212)', () => {
  const g = (keyId: Grant['keyId'], tier: Grant['tier'], agentId = AGENT): Grant => ({
    agentId,
    keyId,
    tier,
  });
  const agent = { id: AGENT, kind: 'agent' as const };
  const save = (held: Grant[], tiers: { merge?: Grant['tier']; deploy?: Grant['tier'] }) => {
    const baseTiers = configureKeyTiers(held);
    const keys = configureKeyState(held);
    return configureGrants(held, {
      baseKeys: keys,
      keys,
      baseTiers,
      tiers: { ...baseTiers, ...tiers },
    });
  };
  const withAgent = (grants: readonly Omit<Grant, 'agentId'>[] | null) =>
    (grants ?? []).map((x) => ({ agentId: AGENT, ...x }));

  const allRows = (tier: Grant['tier']) => Object.fromEntries(KEY_TIER_ROWS.map((row) => [row, tier]));

  it('reads the tier that decides each row (the strictest of the keys it reads)', () => {
    expect(configureKeyTiers(developer)).toEqual(allRows('cannot'));
    // The agent's defaults ask before all six (RA-01, OA-05).
    expect(configureKeyTiers(defaults)).toEqual(allRows('ask'));
    // Money reads refunds and billing data, the strictest of the two.
    expect(keyRowTier([g('refunds.issue', 'can'), g('billing.write', 'ask')], 'refunds.issue')).toBe('ask');
    expect(keyRowTier([g('refunds.issue', 'can')], 'refunds.issue')).toBe('cannot');
    expect(keyRowTier([g('deploy.staging', 'can'), g('deploy.production', 'ask')], 'deploy')).toBe('ask');
    expect(keyRowTier([g('deploy', 'can'), g('deploy.production', 'cannot')], 'deploy')).toBe('cannot');
    expect(keyRowTier([g('merge', 'can')], 'merge')).toBe('can');
    // A stale `merge.main: cannot` under `merge: can` decides a merge into main, so the row reads Off.
    expect(keyRowTier([g('merge', 'can'), g('merge.main', 'cannot')], 'merge')).toBe('cannot');
    // Scopes aside; no grant reads Off.
    expect(keyRowTier([{ ...g('merge', 'ask'), scope: { repos: ['whombat/web'] } }], 'merge')).toBe('ask');
    expect(keyRowTier([], 'deploy')).toBe('cannot');
    // Only the rows shown.
    expect(configureKeyTiers(developer, [])).toEqual({});
  });

  it('turns Merge on over a stale merge.main: cannot', () => {
    const next = save(developer, { merge: 'can' });
    expect(next?.filter((x) => x.keyId === 'merge' || x.keyId === 'merge.main')).toEqual([
      { keyId: 'merge.main', tier: 'can' },
      { keyId: 'merge', tier: 'can' },
    ]);
    const after = withAgent(next);
    expect(decide(agent, after, 'merge.main').outcome).toBe('allow');
    expect(decide(agent, after, 'merge').outcome).toBe('allow');
    expect(configureKeyTiers(after)).toEqual({ ...allRows('cannot'), merge: 'can' });
    // Nothing else changed; the Keys events read as the person meant.
    expect(diffGrants(developer, after).map((c) => describeGrantChange('Dusty', c))).toEqual([
      'Gave Dusty a new key: Merge',
      'Gave Dusty a new key: Merge into main',
    ]);
  });

  it('sets Deploy to Ask, then On, then Off, aligning staging and production', () => {
    const on = withAgent(save(defaults, { deploy: 'can' }));
    // The defaults hold the row's keys at ask (RA-01): the row aligns them in place.
    expect(on.filter((x) => x.keyId.startsWith('deploy'))).toEqual([
      g('deploy', 'can'),
      g('deploy.staging', 'can'),
      g('deploy.production', 'can'),
    ]);
    expect(decide(agent, on, 'deploy.production').outcome).toBe('allow');
    expect(diffGrants(defaults, on).map((c) => [c.keyId, c.from, c.to])).toEqual([
      ['deploy.staging', 'ask', 'can'],
      ['deploy.production', 'ask', 'can'],
      ['deploy', 'ask', 'can'],
    ]);
    expect(diffGrants(defaults, on).map((c) => describeGrantChange('Dusty', c))[0]).toBe(
      'Let Dusty use “Deploy to staging” without asking',
    );
    const off = withAgent(save(on, { deploy: 'cannot' }));
    expect(decide(agent, off, 'deploy.staging').outcome).toBe('deny');
    expect(configureKeyTiers(off).deploy).toBe('cannot');
    const asks = withAgent(save(off, { deploy: 'ask' }));
    expect(decide(agent, asks, 'deploy.production').outcome).toBe('ask');
    expect(decide(agent, asks, 'deploy').outcome).toBe('ask');
  });

  it('round-trips: a save at the tiers it opened with changes nothing', () => {
    for (const held of [developer, defaults]) expect(save(held, {})).toBeNull();
    // Re-reading after any save gives the tiers that were set.
    for (const merge of ['cannot', 'ask', 'can'] as const)
      for (const deploy of ['cannot', 'ask', 'can'] as const) {
        const next = save(developer, { merge, deploy });
        const tiers = configureKeyTiers(withAgent(next ?? developer));
        expect(tiers).toEqual({ ...allRows('cannot'), merge, deploy });
      }
  });

  it('drops a row grant’s scope and keeps every other grant', () => {
    const held: Grant[] = [{ ...g('merge', 'ask'), scope: { repos: ['whombat/web'] } }, g('pr.open', 'can')];
    expect(save(held, { merge: 'can' })).toEqual([g('merge', 'can'), g('pr.open', 'can')].map(strip1));
  });

  it('reads a switch edit on a row when no tiers are sent (a client showing the rows as switches)', () => {
    const base = configureKeyState(developer);
    const next = configureGrants(developer, {
      baseKeys: base,
      keys: { ...base, merge: true },
    });
    expect(keyRowTier(withAgent(next), 'merge')).toBe('can');
    const offAgain = configureGrants(withAgent(next), {
      baseKeys: configureKeyState(withAgent(next)),
      keys: { ...configureKeyState(withAgent(next)), merge: false },
    });
    expect(keyRowTier(withAgent(offAgain), 'merge')).toBe('cannot');
  });

  it('offers the six rows', () => {
    expect(Object.keys(configureKeyTiers(defaults, RISK_KEY_OPTIONS))).toEqual([...KEY_TIER_ROWS]);
  });

  it('withKeyRowTier adds the umbrella once, leaves narrower keys absent when not held, and writes Money whole', () => {
    expect(withKeyRowTier([], 'deploy', 'ask')).toEqual([{ keyId: 'deploy', tier: 'ask' }]);
    expect(withKeyRowTier([{ keyId: 'deploy', tier: 'cannot' }], 'deploy', 'can')).toEqual([
      { keyId: 'deploy', tier: 'can' },
    ]);
    expect(withKeyRowTier([], 'refunds.issue', 'can')).toEqual([
      { keyId: 'refunds.issue', tier: 'can' },
      { keyId: 'billing.write', tier: 'can' },
    ]);
    expect(
      withKeyRowTier(
        [
          { keyId: 'billing.write', tier: 'cannot' },
          { keyId: 'pr.open', tier: 'can' },
        ],
        'refunds.issue',
        'ask',
      ),
    ).toEqual([
      { keyId: 'billing.write', tier: 'ask' },
      { keyId: 'pr.open', tier: 'can' },
      { keyId: 'refunds.issue', tier: 'ask' },
    ]);
    expect(withKeyRowTier([], 'messages.external', 'can')).toEqual([
      { keyId: 'messages.external', tier: 'can' },
    ]);
  });
});

function strip1({ agentId: _agentId, ...grant }: Grant) {
  return grant;
}
