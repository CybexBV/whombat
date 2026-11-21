import { SUBSCRIPTION_TERMS_VERSION } from '@whombat/control-contracts';
import { describe, expect, it } from 'vitest';
import {
  afterCreateOrgPath,
  type BillingPage,
  billingErrorText,
  billingPageOf,
  billingRedirectUrl,
  billingStateLine,
  billingTone,
  CHECKOUT_POLL_EVERY_MS,
  CHECKOUT_POLL_FOR_MS,
  canClaimMore,
  checkoutPollStep,
  claimRefusalOf,
  clampWhombats,
  createOrgErrorKey,
  createOrgForm,
  formatEuro,
  needsPlan,
  planCardText,
  planTotalText,
  pollCheckout,
  readInvitationSignIn,
  readSignupFragment,
  waitlistErrorText,
} from './billing';
import { claimErrorText } from './claim';
import { type BillingView, ControlError, createHttpControl } from './control';

const view = (over: Partial<BillingView> = {}): BillingView => ({
  org: 'org_1',
  provider: 'stripe',
  plan: { id: 'whombat', name: 'Whombat' },
  state: 'active',
  trialEndsAt: null,
  currentPeriodEnd: Date.UTC(2026, 10, 1, 12) / 1000,
  cancelAtPeriodEnd: false,
  whombats: { claimed: 1, paid: 2 },
  setupRequired: false,
  trialAvailable: true,
  manual: false,
  ...over,
});

const whombat = {
  id: 'whombat',
  name: 'Whombat',
  amountCents: 4900,
  currency: 'eur' as const,
  interval: 'month' as const,
  limits: { connectors: null },
};

describe('plans and prices', () => {
  it('formats euros the way the spec writes them', () => {
    expect(formatEuro(4900)).toBe('€49');
    expect(formatEuro(14900)).toBe('€149');
    expect(formatEuro(149000)).toBe('€1,490');
    expect(formatEuro(4950)).toBe('€49.50');
    expect(formatEuro(0)).toBe('€0');
  });

  it('writes a plan card from the plan, not from hard-coded prices', () => {
    expect(planCardText(whombat)).toEqual({
      name: 'Whombat',
      price: '€49 per Whombat a month',
      extras: 'Unlimited connectors',
    });
    expect(planCardText({ name: 'Solo', amountCents: 1900, limits: { connectors: 2 } })).toEqual({
      name: 'Solo',
      price: '€19 per Whombat a month',
      extras: 'Up to 2 connectors',
    });
    expect(planTotalText(whombat, 2)).toBe('Total €98 a month');
  });

  it('keeps the Whombats stepper within 1…50', () => {
    expect(clampWhombats(0)).toBe(1);
    expect(clampWhombats(3)).toBe(3);
    expect(clampWhombats(51)).toBe(50);
    expect(clampWhombats(Number.NaN)).toBe(1);
  });
});

describe('the Billing page', () => {
  it('picks the page from the view', () => {
    const cases: [Partial<BillingView>, BillingPage][] = [
      [{ setupRequired: true, plan: null, state: 'cancelled' }, 'choose'],
      [{ state: 'cancelled' }, 'choose'],
      [{ manual: true, provider: 'manual', state: 'trialing' }, 'manual'],
      [{ manual: true, state: 'cancelled' }, 'manual'],
      [{ state: 'trialing' }, 'subscribed'],
      [{ state: 'past_due' }, 'subscribed'],
    ];
    for (const [over, page] of cases) expect(billingPageOf(view(over))).toBe(page);
  });

  it('says the state in one line', () => {
    const tz = 'Europe/Amsterdam';
    const end = Date.UTC(2026, 9, 11, 12) / 1000;
    expect(billingStateLine(view({ state: 'trialing', trialEndsAt: end, currentPeriodEnd: end }), tz)).toBe(
      'Trial · ends 11 October 2026',
    );
    expect(billingStateLine(view(), tz)).toBe('Active · renews 1 November 2026');
    expect(billingStateLine(view({ cancelAtPeriodEnd: true }), tz)).toBe('Active · ends 1 November 2026');
    expect(billingStateLine(view({ currentPeriodEnd: null }), tz)).toBe('Active');
    expect(billingStateLine(view({ state: 'trialing', currentPeriodEnd: null }), tz)).toBe('Trial');
    expect(billingStateLine(view({ state: 'past_due' }), tz)).toBe('Payment problem');
    expect(billingStateLine(view({ state: 'grace' }), tz)).toBe('Payment problem');
    expect(billingStateLine(view({ state: 'cancelled' }), tz)).toBe('Ended');
    expect(billingTone(view({ state: 'grace' }))).toBe('warn');
    expect(billingTone(view({ state: 'cancelled' }))).toBe('bad');
    expect(billingTone(view({ state: 'trialing' }))).toBe('ok');
  });

  it('polls after checkout until the subscription shows, for at most a minute', () => {
    const waiting = view({ setupRequired: true, plan: null, state: 'cancelled' });
    expect(CHECKOUT_POLL_EVERY_MS).toBe(2_000);
    expect(CHECKOUT_POLL_FOR_MS).toBe(60_000);
    expect(checkoutPollStep(waiting, 0)).toBe('wait');
    expect(checkoutPollStep(null, 10_000)).toBe('wait');
    expect(checkoutPollStep(waiting, 58_000)).toBe('wait');
    expect(checkoutPollStep(waiting, 58_001)).toBe('timeout');
    expect(checkoutPollStep(view({ state: 'trialing' }), 4_000)).toBe('done');
    // A subscription that ended before isn't the new one.
    expect(checkoutPollStep(view({ state: 'cancelled' }), 4_000)).toBe('wait');
    expect(canClaimMore(view())).toBe(true);
    expect(canClaimMore(view({ whombats: { claimed: 2, paid: 2 } }))).toBe(false);
    expect(canClaimMore(waiting)).toBe(false);
  });
});

