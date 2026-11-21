/**
 * Passkeys that open this Whombat (docs/decisions/passkeys.md PK-01…PK-09, PK-D01…): registration from an enrolled
 * device with the Whombat's own nonce, one-touch enrollment the Whombat verifies itself (RP ID, origin, type, user
 * verification, the challenge bound to the session's PeerId, its own user handle, the counter, the policy), one
 * `passkey_invalid` for every failed check, the failure budget, the limit, listing and removal, the person's policy
 * and the notice to the person's other devices. A software authenticator stands in for the browser.
 * Remote help's step-up runs the same checks for the person's own passkey against a challenge bound to the choice, and
 * its follower signs each event into the same chain once, moving its cursor in that transaction, and tells the person in
 * their Chat (remote-help-server.md RH-S04, RH-S05): both need the stored passkeys, accounts and chain.
 */
import { randomBytes } from 'node:crypto';
import {
  PASSKEY_ANDROID_ORIGINS,
  PASSKEY_ENROLL_FAILURES_PER_HOUR,
  PASSKEYS_PER_ACCOUNT_MAX,
  passkeyEnrollChallengeBase64url,
  passkeyRegisterChallengeBase64url,
  passkeyRemoteHelpChallengeBase64url,
  passkeyUserHandleBase64url,
} from '@whombat/protocol/session';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts,
  applianceEndpoints,
  applianceEvents,
  appliancePasskeys,
  applianceState,
  messages,
} from '../db/schema/index';
import { tellPerson } from '../desk/tell';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { TEST_APP_URL } from '../test/harness';
import { useManagedRuntime } from '../test/managed';
import { addPersonalAgent } from '../test/personal';
import { SoftwareAuthenticator } from '../test/webauthn';
import { verifyApplianceChain } from './audit';
import { FakeSupport } from './fake-support';
import { REMOTE_HELP_VISIT_QUIET_MS, RemoteHelpService } from './remote-help';
import { type TestIdentity, type TestSessionClient, testIdentity } from './testing';

const LOCAL_ORIGIN = 'http://localhost:5180';
const m = useManagedRuntime({ seed: true, env: { WHOMBAT_PASSKEY_EXTRA_ORIGINS: ` ${LOCAL_ORIGIN}/ ` } });
const RP_ID = new URL(TEST_APP_URL).hostname;
const hex32 = () => randomBytes(32).toString('hex');

type Answer = { t: string; code?: string; output?: Record<string, unknown>; details?: { code?: string } };
const output = <T = Record<string, unknown>>(r: unknown) => (r as { output: T }).output;
const INVALID = { t: 'error', code: 'forbidden', details: { code: 'passkey_invalid' } };

type Enrolled = Awaited<ReturnType<typeof m.enroll>>;
let owner: Enrolled;

beforeAll(async () => {
  owner = await m.enroll(IDS.mara);
});

/** `passkey.register.begin` → the authenticator's `create` → `passkey.register`, as the client does (PK-06). */
async function register(
  client: TestSessionClient,
  auth: SoftwareAuthenticator,
  o: {
    name?: string;
    origin?: string;
    uv?: boolean;
    reuse?: { applianceNonce: string; userId: string };
  } = {},
) {
  const begin = o.reuse
    ? null
    : output<{ applianceNonce: string; rpId: string; user: { id: string } }>(
        await client.request('passkey.register.begin', {}),
      );
  const applianceNonce = o.reuse?.applianceNonce ?? (begin?.applianceNonce as string);
  const userId = o.reuse?.userId ?? (begin?.user.id as string);
  const controlNonce = hex32();
  const response = auth.create({
    rpId: RP_ID,
    origin: o.origin ?? TEST_APP_URL,
    challenge: passkeyRegisterChallengeBase64url({
      controlNonce,
      applianceNonce,
      appliance: m.appliance.peerId,
    }),
    userId,
    ...(o.uv === false ? { uv: false } : {}),
  });
  const answer = (await client.request('passkey.register', {
    controlNonce,
    response,
    name: o.name ?? 'Chrome on Linux',
  })) as Answer;
  return { answer, applianceNonce, userId };
}

