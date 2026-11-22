import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS, ControlErrorBody } from './common.js';
import {
  BillingView,
  controlApi,
  formatSignupCode,
  normaliseSignupCode,
  OPERATOR_PERMISSIONS,
  SIGNUP_CODE_ALPHABET,
  SUBSCRIPTION_TERMS_VERSION,
} from './index.js';

const now = 1_790_000_000;
const limits = { connectors: null };
const whombatPlan = {
  id: 'whombat',
  name: 'Whombat',
  amountCents: 4900,
  currency: 'eur',
  interval: 'month',
  limits,
};

describe('signup codes (BL-22)', () => {
  it('normalises what people type', () => {
    expect(normaliseSignupCode('ab12-cd34')).toBe('AB12CD34');
    expect(normaliseSignupCode(' AB12 CD34 ')).toBe('AB12CD34');
    expect(normaliseSignupCode('a-b-1-2-c-d-3-4')).toBe('AB12CD34');
    expect(normaliseSignupCode('oOiI-lL9z')).toBe('0011119Z');
    expect(normaliseSignupCode('0011\t119Z')).toBe('0011119Z');
  });

  it('refuses what isn’t a code', () => {
    for (const bad of [
      '',
      'AB12-CD3',
      'AB12-CD345',
      'AB12-CDU4',
      'AB12_CD34',
      'AB12.CD34',
      'ÄB12CD34',
      'A'.repeat(65),
    ])
      expect(normaliseSignupCode(bad), bad).toBeNull();
  });

  it('is idempotent and formats with a dash', () => {
    for (const input of ['ab12-cd34', 'xyzw 9876', 'o0i1-lLoO']) {
      const once = normaliseSignupCode(input);
      expect(once).not.toBeNull();
      expect(normaliseSignupCode(once as string)).toBe(once);
      expect(normaliseSignupCode(formatSignupCode(input) as string)).toBe(once);
    }
    expect(formatSignupCode('ab12cd34')).toBe('AB12-CD34');
    expect(formatSignupCode('nope')).toBeNull();
  });

  it('uses the Crockford alphabet', () => {
    expect(SIGNUP_CODE_ALPHABET).toHaveLength(32);
    for (const c of 'ILOU') expect(SIGNUP_CODE_ALPHABET).not.toContain(c);
    for (const c of SIGNUP_CODE_ALPHABET) expect(normaliseSignupCode(c.repeat(8))).toBe(c.repeat(8));
  });
});

