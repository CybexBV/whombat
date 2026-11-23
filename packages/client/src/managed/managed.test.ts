import { describe, expect, it } from 'vitest';
import { createFakeAppliance } from '../session/fake';
import { OperationError } from '../session/managed-ops';
import { createSecureSession } from '../session/secure';
import { claimErrorKey, parseClaimQr } from './claim';
import { APPLIANCE_TERMS_VERSION, ControlError, createHttpControl, type PushRegistration } from './control';
import { parseMagicLinkUrl, readVerifyFragment, signInErrorText } from './magic-link';
import {
  formatPairingCodeInput,
  letInAlready,
  pairingErrorKey,
  pairingFingerprint,
  platformName,
} from './pairing';
import {
  clearPush,
  ensurePushHandle,
  forgetAppliance,
  type PushStore,
  pushKindOf,
  pushTarget,
  resolvePushRef,
  type SavedPush,
  tellAppliance,
} from './push';
import { createRegistry, forgetEnrollments } from './registry';

function memoryPushStore(): PushStore & { value: SavedPush | null } {
  const s = {
    value: null as SavedPush | null,
    get: async () => s.value,
    set: async (v: SavedPush) => {
      s.value = v;
    },
    remove: async () => {
      s.value = null;
    },
  };
  return s;
}

describe('magic links opened in the app', () => {
  const ui = ['https://app.whombat.com', 'http://localhost:4830'];
  it('reads the hosted UI link and the app scheme, fragment only', () => {
    expect(
      parseMagicLinkUrl('https://app.whombat.com/auth/verify#token=abcDEF_123-x&next=%2Fappliances', ui),
    ).toEqual({ token: 'abcDEF_123-x', next: '/appliances' });
    expect(parseMagicLinkUrl('http://localhost:4830/auth/verify#token=t1', ui)).toEqual({
      token: 't1',
      next: '/',
    });
    expect(parseMagicLinkUrl('whombat://auth/verify#token=t2', ui)).toEqual({
      token: 't2',
      next: '/',
    });
  });
  it('refuses other hosts, other paths and query tokens', () => {
    expect(parseMagicLinkUrl('https://evil.example/auth/verify#token=t', ui)).toBeNull();
    expect(parseMagicLinkUrl('https://app.whombat.com/appliances#token=t', ui)).toBeNull();
    expect(parseMagicLinkUrl('https://app.whombat.com/auth/verify?token=t', ui)).toBeNull();
    expect(parseMagicLinkUrl('whombat://approvals/12', ui)).toBeNull();
    expect(readVerifyFragment({ pathname: '/auth/verify', hash: '#token=t&next=//evil' })?.next).toBe('/');
    // The contract's same-origin check (CT-48): encoded slashes and backslashes are refused too.
    for (const next of ['/%2fevil.example', '/\\evil', '/a\\b', 'https://evil', '/a b'])
      expect(
        readVerifyFragment({ pathname: '/auth/verify', hash: `#token=t&next=${encodeURIComponent(next)}` })
          ?.next,
      ).toBe('/');
    expect(
      readVerifyFragment({ pathname: '/auth/verify', hash: '#token=t&next=%2Fappliances%2Fdev_1%2Fpair' })
        ?.next,
    ).toBe('/appliances/dev_1/pair');
  });
});

describe('a sign-in link that couldn’t be sent', () => {
  it('words control’s refusals as refusals, not as “couldn’t reach”', () => {
    expect(signInErrorText(new ControlError('invalid_link', 'x'))).toBe(
      'That email address doesn’t look right. Check it and try again.',
    );
    expect(signInErrorText(new ControlError('rate_limited', 'x'))).toMatch(/^Too many sign-in links/);
    expect(signInErrorText(new ControlError('unavailable', 'x'))).toMatch(/^Couldn’t reach Whombat/);
    expect(signInErrorText(new TypeError('fetch failed'))).toMatch(/^Couldn’t reach Whombat/);
  });
});

