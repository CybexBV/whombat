import { deriveSeedKeypair, hexToBytes } from '@whombat/core/audit';
import { FEEDBACK_MAX_BODY_BYTES, FEEDBACK_PUBLIC_PATHS } from '@whombat/core/contracts';
import {
  FeedbackReporterCodeRequest,
  FeedbackReporterOk,
  FeedbackReporterReports,
  FeedbackReporterSession,
  FeedbackReporterSessionRequest,
} from '@whombat/core/domain';
import { dropEnvelopeCap } from '@whombat/core/feedback/drop';
import { reporterEmailDigest } from '@whombat/core/feedback/reporters';
import { peerIdFromEd25519PublicKey } from '@whombat/protocol';
import { isRetryableUpdateFailure } from '@whombat/release';
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS } from './common.js';
import {
  DEVICE_REQUEST_MAX_BYTES,
  deviceRequestMaxBytes,
  signDeviceRequest,
  verifyDeviceRequest,
} from './device/envelope.js';
import {
  FEEDBACK_CARD_MAX_BYTES,
  FEEDBACK_CARDS_MAX,
  FEEDBACK_CARDS_SYNC_MAX_BYTES,
  FEEDBACK_DROP_MAX_ENVELOPE_BYTES,
  FEEDBACK_PULL_MAX_BYTES,
  FEEDBACK_PULL_RESPONSE_MAX_BYTES,
  FEEDBACK_REPORTERS_PUBLISH_MAX,
  FeedbackDrop,
} from './device/feedback.js';
import { assignmentResultValid, DEVICE_OPS, DeviceOpName } from './device/ops.js';
import { signRegistration, verifyRegistration } from './device/provisioning.js';
import { PushRef, pushRefFor } from './device/push.js';
import { describeUpdateFailure, UpdateFailureDetail } from './device/status.js';
import {
  FEEDBACK_DROP_CORS,
  FEEDBACK_PUBLIC_MESSAGES,
  FeedbackDropReceipt,
  feedbackDropApi,
} from './feedback.js';
import {
  APPLIANCE_TERMS_ACCEPTED,
  APPLIANCE_TERMS_VERSION,
  applianceTermsAccepted,
  controlApi,
  isSafeNext,
  MagicLinkRequest,
  OperatorPlan,
  SUBSCRIPTION_TERMS_VERSION,
} from './index.js';
import { LINK_COUNTRIES, LinkCountry, linkSoldIn } from './link.js';
import {
  MANAGER_PATHS,
  RuntimeFeedbackAckRequest,
  RuntimeFeedbackCardsRequest,
  RuntimeFeedbackPullResponse,
  RuntimeFeedbackReportersRequest,
  RuntimeFeedbackReportersResponse,
  RuntimePushRegisterRequest,
  RuntimePushUnregisterResponse,
  summarizeUpdate,
  UpdateFacts,
} from './local/index.js';
import { ROLLOUT_PAUSE_REASONS, ROLLOUT_PRESETS, Rollout } from './rollout.js';

const mgmt = deriveSeedKeypair('dev_1-management');
const now = 1_790_000_000;

