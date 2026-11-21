/**
 * What people see of the appliance licence (LC-13, LC-14) and of control's new refusals (LC-15, LC-16, LC-18, CT-78).
 */
import { describe, expect, it } from 'vitest';
import type { LicenceView } from '../session/managed-ops';
import { OperationError } from '../session/managed-ops';
import { claimErrorText } from './claim';
import { ControlError, createHttpControl, devicesAllowedOf } from './control';
import {
  isUnknownOp,
  licenceBanner,
  licenceDay,
  licenceRefreshErrorText,
  licenceRefusalText,
  licenceSummary,
  licenceUsage,
} from './licence';

const UTC = 'UTC';
const view = (over: Partial<LicenceView> = {}): LicenceView => ({
  state: 'licensed',
  reason: 'active',
  plan: 'whombat',
  limits: { devices: 3, connectors: 3 },
  renewedAt: '2026-09-25T10:00:00.000Z',
  expiresAt: '2026-10-09T10:00:00.000Z',
  graceEndsAt: '2026-11-08T10:00:00.000Z',
  effectiveAt: '2026-09-26T10:00:00.000Z',
  usage: { connectors: 3 },
  checkedAt: '2026-09-26T10:00:00.000Z',
  ...over,
});

describe('the Subscription section (LC-13)', () => {
  it('names the state, the plan and until when', () => {
    expect(licenceDay('2026-10-09T10:00:00.000Z', UTC)).toBe('9 October 2026');
    expect(licenceSummary(view(), UTC)).toEqual({
      dot: 'ok',
      title: 'Active',
      meta: 'Whombat plan · Valid until 9 October 2026',
    });
    expect(licenceSummary(view({ reason: 'trial', plan: 'trial' }), UTC).title).toBe('Trial');
    expect(licenceSummary(view({ reason: 'past_due' }), UTC)).toMatchObject({
      dot: 'warn',
      title: 'Payment problem',
    });
    expect(licenceSummary(view({ state: 'grace', reason: 'payment' }), UTC)).toEqual({
      dot: 'warn',
      title: 'Payment problem',
      meta: 'Whombat plan · Everything keeps working until 8 November 2026',
    });
    expect(licenceSummary(view({ state: 'grace', reason: 'not_renewed' }), UTC).title).toBe(
      'Not confirmed since 25 September 2026',
    );
    expect(
      licenceSummary(view({ state: 'grace', reason: 'no_licence', renewedAt: null, plan: null }), UTC),
    ).toMatchObject({ title: 'Not confirmed yet', meta: 'Everything keeps working until 8 November 2026' });
    expect(licenceSummary(view({ state: 'lapsed', reason: 'cancelled', graceEndsAt: null }), UTC)).toEqual({
      dot: 'bad',
      title: 'Ended',
      meta: 'Whombat plan · Agents and automations are paused. You can still read and export everything.',
    });
  });

  it('shows usage only against the limits there are', () => {
    expect(licenceUsage(view())).toEqual([{ key: 'connectors', text: 'Connectors 3 of 3', full: true }]);
    expect(licenceUsage(view({ limits: null }))).toEqual([]);
  });
});

describe('the strips (LC-14)', () => {
  it('grace and lapsed; nothing while licensed', () => {
    const grace = view({ state: 'grace', reason: 'not_renewed' });
    expect(licenceBanner(grace, UTC)).toEqual({
      tone: 'warn',
      text: 'Your Whombat couldn’t confirm its subscription. Everything keeps working until 8 November 2026.',
    });
    expect(licenceBanner(view({ state: 'grace', reason: 'payment' }), UTC)?.text).toBe(
      'There’s a problem with your Whombat’s subscription. Everything keeps working until 8 November 2026.',
    );
    const lapsed = {
      tone: 'bad',
      text: 'Your Whombat’s subscription has ended. You can still read and export everything.',
    };
    expect(licenceBanner(view({ state: 'lapsed', reason: 'expired' }))).toEqual(lapsed);
    expect(licenceBanner(view())).toBeNull();
    expect(licenceBanner(null)).toBeNull();
  });
});