/** One touch on a new device: `enroll.passkey` with an assertion for this session's PeerId (PK-04, PK-05). */
async function enroll(
  auth: SoftwareAuthenticator,
  o: {
    identity?: TestIdentity;
    rpId?: string;
    origin?: string;
    uv?: boolean;
    challengeFor?: string;
    userHandle?: string | null;
    step?: number;
    type?: string;
  } = {},
) {
  const identity = o.identity ?? testIdentity();
  const client = await m.client(identity);
  const nonce = hex32();
  const response = auth.get({
    rpId: o.rpId ?? RP_ID,
    origin: o.origin ?? TEST_APP_URL,
    challenge: passkeyEnrollChallengeBase64url({ nonce, endpoint: o.challengeFor ?? identity.peerId }),
    ...(o.uv === false ? { uv: false } : {}),
    ...(o.userHandle !== undefined ? { userHandle: o.userHandle } : {}),
    ...(o.step !== undefined ? { step: o.step } : {}),
    ...(o.type ? { type: o.type } : {}),
  });
  const answer = (await client.request('enroll.passkey', {
    nonce,
    response,
    endpoint: { label: 'Pixel 9', platform: 'android' },
  })) as Answer;
  return { answer, client, identity };
}

/** In the order they happened: tests read the last one. */
const events = async (type: string) =>
  m.t.services.db
    .select()
    .from(applianceEvents)
    .where(eq(applianceEvents.type, type))
    .orderBy(asc(applianceEvents.seq));

