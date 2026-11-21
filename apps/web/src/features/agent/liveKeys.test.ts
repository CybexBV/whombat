import type { Grant } from '@whombat/core';
import {
  ALL_KEY_OPTIONS,
  configureGrants,
  configureKeyState,
  configureKeyTiers,
  keyRowTier,
  RISK_KEY_OPTIONS,
} from '@whombat/core/keys';
import { describe, expect, it } from 'vitest';
import {
  allKeyOptions,
  keyPlace,
  keyRowOptions,
  liveKeyRows,
  ownKeyOptions,
  selectedKeys,
  TIER_SEGMENTS,
  tierKeyRows,
} from './liveKeys';

const row = (rows: ReturnType<typeof liveKeyRows>, keyId: string) =>
  rows.find((r) => r.option.keyId === keyId);

describe('All keys as the switches stand (S2, AP-253, AP-679)', () => {
  const options = ownKeyOptions(ALL_KEY_OPTIONS);

  it('shows “Browse the web” on and locked while “Use a web browser” is on, and sends only the browser key', () => {
    const on = new Set(['browser.use', 'pr.comment']);
    const rows = liveKeyRows(options, (k) => on.has(k));
    expect(row(rows, 'web.browse')).toMatchObject({
      checked: true,
      includedWith: 'browser.use',
      note: 'included with the browser',
    });
    expect(selectedKeys(rows)).toEqual(expect.arrayContaining(['pr.comment', 'browser.use']));
    expect(selectedKeys(rows)).not.toContain('web.browse');
  });

  it('makes it an ordinary row again once the browser is off', () => {
    const rows = liveKeyRows(options, (k) => k === 'web.browse');
    expect(row(rows, 'web.browse')).toMatchObject({ checked: true, includedWith: null, note: null });
    expect(row(rows, 'browser.use')?.checked).toBe(false);
    expect(selectedKeys(rows)).toEqual(['web.browse']);
  });

  it('leaves the three-state keys out of the switches: the rows and connected services’ changes (CT-246)', () => {
    const rows = liveKeyRows([...RISK_KEY_OPTIONS, ...options], () => true);
    for (const key of ['deploy', 'merge', 'refunds.issue', 'connections.write'])
      expect(row(rows, key)).toBeUndefined();
    expect(row(rows, 'pr.approve')?.checked).toBe(true);
  });

  it('lists every key; a pack’s tools are gone', () => {
    expect(allKeyOptions().map((o) => o.keyId)).toEqual(ALL_KEY_OPTIONS.map((o) => o.keyId));
    expect(allKeyOptions().map((o) => o.keyId)).not.toContain('packs.tool.write');
    expect(allKeyOptions().map((o) => o.keyId)).toContain('connections.write');
  });
});