describe('pairing a new device (CT-46)', () => {
  it('computes the fingerprint the contract’s vectors give', () => {
    expect(pairingFingerprint('12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH')).toBe('D473-2B05-9829');
    expect(pairingFingerprint('12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa')).toBe('7B18-10D0-9B60');
  });
  it('words the device and every refusal plainly', () => {
    expect(platformName('android')).toBe('Android phone');
    expect(platformName('web')).toBe('Browser');
    expect(formatPairingCodeInput('12a345678 9')).toBe('1234-5678');
    const e = (code: string) => new OperationError('enroll.pair.approve', 409, code, 'x');
    expect(pairingErrorKey(e('pairing_fingerprint_mismatch'))).toBe('fingerprintChanged');
    expect(pairingErrorKey(e('pairing_code_invalid'))).toBe('badCode');
    expect(pairingErrorKey(e('pairing_expired'))).toBe('expired');
    expect(pairingErrorKey(e('rate_limited'))).toBe('rateLimited');
    expect(pairingErrorKey(new Error('offline'))).toBe('failed');
  });
  it('opens without pairing when the box says this device is in already (a box restored from a backup)', () => {
    const open = (channel: 'app' | 'enroll', account: { id: string } | null) =>
      ({ status: 'open', info: { channel, account } }) as unknown as Parameters<typeof letInAlready>[0];
    expect(letInAlready(open('app', { id: 'acc_olive' }))).toEqual({ accountId: 'acc_olive' });
    expect(letInAlready(open('enroll', null))).toBeNull();
    expect(letInAlready({ status: 'connecting', attempt: 1 })).toBeNull();
  });
});

describe('a device set up again with a new key', () => {
  it('is enrolled nowhere: every known Whombat asks to let it in again', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    const registry = createRegistry('acc_1', storage);
    const base = { orgId: 'org_1', name: null, peerId: 'p', pinSource: 'claim' as const, kitPending: false };
    registry.put({ ...base, device: 'dev_1', enrolled: true });
    registry.put({ ...base, device: 'dev_2', enrolled: true });
    registry.setLastUsed('dev_1');
    forgetEnrollments(registry);
    expect(registry.list().map((a) => a.enrolled)).toEqual([false, false]);
    expect(registry.lastUsed()).toBe('dev_1');
  });
});

describe('claim card QR text', () => {
  it('parses the card and ignores its fingerprint (the claim PAKE authenticates the box, CC-02)', () => {
    const card = parseClaimQr(
      'WHOMBAT1:wb-8mv1-q7rt-4b62:QI4E7-IXQHK-B5R4O-OO2EF-4IO7L:abcdefghijklmnopqrstuvwxyz',
    );
    expect(card).toEqual({
      device: 'wb-8mv1-q7rt-4b62',
      secret: 'abcdefghijklmnopqrstuvwxyz',
    });
    expect(parseClaimQr('https://example.com')).toBeNull();
  });
});