describe('registering a passkey (PK-06)', () => {
  const ownerKey = new SoftwareAuthenticator();

  it('begins with the Whombat’s own nonce and the PK-01 user, then stores the credential for the caller', async () => {
    const laptop = await m.client(owner);
    const begin = output(await laptop.request('passkey.register.begin', {}));
    const [mara] = await m.t.services.db.select().from(accounts).where(eq(accounts.id, owner.accountId));
    expect(begin).toEqual({
      applianceNonce: expect.stringMatching(/^[0-9a-f]{64}$/),
      endpoint: owner.peerId,
      rpId: RP_ID,
      user: {
        id: passkeyUserHandleBase64url(m.appliance.peerId),
        name: mara?.email,
        displayName: expect.any(String),
      },
      excludeCredentialIds: [],
    });
    const { answer } = await register(laptop, ownerKey, { name: 'Chrome on Linux' });
    expect(answer).toMatchObject({
      t: 'result',
      output: {
        id: ownerKey.id,
        name: 'Chrome on Linux',
        accountId: owner.accountId,
        personName: expect.any(String),
        lastUsedAt: null,
        synced: false,
        current: false,
      },
    });
    const [row] = await m.t.services.db
      .select()
      .from(appliancePasskeys)
      .where(eq(appliancePasskeys.id, ownerKey.id));
    expect(row).toMatchObject({ accountId: owner.accountId, backupEligible: false, counter: 0 });
    expect(row?.transports).toEqual(['internal', 'hybrid']);
    expect((await events('passkey.registered')).at(-1)?.payload).toEqual({
      credentialId: ownerKey.id,
      accountId: owner.accountId,
      byAccountId: owner.accountId,
      synced: false,
    });
    // The next begin excludes it.
    expect(output(await laptop.request('passkey.register.begin', {})).excludeCredentialIds).toEqual([
      ownerKey.id,
    ]);
  });

  it('uses a begin once, and refuses a wrong origin, no user verification and an unknown session', async () => {
    const laptop = await m.client(owner);
    const first = await register(laptop, new SoftwareAuthenticator());
    expect(first.answer).toMatchObject({ t: 'result' });
    // The same begin again: its nonce is gone.
    expect((await register(laptop, new SoftwareAuthenticator(), { reuse: first })).answer).toMatchObject(
      INVALID,
    );
    expect(
      (await register(laptop, new SoftwareAuthenticator(), { origin: 'https://evil.test' })).answer,
    ).toMatchObject(INVALID);
    expect((await register(laptop, new SoftwareAuthenticator(), { uv: false })).answer).toMatchObject(
      INVALID,
    );
    // A begin of another session doesn't carry over.
    const begin = output<{ applianceNonce: string; user: { id: string } }>(
      await laptop.request('passkey.register.begin', {}),
    );
    const other = await m.client(owner);
    expect(
      (
        await register(other, new SoftwareAuthenticator(), {
          reuse: { applianceNonce: begin.applianceNonce, userId: begin.user.id },
        })
      ).answer,
    ).toMatchObject(INVALID);
    // Unenrolled sessions can't begin.
    expect(await (await m.client()).request('passkey.register.begin', {})).toMatchObject({
      t: 'error',
      code: 'enrollment_required',
    });
  });

  it('refuses a synced passkey under “Only passkeys that stay on one device”', async () => {
    const laptop = await m.client(owner);
    expect(await laptop.request('passkeys.policy', { deviceBoundOnly: true })).toMatchObject({
      t: 'result',
      output: { ok: true },
    });
    expect((await register(laptop, new SoftwareAuthenticator({ synced: true }))).answer).toMatchObject({
      t: 'error',
      code: 'not_allowed',
      details: { code: 'passkey_not_allowed' },
    });
    expect(output(await laptop.request('passkeys.list', {})).policy).toEqual({ deviceBoundOnly: true });
    await laptop.request('passkeys.policy', { deviceBoundOnly: false });
    expect((await events('passkeys.policy_changed')).map((e) => e.payload)).toEqual([
      { deviceBoundOnly: true, byAccountId: owner.accountId },
      { deviceBoundOnly: false, byAccountId: owner.accountId },
    ]);
  });

  it('stops at PASSKEYS_PER_ACCOUNT_MAX per account (passkey_limit)', async () => {
    const phone = await m.client(owner);
    const begin = output<{ applianceNonce: string; user: { id: string } }>(
      await phone.request('passkey.register.begin', {}),
    );
    const filler = (n: number) =>
      Array.from({ length: n }, () => ({
        id: randomBytes(16).toString('base64url'),
        accountId: owner.accountId,
        name: 'Old key',
        publicKey: Buffer.alloc(8),
        backupEligible: false,
        backedUp: false,
      }));
    const old = filler(PASSKEYS_PER_ACCOUNT_MAX);
    await m.t.services.db.insert(appliancePasskeys).values(old);
    expect(
      (
        await register(phone, new SoftwareAuthenticator(), {
          reuse: { applianceNonce: begin.applianceNonce, userId: begin.user.id },
        })
      ).answer,
    ).toMatchObject({ t: 'error', code: 'conflict', details: { code: 'passkey_limit' } });
    expect(await phone.request('passkey.register.begin', {})).toMatchObject({
      t: 'error',
      details: { code: 'passkey_limit' },
    });
    await m.t.services.db.delete(appliancePasskeys).where(
      inArray(
        appliancePasskeys.id,
        old.map((k) => k.id),
      ),
    );
  });
});