describe('refusals (LC-10, LC-14)', () => {
  it('words `licence.lapsed` and `licence.limit` from the session and from REST', () => {
    const lapsed = new OperationError('messages.send', 403, 'licence.lapsed', 'x', {
      code: 'licence.lapsed',
    });
    expect(licenceRefusalText(lapsed)).toBe(
      'Your Whombat’s subscription has ended, so your agent and automations are paused. You can still read and export everything.',
    );
    const limit = new OperationError('connections.create', 403, 'licence.limit', 'x', {
      code: 'licence.limit',
      limit: 'connectors',
      allowed: 5,
    });
    expect(licenceRefusalText(limit)).toContain('5 connectors');
    expect(
      licenceRefusalText({
        code: 'licence.limit',
        details: { code: 'licence.limit', limit: 'connectors', allowed: 1 },
      }),
    ).toBe('Your plan allows 1 connector. Remove one or change your plan.');
    expect(licenceRefusalText(new OperationError('x', 403, 'forbidden', 'x'))).toBeNull();
  });

  it('“Check again” that couldn’t renew, or came too soon, says so', () => {
    expect(
      licenceRefreshErrorText(new OperationError('licence.refresh', 503, 'licence.renew_failed', 'x')),
    ).toBe('Couldn’t reach Whombat’s servers, so nothing changed. Try again in a minute.');
    expect(licenceRefreshErrorText(new OperationError('licence.refresh', 429, 'rate_limited', 'x'))).toBe(
      'You just checked. Try again in a minute.',
    );
    expect(isUnknownOp(new OperationError('licence.status', 404, 'unknown_op', 'x'))).toBe(true);
  });
});

describe('control’s refusals at claim and account deletion (LC-15, LC-16, LC-18, CT-78)', () => {
  const answering = (status: number, reason: string, message = 'x') =>
    createHttpControl('http://control.test', {
      tokens: { get: () => 't', set: () => {}, remove: () => {} },
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'x', message, details: { code: reason } } }), {
          status,
        }),
    });

  it('reads each reason and words the claim refusals', async () => {
    const start = (c: ReturnType<typeof answering>) =>
      c
        .startClaim({
          orgId: 'org_1',
          method: 'code',
          device: 'wb-1',
          terms: { version: '2026-09-27-draft' },
        })
        .catch((e: unknown) => e);
    const terms = await start(answering(400, 'terms_required'));
    expect(terms).toMatchObject({ code: 'terms_required' });
    expect(claimErrorText(terms, 'code')).toBe(
      'The Whombat Appliance Terms have changed. Update the app, then try again.',
    );
    const self = await start(answering(403, 'self_install_not_allowed'));
    expect(claimErrorText(self, 'code')).toBe(
      'This Whombat was installed by hand, and your plan doesn’t include self-installed Whombats.',
    );
    const limit = await start(answering(403, 'devices_allowed_reached', 'Your plan covers 2 Whombats.'));
    expect(devicesAllowedOf(limit)).toBe(2);
    expect(claimErrorText(limit, 'card')).toBe('Your plan covers 2 Whombats.');
    const one = await start(answering(403, 'devices_allowed_reached', 'Your plan covers 1 Whombats.'));
    expect(claimErrorText(one, 'code')).toBe('Your plan covers 1 Whombat.');
    const unknown = await start(answering(403, 'devices_allowed_reached', 'No.'));
    expect(claimErrorText(unknown, 'code')).toBe('Your plan doesn’t cover another Whombat.');
  });

  it('deletes the account with the typed email and forgets the token; refusals keep their reason', async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    let token: string | null = 't';
    const control = createHttpControl('http://control.test', {
      tokens: {
        get: () => token,
        set: (t) => {
          token = t;
        },
        remove: () => {
          token = null;
        },
      },
      fetch: async (url, init) => {
        seen.push({ url, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await control.deleteAccount('mara@burrowhq.example');
    expect(seen).toEqual([
      { url: 'http://control.test/v1/me', method: 'DELETE', body: { email: 'mara@burrowhq.example' } },
    ]);
    expect(token).toBeNull();
    for (const [status, reason] of [
      [409, 'org_has_devices'],
      [409, 'subscription_live'],
      [400, 'email_mismatch'],
    ] as const)
      await expect(answering(status, reason).deleteAccount('x@y.z')).rejects.toMatchObject({ code: reason });
    await expect(answering(400, 'email_mismatch').deleteAccount('x@y.z')).rejects.toBeInstanceOf(
      ControlError,
    );
  });
});
