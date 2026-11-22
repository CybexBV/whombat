/**
 * The own address on a box that started with it (own-address.md, A3): the flag decided once at the first start and
 * kept in the database, the certificate recorded before it is served, the claim only on a page the box served (the claim
 * link at its own address, the letters there or on its local network; never the relay or control, no claim report),
 * code pairing off, box passkeys made and used with their own RP (origins, the binding to the new device's key, the
 * session's nonce, never a hosted passkey), the set declared to control, linking by code through the manager, the
 * owner's switch and what the certificate watch calls foreign. Postgres holds the flag, the claim, the passkeys, the
 * certificates and the declared set.
 */
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOwnAddressLabel } from '@whombat/core/own-address';
import { localClaimPakeInitiator } from '@whombat/protocol/claim';
import { PASSKEY_ANDROID_ORIGINS, passkeyEnrollChallengeBase64url } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { appliancePasskeys, applianceState, ownAddressCerts } from '../db/schema/index';
import { useManagedRuntime } from '../test/managed';
import { SoftwareAuthenticator } from '../test/webauthn';
import type { SessionTransport } from './direct/transport';
import { LABEL_DRAWS_MAX, OwnAddressService, spkiSha256 } from './own-address/state';
import { ManagerCallError } from './ports';
import {
  FakeManager,
  pakeLocalClaim,
  type TestIdentity,
  type TestSessionClient,
  testIdentity,
} from './testing';

const LABEL = 'maple-otter-river';
const HOST = `${LABEL}.dev.whombat.app`;
const ORIGIN = `https://${HOST}`;
const pem = readFileSync(
  join(import.meta.dirname, 'own-address', '__fixtures__', 'own-address-pair.pem'),
  'utf8',
);
const certPem = pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----'));
const keyPem = pem.slice(0, pem.indexOf('-----BEGIN CERTIFICATE-----'));
const x509 = new X509Certificate(certPem);
const META = {
  serial: x509.serialNumber.toLowerCase(),
  spkiSha256: spkiSha256(certPem),
  notBefore: new Date(x509.validFrom).toISOString(),
  notAfter: new Date(x509.validTo).toISOString(),
};
const OTHER_KEY = 'ab'.repeat(32);
const ORDERED_KEY = 'cd'.repeat(32);

const DOOR: SessionTransport = {
  via: 'direct',
  network: 'door',
  tls: true,
  page: { origin: ORIGIN, secureContext: true },
};
const LAN: SessionTransport = {
  via: 'direct',
  network: 'lan',
  tls: false,
  page: { origin: 'http://10.100.0.5:4480', secureContext: false },
};

const m = useManagedRuntime({
  sessions: { maxUnenrolled: 64, maxUnenrolledDirect: 64, maxUnenrolledDoor: 64, unenrolledDoorPerPeer: 64 },
});
m.manager.ownAddress = {
  v: 1,
  enabled: true,
  label: LABEL,
  host: HOST,
  acme: { state: 'valid' },
  cert: META,
};
m.manager.ownAddressPair = { v: 1, host: HOST, certPem, keyPem, ...META };
const ct = (certs: { spkiSha256: string; dnsNames: string[] }[], ordered = [] as (typeof META)[]) => ({
  v: 1 as const,
  source: 'certspotter' as const,
  checkingSince: '2026-11-01T00:00:00Z',
  lastFreshAt: new Date().toISOString(),
  missed: [{ from: '2026-11-10T00:00:00Z', to: '2026-11-11T06:00:00Z' }],
  certs: certs.map((c, i) => ({
    id: String(1000 + i),
    issuer: "C=US, O=Let's Encrypt, CN=R11",
    notBefore: '2026-11-15T00:00:00Z',
    notAfter: '2099-01-01T00:00:00Z',
    ...c,
  })),
  ordered,
});
m.manager.ownAddressWatch = ct([{ spkiSha256: META.spkiSha256, dnsNames: [HOST] }]);