describe('device-signed requests', () => {
  const req = signDeviceRequest(
    {
      aud: 'whombat-api:dev',
      device: 'dev_1',
      op: 'push.send',
      ts: now,
      nonce: '00112233445566778899aabbccddeeff',
      body: { kind: 'approval', ref: 'q3Vx9LpA0dZkT7mW2bNcYe', handles: ['h'.repeat(22)], ttlS: 600 },
    },
    mgmt.secretKey,
  );
  const seen = new Set<string>();
  const ctx = {
    audience: 'whombat-api:dev',
    now,
    publicKeyOf: (d: string) => (d === 'dev_1' ? mgmt.publicKey : undefined),
    claimNonce: (d: string, n: string) => !seen.has(`${d}/${n}`) && !!seen.add(`${d}/${n}`),
  };

  it('verifies once, then refuses the replay', () => {
    const first = verifyDeviceRequest(req, ctx);
    expect(first).toMatchObject({ ok: true, op: 'push.send', device: 'dev_1' });
    expect(verifyDeviceRequest(req, ctx)).toEqual({ ok: false, error: 'replayed' });
  });

  it('refuses tampering, other audiences, unknown devices and stale clocks', () => {
    const fresh = { ...ctx, claimNonce: () => true };
    expect(verifyDeviceRequest({ ...req, body: { ...req.body, ttlS: 601 } }, fresh)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
    expect(verifyDeviceRequest(req, { ...fresh, audience: 'whombat-api:prod' })).toEqual({
      ok: false,
      error: 'wrong_audience',
    });
    expect(verifyDeviceRequest({ ...req, device: 'dev_2' }, fresh)).toEqual({
      ok: false,
      error: 'unknown_device',
    });
    expect(verifyDeviceRequest(req, { ...fresh, now: now + 301 })).toEqual({ ok: false, error: 'stale' });
    expect(verifyDeviceRequest({ ...req, op: 'nope' }, fresh)).toEqual({ ok: false, error: 'bad_envelope' });
    const badBody = signDeviceRequest(
      {
        aud: 'whombat-api:dev',
        device: 'dev_1',
        op: 'push.send',
        ts: now,
        nonce: 'ff'.repeat(16),
        body: { kind: 'x' } as never,
      },
      mgmt.secretKey,
    );
    expect(verifyDeviceRequest(badBody, fresh)).toEqual({ ok: false, error: 'bad_body' });
  });

  it('keeps device bodies free of free text', () => {
    // Field allowlist: status reports reject unknown members.
    const status = DEVICE_OPS['status.report'].body;
    expect(status.safeParse({ note: 'free text' }).success).toBe(false);
  });
});

describe('provisioning registration', () => {
  it('proves possession of the management and the content key', () => {
    const content = deriveSeedKeypair('dev_1-content');
    const unsigned = {
      env: 'dev' as const,
      hardwareSerial: 'WB1-000123',
      model: 'wb-mini-1',
      managementPublicKey: mgmt.publicKey,
      contentPeerId: peerIdFromEd25519PublicKey(hexToBytes(content.publicKey)),
      contentPublicKey: content.publicKey,
      provisionedAt: now,
    };
    const reg = signRegistration(unsigned, {
      managementSecretKeyHex: mgmt.secretKey,
      contentSecretKeyHex: content.secretKey,
    });
    expect(verifyRegistration(reg)).toBe(true);
    expect(verifyRegistration({ ...reg, hardwareSerial: 'WB1-000124' })).toBe(false);
    expect(verifyRegistration({ ...reg, contentProof: reg.proof })).toBe(false);
    expect(
      verifyRegistration({ ...reg, contentPeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH' }),
    ).toBe(false);
  });
});

describe('Whombat Link (4.4)', () => {
  const registration = {
    env: 'dev',
    hardwareSerial: 'SELF-0001',
    model: 'self-installed',
    managementPublicKey: 'a'.repeat(64),
    contentPeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    contentPublicKey: 'b'.repeat(64),
    provisionedAt: 1_790_000_000,
    proof: 'c'.repeat(128),
    contentProof: 'd'.repeat(128),
  };

  it('starts Link from a box control has never seen, with its registration', () => {
    expect(DEVICE_OPS['link.begin'].body.safeParse({ registration }).success).toBe(true);
    expect(DEVICE_OPS['link.begin'].body.safeParse({}).success).toBe(false);
    for (const op of [
      'link.begin',
      'link.status',
      'link.leave',
      'push.register',
      'push.unregister',
      'support.heartbeat',
    ])
      expect(DeviceOpName.safeParse(op).success, op).toBe(true);
  });

  it('carries the Link state on tickets, absent from an older control', () => {
    const ticket = {
      ticket: 'test-header.test-payload.test-signature',
      expiresAt: 1_790_000_120,
      relay: {
        worker: 'relay-eu-1',
        url: 'wss://relay.example.com/v1/connect',
        reassignAfter: 1_790_003_600,
      },
      channel: 'app',
    };
    expect(DEVICE_OPS['ticket.issue'].response.parse(ticket).link).toBeUndefined();
    const link = { state: 'on', since: 1_790_000_000, label: 'maple-otter-river' };
    expect(DEVICE_OPS['ticket.issue'].response.parse({ ...ticket, link }).link).toEqual(link);
  });

  it('forwards push tokens with the device ops’ own schemas', () => {
    expect(RuntimePushRegisterRequest).toBe(DEVICE_OPS['push.register'].body);
    expect(RuntimePushUnregisterResponse).toBe(DEVICE_OPS['push.unregister'].response);
    const paths = Object.values(MANAGER_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    for (const key of ['linkState', 'linkOn', 'linkOff', 'updateChannel', 'updateChannelSet', 'pushRegister'])
      expect(MANAGER_PATHS, key).toHaveProperty(key);
  });

  it('serves the account site’s link page, boxes and billing', () => {
    expect(Object.keys(controlApi.link).sort()).toEqual([
      'boxes',
      'checkout',
      'confirm',
      'lookup',
      'portal',
      'remove',
    ]);
    expect(controlApi.link.confirm.body.safeParse({ code: 'KXQM-TRVW' }).success).toBe(true);
    expect(controlApi.link.confirm.body.safeParse({ code: 'kxqm-trvw' }).success).toBe(false);
    for (const reason of ['registration_invalid', 'email_unconfirmed', 'link_trial_boxes', 'link_off'])
      expect(CONTROL_REASONS, reason).toHaveProperty(reason);
  });
});

describe('control api', () => {
  it('has unique ids', () => {
    const ids = Object.values(controlApi).flatMap((g) => Object.values(g).map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('claims.start takes a card or a nearby device, never a lookup number (CC-05, CC-13)', () => {
    const body = controlApi.directory.startClaim.body;
    const proof = 'A'.repeat(43);
    const terms = { version: APPLIANCE_TERMS_VERSION };
    expect(body.parse({ method: 'card', device: 'dev_1', claimProof: proof, terms })).toEqual({
      method: 'card',
      device: 'dev_1',
      claimProof: proof,
      class: 'interactive',
      terms,
    });
    expect(body.safeParse({ method: 'code', device: 'dev_1', terms }).success).toBe(true);
    expect(body.safeParse({ method: 'code', device: 'dev_1', class: 'bulk', terms }).success).toBe(true);
    for (const bad of [
      { method: 'code', device: 'dev_1', lookup: '4821', terms },
      { method: 'code', terms },
      { method: 'code', lookup: '482', terms },
      { method: 'code', lookup: '4821', terms },
      { method: 'code', device: 'dev_1', claimProof: proof, terms },
      { method: 'card', device: 'dev_1', terms },
      { device: 'dev_1', claimProof: proof, terms },
    ])
      expect(body.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('claims.start requires the appliance terms (LC-18)', () => {
    const body = controlApi.directory.startClaim.body;
    // The open-source terms: Cybex's service and boxes, not the right to run the software.
    expect(APPLIANCE_TERMS_VERSION).toBe('2026-11-22');
    expect(body.safeParse({ method: 'code', device: 'dev_1' }).success).toBe(false);
    for (const terms of [{}, { version: 'latest' }, { version: APPLIANCE_TERMS_VERSION, accepted: true }])
      expect(body.safeParse({ method: 'code', device: 'dev_1', terms }).success, JSON.stringify(terms)).toBe(
        false,
      );
    // Another well-formed version parses (the one before too); control refuses it (`terms_required`).
    for (const version of ['2027-01-01', '2026-10-25-draft'])
      expect(body.safeParse({ method: 'code', device: 'dev_1', terms: { version } }).success).toBe(true);
  });

  it('control takes the current appliance terms and the one before, nothing else', () => {
    expect(APPLIANCE_TERMS_ACCEPTED[0]).toBe(APPLIANCE_TERMS_VERSION);
    expect(applianceTermsAccepted(APPLIANCE_TERMS_VERSION)).toBe(true);
    expect(applianceTermsAccepted('2026-11-19')).toBe(true);
    for (const version of ['2026-10-25', '2027-01-01', 'latest'])
      expect(applianceTermsAccepted(version)).toBe(false);
  });

  it('entitlements carry limits and selfInstall; the operator body keeps absent members (LC-11, LC-15)', () => {
    const e = {
      org: 'org_1',
      plan: 'whombat',
      state: 'active',
      devicesAllowed: 2,
      currentPeriodEnd: null,
      limits: { connectors: 3 },
      selfInstall: true,
      services: { relay: true, updates: true, push: true },
    };
    expect(controlApi.billing.entitlement.response.safeParse(e).success).toBe(true);
    const { limits: _l, ...old } = e;
    expect(controlApi.billing.entitlement.response.safeParse(old).success).toBe(false);
    const set = controlApi.operator.setEntitlement.body;
    expect(set.safeParse({ state: 'active' }).success).toBe(true);
    expect(set.safeParse({ state: 'active', limits: { connectors: null }, selfInstall: false }).success).toBe(
      true,
    );
    expect(set.safeParse({ state: 'active', limits: { devices: 3 } }).success).toBe(false);
    // No member limit since 3.0 (CT-1562).
    expect(set.safeParse({ state: 'active', limits: { members: null } }).success).toBe(false);
    expect(
      controlApi.billing.entitlement.response.parse({ ...e, limits: { members: 10, connectors: 3 } }).limits,
    ).toEqual({
      connectors: 3,
    });
  });

  it('deletes accounts with a typed confirmation', () => {
    const del = controlApi.auth.deleteAccount;
    expect(del).toMatchObject({ id: 'accounts.delete', method: 'DELETE', path: '/me', auth: 'session' });
    expect(del.body.safeParse({ email: 'mara@example.com' }).success).toBe(true);
    expect(del.body.safeParse({}).success).toBe(false);
    expect(del.body.safeParse({ email: 'mara@example.com', confirm: true }).success).toBe(false);
  });

  it('an org has one account: no members, roles or invitations (CT-1560)', () => {
    expect(Object.keys(controlApi.orgs).sort()).toEqual([
      'audit',
      'create',
      'createWhombatLink',
      'get',
      'list',
    ]);
    const org = { orgId: 'org_1', name: 'Lumio', createdAt: '2026-10-25T09:00:00Z' };
    expect(
      controlApi.orgs.list.response.parse({ orgs: [{ ...org, role: 'owner' }] }).orgs[0],
    ).not.toHaveProperty('role');
    const session = controlApi.auth.session.response.parse({
      expiresAt: '2026-10-30T12:00:00Z',
      account: {
        accountId: 'acc_1',
        email: 'mara@example.com',
        name: null,
        createdAt: '2026-09-01T00:00:00Z',
      },
      orgs: [{ orgId: 'org_1', name: 'Lumio', role: 'owner' }],
    });
    expect(session.orgs).toEqual([{ orgId: 'org_1', name: 'Lumio' }]);
    for (const code of [
      'member_not_found',
      'role_forbidden',
      'last_owner',
      'invitation_invalid',
      'invitation_not_found',
      'invitation_email_mismatch',
    ])
      expect(CONTROL_REASONS, code).not.toHaveProperty(code);
  });

  it('marks the hidden Link org and a plan with a card (4.5)', () => {
    const account = {
      accountId: 'acc_1',
      email: 'mara@example.com',
      name: null,
      createdAt: '2026-09-01T00:00:00Z',
    };
    const session = controlApi.auth.session.response.parse({
      expiresAt: '2026-10-30T12:00:00Z',
      account,
      orgs: [
        { orgId: 'org_1', name: 'Lumio' },
        { orgId: 'org_2', name: 'Whombat Link', link: true },
      ],
    });
    expect(session.orgs.map((o) => o.link)).toEqual([undefined, true]);
    const plan = {
      state: 'trialing',
      trialEndsAt: 1_795_000_000,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialAvailable: false,
      boxes: 1,
    };
    const boxes = controlApi.link.boxes.response;
    expect(boxes.parse({ plan, boxes: [] }).plan).not.toHaveProperty('cardOnFile');
    expect(boxes.parse({ plan: { ...plan, cardOnFile: true }, boxes: [] }).plan.cardOnFile).toBe(true);
    expect(boxes.safeParse({ plan: { ...plan, cardOnFile: 'yes' }, boxes: [] }).success).toBe(false);
  });

  it('says a Link plan’s interval and discount, and checks out monthly or yearly (4.6)', () => {
    const plan = {
      state: 'active',
      trialEndsAt: null,
      currentPeriodEnd: 1_795_000_000,
      cancelAtPeriodEnd: false,
      trialAvailable: false,
      boxes: 1,
      cardOnFile: true,
    };
    const boxes = controlApi.link.boxes.response;
    const parsed = (p: object) => boxes.safeParse({ plan: p, boxes: [] });
    expect(boxes.parse({ plan, boxes: [] }).plan).not.toHaveProperty('interval');
    expect(boxes.parse({ plan, boxes: [] }).plan).not.toHaveProperty('discount');
    for (const interval of ['month', 'year'])
      expect(parsed({ ...plan, interval }).success, interval).toBe(true);
    expect(parsed({ ...plan, interval: 'week' }).success).toBe(false);

    const freeForever = { percentOff: 100, endsAt: null, code: null };
    const halfOffCode = { percentOff: 50, endsAt: 1_800_000_000, code: 'SPRING26' };
    for (const discount of [freeForever, halfOffCode, null])
      expect(parsed({ ...plan, discount }).success, JSON.stringify(discount)).toBe(true);
    expect(boxes.parse({ plan: { ...plan, discount: halfOffCode }, boxes: [] }).plan.discount?.code).toBe(
      'SPRING26',
    );
    for (const discount of [
      { ...freeForever, percentOff: 0 },
      { ...freeForever, percentOff: 101 },
      { ...freeForever, percentOff: 12.5 },
      { ...halfOffCode, code: 'SPRING 26' },
      { ...halfOffCode, code: '' },
      { percentOff: 100, code: null },
      { percentOff: 100, endsAt: null },
    ])
      expect(parsed({ ...plan, discount }).success, JSON.stringify(discount)).toBe(false);

    const checkout = controlApi.link.checkout.body;
    expect(checkout.safeParse({}).success).toBe(true);
    expect(checkout.safeParse({ interval: 'year' }).success).toBe(true);
    expect(checkout.safeParse({ interval: 'week' }).success).toBe(false);
    expect(checkout.safeParse({ interval: 'year', coupon: 'X' }).success).toBe(false);

    const yearly = {
      id: 'link-yearly',
      name: 'Whombat Link',
      amountCents: 2_500,
      currency: 'eur',
      interval: 'year',
      limits: { connectors: null },
      selfInstall: true,
      public: false,
      sort: 101,
      stripeLookupKey: 'whombat-link-yearly-eur',
      stripePriceId: null,
      updatedAt: now,
    };
    expect(OperatorPlan.safeParse(yearly).success).toBe(true);
    expect(OperatorPlan.safeParse({ ...yearly, interval: 'week' }).success).toBe(false);
  });

  it('link.checkout takes a typed promotion code and the terms; link.portal the terms (4.8)', () => {
    const checkout = controlApi.link.checkout.body;
    const terms = { version: SUBSCRIPTION_TERMS_VERSION };
    for (const ok of [
      {},
      { interval: 'year' },
      { promotionCode: 'SPRING26' },
      { interval: 'month', promotionCode: 'friends-2027', terms },
      { terms },
    ])
      expect(checkout.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [
      { promotionCode: '' },
      { promotionCode: 'SPRING 26' },
      { promotionCode: 'X'.repeat(201) },
      { terms: {} },
      { terms: { ...terms, accepted: true } },
      { coupon: 'SPRING26' },
    ])
      expect(checkout.safeParse(bad).success, JSON.stringify(bad)).toBe(false);

    // 4.10: where the person lives, any country as its ISO code; control refuses one Link isn't sold in.
    for (const country of ['NL', 'GR', 'GB', 'US'])
      expect(checkout.safeParse({ country, terms }).success, country).toBe(true);
    for (const country of ['nl', 'NLD', 'N1', '', 'Netherlands'])
      expect(checkout.safeParse({ country }).success, country).toBe(false);
    expect(LINK_COUNTRIES).toHaveLength(27);
    expect(new Set(LINK_COUNTRIES).size).toBe(27);
    for (const country of LINK_COUNTRIES) expect(LinkCountry.safeParse(country).success, country).toBe(true);
    expect(['NL', 'DE', 'GR', 'IE'].every(linkSoldIn)).toBe(true);
    expect(['GB', 'CH', 'NO', 'US', 'EL', 'nl'].some(linkSoldIn)).toBe(false);

    const portal = controlApi.link.portal.body;
    expect(portal.safeParse({}).success).toBe(true);
    expect(portal.safeParse({ terms }).success).toBe(true);
    expect(portal.safeParse({ terms: { version: 'latest' } }).success).toBe(false);
    expect(portal.safeParse({ interval: 'year' }).success).toBe(false);

    for (const reason of [
      'terms_required',
      'terms_outdated',
      'promotion_code_invalid',
      'checkout_busy',
      // 4.9: codes go in the payment page's own field; Stripe can refuse for good.
      'promotion_code_on_payment_page',
      'billing_provider_refused',
      'manual_billing',
      'no_subscription',
      'subscription_exists',
      // 4.10: Link is sold in EU countries only.
      'link_country',
    ])
      expect(CONTROL_REASONS, reason).toHaveProperty(reason);
  });

  it('link.confirm takes the Subscription Terms the lookup asks for (4.7)', () => {
    const lookup = controlApi.link.lookup.response;
    const found = {
      code: 'KXQM-TRVW',
      name: 'Kitchen',
      expiresAt: 1_800_000_000,
      linked: false,
      trial: true,
    };
    // An older control names no version; a 4.7 one names the current terms.
    expect(lookup.parse(found).termsVersion).toBeUndefined();
    expect(lookup.parse({ ...found, termsVersion: SUBSCRIPTION_TERMS_VERSION }).termsVersion).toBe(
      SUBSCRIPTION_TERMS_VERSION,
    );
    expect(lookup.safeParse({ ...found, termsVersion: 'latest' }).success).toBe(false);

    const confirm = controlApi.link.confirm.body;
    const terms = { version: SUBSCRIPTION_TERMS_VERSION };
    expect(confirm.safeParse({ code: 'KXQM-TRVW', terms }).success).toBe(true);
    // Another well-formed version parses; control refuses it (`terms_outdated`).
    expect(confirm.safeParse({ code: 'KXQM-TRVW', terms: { version: '2026-11-15' } }).success).toBe(true);
    for (const bad of [{}, { version: 'latest' }, { ...terms, accepted: true }])
      expect(confirm.safeParse({ code: 'KXQM-TRVW', terms: bad }).success, JSON.stringify(bad)).toBe(false);
    expect(CONTROL_REASONS).toHaveProperty('terms_outdated');
  });

  it('leases claim lookups to unclaimed devices (CC-03)', () => {
    const op = DEVICE_OPS['claim.lookup'];
    expect(op.body.safeParse({}).success).toBe(true);
    expect(op.body.safeParse({ lookup: '4821' }).success).toBe(false);
    expect(op.response.safeParse({ lookup: '4821', expiresAt: now + 600, renewAfterS: 300 }).success).toBe(
      true,
    );
    expect(op.response.safeParse({ lookup: 4821, expiresAt: now + 600, renewAfterS: 300 }).success).toBe(
      false,
    );
  });
});

describe('push refs', () => {
  it('keyed hashes are 22 base64url characters and depend on the key', () => {
    const k1 = new Uint8Array(32).fill(1);
    const k2 = new Uint8Array(32).fill(2);
    const a = pushRefFor(k1, 'ntf_1');
    expect(PushRef.safeParse(a).success).toBe(true);
    expect(a).toHaveLength(22);
    expect(pushRefFor(k2, 'ntf_1')).not.toBe(a);
    expect(() => pushRefFor(new Uint8Array(16), 'x')).toThrowError(/32 bytes/);
  });
});

describe('assignment poll results', () => {
  it('carry an assignment exactly when assigned', () => {
    expect(assignmentResultValid({ result: 'unchanged', assignment: null })).toBe(true);
    expect(assignmentResultValid({ result: 'assigned', assignment: null })).toBe(false);
    expect(assignmentResultValid({ result: 'none', assignment: {} })).toBe(false);
  });
});

describe('magic-link next (CT-48)', () => {
  it('accepts same-origin paths only', () => {
    for (const ok of ['/', '/claim', '/o/org_1/devices?tab=a&x=1', '/a/%2Fb'])
      expect(MagicLinkRequest.safeParse({ email: 'a@b.co', next: ok }).success, ok).toBe(true);
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      '/%2fevil.com',
      '/%5Cevil',
      'https://evil.com',
      '/a\\b',
      '/a#f',
      '/a b',
    ])
      expect(isSafeNext(bad), bad).toBe(false);
  });

  it('carries a held signup code (BL-33)', () => {
    for (const code of ['AB12-CD34', 'AB12CD34'])
      expect(MagicLinkRequest.safeParse({ email: 'a@b.co', code }).success, code).toBe(true);
    for (const code of ['ab12-cd34', 'AB12-CD3', 'AB12-CD3O'])
      expect(MagicLinkRequest.safeParse({ email: 'a@b.co', code }).success, code).toBe(false);
  });
});

describe('feedback drop (CT-91)', () => {
  it('allows a larger request for feedback.cards.sync only', () => {
    expect(deviceRequestMaxBytes('feedback.cards.sync')).toBe(FEEDBACK_CARDS_SYNC_MAX_BYTES);
    expect(deviceRequestMaxBytes('push.send')).toBe(DEVICE_REQUEST_MAX_BYTES);
    expect(FEEDBACK_CARDS_SYNC_MAX_BYTES).toBeGreaterThan(
      FEEDBACK_CARDS_MAX * (FEEDBACK_CARD_MAX_BYTES + 64),
    );
    const big = { dropIds: ['fdr_q3Vx9LpA0dZkT7mW2bNcYe'], padding: 'x'.repeat(70_000) };
    const ack = signDeviceRequest(
      {
        aud: 'whombat-api:dev',
        device: 'dev_1',
        op: 'feedback.drops.ack',
        ts: now,
        nonce: 'ab'.repeat(16),
        body: big as never,
      },
      mgmt.secretKey,
    );
    const ctx = {
      audience: 'whombat-api:dev',
      now,
      publicKeyOf: () => mgmt.publicKey,
      claimNonce: () => true,
    };
    expect(verifyDeviceRequest(ack, ctx)).toEqual({ ok: false, error: 'too_large' });
    const sync = signDeviceRequest(
      {
        aud: 'whombat-api:dev',
        device: 'dev_1',
        op: 'feedback.cards.sync',
        ts: now,
        nonce: 'cd'.repeat(16),
        body: { seq: 1, cards: [{ card: { note: 'x'.repeat(70_000) }, sig: `${'A'.repeat(85)}Q` }] },
      },
      mgmt.secretKey,
    );
    expect(verifyDeviceRequest(sync, ctx)).toMatchObject({ ok: true, op: 'feedback.cards.sync' });
  });

  it('keeps the pull answer within what the manager accepts', () => {
    const json = (n: number) => Math.ceil((n * 4) / 3) + 20 * 400 + FEEDBACK_CARDS_MAX * 64 + 200;
    expect(json(FEEDBACK_PULL_MAX_BYTES)).toBeLessThan(FEEDBACK_PULL_RESPONSE_MAX_BYTES);
    expect(json(FEEDBACK_DROP_MAX_ENVELOPE_BYTES)).toBeLessThan(FEEDBACK_PULL_RESPONSE_MAX_BYTES);
    expect(FEEDBACK_DROP_MAX_ENVELOPE_BYTES).toBe(dropEnvelopeCap(FEEDBACK_MAX_BODY_BYTES));
  });

  it('shapes the device ops and the manager paths alike', () => {
    expect(RuntimeFeedbackCardsRequest).toBe(DEVICE_OPS['feedback.cards.sync'].body);
    expect(RuntimeFeedbackPullResponse).toBe(DEVICE_OPS['feedback.drops.pull'].response);
    expect(RuntimeFeedbackAckRequest).toBe(DEVICE_OPS['feedback.drops.ack'].body);
    expect(MANAGER_PATHS.feedbackCards).toBe('/v1/runtime/feedback/cards');
    expect(MANAGER_PATHS.feedbackPull).toBe('/v1/runtime/feedback/pull');
    expect(MANAGER_PATHS.feedbackAck).toBe('/v1/runtime/feedback/ack');
    const pull = DEVICE_OPS['feedback.drops.pull'];
    expect(pull.body.safeParse({ max: 10, maxBytes: 16 * 1024 * 1024 }).success).toBe(true);
    expect(pull.response.safeParse({ drops: [], pending: 0, expired: [], nextPullS: 30 }).success).toBe(true);
    expect(DEVICE_OPS['feedback.drops.ack'].body.safeParse({ dropIds: [] }).success).toBe(false);
    expect(CONTROL_REASONS.feedback_drop_off).toMatch(/FEEDBACK_DROP/);
  });

  it('describes the public card and drop endpoints', () => {
    expect(feedbackDropApi.card).toMatchObject({
      method: 'GET',
      path: '/feedback/sites/:site/card',
      auth: 'none',
    });
    expect(feedbackDropApi.drop).toMatchObject({
      method: 'POST',
      path: '/feedback/sites/:site/drops',
      status: 202,
    });
    expect(feedbackDropApi.drop.body.safeParse(new Uint8Array(4)).success).toBe(true);
    expect(feedbackDropApi.drop.body.safeParse('bytes').success).toBe(false);
    expect(FeedbackDropReceipt.safeParse({ receivedAt: '2026-09-27T10:15:02.114Z' }).success).toBe(true);
    expect(FEEDBACK_PUBLIC_MESSAGES.unavailable).toBe('Feedback is not available here.');
    expect(Object.values(controlApi).some((area) => 'drop' in area)).toBe(false);
  });
});

describe('reporter sign-in (CT-164)', () => {
  const site = 'fbs_Q3v9xLpA0dZkT7mW2bNcYe12';
  const update = {
    site,
    reporterId: 'fbr_q3Vx9LpA0dZkT7mW2bNcYe',
    reference: 'FB-7K3Q-9M2X',
    type: 'bug',
    status: 'in_progress',
    receivedAt: now - 3_600,
    updatedAt: now,
  };
  const removal = { site, reference: 'FB-7K3Q-9M2Y' };
  const publish = DEVICE_OPS['feedback.reporters.publish'];

  it('describes the reporter endpoints with the same shapes as the runtime', () => {
    expect(feedbackDropApi.reporterCode).toMatchObject({
      id: 'feedback.reporter.code',
      method: 'POST',
      path: '/feedback/sites/:site/reporter/code',
      auth: 'none',
      status: 202,
      body: FeedbackReporterCodeRequest,
      response: FeedbackReporterOk,
    });
    expect(feedbackDropApi.reporterSession).toMatchObject({
      method: 'POST',
      path: '/feedback/sites/:site/reporter/session',
      status: 200,
      body: FeedbackReporterSessionRequest,
      response: FeedbackReporterSession,
    });
    expect(feedbackDropApi.reporterSignOut).toMatchObject({
      method: 'DELETE',
      path: '/feedback/sites/:site/reporter/session',
      status: 204,
    });
    expect(feedbackDropApi.reporterReports).toMatchObject({
      method: 'GET',
      path: '/feedback/sites/:site/reporter/reports',
      response: FeedbackReporterReports,
    });
    const ids = Object.values(feedbackDropApi).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of Object.values(feedbackDropApi))
      expect(FEEDBACK_DROP_CORS.allowMethods.split(', ')).toContain(e.method);
    for (const key of ['reporterCode', 'reporterSession', 'reporterReports'] as const)
      expect(`/v1${feedbackDropApi[key].path}`.replace('/v1/feedback/', '/embed/v1/')).toBe(
        FEEDBACK_PUBLIC_PATHS[key],
      );
  });

  it('allows the bearer header and DELETE, still without credentials', () => {
    expect(FEEDBACK_DROP_CORS).toEqual({
      allowMethods: 'GET, POST, DELETE',
      allowHeaders: 'content-type, authorization',
      maxAgeS: 600,
    });
    expect('allowCredentials' in FEEDBACK_DROP_CORS).toBe(false);
  });

  it('carries control’s attestation on a drop, optional for older controls', () => {
    const drop = {
      dropId: 'fdr_q3Vx9LpA0dZkT7mW2bNcYe',
      site,
      receivedAt: now,
      origin: 'https://embed.whombat.com',
      bytes: 4658,
      envelope: 'AAECAwQF',
    };
    const reporter = { id: update.reporterId, emailDigest: reporterEmailDigest(site, 'a@b.example') };
    expect(FeedbackDrop.parse(drop).reporter).toBeUndefined();
    expect(FeedbackDrop.parse({ ...drop, reporter }).reporter).toEqual(reporter);
    expect(FeedbackDrop.safeParse({ ...drop, reporter: { ...reporter, id: 'fbr_x' } }).success).toBe(false);
    expect(
      FeedbackDrop.safeParse({ ...drop, reporter: { ...reporter, emailDigest: 'A'.repeat(64) } }).success,
    ).toBe(false);
  });

  it('bounds feedback.reporters.publish', () => {
    expect(publish.body.safeParse({ updates: [update], removals: [removal] }).success).toBe(true);
    expect(publish.body.safeParse({ updates: [], removals: [] }).success).toBe(true);
    const full = {
      updates: Array(FEEDBACK_REPORTERS_PUBLISH_MAX).fill(update),
      removals: Array(FEEDBACK_REPORTERS_PUBLISH_MAX).fill(removal),
    };
    expect(publish.body.safeParse(full).success).toBe(true);
    expect(publish.body.safeParse({ ...full, updates: [...full.updates, update] }).success).toBe(false);
    expect(publish.body.safeParse({ ...full, removals: [...full.removals, removal] }).success).toBe(false);
    expect(publish.body.safeParse({ updates: [] }).success).toBe(false);
    for (const bad of [
      { status: 'triaged' },
      { type: 'question' },
      { reference: 'FB-7K3Q-9M2' },
      { reporterId: 'fbr_short' },
      { site: 'fbs_x' },
      { updatedAt: -1 },
      { summary: 'text never travels' },
    ])
      expect(publish.body.safeParse({ updates: [{ ...update, ...bad }], removals: [] }).success).toBe(false);
    expect(publish.response.safeParse({ ok: true }).success).toBe(true);
    const signed = signDeviceRequest(
      {
        aud: 'whombat-api:dev',
        device: 'dev_1',
        op: 'feedback.reporters.publish',
        ts: now,
        nonce: 'ef'.repeat(16),
        body: full,
      },
      mgmt.secretKey,
    );
    expect(deviceRequestMaxBytes('feedback.reporters.publish')).toBe(DEVICE_REQUEST_MAX_BYTES);
    expect(JSON.stringify(signed).length).toBeLessThan(DEVICE_REQUEST_MAX_BYTES / 2);
  });

  it('forwards it through the manager', () => {
    expect(MANAGER_PATHS.feedbackReporters).toBe('/v1/runtime/feedback/reporters');
    expect(RuntimeFeedbackReportersRequest).toBe(publish.body);
    expect(RuntimeFeedbackReportersResponse).toBe(publish.response);
  });
});

describe('robust updates (CT-137…CT-141)', () => {
  const detail = {
    stage: 'Staged' as const,
    code: 'schema_incompatible',
    reasons: ['candidate_cannot_read_schema'],
    release: 'pve-20260928.5',
    schema: { database: 48, target: null, candidateWrites: 49, candidateReads: { min: 49, max: 49 } },
    failedChecks: [],
    at: now,
  };
  const status = {
    release: 'pve-20260928.4',
    managerVersion: '0.1.0',
    uptimeS: 60,
    update: { state: 'Quarantined', candidate: 'pve-20260928.5', attempt: 3, failure: 'schema_incompatible' },
    health: {
      runtime: 'ok',
      database: 'ok',
      runner: 'ok',
      sessionEndpoint: 'ok',
      relay: 'ok',
      backup: 'unconfigured',
    },
    storage: { persistUsedPct: 12, persistFreeBytes: 1_000_000 },
    sessionsActive: 0,
    recoveryKit: 'confirmed',
    lastBackupAt: null,
    clockSynced: true,
  };

  it('reports failure detail in status reports and progress, codes only', () => {
    const body = DEVICE_OPS['status.report'].body;
    // A 0.21 manager's report still parses.
    expect(body.safeParse(status).success).toBe(true);
    const report = {
      ...status,
      runtimeVersion: '0.2.0-20260928190000.abcdef1',
      update: { ...status.update, failureDetail: detail },
    };
    expect(body.parse(report)).toEqual(report);
    // Strict: no message or other member rides along.
    const withMessage = {
      ...report,
      update: { ...report.update, failureDetail: { ...detail, message: 'x' } },
    };
    expect(body.safeParse(withMessage).success).toBe(false);
    expect(describeUpdateFailure(detail)).toBe(
      'pve-20260928.5 couldn’t start on this Whombat’s database: it reads schema 49 only and the database is at 48. Nothing was changed.',
    );
    const progress = DEVICE_OPS['update.progress'].body;
    expect(
      progress.safeParse({
        sequence: 4,
        state: 'Failed',
        current: 'pve-20260928.4',
        candidate: 'pve-20260928.5',
        attempt: 1,
        failure: 'schema_incompatible',
        failedChecks: [],
        failureDetail: detail,
        at: now,
      }).success,
    ).toBe(true);
    // Waiting, codes only (CT-147).
    const waiting = { reason: 'checkpoint', since: now };
    expect(body.safeParse({ ...status, update: { ...status.update, waiting } }).success).toBe(true);
    expect(
      body.safeParse({
        ...status,
        update: { ...status.update, waiting: { ...waiting, blockers: [{ kind: 'run', count: 1 }] } },
      }).success,
    ).toBe(false);
    expect(
      progress.safeParse({
        sequence: 5,
        state: 'WaitingForSafeBoundary',
        current: 'pve-20260928.4',
        candidate: 'pve-20260928.5',
        attempt: 0,
        failure: null,
        failedChecks: [],
        waiting: { reason: 'boundary', since: now },
        at: now,
      }).success,
    ).toBe(true);
    // The tolerant copy strips what a newer manager adds.
    expect(UpdateFailureDetail.parse({ ...detail, extra: 1 })).toEqual(detail);
  });

  it('passes the update facts of 0.22 through to appliance.status', () => {
    const facts = UpdateFacts.parse({
      state: 'WaitingForSafeBoundary',
      current: 'pve-20260928.6',
      candidate: 'pve-20260929.1',
      lastCheckedAt: '2026-09-29T08:00:00Z',
      deferredReason: 'task_running',
      failure: null,
      failureDetail: detail,
      waiting: {
        reason: 'boundary',
        since: '2026-09-29T08:00:00+02:00',
        blockers: [{ kind: 'run', count: 2 }],
      },
      lastUpdate: { release: 'pve-20260928.6', from: 'pve-20260928.4', at: '2026-09-28T20:00:00Z' },
    });
    expect(summarizeUpdate(facts)).toMatchObject({
      lastCheckedAt: '2026-09-29T08:00:00.000Z',
      failureDetail: detail,
      waiting: {
        reason: 'boundary',
        since: '2026-09-29T06:00:00.000Z',
        blockers: [{ kind: 'run', count: 2 }],
      },
      lastUpdate: { release: 'pve-20260928.6', from: 'pve-20260928.4', at: '2026-09-28T20:00:00.000Z' },
    });
    const bare = summarizeUpdate({
      ...facts,
      failureDetail: undefined,
      waiting: undefined,
      lastUpdate: undefined,
    });
    expect(bare && Object.keys(bare).sort()).toEqual(
      ['candidate', 'current', 'deferredReason', 'failure', 'lastCheckedAt', 'state'].sort(),
    );
    const pausedFacts = UpdateFacts.parse({ ...facts, paused: true });
    expect(summarizeUpdate(pausedFacts)).toMatchObject({ paused: true });
    expect(summarizeUpdate({ ...facts, paused: false })?.paused).toBeUndefined();
  });

  it('has the wave presets of UP-E1, each a valid rollout', () => {
    const create = controlApi.rollout.create.body;
    for (const waves of Object.values(ROLLOUT_PRESETS))
      expect(create.safeParse({ release: 'pve-20260929.1', waves }).success).toBe(true);
    expect(
      ROLLOUT_PRESETS.default.map((w) => [w.cohorts.join('+'), w.basisPoints, w.minObservationS]),
    ).toEqual([
      ['internal', 10_000, 3_600],
      ['pilot', 10_000, 21_600],
      ['canary', 10_000, 43_200],
      ['general', 1_000, 86_400],
      ['general', 10_000, 0],
    ]);
    expect(ROLLOUT_PRESETS['all-at-once']).toEqual([
      {
        index: 0,
        cohorts: ['internal', 'pilot', 'canary', 'general'],
        basisPoints: 10_000,
        minObservationS: 0,
        failureThresholdBp: 0,
        minSample: 1,
      },
    ]);
    for (const w of Object.values(ROLLOUT_PRESETS).flat())
      expect([w.failureThresholdBp, w.minSample]).toEqual([0, 1]);
  });

  it('reads rollouts of an older control and pause details of a newer one', () => {
    const rollout = {
      rollout: 'rol_1',
      release: 'pve-20260929.1',
      state: 'paused',
      waves: [{ ...ROLLOUT_PRESETS['all-at-once'][0], state: 'paused', startedAt: now }],
      pauseReason: 'device_failed',
      createdAt: now,
      counts: { assigned: 1, healthy: 0, failed: 1, rolledBack: 0 },
    };
    expect(Rollout.safeParse(rollout).success).toBe(true);
    const paused = {
      ...rollout,
      pauseDetail: { device: 'dev_1', reason: 'device_failed', failureDetail: detail, at: now },
    };
    expect(Rollout.parse(paused).pauseDetail?.failureDetail?.code).toBe('schema_incompatible');
    expect(Object.keys(ROLLOUT_PAUSE_REASONS)).toEqual([
      'operator',
      'failure_threshold',
      'device_failed',
      'health_regression',
      'quarantined',
    ]);
  });

  it('describes the operator endpoints of the release pipeline', () => {
    const op = controlApi.operator;
    const tuple = {
      releaseId: 'pve-20260929.1',
      runtime: {
        version: '0.2.0-20260928190000.abcdef1',
        storePath: `/nix/store/${'a'.repeat(32)}-whombat-runtime`,
        narHash: `sha256:${'a'.repeat(64)}`,
        schemaReads: { min: 49, max: 49 },
        schemaWrites: 49,
        protocol: { min: 1000, max: 1000 },
        hostAbi: { min: 1, max: 1 },
      },
      providers: [],
      host: {
        version: 'pve-20260929.1',
        storePath: `/nix/store/${'c'.repeat(32)}-nixos-system`,
        narHash: `sha256:${'c'.repeat(64)}`,
        abi: 1,
      },
      manager: {
        version: '0.2.0-20260928190000.1234567',
        storePath: `/nix/store/${'d'.repeat(32)}-whombat-manager`,
        narHash: `sha256:${'d'.repeat(64)}`,
      },
    };
    const gate = { ok: true, at: now, sha256: 'ab'.repeat(32), summary: 'every gate passed' };
    const record = {
      notes: { summary: 'Backups to S3 and SFTP.', markdown: '## Changes' },
      migrations: [{ tag: '0048_capabilities', class: 'expand', readers: 47, writers: 47, version: 49 }],
      twin: 'pve-dev-20260929.1',
      env: 'prod',
      gates: { build: gate, validate: gate },
      builtFrom: { appliance: 'a'.repeat(40), contracts: '0.22.0' },
      knownIssues: [],
    };
    expect(op.registerRelease.body.safeParse({ tuple }).success).toBe(true);
    expect(op.registerRelease.body.safeParse({ tuple, record }).success).toBe(true);
    expect(op.setReleaseRecord.body.safeParse({ gates: { devSoak: gate } }).success).toBe(true);
    // A custody rollback's signed allowDowngradeFrom, copied for control's offer (CT-144).
    expect(
      op.setReleaseRecord.body.safeParse({ allowDowngradeFrom: ['pve-20260929.1', 'pve-dev-20260929.1'] })
        .success,
    ).toBe(true);
    expect(op.setReleaseRecord.body.safeParse({ allowDowngradeFrom: ['Not A Release'] }).success).toBe(false);
    expect(
      op.setReleaseRecord.body.safeParse({
        allowDowngradeFrom: Array.from({ length: 17 }, (_, i) => `pve-20260929.${i + 1}`),
      }).success,
    ).toBe(false);
    expect(op.setReleaseRecord).toMatchObject({ method: 'PUT', path: '/operator/releases/:release/record' });
    expect(
      op.releases.response.safeParse({
        releases: [
          {
            release: 'pve-20260928.6',
            state: 'approved',
            quarantinedAt: null,
            tupleDigest: `sha256:${'e'.repeat(64)}`,
          },
          {
            release: 'pve-20260929.1',
            state: 'approved',
            quarantinedAt: null,
            tupleDigest: `sha256:${'f'.repeat(64)}`,
            record,
            versions: {
              host: 'pve-20260929.1',
              runtime: tuple.runtime.version,
              manager: tuple.manager.version,
            },
            schemaWrites: 49,
            createdAt: now,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      op.rolloutDevices.response.safeParse({
        devices: [
          {
            device: 'dev_1',
            org: 'org_1',
            cohort: 'internal',
            wave: 0,
            state: 'Quarantined',
            attempt: 3,
            failure: 'schema_incompatible',
            failureDetail: detail,
            hold: 'failed_before',
            managerVersion: '0.1.0',
            updatedAt: now,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      op.fleet.response.safeParse({
        generatedAt: now,
        devices: { total: 2, live: 1, unseen24h: 1 },
        releases: [{ release: 'pve-20260928.6', devices: 1, managerVersions: ['0.1.0'] }],
        rollouts: [],
        alerts: { open: 1, critical: 0 },
      }).success,
    ).toBe(true);
    const alert = {
      id: 'alr_1',
      kind: 'rollout_paused',
      severity: 'critical',
      subject: 'rollout rol_1',
      detail: 'pve-20260929.1 paused: a device failed.',
      openedAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
    expect(op.alerts.response.safeParse({ alerts: [alert] }).success).toBe(true);
    expect(op.alerts.query.safeParse({ state: 'all' }).success).toBe(true);
    expect(op.ackAlert.response.safeParse(alert).success).toBe(true);
    expect(
      op.registrations.response.safeParse({
        registrations: [
          {
            id: 'reg_1',
            existingDevice: 'dev_1',
            existingState: 'claimed',
            attempts: 3,
            firstAt: now,
            lastAt: now,
          },
        ],
      }).success,
    ).toBe(true);
    expect(op.retireExisting.body.safeParse({ reason: 'reinstalled' }).success).toBe(true);
    // CT-147: retry a device, waiting in the rollout view, the fleet's mail and backup counts, stalled rollouts.
    expect(op.retryDevice).toMatchObject({ method: 'POST', path: '/operator/devices/:device/retry' });
    expect(op.retryDevice.body.safeParse({ release: 'pve-20260929.1', reason: 'space_freed' }).success).toBe(
      true,
    );
    expect(op.retryDevice.body.safeParse({ release: 'pve-20260929.1' }).success).toBe(false);
    expect(
      op.retryDevice.response.safeParse({
        device: 'dev_1',
        org: null,
        cohort: 'internal',
        wave: 0,
        state: 'WaitingForSafeBoundary',
        attempt: 0,
        failure: null,
        failureDetail: null,
        hold: null,
        managerVersion: '0.2.0-20260928190000.1234567',
        updatedAt: now,
        waiting: { reason: 'boundary', since: now },
      }).success,
    ).toBe(true);
    expect(
      op.fleet.response.safeParse({
        generatedAt: now,
        devices: { total: 2, live: 2, unseen24h: 0, backupUnconfigured: 1 },
        releases: [],
        rollouts: [],
        alerts: { open: 0, critical: 0, mail: false },
      }).success,
    ).toBe(true);
    expect(op.alerts.response.safeParse({ alerts: [{ ...alert, kind: 'rollout_stalled' }] }).success).toBe(
      true,
    );
    expect(isRetryableUpdateFailure('no_space')).toBe(true);
    expect(isRetryableUpdateFailure('schema_incompatible')).toBe(false);
    expect(controlApi.rollout.releaseSummary).toMatchObject({
      auth: 'session',
      path: '/releases/:release/summary',
    });
    expect(
      controlApi.rollout.releaseSummary.response.safeParse({
        release: 'pve-20260929.1',
        summary: 'Backups to S3 and SFTP.',
        publishedAt: now,
      }).success,
    ).toBe(true);
  });
});

describe('phone sign-in by QR code (CT-190) and downloads (CT-191)', () => {
  const mac = 'A'.repeat(43);

  it('a report is a pairing request with its MAC, or signed in', () => {
    const body = controlApi.auth.reportPhoneHandoff.body;
    expect(
      body.safeParse({ kind: 'pairing', code: '1234-5678', fingerprint: 'AB12-CD34-EF56', mac }).success,
    ).toBe(true);
    expect(body.safeParse({ kind: 'signed_in' }).success).toBe(true);
    // No lower-case fingerprints, no codes without the dash, no MAC of another length, nothing extra.
    expect(
      body.safeParse({ kind: 'pairing', code: '1234-5678', fingerprint: 'ab12-cd34-ef56', mac }).success,
    ).toBe(false);
    expect(
      body.safeParse({ kind: 'pairing', code: '12345678', fingerprint: 'AB12-CD34-EF56', mac }).success,
    ).toBe(false);
    expect(
      body.safeParse({ kind: 'pairing', code: '1234-5678', fingerprint: 'AB12-CD34-EF56', mac: `${mac}A` })
        .success,
    ).toBe(false);
    expect(body.safeParse({ kind: 'signed_in', code: '1234-5678' }).success).toBe(false);
  });

  it('redeeming answers a cloud session with the handoff it reports to', () => {
    const r = controlApi.auth.redeemPhoneHandoff;
    expect(r.auth).toBe('none');
    expect(r.body.safeParse({ token: 'short' }).success).toBe(false);
    expect(
      r.response.safeParse({
        token: 't'.repeat(43),
        expiresAt: '2026-10-30T12:00:00Z',
        account: {
          accountId: 'acc_1',
          email: 'mara@example.com',
          name: null,
          createdAt: '2026-09-01T00:00:00Z',
        },
        orgs: [],
        handoffId: 'ph_abcdefgh',
      }).success,
    ).toBe(true);
  });

  it('a handoff view carries its report only as the union', () => {
    const view = controlApi.auth.phoneHandoff.response;
    const base = { handoffId: 'ph_abcdefgh', expiresAt: '2026-10-30T12:00:00Z' };
    expect(view.safeParse({ ...base, state: 'waiting', report: null }).success).toBe(true);
    expect(view.safeParse({ ...base, state: 'done', report: { kind: 'signed_in' } }).success).toBe(true);
    expect(view.safeParse({ ...base, state: 'gone', report: null }).success).toBe(false);
  });

  it('the Android download is public and names its file by absolute URL', () => {
    const d = controlApi.downloads.android;
    expect(d.auth).toBe('none');
    const android = {
      version: '0.16.0',
      versionCode: 16000,
      size: 41_000_000,
      sha256: 'a'.repeat(64),
      publishedAt: '2026-09-30T12:00:00Z',
      url: 'https://api-dev.whombat.com/v1/downloads/android/whombat-0.16.0.apk',
    };
    expect(d.response.safeParse({ android }).success).toBe(true);
    expect(d.response.safeParse({ android: null }).success).toBe(true);
    expect(d.response.safeParse({ android: { ...android, sha256: 'A'.repeat(64) } }).success).toBe(false);
  });
});