describe('Keys by risk: six rows, Off · Ask · On (RA-01, RA-02; AP-678)', () => {
  const tiers = (deployWorkflow?: boolean) =>
    tierKeyRows(keyRowOptions(RISK_KEY_OPTIONS), (_, o) => o.defaultTier ?? 'cannot', deployWorkflow);

  it('opens all six rows at Ask, with the rows’ own labels and lines', () => {
    expect(tiers().map((r) => [r.row, r.tier])).toEqual([
      ['deploy', 'ask'],
      ['merge', 'ask'],
      ['branch.main.push', 'ask'],
      ['commands.destructive', 'ask'],
      ['messages.external', 'ask'],
      ['refunds.issue', 'ask'],
    ]);
    expect(tiers().map((r) => r.label)).toEqual([
      'Deploy',
      'Merge into main',
      'Push to main',
      'Destructive commands on other machines',
      'Message people outside your Whombat',
      'Money',
    ]);
    expect(tiers()[5]?.description).toBe('Refunds, payments and billing data.');
    expect(TIER_SEGMENTS.map((s) => s.label)).toEqual(['Just watch', 'Ask me first', 'Go ahead']);
  });

  it('gives Deploy its hint only when the Whombat has no deploy workflow', () => {
    const hint = (w?: boolean) => tiers(w).map((r) => r.hint);
    const none = [null, null, null, null, null, null];
    expect(hint(false)).toEqual(['No deploy workflow is set up on this Whombat yet.', ...none.slice(1)]);
    expect(hint(true)).toEqual(none);
    expect(hint(undefined)).toEqual(none);
  });

  it('round-trips a stale `merge.main: cannot`: reads Off, writes the row at Ask, reads Ask', () => {
    const options = [...RISK_KEY_OPTIONS, ...ALL_KEY_OPTIONS];
    // An agent that still holds the narrow `merge.main` at `cannot` (from before 0.44).
    const held: Grant[] = [{ agentId: 'agt_neo', keyId: 'merge.main', tier: 'cannot' }];
    const baseTiers = configureKeyTiers(held, options);
    expect(baseTiers).toEqual({
      deploy: 'cannot',
      merge: 'cannot',
      'branch.main.push': 'cannot',
      'commands.destructive': 'cannot',
      'messages.external': 'cannot',
      'refunds.issue': 'cannot',
      // Trashing mail and files (accounts.md ACC-04) and “Change things in connected services” (CT-270): three states.
      'settings.change': 'cannot',
      'mail.delete': 'cannot',
      'files.delete': 'cannot',
      'connections.write': 'cannot',
    });
    const keys = configureKeyState(held, ALL_KEY_OPTIONS);
    const edit = { baseKeys: keys, keys, baseTiers };
    expect(configureGrants(held, { ...edit, tiers: baseTiers }, options)).toBeNull();

    const saved = configureGrants(held, { ...edit, tiers: { ...baseTiers, merge: 'ask' } }, options);
    expect(saved).toContainEqual({ keyId: 'merge.main', tier: 'ask' });
    expect(saved).toContainEqual({ keyId: 'merge', tier: 'ask' });
    const after = (saved ?? []).map((g) => ({ ...g, agentId: 'agt_neo' }));
    expect(configureKeyTiers(after, options)).toEqual({ ...baseTiers, merge: 'ask' });
    // On without the narrower grant aligned would still read Off: the row is what decides.
    expect(keyRowTier([...held, { agentId: 'agt_neo', keyId: 'merge', tier: 'can' }], 'merge')).toBe(
      'cannot',
    );
  });

  it('writes both of Money’s keys, and Change things in connected services as a key of its own', () => {
    const options = [...RISK_KEY_OPTIONS, ...ALL_KEY_OPTIONS];
    const held: Grant[] = [];
    const baseTiers = configureKeyTiers(held, options);
    const keys = configureKeyState(held, ALL_KEY_OPTIONS);
    const edit = { baseKeys: keys, keys, baseTiers };
    const saved = configureGrants(
      held,
      { ...edit, tiers: { ...baseTiers, 'refunds.issue': 'can', 'connections.write': 'ask' } },
      options,
    );
    expect(saved).toContainEqual({ keyId: 'refunds.issue', tier: 'can' });
    expect(saved).toContainEqual({ keyId: 'billing.write', tier: 'can' });
    expect(saved).toContainEqual({ keyId: 'connections.write', tier: 'ask' });
  });
});

describe('Keys’ `?key=` (AP-250, AP-679)', () => {
  const rows = keyRowOptions(RISK_KEY_OPTIONS);
  const all = allKeyOptions();

  it('finds a key’s row, a key under All keys, or nothing', () => {
    expect(keyPlace('deploy.staging', rows, all)).toEqual({ place: 'row', keyId: 'deploy' });
    expect(keyPlace('billing.write', rows, all)).toEqual({ place: 'row', keyId: 'refunds.issue' });
    expect(keyPlace('web.browse', rows, all)).toEqual({ place: 'all', keyId: 'web.browse' });
    // A person's own mail is a switch under All keys too, at its cap (contracts 0.123.0 `ACCOUNT_KEYS`).
    expect(keyPlace('mail.send', rows, all)).toEqual({ place: 'all', keyId: 'mail.send' });
    expect(keyPlace('agents.manage', rows, all)).toBeNull();
  });
});