type Answer = { t: string; code?: string; output?: Record<string, unknown>; details?: { code?: string } };
const out = <T = Record<string, unknown>>(r: unknown) => (r as { output: T }).output;
const codeOf = (r: unknown) => (r as Answer).details?.code;
const own = () => {
  const service = m.runtime.ownAddress;
  if (!service) throw new Error('no own address');
  return service;
};
const letters = () => {
  const code = m.runtime.trust.ceremony.codePassword(m.t.services.clock());
  if (!code) throw new Error('no letters on the console');
  return code.password;
};

/** The claim with the letters on the screen, on a claim id this session started. */
async function localClaim(client: TestSessionClient, claimId: string) {
  const done = await pakeLocalClaim(client, {
    password: letters(),
    appliancePeerId: m.appliance.peerId,
    claimId,
  });
  return done.claim ?? done.prove ?? done.begin;
}

let owner: TestSessionClient;
let ownerId: TestIdentity;

beforeAll(async () => {
  await own().readCt();
});

describe('the A3 flag', () => {
  it('is set at the first start from the manager’s answer, and never changes after', async () => {
    expect(own().sharedRouteOff).toBe(true);
    const [row] = await m.t.services.db.select().from(applianceState).where(eq(applianceState.id, 1));
    expect(row?.sharedRouteOff).toBe(true);
    const was = m.manager.ownAddress;
    m.manager.ownAddress = null;
    await own().poll();
    expect(own().sharedRouteOff).toBe(true);
    m.manager.ownAddress = was;
    await own().poll();
  });

  it('serves the certificate only after recording it, and takes web and acme from the door', async () => {
    const rows = await m.t.services.db.select().from(ownAddressCerts);
    expect(rows.map((r) => r.spkiSha256)).toContain(META.spkiSha256);
    expect(own().summary()).toMatchObject({ host: HOST, url: `${ORIGIN}/`, state: 'ready', reachable: true });
    expect(own().accepts()).toEqual(['web', 'acme']);
  });
});

