/**
 * The AI gateway's decisions (docs/decisions/ai-gateway.md AIG-11, AIG-12, AIG-14): used up, the refusal a turn gets,
 * and the person's alerts, once per fault and `until`.
 */
import type { GatewayAccountUsage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { StoredGatewayFault } from '../db/schema/gateway';
import {
  dueGatewayAlerts,
  fallbackProvider,
  fallbackSignIns,
  fallsBack,
  gatewayRefusal,
  unreachable,
  usableOwnSignIn,
  usedUpUntil,
} from './logic';

const NOW = new Date('2026-10-10T12:00:00Z');
const SOON = '2026-10-10T14:05:00.000Z';
const MONDAY = '2026-10-12T07:00:00.000Z';

function acct(over: Partial<GatewayAccountUsage>): GatewayAccountUsage {
  return {
    key: 'k',
    label: 'a@example.com',
    provider: 'claude',
    plan: null,
    status: 'ok',
    until: null,
    windows: [],
    ...over,
  };
}

describe('used up (AIG-12)', () => {
  it('only when every enabled account of the provider is used up, with the earliest until', () => {
    const accounts = [
      acct({ status: 'used_up', until: MONDAY }),
      acct({ status: 'used_up', until: SOON }),
      acct({ status: 'off' }),
      acct({ provider: 'codex' }),
    ];
    expect(usedUpUntil(accounts, 'claude', NOW)).toEqual({ until: SOON });
    expect(usedUpUntil(accounts, 'codex', NOW)).toBeNull();
    expect(
      usedUpUntil([...accounts, acct({ status: 'rate_limited', until: SOON })], 'claude', NOW),
    ).toBeNull();
    // No enabled account: Fusebox answers for itself.
    expect(usedUpUntil([acct({ status: 'off' })], 'claude', NOW)).toBeNull();
    // An API key out of credit is used up, but Fusebox's next try of it is no time to promise room.
    const broke = acct({ status: 'used_up', until: SOON, outOfCredit: true });
    expect(usedUpUntil([acct({ status: 'used_up', until: MONDAY }), broke], 'claude', NOW)).toEqual({
      until: MONDAY,
    });
    expect(usedUpUntil([broke], 'claude', NOW)).toEqual({ until: null });
    // A reset that has passed is room again.
    expect(
      usedUpUntil([acct({ status: 'used_up', until: '2026-10-10T11:00:00Z' })], 'claude', NOW),
    ).toBeNull();
    expect(usedUpUntil([acct({ status: 'used_up', until: null })], 'claude', NOW)).toEqual({ until: null });
  });
});

describe('the refusal at claim (AIG-12)', () => {
  const usage = (over: Partial<{ failures: number; accounts: GatewayAccountUsage[] }> = {}) => ({
    failures: 0,
    failingSince: null,
    accounts: [],
    ...over,
  });

  it('missing, then unreachable, then used up, in that order', () => {
    const usedUp = [acct({ status: 'used_up', until: MONDAY })];
    expect(
      gatewayRefusal({
        usable: false,
        kind: 'fusebox',
        usage: usage({ failures: 5, accounts: usedUp }),
        provider: 'claude',
        now: NOW,
      }),
    ).toEqual({ code: 'gateway.missing', until: null });
    expect(
      gatewayRefusal({
        usable: true,
        kind: 'fusebox',
        usage: usage({ failures: 2, accounts: usedUp }),
        provider: 'claude',
        now: NOW,
      }),
    ).toEqual({ code: 'gateway.unreachable', until: null });
    expect(
      gatewayRefusal({
        usable: true,
        kind: 'fusebox',
        usage: usage({ failures: 1, accounts: usedUp }),
        provider: 'claude',
        now: NOW,
      }),
    ).toEqual({ code: 'gateway.used_up', until: MONDAY });
  });

  it('lets a turn start before the first poll, on the other tool, and on a generic gateway', () => {
    expect(
      gatewayRefusal({ usable: true, kind: 'fusebox', usage: null, provider: 'claude', now: NOW }),
    ).toBeNull();
    const usedUp = usage({ accounts: [acct({ status: 'used_up', until: MONDAY })] });
    expect(
      gatewayRefusal({ usable: true, kind: 'fusebox', usage: usedUp, provider: 'codex', now: NOW }),
    ).toBeNull();
    expect(
      gatewayRefusal({ usable: true, kind: 'ai_gateway', usage: usedUp, provider: 'claude', now: NOW }),
    ).toBeNull();
  });

  it('counts two failed polls in a row as unreachable', () => {
    expect(unreachable({ failures: 1 })).toBe(false);
    expect(unreachable({ failures: 2 })).toBe(true);
    expect(unreachable(null)).toBe(false);
  });
});

describe('alerts to the person (AIG-14)', () => {
  const on = { claude: true, codex: false };
  const ok = { failures: 0, failingSince: null };
  const out: StoredGatewayFault = {
    key: 'provider:claude',
    kind: 'provider',
    provider: 'claude',
    accountId: null,
    until: MONDAY,
  };
  const signin: StoredGatewayFault = {
    key: 'signin:acct-1',
    kind: 'signin',
    provider: 'claude',
    accountId: 'acct-1',
    until: null,
  };
  const labelOf = (id: string) => (id === 'acct-1' ? 'work@example.com' : null);

  it('says “no room” once per fault and until, and “room again” once it is over', () => {
    const first = dueGatewayAlerts({
      switches: on,
      faults: [out],
      labelOf,
      reachability: ok,
      sent: [],
      now: NOW,
    });
    expect(first.alerts).toEqual([{ kind: 'used_up', provider: 'claude', until: MONDAY }]);
    const again = dueGatewayAlerts({
      switches: on,
      faults: [{ ...out, until: '2026-10-12T07:00:20Z' }],
      labelOf,
      reachability: ok,
      sent: first.keys,
      now: NOW,
    });
    expect(again.alerts).toEqual([]);
    const later = dueGatewayAlerts({
      switches: on,
      faults: [{ ...out, until: '2026-10-13T07:00:00Z' }],
      labelOf,
      reachability: ok,
      sent: again.keys,
      now: NOW,
    });
    // A new until is a new fault: said again, and no “back” in between.
    expect(later.alerts).toEqual([{ kind: 'used_up', provider: 'claude', until: '2026-10-13T07:00:00Z' }]);
    const back = dueGatewayAlerts({
      switches: on,
      faults: [],
      labelOf,
      reachability: ok,
      sent: later.keys,
      now: NOW,
    });
    expect(back.alerts).toEqual([{ kind: 'back', provider: 'claude' }]);
    expect(back.keys).toEqual([]);
  });

  it('says nothing about a fault whose line is quiet, then or when it is over (quiet-notices.md QN-S19)', () => {
    const quiet = (f: Pick<StoredGatewayFault, 'kind'>) => f.kind === 'provider';
    const first = dueGatewayAlerts({
      switches: on,
      faults: [out, signin],
      labelOf,
      reachability: ok,
      sent: [],
      now: NOW,
      quiet,
    });
    expect(first.alerts).toEqual([
      { kind: 'signin_expired', provider: 'claude', account: 'work@example.com' },
    ]);
    // The ignore ended (no `quiet` now) while it lasts: still nothing; when it is over, no “room again” either.
    const again = dueGatewayAlerts({
      switches: on,
      faults: [out],
      labelOf,
      reachability: ok,
      sent: first.keys,
      now: NOW,
    });
    expect(again.alerts).toEqual([]);
    const over = dueGatewayAlerts({
      switches: on,
      faults: [],
      labelOf,
      reachability: ok,
      sent: again.keys,
      now: NOW,
    });
    expect(over.alerts).toEqual([]);
    expect(over.keys).toEqual([]);
  });

  it('only for a tool whose switch is on', () => {
    const off = dueGatewayAlerts({
      switches: { claude: false, codex: true },
      faults: [out, signin],
      labelOf,
      reachability: ok,
      sent: [],
      now: NOW,
    });
    expect(off.alerts).toEqual([]);
  });

  it('says an expired sign-in once, with the account', () => {
    const first = dueGatewayAlerts({
      switches: on,
      faults: [signin],
      labelOf,
      reachability: ok,
      sent: [],
      now: NOW,
    });
    expect(first.alerts).toEqual([
      { kind: 'signin_expired', provider: 'claude', account: 'work@example.com' },
    ]);
    const again = dueGatewayAlerts({
      switches: on,
      faults: [signin],
      labelOf,
      reachability: ok,
      sent: first.keys,
      now: NOW,
    });
    expect(again.alerts).toEqual([]);
    expect(
      dueGatewayAlerts({ switches: on, faults: [], labelOf, reachability: ok, sent: again.keys, now: NOW }),
    ).toEqual({ alerts: [], keys: [] });
  });

  it('says it can’t reach the gateway after 5 minutes with a switch on, and when it answers again', () => {
    const since = new Date(NOW.getTime() - 4 * 60_000);
    const early = dueGatewayAlerts({
      switches: on,
      faults: [out],
      labelOf,
      reachability: { failures: 3, failingSince: since },
      sent: ['provider:claude|2026-10-12T07:00:00.000Z'],
      now: NOW,
    });
    // Down: nothing new about faults, nothing over, and not five minutes yet.
    expect(early.alerts).toEqual([]);
    expect(early.keys).toEqual(['provider:claude|2026-10-12T07:00:00.000Z']);
    const fiveMin = new Date(since.getTime() + 5 * 60_000);
    const down = dueGatewayAlerts({
      switches: { claude: true, codex: true },
      faults: [],
      labelOf,
      reachability: { failures: 5, failingSince: since },
      sent: early.keys,
      now: fiveMin,
    });
    expect(down.alerts).toEqual([{ kind: 'unreachable', providers: ['claude', 'codex'] }]);
    const still = dueGatewayAlerts({
      switches: on,
      faults: [],
      labelOf,
      reachability: { failures: 6, failingSince: since },
      sent: down.keys,
      now: fiveMin,
    });
    expect(still.alerts).toEqual([]);
    const up = dueGatewayAlerts({
      switches: on,
      faults: [out],
      labelOf,
      reachability: ok,
      sent: still.keys,
      now: NOW,
    });
    expect(up.alerts).toEqual([{ kind: 'reachable' }]);
    expect(up.keys).toEqual(['provider:claude|2026-10-12T07:00:00.000Z']);
  });

  it('says nothing about an unreachable gateway with every switch off', () => {
    const since = new Date(NOW.getTime() - 60 * 60_000);
    expect(
      dueGatewayAlerts({
        switches: { claude: false, codex: false },
        faults: [],
        labelOf,
        reachability: { failures: 9, failingSince: since },
        sent: [],
        now: NOW,
      }).alerts,
    ).toEqual([]);
  });
});

describe('the person’s own sign-in when the gateway can’t take a turn', () => {
  const sub = (authMode: string, signal: { state: string; until: string | null } | null = null) => ({
    authMode,
    signal,
  });

  it('falls back when the gateway is gone or silent, never when its pool is used up', () => {
    expect(fallsBack('gateway.unreachable')).toBe(true);
    expect(fallsBack('gateway.missing')).toBe(true);
    expect(fallsBack('gateway.used_up')).toBe(false);
  });

  it('takes only a subscription that works now, never a paid key', () => {
    expect(usableOwnSignIn('claude', sub('subscription_cli'), NOW)).toBe(true);
    expect(usableOwnSignIn('claude', sub('subscription_sdk'), NOW)).toBe(true);
    expect(usableOwnSignIn('codex', sub('chatgpt'), NOW)).toBe(true);
    expect(usableOwnSignIn('codex', sub('access_token'), NOW)).toBe(true);
    expect(usableOwnSignIn('claude', sub('api_key'), NOW)).toBe(false);
    expect(usableOwnSignIn('claude', sub('cloud'), NOW)).toBe(false);
    expect(usableOwnSignIn('codex', sub('api_key'), NOW)).toBe(false);
    expect(usableOwnSignIn('claude', null, NOW)).toBe(false);
    expect(
      usableOwnSignIn('claude', sub('subscription_cli', { state: 'auth_expired', until: null }), NOW),
    ).toBe(false);
    expect(
      usableOwnSignIn('claude', sub('subscription_cli', { state: 'quota_exhausted', until: SOON }), NOW),
    ).toBe(false);
    // A limit that has reset, or one with no time (only a turn on it would clear it), doesn't stop it.
    expect(
      usableOwnSignIn(
        'claude',
        sub('subscription_cli', { state: 'quota_exhausted', until: '2026-10-10T11:00:00.000Z' }),
        NOW,
      ),
    ).toBe(true);
    expect(usableOwnSignIn('codex', sub('chatgpt', { state: 'outage', until: null }), NOW)).toBe(true);
  });

  it('prefers the turn’s own tool, then the other, among those the runner runs', () => {
    const both = { claude: sub('subscription_cli'), codex: sub('chatgpt') };
    const claimable = ['claude', 'codex', 'local'];
    expect(fallbackProvider({ provider: 'claude', signIns: both, claimable, now: NOW })).toBe('claude');
    expect(fallbackProvider({ provider: 'codex', signIns: both, claimable, now: NOW })).toBe('codex');
    expect(
      fallbackProvider({ provider: 'claude', signIns: { codex: sub('chatgpt') }, claimable, now: NOW }),
    ).toBe('codex');
    expect(
      fallbackProvider({
        provider: 'claude',
        signIns: { codex: sub('chatgpt') },
        claimable: ['claude'],
        now: NOW,
      }),
    ).toBeNull();
    expect(
      fallbackProvider({ provider: 'claude', signIns: { claude: sub('api_key') }, claimable, now: NOW }),
    ).toBeNull();
    expect(fallbackSignIns(both, NOW)).toEqual(['claude', 'codex']);
    expect(fallbackSignIns({ codex: sub('api_key') }, NOW)).toEqual([]);
  });

  it('names them in the alert that the gateway doesn’t answer', () => {
    const down = dueGatewayAlerts({
      switches: { claude: true, codex: false },
      faults: [],
      labelOf: () => null,
      reachability: { failures: 5, failingSince: new Date(NOW.getTime() - 6 * 60_000) },
      sent: [],
      now: NOW,
      fallback: ['claude'],
    });
    expect(down.alerts).toEqual([{ kind: 'unreachable', providers: ['claude'], fallback: ['claude'] }]);
  });
});