describe('the checkout poll', () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };
  it('asks every 2 s until the subscription shows', async () => {
    const c = clock();
    const answers = [
      view({ setupRequired: true, state: 'cancelled', plan: null }),
      view({ setupRequired: true, state: 'cancelled', plan: null }),
      view({ state: 'trialing' }),
    ];
    const seen: BillingView[] = [];
    const asked: number[] = [];
    const out = await pollCheckout({
      load: async () => {
        asked.push(c.now());
        return answers.shift() as BillingView;
      },
      onView: (v) => seen.push(v),
      ...c,
    });
    expect(out).toBe('done');
    expect(asked).toEqual([0, 2_000, 4_000]);
    expect(seen.at(-1)?.state).toBe('trialing');
  });
  it('gives up after a minute, and counts a failed ask as “not yet”', async () => {
    const c = clock();
    let asks = 0;
    const out = await pollCheckout({
      load: async () => {
        asks += 1;
        if (asks % 2) throw new ControlError('unavailable', 'x');
        return view({ setupRequired: true, state: 'cancelled', plan: null });
      },
      onView: () => {},
      ...c,
    });
    expect(out).toBe('timeout');
    // At 0 s, 2 s, … 60 s.
    expect(asks).toBe(31);
    expect(c.now()).toBeLessThanOrEqual(CHECKOUT_POLL_FOR_MS);
  });
  it('stops when the page is left', async () => {
    const c = clock();
    let live = true;
    const out = await pollCheckout({
      load: async () => {
        live = false;
        return view({ setupRequired: true, state: 'cancelled', plan: null });
      },
      onView: () => {},
      live: () => live,
      ...c,
    });
    expect(out).toBe('stopped');
  });
});

describe('where a new organization goes', () => {
  const waiting = { setupRequired: true };
  it('goes to Billing first with Stripe billing', () => {
    expect(afterCreateOrgPath({ billing: 'stripe', view: waiting, from: '/' })).toBe('/billing');
    expect(afterCreateOrgPath({ billing: 'stripe', view: waiting, from: '/claim' })).toBe('/billing');
  });
  it('goes on otherwise', () => {
    expect(afterCreateOrgPath({ billing: 'manual', view: waiting, from: '/claim' })).toBe('/claim');
    expect(
      afterCreateOrgPath({ billing: 'stripe', view: { ...waiting, setupRequired: false }, from: '/' }),
    ).toBe('/appliances');
    // A code with a plan (BL-22), or control without signups (404): straight on.
    expect(afterCreateOrgPath({ billing: 'stripe', view: null, from: '/signup' })).toBe('/appliances');
    expect(afterCreateOrgPath({ billing: null, view: null, from: '/claim' })).toBe('/claim');
  });
  it('the list asks for a plan while the org waits for one', () => {
    expect(needsPlan({ setupRequired: true })).toBe(true);
    expect(needsPlan({ setupRequired: false })).toBe(false);
    expect(needsPlan(null)).toBe(false);
  });
});