describe('orgs.create (BL-21, BL-24)', () => {
  const body = controlApi.orgs.create.body;
  const terms = { version: SUBSCRIPTION_TERMS_VERSION };

  it('requires the terms and takes an optional normalised code', () => {
    expect(SUBSCRIPTION_TERMS_VERSION).toBe('2026-11-22');
    expect(body.parse({ name: ' Lumio BV ', terms })).toEqual({ name: 'Lumio BV', terms });
    expect(body.safeParse({ name: 'Lumio', terms, code: 'AB12-CD34' }).success).toBe(true);
    expect(body.safeParse({ name: 'Lumio', terms, code: 'AB12CD34' }).success).toBe(true);
    expect(body.safeParse({ name: 'Lumio', terms: { version: '2027-01-01' } }).success).toBe(true);
  });

  it('refuses a body without terms, a raw code or extra members', () => {
    for (const bad of [
      { name: 'Lumio' },
      { name: 'Lumio', terms: {} },
      { name: 'Lumio', terms: { version: 'latest' } },
      { name: 'Lumio', terms: { ...terms, accepted: true } },
      { name: 'Lumio', terms, code: 'ab12-cd34' },
      { name: 'Lumio', terms, code: 'AB12-CDO4' },
      { name: 'Lumio', terms, plan: 'team' },
    ])
      expect(body.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('signup and waitlist (BL-23, BL-25)', () => {
  it('describes public endpoints', () => {
    expect(controlApi.signup.info).toMatchObject({ method: 'GET', path: '/signup', auth: 'none' });
    expect(controlApi.signup.waitlist).toMatchObject({ method: 'POST', path: '/waitlist', auth: 'none' });
  });

  it('parses the signup info', () => {
    const info = {
      mode: 'waitlist',
      billing: 'stripe',
      trialDays: 14,
      termsVersion: SUBSCRIPTION_TERMS_VERSION,
      plans: [
        whombatPlan,
        { ...whombatPlan, id: 'free', name: 'Free', amountCents: 0, limits: { connectors: 3 } },
      ],
    };
    expect(controlApi.signup.info.response.safeParse(info).success).toBe(true);
    for (const bad of [
      { ...info, mode: 'closed' },
      { ...info, billing: 'paddle' },
      { ...info, trialDays: 0 },
      { ...info, trialDays: 61 },
      { ...info, plans: [{ ...whombatPlan, currency: 'usd' }] },
      { ...info, plans: [{ ...whombatPlan, interval: 'year' }] },
    ])
      expect(controlApi.signup.info.response.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    // No member limit since 3.0 (CT-1562): an older control's is stripped.
    const older = { ...info, plans: [{ ...whombatPlan, limits: { members: 5, connectors: null } }] };
    expect(controlApi.signup.info.response.parse(older).plans[0]?.limits).toEqual({ connectors: null });
  });

  it('bounds the waitlist body', () => {
    const body = controlApi.signup.waitlist.body;
    expect(body.safeParse({ email: 'mara@lumio.example' }).success).toBe(true);
    expect(
      body.safeParse({ email: 'mara@lumio.example', company: 'Lumio', note: 'n'.repeat(500) }).success,
    ).toBe(true);
    expect(body.safeParse({ email: 'mara@lumio.example', note: 'n'.repeat(501) }).success).toBe(false);
    expect(body.safeParse({ email: 'not an email' }).success).toBe(false);
    expect(body.safeParse({ email: 'mara@lumio.example', source: 'ad' }).success).toBe(false);
  });
});

describe('billing (BL-13…BL-18)', () => {
  const view = {
    org: 'org_1',
    provider: 'stripe',
    plan: { id: 'whombat', name: 'Whombat' },
    state: 'trialing',
    trialEndsAt: now + 14 * 86_400,
    currentPeriodEnd: now + 14 * 86_400,
    cancelAtPeriodEnd: false,
    whombats: { claimed: 1, paid: 2 },
    setupRequired: false,
    trialAvailable: false,
    manual: false,
  };

  it('parses the billing view, also while waiting for a plan', () => {
    expect(BillingView.safeParse(view).success).toBe(true);
    const waiting = {
      ...view,
      plan: null,
      state: 'cancelled',
      trialEndsAt: null,
      currentPeriodEnd: null,
      whombats: { claimed: 0, paid: 0 },
      setupRequired: true,
      trialAvailable: true,
    };
    expect(BillingView.safeParse(waiting).success).toBe(true);
    // The org's one account manages it (CT-1561): an older control's `canManage` is stripped.
    expect(BillingView.parse({ ...view, canManage: true })).not.toHaveProperty('canManage');
  });

  it('bounds checkout and the number of Whombats', () => {
    const { checkout, whombats, portal, startNow, view: get } = controlApi.billing;
    expect(get).toMatchObject({ method: 'GET', path: '/orgs/:org/billing', auth: 'session' });
    expect(checkout.body.safeParse({ plan: 'whombat', whombats: 1 }).success).toBe(true);
    expect(checkout.body.safeParse({ plan: 'whombat', whombats: 50 }).success).toBe(true);
    for (const bad of [
      { plan: 'whombat', whombats: 0 },
      { plan: 'whombat', whombats: 51 },
      { plan: 'Whombat', whombats: 1 },
      { plan: 'whombat' },
      { plan: 'whombat', whombats: 1, trial: true },
    ])
      expect(checkout.body.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(whombats.body.safeParse({ count: 3 }).success).toBe(true);
    expect(whombats.body.safeParse({ count: 51 }).success).toBe(false);
    expect(portal.body.safeParse({}).success).toBe(true);
    expect(startNow.body.safeParse({}).success).toBe(true);
    const url = 'https://checkout.stripe.com/c/pay/cs_test_a1#fid';
    expect(checkout.response.safeParse({ url }).success).toBe(true);
    expect(checkout.response.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('documents the refusals and carries their details', () => {
    for (const code of [
      'billing_setup_required',
      'trial_used_device',
      'subscription_exists',
      'subscription_live',
      'manual_billing',
      'signup_code_required',
      'signup_code_invalid',
      'terms_outdated',
      'waitlist_closed',
    ])
      expect(CONTROL_REASONS).toHaveProperty(code);
    const refusal = {
      error: {
        code: 'conflict',
        message: 'This Whombat already had a free trial.',
        details: { code: 'trial_used_device', canStartNow: true },
      },
    };
    expect(ControlErrorBody.parse(refusal).error.details?.canStartNow).toBe(true);
    const withheld = {
      error: {
        code: 'entitlement_withheld',
        message: 'Your plan covers 2 Whombats.',
        details: { code: 'devices_allowed_reached', allowed: 2 },
      },
    };
    expect(ControlErrorBody.parse(withheld).error.details?.allowed).toBe(2);
  });
});

describe('operator panel and customers (BL-27, BL-28)', () => {
  const op = controlApi.operator;

  it('keeps every endpoint under /operator and names the new permissions', () => {
    for (const e of Object.values(op)) expect(e.path.startsWith('/operator/'), e.id).toBe(true);
    for (const p of ['customers.read', 'customers.write', 'signup.write', 'plans.write', 'settings.write'])
      expect(OPERATOR_PERMISSIONS).toContain(p);
    expect(op.signIn).toMatchObject({ method: 'POST', path: '/operator/session', auth: 'none' });
    expect(op.session).toMatchObject({ method: 'GET', path: '/operator/session', auth: 'operator' });
    expect(op.signOut).toMatchObject({ method: 'DELETE', path: '/operator/session', auth: 'operator' });
  });

  it('parses a session with permissions a newer control may add', () => {
    const session = {
      operator: 'john.pals',
      username: 'john',
      permissions: ['customers.read', 'billing.write', 'future.thing'],
    };
    expect(op.session.response.safeParse(session).success).toBe(true);
    expect(op.session.response.safeParse({ ...session, permissions: ['Not A Permission'] }).success).toBe(
      false,
    );
    expect(op.session.response.safeParse({ ...session, username: 'John' }).success).toBe(false);
    const signIn = op.signIn.body;
    expect(signIn.parse({ username: 'john.pals', password: ' spaces kept ' }).password).toBe(' spaces kept ');
    for (const bad of [
      {},
      { token: 'x'.repeat(43) },
      { username: 'john' },
      { username: 'john', password: '' },
      { username: 'john', password: 'p'.repeat(257) },
      { username: '', password: 'pw' },
      { username: 'John', password: 'pw' },
      { username: 'j'.repeat(65), password: 'pw' },
      { username: 'john', password: 'pw', remember: true },
    ])
      expect(signIn.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  const row = {
    org: 'org_1',
    name: 'Lumio',
    email: 'mara@lumio.example',
    createdAt: now - 86_400,
    plan: 'whombat',
    planName: 'Whombat',
    state: 'trialing',
    provider: 'stripe',
    trialEndsAt: now + 13 * 86_400,
    currentPeriodEnd: now + 13 * 86_400,
    whombats: { claimed: 1, allowed: 2 },
    lastSeenAt: now - 60,
    flags: { sameNetworkAs: [{ org: 'org_2', name: 'Lumio Labs' }], trialEndedEarly: false },
  };

  it('pages orgs and describes one org', () => {
    expect(op.orgs.response.safeParse({ items: [row], next: 'c_2' }).success).toBe(true);
    expect(
      op.orgs.query.safeParse({ q: 'lumio', state: 'trialing', plan: 'whombat', cursor: 'c_2' }).success,
    ).toBe(true);
    expect(op.orgs.query.safeParse({ state: 'waiting' }).success).toBe(false);
    const detail = {
      ...row,
      account: { account: 'acc_1', email: 'mara@lumio.example', joinedAt: now - 86_400 },
      devices: [
        {
          device: 'dev_1',
          name: 'Office',
          model: 'wb-mini-1',
          origin: 'factory',
          state: 'claimed',
          claimedAt: now - 3600,
          lastSeenAt: now - 60,
        },
      ],
      entitlement: {
        org: 'org_1',
        plan: 'whombat',
        state: 'trialing',
        devicesAllowed: 2,
        currentPeriodEnd: now + 13 * 86_400,
        limits: { connectors: null },
        selfInstall: true,
        services: { relay: true, updates: true, push: true },
      },
      billing: {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        customerUrl: 'https://dashboard.stripe.com/test/customers/cus_1',
        subscriptionUrl: 'https://dashboard.stripe.com/test/subscriptions/sub_1',
        cancelAtPeriodEnd: false,
      },
      trialMarks: [
        { kind: 'device', label: 'dev_1', createdAt: now - 3600, alsoUsedBy: [] },
        {
          kind: 'card',
          label: null,
          createdAt: now - 3600,
          alsoUsedBy: [{ org: 'org_3', name: 'Old Lumio' }],
        },
      ],
      terms: [
        {
          account: 'acc_1',
          email: 'mara@lumio.example',
          document: 'subscription-terms',
          version: SUBSCRIPTION_TERMS_VERSION,
          acceptedAt: now - 86_400,
        },
      ],
      audit: [],
    };
    expect(op.org.response.safeParse(detail).success).toBe(true);
    expect(op.extendTrial.response.safeParse(detail).success).toBe(true);
    // An org whose account is gone, and a row without its account's email (CT-1560).
    expect(op.org.response.safeParse({ ...detail, email: null, account: null }).success).toBe(true);
    expect(op.org.response.parse({ ...detail, members: [] })).not.toHaveProperty('members');
  });

  it('bounds the org actions', () => {
    expect(op.extendTrial.body.safeParse({ days: 30 }).success).toBe(true);
    expect(op.extendTrial.body.safeParse({ days: 31 }).success).toBe(false);
    expect(op.setPlan.body.safeParse({ plan: 'free', whombats: 3 }).success).toBe(true);
    expect(op.setPlan.body.safeParse({ plan: 'free', whombats: 3, state: 'grace' }).success).toBe(true);
    expect(op.setPlan.body.safeParse({ plan: 'free' }).success).toBe(false);
    expect(op.cancelSubscription.body.safeParse({ at: 'period_end' }).success).toBe(true);
    expect(op.cancelSubscription.body.safeParse({ at: 'tomorrow' }).success).toBe(false);
    expect(op.syncBilling.body.safeParse({}).success).toBe(true);
  });

  it('deletes an org and an account with a typed confirmation', () => {
    expect(op.deleteOrg.body.safeParse({ name: 'Lumio BV' }).success).toBe(true);
    expect(op.deleteOrg.body.safeParse({ name: '' }).success).toBe(false);
    expect(op.deleteOrg.body.safeParse({}).success).toBe(false);
    expect(op.deleteOrg.body.safeParse({ name: 'Lumio BV', force: true }).success).toBe(false);
    expect(op.deleteOrg.response.safeParse({ ok: true, devicesReleased: 2 }).success).toBe(true);
    expect(op.deleteOrg.response.safeParse({ ok: true, devicesReleased: -1 }).success).toBe(false);
    expect(op.deleteAccount.body.safeParse({ email: 'mara@lumio.example' }).success).toBe(true);
    expect(op.deleteAccount.body.safeParse({ email: 'mara' }).success).toBe(false);
    const deleted = { ok: true, orgsDeleted: 1, devicesReleased: 0 };
    expect(op.deleteAccount.response.safeParse(deleted).success).toBe(true);
    expect(op.deleteAccount.response.parse({ ...deleted, orgsLeft: 1 })).not.toHaveProperty('orgsLeft');
    expect(op.deleteAccount.response.safeParse({ ok: true }).success).toBe(false);
  });

  it('pages accounts', () => {
    const account = {
      account: 'acc_1',
      email: 'mara@lumio.example',
      name: null,
      createdAt: now,
      orgs: [{ org: 'org_1', name: 'Lumio' }],
      lastSignInAt: null,
      disabled: false,
    };
    expect(op.accounts.response.safeParse({ items: [account], next: null }).success).toBe(true);
    expect(op.disableAccount.response.safeParse({ ...account, disabled: true }).success).toBe(true);
  });

  it('changes live settings partially and within bounds', () => {
    const settings = { signupMode: 'invite', selfRegistration: false, feedbackDrop: true, trialDays: 14 };
    expect(op.settings.response.safeParse(settings).success).toBe(true);
    expect(op.setSettings.body.safeParse({ signupMode: 'open' }).success).toBe(true);
    expect(op.setSettings.body.safeParse({ trialDays: 60 }).success).toBe(true);
    for (const bad of [
      {},
      { trialDays: 0 },
      { trialDays: 61 },
      { signupMode: 'closed' },
      { stripeKey: 'sk' },
    ])
      expect(op.setSettings.body.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('lists the waitlist', () => {
    const entry = {
      id: 'wl_1',
      email: 'noor@example.com',
      company: null,
      note: 'We run 3 offices.',
      status: 'invited',
      createdAt: now - 86_400,
      invitedAt: now,
      codeHint: 'CD34',
      sameNetworkAs: [],
    };
    expect(op.waitlist.response.safeParse({ items: [entry], next: null }).success).toBe(true);
    expect(op.waitlist.query.safeParse({ status: 'waiting' }).success).toBe(true);
    expect(op.approveWaitlist.response.safeParse(entry).success).toBe(true);
  });

  it('shows a signup code once, then only its hint', () => {
    const code = {
      id: 'sc_1',
      hint: 'CD34',
      note: 'Lumio pilot',
      plan: 'free',
      whombats: 3,
      maxUses: 1,
      uses: 0,
      expiresAt: now + 30 * 86_400,
      createdBy: 'john.pals',
      createdAt: now,
      revokedAt: null,
      waitlistEntryId: null,
      status: 'active',
      email: null,
      sentAt: null,
    };
    const created = { ...code, code: 'AB12-CD34', link: 'https://app.whombat.com/signup#code=AB12-CD34' };
    expect(op.createSignupCode.response.safeParse(created).success).toBe(true);
    expect(op.createSignupCode.status).toBe(201);
    expect(op.createSignupCode.response.safeParse({ ...created, code: 'AB12CD34' }).success).toBe(false);
    // Listing strips the code: a reader never keeps it.
    const listed = op.signupCodes.response.parse({ items: [created], next: null });
    expect(listed.items[0]).not.toHaveProperty('code');
    expect(op.createSignupCode.body.safeParse({ note: 'Pilot' }).success).toBe(true);
    expect(
      op.createSignupCode.body.safeParse({
        note: 'Pilot',
        plan: 'whombat',
        whombats: 5,
        maxUses: 10,
        expiresInDays: 90,
      }).success,
    ).toBe(true);
    expect(op.createSignupCode.body.safeParse({}).success).toBe(false);
    expect(op.createSignupCode.body.safeParse({ note: 'Pilot', expiresInDays: 0 }).success).toBe(false);
  });

  it('binds an invitation to one address, single-use, and resends it as a new code (BL-34, BL-35)', () => {
    const body = op.createSignupCode.body;
    expect(body.safeParse({ note: 'Acme', email: 'jan@acme.example' }).success).toBe(true);
    expect(body.safeParse({ note: 'Acme', email: 'jan@acme.example', maxUses: 1 }).success).toBe(true);
    expect(body.safeParse({ note: 'Acme', email: 'jan@acme.example', maxUses: 2 }).success).toBe(false);
    expect(body.safeParse({ note: 'Acme', email: 'not an address' }).success).toBe(false);
    expect(op.resendSignupCode.path).toBe('/operator/signup-codes/:id/resend');
    expect(op.resendSignupCode.body.safeParse({}).success).toBe(true);
    const invitation = {
      id: 'sc_2',
      hint: 'CD34',
      note: 'Acme',
      plan: null,
      whombats: 1,
      maxUses: 1,
      uses: 0,
      expiresAt: now + 30 * 86_400,
      createdBy: 'john.pals',
      createdAt: now,
      revokedAt: null,
      waitlistEntryId: null,
      status: 'active',
      email: 'jan@acme.example',
      sentAt: now,
    };
    expect(
      op.resendSignupCode.response.safeParse({ ...invitation, code: 'AB12-CD34', link: 'x' }).success,
    ).toBe(true);
    expect(op.signupCodes.response.safeParse({ items: [{ ...invitation, email: undefined }] }).success).toBe(
      false,
    );
  });

  it('lists plans and updates them partially', () => {
    const plan = {
      ...whombatPlan,
      selfInstall: true,
      public: true,
      sort: 10,
      stripeLookupKey: 'whombat-monthly-eur',
      stripePriceId: null,
      updatedAt: now,
    };
    expect(op.plans.response.safeParse({ plans: [plan] }).success).toBe(true);
    expect(op.updatePlan.body.safeParse({ amountCents: 5900 }).success).toBe(true);
    expect(op.updatePlan.body.safeParse({ limits: { connectors: null } }).success).toBe(true);
    for (const bad of [
      {},
      { currency: 'usd' },
      { limits: { devices: 3 } },
      { limits: { members: null } },
      { amountCents: -1 },
    ])
      expect(op.updatePlan.body.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