describe('control over HTTPS', () => {
  it('keeps the bearer token in the injected store and sends it', async () => {
    let token: string | null = null;
    const tokens = {
      get: async () => token,
      set: async (t: string) => {
        token = t;
      },
      remove: async () => {
        token = null;
      },
    };
    const seen: { url: string; auth: string | null }[] = [];
    const control = createHttpControl('http://control.test/', {
      tokens,
      fetch: async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url, auth: headers.authorization ?? null });
        if (url.endsWith('/v1/auth/verify'))
          return new Response(
            JSON.stringify({
              token: 'x'.repeat(40),
              expiresAt: '2026-10-01T00:00:00Z',
              account: { accountId: 'acc_1', email: 'a@b.c', name: null },
              orgs: [],
            }),
          );
        if (url.endsWith('/v1/push/handles')) return new Response(JSON.stringify({ handle: 'h'.repeat(22) }));
        return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
      },
    });
    expect(await control.session()).toBeNull();
    await control.verifySignIn('tok_123');
    expect(token).toBe('x'.repeat(40));
    expect(
      await control.pushRegister({ platform: 'fcm', token: 'f'.repeat(20), appId: 'com.whombat.mobile' }),
    ).toEqual({
      handle: 'h'.repeat(22),
    });
    expect(seen.at(-1)?.auth).toBe(`Bearer ${'x'.repeat(40)}`);
    // An older control without `push.vapid`: browser push is simply not offered.
    expect(await control.pushVapidKey()).toBeNull();
  });

  it('asks for a newer app with no sign-in, even when signed in', async () => {
    const seen: (string | null)[] = [];
    const control = createHttpControl('http://control.test', {
      tokens: { get: () => 'x'.repeat(40), set: () => {}, remove: () => {} },
      fetch: async (_url, init) => {
        seen.push(((init?.headers ?? {}) as Record<string, string>).authorization ?? null);
        return new Response(JSON.stringify({ android: null }));
      },
    });
    expect(await control.androidDownload()).toBeNull();
    expect(seen).toEqual([null]);
  });

  it('asks for a sign-in link with a same-origin next only (CT-48)', async () => {
    const bodies: unknown[] = [];
    const control = createHttpControl('http://control.test', {
      tokens: { get: () => null, set: () => {}, remove: () => {} },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }));
      },
    });
    await control.requestSignInLink('a@b.c');
    await control.requestSignInLink('a@b.c', '/burrow-hq/c/billing-v2?x=1');
    await control.requestSignInLink('a@b.c', '//evil.example');
    await control.requestSignInLink('a@b.c', '/%2Fevil.example');
    // A held signup code goes along, normalised (BL-33); one that isn't a code is left out.
    await control.requestSignInLink('a@b.c', '/signup', 'ab12cd34');
    await control.requestSignInLink('a@b.c', '/signup', 'abc');
    expect(bodies).toEqual([
      { email: 'a@b.c', next: '/appliances' },
      { email: 'a@b.c', next: '/burrow-hq/c/billing-v2?x=1' },
      { email: 'a@b.c' },
      { email: 'a@b.c' },
      { email: 'a@b.c', next: '/signup', code: 'AB12-CD34' },
      { email: 'a@b.c', next: '/signup' },
    ]);
  });

  it('reads the reason control puts in details (a wrong claim card)', async () => {
    const control = createHttpControl('http://control.test', {
      tokens: { get: () => 't', set: () => {}, remove: () => {} },
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'forbidden',
              message: 'The claim card details don’t match this appliance.',
              details: { code: 'claim_proof_invalid' },
            },
          }),
          { status: 403 },
        ),
    });
    const error = await control
      .startClaim({
        orgId: 'org_1',
        method: 'card',
        device: 'wb-1',
        claimProof: 'x'.repeat(43),
        terms: { version: APPLIANCE_TERMS_VERSION },
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'claim_invalid' });
    expect(claimErrorKey(error)).toBe('claim_invalid');
  });

  it('lists nearby boxes and starts code claims; the claim-code refusals keep their reason (CC-04, CC-05)', async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const control = createHttpControl('http://control.test', {
      tokens: { get: () => 't', set: () => {}, remove: () => {} },
      fetch: async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        seen.push({ url, method: init?.method ?? 'GET', body });
        if (url.endsWith('/claims/nearby'))
          return reply(200, {
            devices: [{ device: 'wb-1', model: 'wb-mini-1', registeredAt: 1, lastSeenAt: 2, extra: true }],
          });
        if (body?.device === 'wb-far')
          return reply(403, { error: { code: 'forbidden', details: { code: 'device_not_nearby' } } });
        if (body?.device === 'wb-owned')
          return reply(409, { error: { code: 'claim_conflict', details: { code: 'already_claimed' } } });
        return reply(201, {
          claim: {
            claim: 'clm_1',
            device: 'wb-1',
            org: 'org_1',
            requestedBy: 'acc_1',
            state: 'pending',
            createdAt: 1,
            expiresAt: 2,
            method: 'code',
            contentPeerId: 'peer',
          },
          ticket: { ticket: 'tk', expiresAt: 3, relay: { worker: 'w', url: 'wss://r', reassignAfter: 1 } },
        });
      },
    });
    expect(await control.nearbyClaims('org_1')).toEqual([
      { device: 'wb-1', model: 'wb-mini-1', registeredAt: 1, lastSeenAt: 2 },
    ]);
    const terms = { version: APPLIANCE_TERMS_VERSION };
    const started = await control.startClaim({ orgId: 'org_1', method: 'code', device: 'wb-1', terms });
    expect(started.claim).toEqual({
      claim: 'clm_1',
      device: 'wb-1',
      method: 'code',
      contentPeerId: 'peer',
      expiresAt: 2,
    });
    expect(seen[1]).toMatchObject({
      url: 'http://control.test/v1/orgs/org_1/claims',
      method: 'POST',
      body: { method: 'code', device: 'wb-1', terms, class: 'interactive' },
    });
    const refused = (x: Parameters<typeof control.startClaim>[0]) =>
      control.startClaim(x).catch((e: unknown) => (e as ControlError).code);
    expect(await refused({ orgId: 'org_1', method: 'code', device: 'wb-far', terms })).toBe(
      'device_not_nearby',
    );
    expect(await refused({ orgId: 'org_1', method: 'code', device: 'wb-owned', terms })).toBe(
      'already_claimed',
    );
  });

  it('drops a token control no longer accepts', async () => {
    let token: string | null = 'stale';
    const tokens = {
      get: () => token,
      set: (t: string) => {
        token = t;
      },
      remove: () => {
        token = null;
      },
    };
    const control = createHttpControl('http://control.test', {
      tokens,
      fetch: async () => new Response('{}', { status: 401 }),
    });
    expect(await control.session()).toBeNull();
    expect(token).toBeNull();
    await expect(control.appliances('org_1')).rejects.toBeInstanceOf(ControlError);
  });
});