describe('signup modes and codes', () => {
  it('shows the form each mode needs', () => {
    expect(createOrgForm({ mode: 'open' }, { heldCode: false, wantsCode: false })).toEqual({
      waitlist: false,
      showCode: false,
      codeRequired: false,
      inviteOnly: false,
    });
    expect(createOrgForm({ mode: 'open' }, { heldCode: true, wantsCode: false }).showCode).toBe(true);
    expect(createOrgForm(null, { heldCode: false, wantsCode: false }).showCode).toBe(false);
    expect(createOrgForm({ mode: 'invite' }, { heldCode: false, wantsCode: false })).toEqual({
      waitlist: false,
      showCode: true,
      codeRequired: true,
      inviteOnly: true,
    });
    expect(createOrgForm({ mode: 'waitlist' }, { heldCode: false, wantsCode: false })).toEqual({
      waitlist: true,
      showCode: false,
      codeRequired: false,
      inviteOnly: false,
    });
    expect(createOrgForm({ mode: 'waitlist' }, { heldCode: false, wantsCode: true }).waitlist).toBe(false);
    expect(createOrgForm({ mode: 'waitlist' }, { heldCode: true, wantsCode: false }).codeRequired).toBe(true);
  });

  it('reads the code from the fragment of /signup only', () => {
    expect(readSignupFragment({ pathname: '/signup', hash: '#code=7KQ2-M4XD' })).toBe('7KQ2-M4XD');
    expect(readSignupFragment({ pathname: '/signup', hash: '#code=%207kq2m4xd%20' })).toBe('7kq2m4xd');
    expect(readSignupFragment({ pathname: '/signup', hash: '' })).toBeNull();
    expect(readSignupFragment({ pathname: '/signup', hash: '#other=1' })).toBeNull();
    expect(readSignupFragment({ pathname: '/signup', hash: `#code=${'A'.repeat(65)}` })).toBeNull();
    expect(readSignupFragment({ pathname: '/appliances', hash: '#code=7KQ2-M4XD' })).toBeNull();
  });

  it('reads an invitation’s sign-in token and address from the fragment of /signup only', () => {
    const token = 'a'.repeat(43);
    const hash = `#code=7KQ2-M4XD&token=${token}&email=Ada%40Example.com`;
    expect(readInvitationSignIn({ pathname: '/signup', hash })).toEqual({ token, email: 'ada@example.com' });
    expect(readSignupFragment({ pathname: '/signup', hash })).toBe('7KQ2-M4XD');
    expect(readInvitationSignIn({ pathname: '/signup', hash: `#token=${token}&email=nope` })).toEqual({
      token,
      email: null,
    });
    expect(readInvitationSignIn({ pathname: '/signup', hash: '#code=7KQ2-M4XD' })).toBeNull();
    expect(readInvitationSignIn({ pathname: '/signup', hash: '#token=short' })).toBeNull();
    expect(readInvitationSignIn({ pathname: '/signup', hash: `#token=${token}%3Cx` })).toBeNull();
    expect(readInvitationSignIn({ pathname: '/appliances', hash: `#token=${token}` })).toBeNull();
  });
});