describe('enrolling a device with a passkey (PK-04, PK-05, PK-09)', () => {
  const key = new SoftwareAuthenticator();

  beforeAll(async () => {
    const laptop = await m.client(owner);
    expect((await register(laptop, key)).answer).toMatchObject({ t: 'result' });
    // The person's laptop gets push: it hears of the new device (PK-09).
    await laptop.request('push.handles.set', { handle: 'push-handle-mara-laptop' });
  });

  it('enrolls the session’s endpoint into the passkey’s account in one step and promotes the session', async () => {
    const pushesBefore = m.manager.pushes.length;
    const { answer, client, identity } = await enroll(key);
    expect(answer).toMatchObject({
      t: 'result',
      output: {
        accountId: owner.accountId,
        endpoint: { label: 'Pixel 9', platform: 'android', current: true, revocation: 'none' },
      },
    });
    const endpointId = (output(answer).endpoint as { endpointId: string }).endpointId;
    const [row] = await m.t.services.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, identity.peerId));
    expect(row).toMatchObject({ id: endpointId, enrolledVia: 'passkey', enrolledPasskeyId: key.id });
    expect((await events('endpoint.enrolled')).at(-1)?.payload).toMatchObject({
      via: 'passkey',
      credentialId: key.id,
      endpointId,
      accountId: owner.accountId,
    });
    // The same session now uses the app; the passkey is `current` for it and was just used.
    const listed = output<{ passkeys: { id: string; current: boolean; lastUsedAt: string | null }[] }>(
      await client.request('passkeys.list', {}),
    );
    expect(listed.passkeys.find((p) => p.id === key.id)).toMatchObject({
      current: true,
      lastUsedAt: expect.any(String),
    });
    // The person's other device hears of it: a security push that says what happened, and its tap opens Devices.
    await expect.poll(() => m.manager.pushes.length).toBeGreaterThan(pushesBefore);
    const pushed = m.manager.pushes.at(-1);
    expect(pushed).toMatchObject({
      kind: 'security',
      handles: ['push-handle-mara-laptop'],
      preview: { title: expect.stringContaining('device') },
    });
    expect(await client.request('push.resolve', { ref: pushed?.ref })).toMatchObject({
      t: 'result',
      output: { link: { type: 'external', url: expect.stringContaining('section=devices') } },
    });
    // Already enrolled: no second endpoint.
    const nonce = hex32();
    expect(
      await client.request('enroll.passkey', {
        nonce,
        response: key.get({
          rpId: RP_ID,
          origin: TEST_APP_URL,
          challenge: passkeyEnrollChallengeBase64url({ nonce, endpoint: identity.peerId }),
        }),
        endpoint: { label: 'Pixel 9', platform: 'android' },
      }),
    ).toMatchObject({ t: 'error', details: { code: 'endpoint_enrolled' } });
  });

  it('accepts the Android app’s origin and WHOMBAT_PASSKEY_EXTRA_ORIGINS', async () => {
    expect((await enroll(key, { origin: PASSKEY_ANDROID_ORIGINS[0] })).answer).toMatchObject({ t: 'result' });
    expect((await enroll(key, { origin: LOCAL_ORIGIN })).answer).toMatchObject({ t: 'result' });
  });

  it('answers passkey_invalid for every failed check', async () => {
    const otherWhombat = passkeyUserHandleBase64url(testIdentity().peerId);
    const cases: [string, Parameters<typeof enroll>[1]][] = [
      ['wrong RP ID', { rpId: 'evil.test' }],
      ['wrong origin', { origin: 'https://app.whombat.evil' }],
      ['wrong type', { type: 'webauthn.create' }],
      ['challenge for another endpoint', { challengeFor: testIdentity().peerId }],
      ['another Whombat’s user handle', { userHandle: otherWhombat }],
      ['no user handle', { userHandle: null }],
      ['no user verification', { uv: false }],
    ];
    for (const [why, o] of cases) expect((await enroll(key, o)).answer, why).toMatchObject(INVALID);
    // A credential this Whombat doesn't know.
    const stranger = new SoftwareAuthenticator();
    stranger.userHandle = passkeyUserHandleBase64url(m.appliance.peerId);
    expect((await enroll(stranger)).answer).toMatchObject(INVALID);
  });

  it('refuses a counter going backwards', async () => {
    const counting = new SoftwareAuthenticator({ counter: 5 });
    expect((await register(await m.client(owner), counting)).answer).toMatchObject({ t: 'result' });
    expect((await enroll(counting)).answer).toMatchObject({ t: 'result' });
    const [row] = await m.t.services.db
      .select()
      .from(appliancePasskeys)
      .where(eq(appliancePasskeys.id, counting.id));
    expect(row?.counter).toBe(6);
    expect((await enroll(counting, { step: -1 })).answer).toMatchObject(INVALID);
    expect((await enroll(counting, { step: 0 })).answer).toMatchObject(INVALID);
    expect((await enroll(counting, { step: 3 })).answer).toMatchObject({ t: 'result' });
  });

  it('refuses a removed passkey', async () => {
    const removed = new SoftwareAuthenticator();
    const laptop = await m.client(owner);
    expect((await register(laptop, removed)).answer).toMatchObject({ t: 'result' });
    expect(await laptop.request('passkey.remove', { id: removed.id })).toMatchObject({ t: 'result' });
    expect((await enroll(removed)).answer).toMatchObject(INVALID);
  });

  it('refuses a synced passkey under deviceBoundOnly (passkey_not_allowed), after it verified', async () => {
    const synced = new SoftwareAuthenticator({ synced: true });
    const laptop = await m.client(owner);
    expect((await register(laptop, synced)).answer).toMatchObject({ t: 'result', output: { synced: true } });
    await laptop.request('passkeys.policy', { deviceBoundOnly: true });
    expect((await enroll(synced)).answer).toMatchObject({
      t: 'error',
      code: 'not_allowed',
      details: { code: 'passkey_not_allowed' },
    });
    // A wrong one under the policy is still just invalid.
    expect((await enroll(synced, { uv: false })).answer).toMatchObject(INVALID);
    // Device-bound ones keep working.
    expect((await enroll(key)).answer).toMatchObject({ t: 'result' });
    await laptop.request('passkeys.policy', { deviceBoundOnly: false });
    expect((await enroll(synced)).answer).toMatchObject({ t: 'result' });
  });

  it(`allows ${PASSKEY_ENROLL_FAILURES_PER_HOUR} failed attempts per peer and hour`, async () => {
    const identity = testIdentity();
    for (let i = 0; i < PASSKEY_ENROLL_FAILURES_PER_HOUR; i++)
      expect((await enroll(key, { identity, uv: false })).answer).toMatchObject(INVALID);
    expect((await enroll(key, { identity })).answer).toMatchObject({ t: 'error', code: 'rate_limited' });
    // Another key isn't affected.
    expect((await enroll(key)).answer).toMatchObject({ t: 'result' });
  });
});