describe('push handles', () => {
  const fcm = (token: string): PushRegistration => ({ platform: 'fcm', token, appId: 'com.whombat.mobile' });

  it('registers once per address, re-registers a rotated token and forgets the old handle', async () => {
    const store = memoryPushStore();
    const registered: string[] = [];
    const forgotten: string[] = [];
    let n = 0;
    const control = {
      pushRegister: async (r: PushRegistration) => {
        registered.push(r.platform === 'webpush' ? r.subscription.endpoint : r.token);
        n += 1;
        return { handle: `handle_${String(n).padStart(20, '0')}` };
      },
      pushUnregister: async (h: string) => void forgotten.push(h),
    };
    const a = await ensurePushHandle(control, store, fcm('token-aaaaaaaaaaaaaaaa'));
    const again = await ensurePushHandle(control, store, fcm('token-aaaaaaaaaaaaaaaa'));
    expect(again.handle).toBe(a.handle);
    const b = await ensurePushHandle(control, store, fcm('token-bbbbbbbbbbbbbbbb'));
    expect(b.handle).not.toBe(a.handle);
    expect(registered).toEqual(['token-aaaaaaaaaaaaaaaa', 'token-bbbbbbbbbbbbbbbb']);
    expect(forgotten).toEqual([a.handle]);
  });

  it('tells the appliance over the session and clears everywhere on sign-out', async () => {
    const store = memoryPushStore();
    const ops: { op: string; input: unknown }[] = [];
    const appliance = createFakeAppliance({
      handle: async (op, input) => {
        ops.push({ op, input });
        return { status: 200, body: { ok: true } };
      },
    });
    const session = createSecureSession({ connector: appliance.connector });
    const forgotten: string[] = [];
    const control = {
      pushRegister: async () => ({ handle: 'h'.repeat(22) }),
      pushUnregister: async (h: string) => void forgotten.push(h),
    };
    const saved = await ensurePushHandle(control, store, fcm('token-cccccccccccccccc'));
    await tellAppliance(session, store, 'dev_1', saved);
    expect(ops).toEqual([{ op: 'push.handles.set', input: { handle: 'h'.repeat(22) } }]);
    expect(store.value?.appliances).toEqual(['dev_1']);
    await forgetAppliance(store, 'dev_1');
    expect(store.value?.appliances).toEqual([]);
    await clearPush(control, store, session);
    expect(ops.at(-1)?.op).toBe('push.handles.clear');
    expect(forgotten).toEqual(['h'.repeat(22)]);
    expect(store.value).toBeNull();
    session.close();
  });
});