describe('refusals', () => {
  it('maps create-org refusals to their words', () => {
    expect(createOrgErrorKey(new ControlError('signup_code_invalid', 'x'))).toBe('signup_code_invalid');
    expect(createOrgErrorKey(new ControlError('signup_code_required', 'x'))).toBe('signup_code_required');
    expect(createOrgErrorKey(new ControlError('terms_outdated', 'x'))).toBe('terms_outdated');
    expect(createOrgErrorKey(new ControlError('rate_limited', 'x'))).toBe('rate_limited');
    expect(createOrgErrorKey(new ControlError('forbidden', 'x'))).toBe('failed');
    expect(createOrgErrorKey(new Error('x'))).toBe('failed');
  });

  it('maps billing and waitlist refusals to their words', () => {
    expect(billingErrorText(new ControlError('subscription_exists', 'x'))).toBe(
      'You already have a subscription. Change it with Manage billing.',
    );
    expect(billingErrorText(new ControlError('billing_provider_error', 'x'))).toBe(
      'Our payment provider didn’t answer. Try again in a moment.',
    );
    expect(billingErrorText(new ControlError('forbidden', 'x'))).toBe('That didn’t work. Try again.');
    expect(billingErrorText(new ControlError('claim_invalid', 'x'))).toBe('That didn’t work. Try again.');
    expect(waitlistErrorText(new ControlError('waitlist_closed', 'x'))).toBe(
      'The waitlist is closed right now.',
    );
    expect(waitlistErrorText(new ControlError('invalid_link', 'x'))).toBe(
      'That email address doesn’t look right. Check it and try again.',
    );
  });

  it('sends the browser on only to Stripe’s Checkout and portal (AP-160)', () => {
    for (const url of [
      'https://checkout.stripe.com/c/pay/cs_test_a1b2#fid=x',
      'https://billing.stripe.com/p/session/test_YWNjdA',
      'https://CHECKOUT.stripe.com/c/pay/cs_1',
      'https://billing.stripe.com:443/p/session/x',
    ])
      expect(billingRedirectUrl(url), url).toBe(new URL(url).href);
    for (const url of [
      'http://checkout.stripe.com/c/pay/cs_1',
      'https://checkout.stripe.com.evil.example/c/pay',
      'https://evil.example/?https://checkout.stripe.com',
      'https://stripe.com/',
      'https://dashboard.stripe.com/',
      'https://checkout.stripe.com:8443/c/pay',
      'https://user:pass@checkout.stripe.com/c/pay',
      'https://evil.example@billing.stripe.com/p',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//checkout.stripe.com/c/pay',
      '/billing?checkout=done',
      '',
      'not a url',
    ])
      expect(billingRedirectUrl(url), url).toBeNull();
  });

  it('allows this page’s own origin only when the environment passes it (the fake world)', () => {
    const fake = ['http://localhost:5180'];
    expect(billingRedirectUrl('http://localhost:5180/billing?checkout=done')).toBeNull();
    expect(billingRedirectUrl('http://localhost:5180/billing?checkout=done', fake)).toBe(
      'http://localhost:5180/billing?checkout=done',
    );
    expect(billingRedirectUrl('http://localhost:5181/billing', fake)).toBeNull();
    expect(billingRedirectUrl('https://localhost:5180/billing', fake)).toBeNull();
    expect(billingRedirectUrl('javascript:alert(1)', ['null'])).toBeNull();
    expect(billingRedirectUrl('https://checkout.stripe.com/c/pay/cs_1', fake)).toBe(
      'https://checkout.stripe.com/c/pay/cs_1',
    );
  });

  it('turns claim refusals into actions', () => {
    expect(claimRefusalOf(new ControlError('billing_setup_required', 'x'))).toEqual({ kind: 'billing' });
    expect(claimRefusalOf(new ControlError('trial_used_device', 'x', { canStartNow: true }))).toEqual({
      kind: 'trial_used',
      canStartNow: true,
    });
    expect(claimRefusalOf(new ControlError('trial_used_device', 'x', { canStartNow: false }))).toEqual({
      kind: 'trial_used',
      canStartNow: false,
    });
    expect(claimRefusalOf(new ControlError('trial_used_device', 'x'))).toEqual({
      kind: 'trial_used',
      canStartNow: true,
    });
    expect(claimRefusalOf(new ControlError('devices_allowed_reached', 'x', { allowed: 2 }))).toEqual({
      kind: 'plan_full',
      allowed: 2,
    });
    expect(
      claimRefusalOf(new ControlError('devices_allowed_reached', 'Your plan covers 3 Whombats.')),
    ).toEqual({
      kind: 'plan_full',
      allowed: 3,
    });
    expect(claimRefusalOf(new ControlError('claim_invalid', 'x'))).toBeNull();
    // The phone has no Billing: its words say where it is.
    expect(claimErrorText(new ControlError('billing_setup_required', 'x'), 'code')).toContain('on the web');
    expect(claimErrorText(new ControlError('trial_used_device', 'x'), 'card')).toContain('free trial');
    expect(claimErrorText(new ControlError('devices_allowed_reached', 'x', { allowed: 2 }), 'code')).toBe(
      'Your plan covers 2 Whombats.',
    );
  });
});