describe('seeing and removing passkeys (PK-08)', () => {
  const laptopKey = new SoftwareAuthenticator();

  beforeAll(async () => {
    expect(
      (await register(await m.client(owner), laptopKey, { name: 'Firefox on Mac' })).answer,
    ).toMatchObject({
      t: 'result',
    });
  });

  it('lists each with the person', async () => {
    const all = output<{ passkeys: { id: string; accountId: string; personName: string }[] }>(
      await (await m.client(owner)).request('passkeys.list', {}),
    );
    const [mara] = await m.t.services.db.select().from(accounts).where(eq(accounts.id, owner.accountId));
    expect(all.passkeys.find((p) => p.id === laptopKey.id)).toMatchObject({
      accountId: owner.accountId,
      personName: mara?.name || mara?.email,
    });
  });

  it('removes one, recorded; again is not found', async () => {
    expect(await (await m.client(owner)).request('passkey.remove', { id: laptopKey.id })).toMatchObject({
      t: 'result',
      output: { ok: true },
    });
    expect((await events('passkey.removed')).at(-1)?.payload).toEqual({
      credentialId: laptopKey.id,
      accountId: owner.accountId,
      byAccountId: owner.accountId,
      synced: false,
    });
    expect(await (await m.client(owner)).request('passkey.remove', { id: laptopKey.id })).toMatchObject({
      t: 'error',
      code: 'not_found',
    });
  });
});