describe('claiming a box inside A3', () => {
  it('is refused through the relay and through control', async () => {
    const relay = await m.client();
    expect(codeOf(await relay.request('enroll.claim.local.start', {}))).toBe('claim_here_unavailable');
    expect(
      codeOf(
        await relay.request('enroll.claim.begin', {
          claimId: 'clm_00000000000000000000',
          method: 'code',
          share: 'A'.repeat(43),
        }),
      ),
    ).toBe('claim_here_unavailable');
  });

  it('needs the claim link at its own address, and a wrong one costs no claim backoff', async () => {
    const door = await m.client(undefined, { transport: DOOR });
    expect(codeOf(await door.request('enroll.claim.local.start', {}))).toBe('claim_link');
    expect(codeOf(await door.request('enroll.claim.local.start', { link: 'aaaaaa' }))).toBe('claim_link');
    expect(await m.runtime.trust.claimBackoff(m.t.services.clock())).toBeNull();
  });

  it('starts on its local network with the letters only', async () => {
    const lan = await m.client(undefined, { transport: LAN });
    expect((await lan.request('enroll.claim.local.start', {})) as Answer).toMatchObject({ t: 'result' });
  });

  it('points at its Tailscale name while it waits for its address, not at the local network', async () => {
    const lan = {
      way: 'lan' as const,
      socket: 'ws://10.100.0.5:4480/v1/direct',
      web: 'http://10.100.0.5:4480/',
    };
    const tailnet = {
      way: 'tailscale' as const,
      socket: 'wss://home.tail1234.ts.net:4480/v1/direct',
      web: 'https://home.tail1234.ts.net:4480/',
    };
    const ways = m.runtime.trust.ways;
    const was = m.manager.ownAddress;
    try {
      // The address isn't serving yet: no claim link to show.
      m.manager.ownAddress = null;
      await own().poll();
      expect(own().claimUrl()).toBeNull();
      m.runtime.trust.ways = () => [lan, tailnet];
      expect(m.runtime.trust.ceremony.consoleState()?.url).toBe(tailnet.web);
      // Without a secure way the local network's address is what there is.
      m.runtime.trust.ways = () => [lan];
      expect(m.runtime.trust.ceremony.consoleState()?.url).toBe(lan.web);
    } finally {
      m.runtime.trust.ways = ways;
      m.manager.ownAddress = was;
      await own().poll();
    }
    expect(m.runtime.trust.ceremony.consoleState()?.url).toBe(`${ORIGIN}/c/${own().claimLink.current}`);
  });

  it('names a second way in under its claim link: the Tailscale page, else the local network’s address', async () => {
    const lan = {
      way: 'lan' as const,
      socket: 'ws://10.100.0.5:4480/v1/direct',
      web: 'http://10.100.0.5:4480/',
    };
    const tailnet = {
      way: 'tailscale' as const,
      socket: 'wss://home.tail1234.ts.net:4480/v1/direct',
      web: 'https://home.tail1234.ts.net:4480/',
    };
    const shown = () => m.runtime.trust.ceremony.consoleState();
    const ways = m.runtime.trust.ways;
    try {
      m.runtime.trust.ways = () => [lan, tailnet];
      expect(shown()).toMatchObject({
        state: 'claimable',
        url: `${ORIGIN}/c/${own().claimLink.current}`,
        fallbackUrl: tailnet.web,
      });
      m.runtime.trust.ways = () => [lan];
      expect(shown()?.fallbackUrl).toBe(lan.web);
      // No other way, or no claim link on the screen (the owner switched the address off): nothing to add.
      m.runtime.trust.ways = () => [];
      expect(shown()?.fallbackUrl).toBeUndefined();
      m.runtime.trust.ways = () => [lan];
      await own().setReach(false);
      expect(shown()).toMatchObject({ url: lan.web });
      expect(shown()?.fallbackUrl).toBeUndefined();
    } finally {
      m.runtime.trust.ways = ways;
      await own().setReach(true);
    }
  });

  it('keeps a start on the session that asked: one from the local network never opens the door’s', async () => {
    // The same device, twice: on the local network (the letters are enough there) and at the own address.
    const me = testIdentity();
    const lan = await m.client(me, { transport: LAN });
    const door = await m.client(me, { transport: DOOR });
    const { claimId } = out<{ claimId: string }>(await lan.request('enroll.claim.local.start', {}));
    const { share } = localClaimPakeInitiator(
      { password: letters(), appliancePeerId: m.appliance.peerId, clientPeerId: me.peerId, claimId },
      (n) => new Uint8Array(randomBytes(n)),
    );
    expect(codeOf(await door.request('enroll.claim.local.begin', { claimId, share }))).toBe(
      'claim_start_missing',
    );
    // The door's own start carried the link; a link that changed since is asked for again when the exchange begins.
    const started = out<{ claimId: string }>(
      await door.request('enroll.claim.local.start', { link: own().claimLink.current }),
    );
    own().claimLink.rotate();
    const again = localClaimPakeInitiator(
      {
        password: letters(),
        appliancePeerId: m.appliance.peerId,
        clientPeerId: me.peerId,
        claimId: started.claimId,
      },
      (n) => new Uint8Array(randomBytes(n)),
    );
    expect(
      codeOf(
        await door.request('enroll.claim.local.begin', { claimId: started.claimId, share: again.share }),
      ),
    ).toBe('claim_link');
    expect(await m.runtime.trust.claimBackoff(m.t.services.clock())).toBeNull();
  });

  it('shows the claim link on its screen, claims at the address, reports nothing and changes the link', async () => {
    const url = m.runtime.trust.ceremony.consoleState()?.url;
    expect(url).toBe(`${ORIGIN}/c/${own().claimLink.current}`);
    const link = own().claimLink.current;
    // The manager has the link for control, which opens the claim for the account that linked this box.
    await m.runtime.claimHandover?.sync();
    expect(m.manager.linkClaims.at(-1)).toBe(link);
    ownerId = testIdentity();
    owner = await m.client(ownerId, { transport: DOOR });
    const start = await owner.request('enroll.claim.local.start', { link });
    const claimed = await localClaim(owner, out<{ claimId: string }>(start).claimId);
    expect(claimed as Answer).toMatchObject({ t: 'result' });
    expect(own().claimLink.current).not.toBe(link);
    // Claimed: the manager is told there is no claim link any more.
    await m.runtime.claimHandover?.sync();
    expect(m.manager.linkClaims.at(-1)).toBeNull();
    await m.runtime.trust.reportPending();
    expect(m.manager.claimed).toEqual([]);
    // Claimed, the screen shows the address itself, never a claim link.
    expect(m.runtime.trust.ceremony.consoleState()?.url).toBe(`${ORIGIN}/`);
    // The enrolled session reads as the person's now.
    owner.close();
    owner = await m.client(ownerId, { transport: DOOR });
  });

  it('makes device links on its own address, with `o=`', async () => {
    const made = out<{ link: string }>(await owner.request('enroll.link.create', {}));
    expect(made.link.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(made.link).toContain(`o=${ORIGIN}/`);
  });

  it('turns code pairing off', async () => {
    const fresh = await m.client(undefined, { transport: LAN });
    expect(
      codeOf(await fresh.request('enroll.pair.request', { endpoint: { label: 'Phone', platform: 'web' } })),
    ).toBe('pairing_off');
  });
});

describe('box passkeys', () => {
  const auth = new SoftwareAuthenticator();
  let credentialId = '';

  it('are made with the box’s own RP, the person’s user handle and the box’s nonce', async () => {
    const begin = out<{
      nonce: string;
      rpId: string;
      user: { id: string; name: string; displayName: string };
      challenge: string;
    }>(await owner.request('boxPasskey.register.begin', {}));
    expect(begin.rpId).toBe(HOST);
    expect(Buffer.from(begin.user.id, 'base64url')).toHaveLength(32);
    expect(begin.user.displayName).toContain('· your Whombat');
    const response = auth.create({
      rpId: HOST,
      origin: ORIGIN,
      challenge: begin.challenge,
      userId: begin.user.id,
    });
    const made = await owner.request('boxPasskey.register', { nonce: begin.nonce, response, name: 'Chrome' });
    expect(made as Answer).toMatchObject({ t: 'result', output: { rpId: HOST } });
    credentialId = response.id;
    const again = out<{ user: { id: string } }>(await owner.request('boxPasskey.register.begin', {}));
    expect(again.user.id).toBe(begin.user.id);
  });

  async function join(o: {
    origin?: string;
    bindTo?: string;
    nonceFrom?: TestSessionClient;
    transport?: SessionTransport;
  }) {
    const me = testIdentity();
    const client = await m.client(me, { transport: o.transport ?? DOOR });
    const begin = out<{ nonce: string; rpId: string }>(
      await (o.nonceFrom ?? client).request('boxPasskey.enroll.begin', {}),
    );
    const response = auth.get({
      rpId: begin.rpId,
      origin: o.origin ?? ORIGIN,
      challenge: passkeyEnrollChallengeBase64url({ nonce: begin.nonce, endpoint: o.bindTo ?? me.peerId }),
    });
    return client.request('boxPasskey.enroll', {
      nonce: begin.nonce,
      response,
      endpoint: { label: 'New laptop', platform: 'web' },
    });
  }

  it('let a new device in from the address, and from the Android app anywhere', async () => {
    expect((await join({})) as Answer).toMatchObject({ t: 'result' });
    expect((await join({ origin: PASSKEY_ANDROID_ORIGINS[0], transport: LAN })) as Answer).toMatchObject({
      t: 'result',
    });
  });

  it('refuse another origin, another device’s key, and another session’s nonce, all as passkey_invalid', async () => {
    expect(codeOf(await join({ origin: 'https://app.whombat.com' }))).toBe('passkey_invalid');
    expect(codeOf(await join({ bindTo: testIdentity().peerId }))).toBe('passkey_invalid');
    const other = await m.client(undefined, { transport: DOOR });
    expect(codeOf(await join({ nonceFrom: other }))).toBe('passkey_invalid');
  });

  it('never let a hosted passkey join here, nor a box passkey through the hosted ceremony', async () => {
    await m.t.services.db
      .update(appliancePasskeys)
      .set({ rpId: null })
      .where(eq(appliancePasskeys.id, credentialId));
    expect(codeOf(await join({}))).toBe('passkey_invalid');
    await m.t.services.db
      .update(appliancePasskeys)
      .set({ rpId: HOST })
      .where(eq(appliancePasskeys.id, credentialId));
    const me = testIdentity();
    const client = await m.client(me);
    const nonce = randomBytes(32).toString('hex');
    const response = auth.get({
      rpId: HOST,
      origin: ORIGIN,
      challenge: passkeyEnrollChallengeBase64url({ nonce, endpoint: me.peerId }),
    });
    expect(
      codeOf(
        await client.request('enroll.passkey', {
          nonce,
          response,
          endpoint: { label: 'x', platform: 'web' },
        }),
      ),
    ).toBe('passkey_invalid');
  });
});

describe('linking the box to an account', () => {
  it('names the account first, then links, and refuses what control refuses', async () => {
    m.manager.linkCodes.set('ABCD-EFGH', 'mara@example.com');
    expect(await owner.request('account.link.lookup', { code: 'ABCD-EFGH' })).toMatchObject({
      t: 'result',
      output: { email: 'mara@example.com' },
    });
    expect(codeOf(await owner.request('account.link.lookup', { code: 'XXXX-YYYY' }))).toBe(
      'link_code_invalid',
    );
    for (const code of [
      'link_other_account',
      'link_terms',
      'link_devices_allowed',
      'link_code_used',
    ] as const) {
      m.manager.linkRefusal = new ManagerCallError(
        '/v1/runtime/account/link',
        502,
        'control_refused',
        `control: ${code}`,
      );
      expect(codeOf(await owner.request('account.link', { code: 'ABCD-EFGH' }))).toBe(code);
    }
    m.manager.linkRefusal = new ManagerCallError('/v1/runtime/account/link', 0, 'unreachable', 'down');
    expect(codeOf(await owner.request('account.link', { code: 'ABCD-EFGH' }))).toBe('control_unreachable');
    m.manager.linkRefusal = null;
    expect(await owner.request('account.link', { code: 'ABCD-EFGH' })).toMatchObject({
      t: 'result',
      output: { email: 'mara@example.com' },
    });
  });

  it('declares the box passkeys to control once linked, and again until control takes a change', async () => {
    await m.runtime.trust.boxPasskeys.settled();
    const ids = await m.runtime.trust.boxPasskeys.declaredSet();
    expect(m.manager.declared.at(-1)).toEqual(ids);
    m.manager.declareFails = new ManagerCallError(
      '/v1/backup/kit-credentials',
      503,
      'control_unreachable',
      'x',
    );
    await m.t.services.db
      .update(appliancePasskeys)
      .set({ removedAt: new Date() })
      .where(eq(appliancePasskeys.rpId, HOST));
    expect(await m.runtime.trust.boxPasskeys.declare()).toBe('later');
    m.manager.declareFails = null;
    expect(await m.runtime.trust.boxPasskeys.declare()).toBe('done');
    expect(m.manager.declared.at(-1)).toEqual([]);
    expect(await m.runtime.trust.boxPasskeys.declare()).toBe('done');
    expect(m.manager.declared.at(-1)).toEqual([]);
  });
});

describe('the owner’s switch and the certificate watch', () => {
  it('turns browsers away and keeps the validations', async () => {
    expect((await owner.request('ownAddress.reach.set', { on: false })) as Answer).toMatchObject({
      t: 'result',
      output: { ownAddress: { reachable: false } },
    });
    expect(own().accepts()).toEqual(['acme']);
    await owner.request('ownAddress.reach.set', { on: true });
    expect(own().accepts()).toEqual(['web', 'acme']);
  });

  it('names the address only while browsers are let in there: Tailscale, then the local network, while it is off', async () => {
    const lan = {
      way: 'lan' as const,
      socket: 'ws://10.100.0.5:4480/v1/direct',
      web: 'http://10.100.0.5:4480/',
    };
    const tailnet = {
      way: 'tailscale' as const,
      socket: 'wss://home.tail1234.ts.net:4480/v1/direct',
      web: 'https://home.tail1234.ts.net:4480/',
    };
    const trust = m.runtime.trust;
    const ways = trust.ways;
    const shown = () => trust.ceremony.consoleState()?.url;
    try {
      trust.ways = () => [lan, tailnet];
      expect(shown()).toBe(`${ORIGIN}/`);
      await owner.request('ownAddress.reach.set', { on: false });
      // The certificate is still valid, but nothing answers at the address: the screen and the links name what does.
      expect(own().ready()).toBe(true);
      expect(shown()).toBe(tailnet.web);
      expect(trust.localLink('device', 'secret-of-a-device-link')).not.toContain(HOST);
      trust.ways = () => [lan];
      expect(shown()).toBe(lan.web);
      await owner.request('ownAddress.reach.set', { on: true });
      expect(shown()).toBe(`${ORIGIN}/`);
    } finally {
      trust.ways = ways;
      await owner.request('ownAddress.reach.set', { on: true });
    }
  });

  it('calls a certificate foreign only when its key is neither served nor ordered', async () => {
    m.manager.ownAddressWatch = ct(
      [
        { spkiSha256: META.spkiSha256, dnsNames: [HOST] },
        { spkiSha256: ORDERED_KEY, dnsNames: [HOST] },
        { spkiSha256: 'ef'.repeat(32), dnsNames: ['*.whombat.app'] },
        { spkiSha256: OTHER_KEY, dnsNames: [`www.${HOST}`, 'example.com'] },
      ],
      [{ ...META, serial: '0a1b', spkiSha256: ORDERED_KEY }],
    );
    await own().readCt();
    const status = out<{
      ownAddress: { watch: { foreign: { spkiSha256: string; names: string[] }[]; missed: unknown[] } };
    }>(await owner.request('ownAddress.status', {}));
    expect(status.ownAddress.watch.foreign.map((f) => f.spkiSha256)).toEqual([OTHER_KEY]);
    expect(status.ownAddress.watch.foreign[0]?.names).toEqual([`www.${HOST}`]);
    expect(status.ownAddress.watch.missed).toHaveLength(1);
    expect(m.runtime.trust.ceremony.consoleState()?.alert?.kind).toBe('own_address_foreign');
  });
});

describe('drawing the label', () => {
  const taken = () =>
    new ManagerCallError('/v1/own-address/register', 409, 'own_address.label_taken', 'taken');

  it('draws again when control says it was used, then registers', async () => {
    const manager = new FakeManager();
    manager.ownAddress = { v: 1, enabled: true, acme: { state: 'idle' } };
    manager.registerRefusals = [taken(), taken()];
    const service = new OwnAddressService({ services: m.t.services, manager, timers: false });
    await service.start();
    expect(manager.registered).toHaveLength(3);
    expect(new Set(manager.registered).size).toBe(3);
    for (const label of manager.registered) expect(isOwnAddressLabel(label)).toBe(true);
    expect(service.label()).toBe(manager.registered[2]);
    expect(service.accepts()).toEqual(['acme']);
  });

  it('stops after five used labels in a row and waits', async () => {
    const manager = new FakeManager();
    manager.ownAddress = { v: 1, enabled: true, acme: { state: 'idle' } };
    manager.registerRefusals = Array.from({ length: 6 }, taken);
    const service = new OwnAddressService({ services: m.t.services, manager, timers: false });
    await service.start();
    expect(manager.registered).toHaveLength(LABEL_DRAWS_MAX);
    await service.poll();
    expect(manager.registered).toHaveLength(LABEL_DRAWS_MAX);
    expect(service.accepts()).toEqual([]);
  });

  it('reads a manager without the routes as no own address', async () => {
    const service = new OwnAddressService({
      services: m.t.services,
      manager: new FakeManager(),
      timers: false,
    });
    await service.start();
    expect(service.summary()).toBeNull();
    expect(service.accepts()).toEqual([]);
  });
});