describe('a tapped push is resolved by its ref (CT-49)', () => {
  const ref = 'r'.repeat(22);
  async function resolveWith(answer: { status: number; body: unknown }) {
    const seen: { op: string; input: unknown }[] = [];
    const appliance = createFakeAppliance({
      handle: async (op, input) => {
        seen.push({ op, input });
        return answer;
      },
    });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      return { open: await resolvePushRef(session, ref), seen };
    } finally {
      session.close();
    }
  }

  it('opens the link in its burrow', async () => {
    const { open, seen } = await resolveWith({
      status: 200,
      body: { burrow: 'burrow-hq', link: { type: 'approval', number: 12 } },
    });
    expect(seen).toEqual([{ op: 'push.resolve', input: { ref } }]);
    expect(open).toEqual({ to: 'link', burrow: 'burrow-hq', link: { type: 'approval', number: 12 } });
  });

  it('not found (gone or not visible): the inbox with a note', async () => {
    const { open } = await resolveWith({ status: 404, body: { error: { code: 'not_found' } } });
    expect(open).toEqual({ to: 'inbox', missing: true });
  });

  it('an appliance without push.resolve: resolve by kind', async () => {
    const { open } = await resolveWith({ status: 400, body: { error: { code: 'unknown_op' } } });
    expect(open).toEqual({ to: 'by_kind' });
  });

  it('any other failure: just the inbox', async () => {
    const { open } = await resolveWith({ status: 500, body: { error: { code: 'internal' } } });
    expect(open).toEqual({ to: 'inbox', missing: false });
  });
});

describe('a tapped generic push', () => {
  const item = (
    id: string,
    kind: 'needs_you' | 'mention' | 'agent_update',
    createdAt: string,
    extra: Partial<{ readAt: string | null; approvalId: string | null; link: { type: string } }> = {},
  ) => ({
    id,
    kind,
    createdAt,
    readAt: null,
    approvalId: null,
    link: { type: 'dm' },
    ...extra,
  });
  const items = [
    item('n1', 'needs_you', '2026-09-25T10:00:00Z', { approvalId: 'apr_1', link: { type: 'approval' } }),
    item('n2', 'needs_you', '2026-09-25T11:00:00Z', { approvalId: 'apr_2', readAt: '2026-09-25T11:01:00Z' }),
    item('n3', 'mention', '2026-09-25T09:00:00Z'),
    item('n4', 'agent_update', '2026-09-25T12:00:00Z', { link: { type: 'run' } }),
  ];

  it('opens the newest unread row of its kind, fetched through the session', () => {
    expect(pushTarget('approval', 'b', items)).toMatchObject({
      to: 'item',
      item: { id: 'n1', approvalId: 'apr_1' },
    });
    expect(pushTarget('mention', 'b', items)).toMatchObject({ to: 'item', item: { id: 'n3' } });
    expect(pushTarget('run', 'b', items)).toMatchObject({ to: 'item', item: { id: 'n4' } });
    expect(pushTarget('generic', 'b', items)).toMatchObject({ to: 'item', item: { id: 'n4' } });
  });

  it('falls back to the inbox, and the appliance for its own news', () => {
    expect(pushTarget('mention', 'b', [])).toEqual({ to: 'inbox' });
    expect(pushTarget('backup', 'b', items)).toEqual({ to: 'appliance' });
    expect(pushKindOf('nonsense')).toBe('generic');
    expect(pushKindOf('approval')).toBe('approval');
  });
});