describe('remote help over a session: the step-up and the signed records (RH-S04, RH-S05, RH-S07)', () => {
  const key = new SoftwareAuthenticator();
  let fake: FakeSupport;
  const service = () =>
    new RemoteHelpService(m.t.services, fake, {
      passkeys: m.runtime.trust.passkeys,
      push: m.runtime.trust.push,
      waitS: 0,
    });
  const choice = { level: 'fix', duration: 'hour' } as const;
  let dm = '';

  beforeAll(async () => {
    fake = new FakeSupport(() => m.t.services.clock().getTime(), { visitAfterMs: null });
    m.runtime.dispatcher.remoteHelp = service();
    const laptop = await m.client(owner);
    await laptop.request('passkeys.policy', { deviceBoundOnly: false });
    expect((await register(laptop, key)).answer).toMatchObject({ t: 'result' });
    dm = (await addPersonalAgent(m.t.services, TEST_BURROW_ID, IDS.mara, { services: null })).dmId;
  });

  afterAll(() => {
    m.runtime.dispatcher.remoteHelp = undefined;
  });

  it('turns on only with the person’s own passkey for exactly the choice begun on this device, once', async () => {
    const laptop = await m.client(owner);
    const sign = (challenge: string, k = key) => k.get({ rpId: RP_ID, origin: TEST_APP_URL, challenge });
    const refusal = (a: unknown) => (a as Answer).details?.code;
    expect(refusal(await laptop.request('remoteHelp.start', choice))).toBe('passkey_required');

    // Signed for another level than the begin's: the Whombat's own check refuses it.
    type Begun = {
      nonce: string;
      options: { challenge: string; rpId: string; allowCredentials: { id: string }[] };
    };
    let begun = output<Begun>(await laptop.request('remoteHelp.confirmBegin', choice));
    expect(begun.options).toMatchObject({ rpId: RP_ID, userVerification: 'required' });
    expect(begun.options.allowCredentials.map((c) => c.id)).toContain(key.id);
    const other = passkeyRemoteHelpChallengeBase64url({
      nonce: begun.nonce,
      endpoint: owner.peerId,
      level: 'look',
      duration: 'hour',
    });
    expect(refusal(await laptop.request('remoteHelp.start', { ...choice, passkey: sign(other) }))).toBe(
      'passkey_failed',
    );

    // Begun on another device of hers: that session has no begin (and the challenge names the laptop).
    begun = output<Begun>(await laptop.request('remoteHelp.confirmBegin', choice));
    const phone = await m.client(await m.enroll(IDS.mara));
    expect(
      refusal(await phone.request('remoteHelp.start', { ...choice, passkey: sign(begun.options.challenge) })),
    ).toBe('passkey_failed');

    // Hers, for this choice, on this device: on; the counter and the last use kept. Again is refused.
    begun = output<Begun>(await laptop.request('remoteHelp.confirmBegin', choice));
    const good = sign(begun.options.challenge);
    expect(await laptop.request('remoteHelp.start', { ...choice, passkey: good })).toMatchObject({
      t: 'result',
      output: { grant: { level: 'fix', grantedBy: { accountId: owner.accountId } } },
    });
    const [row] = await m.t.services.db
      .select()
      .from(appliancePasskeys)
      .where(eq(appliancePasskeys.id, key.id));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
    await laptop.request('remoteHelp.confirmBegin', choice);
    expect(refusal(await laptop.request('remoteHelp.start', { ...choice, passkey: good }))).toBe(
      'passkey_failed',
    );

    // The answer holds no help code here (a test Whombat), and the receipt keeps no answer at all (`secret`).
    expect(output(await laptop.request('remoteHelp.get', {}))).toMatchObject({ grant: { helpCode: null } });
    expect(await laptop.request('remoteHelp.stop', {})).toMatchObject({
      t: 'result',
      output: { grant: null },
    });
  });

  it('gives a visit’s command line through an export stream, cleaned', async () => {
    const laptop = await m.client(owner);
    const visits = output<{ visits: { id: string; transcriptBytes: number }[] }>(
      await laptop.request('remoteHelp.visits', {}),
    ).visits;
    const withLine = visits.find((v) => v.transcriptBytes > 0)?.id ?? '';
    expect(withLine).not.toBe('');
    const s = await laptop.open({
      kind: 'export',
      op: 'remoteHelp.transcript',
      input: { visitId: withLine },
    });
    expect(s.answer).toMatchObject({
      t: 'opened',
      meta: { kind: 'export', contentType: 'text/plain; charset=utf-8' },
    });
    const text = new TextDecoder().decode((await laptop.readStream(s.stream)).bytes);
    expect(text).toContain('systemctl restart whombat-voice');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: what must not be there.
    expect(text).not.toMatch(/[\u001b\r]/);
  });

  it('signs each event once with its cursor, tells the person in their Chat, and repeats nothing after a restart', async () => {
    const help = service();
    // What the step-up's test did first (Mara on, then off): recorded now.
    expect(await help.followOnce(0)).toBe(2);
    const before = (await events('remote_help.on')).length;
    const pushesBefore = m.manager.pushes.length;
    await fake.grant({
      level: 'look',
      duration: 'hour',
      grantedBy: { accountId: owner.accountId, name: 'Mara' },
    });
    fake.startVisit('Claude (opr_dev via john)');
    expect(await help.followOnce(0)).toBe(2);
    const on = (await events('remote_help.on')).slice(before);
    expect(on.map((e) => [e.payload, e.actorAccountId])).toEqual([
      [{ level: 'look', duration: 'hour' }, owner.accountId],
    ]);
    const said = async () =>
      (
        await m.t.services.db
          .select({ text: messages.text })
          .from(messages)
          .where(eq(messages.conversationId, dm))
          .orderBy(asc(messages.createdAt))
      ).map((r) => r.text);
    const told = (await said()).filter((t) => t.includes('Whombat support') || t.includes('remote help'));
    // Mara hears that Claude is looking now (not “Claude (opr_dev …)”).
    expect(told.some((t) => t.startsWith('Claude is looking at this Whombat now'))).toBe(true);
    // Her phone hears it as the assistant's message, not as a second, wordless security push.
    await m.t.services.background.settle();
    const kinds = m.manager.pushes.slice(pushesBefore).map((p) => p.kind);
    expect(kinds).toContain('message');
    expect(kinds).not.toContain('security');

    // A restarted runtime: the cursor is where the chain is; nothing is told again.
    await fake.stop({ reason: 'desk' });
    const count = (await said()).length;
    const restarted = service();
    expect(await restarted.followOnce(0)).toBe(2);
    expect(await restarted.followOnce(0)).toBe(0);
    expect((await said()).length).toBe(count);
    expect((await events('remote_help.visit')).at(-1)?.payload).toMatchObject({
      who: 'Claude',
      level: 'look',
    });
    expect((await events('remote_help.off')).at(-1)?.payload).toEqual({ reason: 'desk' });
    const [state] = await m.t.services.db.select().from(applianceState);
    expect(state?.remoteHelpSeq).toBe((await fake.events(0, 0)).next);
    expect(await verifyApplianceChain(m.t.services.db, m.t.services.custody)).toMatchObject({ ok: true });
  });

  it('says a visit by the same one again only after 12 hours, and the phone stays quiet in between', async () => {
    const help = service();
    await help.followOnce(0);
    const visits = async () =>
      (
        await m.t.services.db
          .select({ text: messages.text })
          .from(messages)
          .where(eq(messages.conversationId, dm))
      )
        .map((r) => r.text)
        .filter((t) => t.includes('is looking at this Whombat now'));
    const before = await visits();
    expect(before.filter((t) => t.startsWith('Claude '))).toHaveLength(1);
    const pushes = m.manager.pushes.length;
    await fake.grant({
      level: 'look',
      duration: 'hour',
      grantedBy: { accountId: owner.accountId, name: 'Mara' },
    });
    fake.startVisit('Claude (opr_dev via john)');
    await help.followOnce(0);
    await m.t.services.background.settle();
    // Claude was announced a moment ago: the Chat stays quiet, and so does the phone.
    expect(await visits()).toEqual(before);
    expect(m.manager.pushes.slice(pushes).map((p) => p.kind)).not.toContain('security');
    // Someone else is announced.
    fake.startVisit('Priya (opr_dev via john)');
    await help.followOnce(0);
    expect((await visits()).filter((t) => t.startsWith('Priya '))).toHaveLength(1);
    // Half a day later the same words are said again.
    const later = new Date(m.t.services.clock().getTime() + REMOTE_HELP_VISIT_QUIET_MS + 60_000);
    const text = before.find((t) => t.startsWith('Claude ')) ?? '';
    const options = { unlessSaidWithinMs: REMOTE_HELP_VISIT_QUIET_MS };
    expect(await tellPerson(m.t.services, TEST_BURROW_ID, IDS.mara, text, options)).toBe(true);
    expect((await visits()).filter((t) => t.startsWith('Claude '))).toHaveLength(1);
    const tomorrow = { ...m.t.services, clock: () => later };
    expect(await tellPerson(tomorrow, TEST_BURROW_ID, IDS.mara, text, options)).toBe(true);
    expect((await visits()).filter((t) => t.startsWith('Claude '))).toHaveLength(2);
    await fake.stop({ reason: 'desk' });
    await help.followOnce(0);
  });
});