describe('the control client’s billing and signups', () => {
  const at = (routes: Record<string, (init?: RequestInit) => Response>) => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const control = createHttpControl('http://control.test', {
      tokens: { get: () => 't', set: () => {}, remove: () => {} },
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const path = new URL(url).pathname;
        const route = routes[`${init?.method ?? 'GET'} ${path}`];
        return route
          ? route(init)
          : new Response(JSON.stringify({ error: { code: 'not_found', message: 'No.' } }), { status: 404 });
      },
    });
    return { control, calls };
  };
  const json =
    (body: unknown, status = 200) =>
    () =>
      new Response(JSON.stringify(body), { status });

  it('creates an org with the terms and a normalised code', async () => {
    const { control, calls } = at({
      'POST /v1/orgs': json({ orgId: 'org_1', name: 'Burrow HQ', createdAt: '2026-09-27T10:00:00Z' }),
    });
    const terms = { version: SUBSCRIPTION_TERMS_VERSION };
    expect(await control.createOrg({ name: 'Burrow HQ', terms, code: ' 7kq2 m4xd ' })).toEqual({
      orgId: 'org_1',
      name: 'Burrow HQ',
    });
    await control.createOrg({ name: 'Burrow HQ', terms, code: 'OIL2-M4XD' });
    await control.createOrg({ name: 'Burrow HQ', terms });
    await control.createOrg({ name: 'Burrow HQ', terms, code: '   ' });
    expect(calls.map((c) => c.body)).toEqual([
      { name: 'Burrow HQ', terms, code: '7KQ2-M4XD' },
      { name: 'Burrow HQ', terms, code: '0112-M4XD' },
      { name: 'Burrow HQ', terms },
      { name: 'Burrow HQ', terms },
    ]);
  });

  it('reads the signup info, and none from an older control', async () => {
    const info = {
      mode: 'waitlist',
      billing: 'stripe',
      trialDays: 14,
      termsVersion: SUBSCRIPTION_TERMS_VERSION,
      plans: [whombat],
    };
    expect(await at({ 'GET /v1/signup': json(info) }).control.signupInfo()).toEqual(info);
    expect(await at({}).control.signupInfo()).toBeNull();
    await expect(
      at({ 'GET /v1/signup': json({ error: { code: 'internal', message: 'x' } }, 500) }).control.signupInfo(),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('joins the waitlist with only the fields that were filled in', async () => {
    const { control, calls } = at({ 'POST /v1/waitlist': json({ ok: true }) });
    await control.joinWaitlist({ email: ' ana@firm.example ', company: ' ', note: ' Soon please ' });
    expect(calls[0]?.body).toEqual({ email: 'ana@firm.example', note: 'Soon please' });
    const closed = at({
      'POST /v1/waitlist': json(
        { error: { code: 'conflict', message: 'Closed.', details: { code: 'waitlist_closed' } } },
        409,
      ),
    });
    await expect(closed.control.joinWaitlist({ email: 'a@b.eu' })).rejects.toMatchObject({
      code: 'waitlist_closed',
    });
  });

  it('calls the billing endpoints and checks their answers', async () => {
    const v = view();
    const url = 'https://checkout.stripe.com/c/pay/cs_test_a1#fid';
    const { control, calls } = at({
      'GET /v1/orgs/org_1/billing': json(v),
      'POST /v1/orgs/org_1/billing/checkout': json({ url }),
      'POST /v1/orgs/org_1/billing/portal': json({ url: 'javascript:alert(1)' }),
      'POST /v1/orgs/org_1/billing/whombats': json({ ...v, whombats: { claimed: 1, paid: 3 } }),
      'POST /v1/orgs/org_1/billing/start-now': json({ ...v, state: 'active' }),
    });
    expect(await control.billing('org_1')).toEqual(v);
    expect(await control.billingCheckout('org_1', { plan: 'team', whombats: 2 })).toEqual({ url });
    // Only an http(s) page: anything else is not followed.
    await expect(control.billingPortal('org_1')).rejects.toMatchObject({ code: 'unavailable' });
    expect((await control.billingWhombats('org_1', 3)).whombats.paid).toBe(3);
    expect((await control.billingStartNow('org_1')).state).toBe('active');
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ['GET', '/v1/orgs/org_1/billing', undefined],
      ['POST', '/v1/orgs/org_1/billing/checkout', { plan: 'team', whombats: 2 }],
      ['POST', '/v1/orgs/org_1/billing/portal', {}],
      ['POST', '/v1/orgs/org_1/billing/whombats', { count: 3 }],
      ['POST', '/v1/orgs/org_1/billing/start-now', {}],
    ]);
  });

  it('keeps the details of a claim refusal', async () => {
    const refuse = (code: string, reason: string, status: number, details: Record<string, unknown>) =>
      at({
        'POST /v1/orgs/org_1/claims': json(
          { error: { code, message: 'No.', details: { code: reason, ...details } } },
          status,
        ),
      }).control.startClaim({
        orgId: 'org_1',
        method: 'code',
        device: 'dev_1',
        terms: { version: 'x' },
      });
    await expect(refuse('forbidden', 'billing_setup_required', 403, {})).rejects.toMatchObject({
      code: 'billing_setup_required',
    });
    await expect(refuse('conflict', 'trial_used_device', 409, { canStartNow: true })).rejects.toMatchObject({
      code: 'trial_used_device',
      details: { canStartNow: true },
    });
    await expect(
      refuse('entitlement_withheld', 'devices_allowed_reached', 403, { allowed: 2, extra: 'dropped' }),
    ).rejects.toMatchObject({ code: 'devices_allowed_reached', details: { allowed: 2 } });
    await expect(refuse('conflict', 'trial_used_device', 409, { canStartNow: 'yes' })).rejects.toMatchObject({
      details: {},
    });
  });
});
