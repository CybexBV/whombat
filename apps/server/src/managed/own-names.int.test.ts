/**
 * Own names on a box (own-address.md): the move from `box.whombat.app` to `whombat.app` and a rename after it, with the
 * box answering at the current host and the one it is leaving; box passkeys per arrival host (new ones only at the
 * current host, sign-in at either), the rename through the manager with control's refusals, the passkeys of a host it
 * stopped answering at removed and the set declared again, older apps that can't read the new hosts, and Cloudflare's
 * certificates for `*.whombat.app`. Postgres holds the passkeys, their removal, the certificates and the declared set.
 */
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWN_ADDRESS_ZONE_CERTIFICATES } from '@whombat/protocol/own-address';
import { assistantAccessFor, passkeyEnrollChallengeBase64url } from '@whombat/protocol/session';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { appliancePasskeys, principals } from '../db/schema/index';
import { useManagedRuntime } from '../test/managed';
import { SoftwareAuthenticator } from '../test/webauthn';
import type { SessionTransport } from './direct/transport';
import { ownAddressItems } from './own-address/notices';
import { spkiSha256 } from './own-address/state';
import { ManagerCallError } from './ports';
import { pakeLocalClaim, type TestIdentity, type TestSessionClient, testIdentity } from './testing';

const LABEL = 'maple-otter-river';
/** Where the box was: the old zone. */
const OLD = `${LABEL}.box.whombat.app`;
/** Where it moved, same label. */
const MOVED = `${LABEL}.whombat.app`;
/** The name the owner chose after the move. */
const HOME = 'home.whombat.app';

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
/** The same key and certificate for every host: the runtime checks the pair's host and key, the browser isn't here. */
const pair = (host: string) => ({ v: 1 as const, host, certPem, keyPem, ...META });
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const door = (host: string): SessionTransport => ({
  via: 'direct',
  network: 'door',
  tls: true,
  page: { origin: `https://${host}`, secureContext: true },
  host,
});
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
  host: OLD,
  acme: { state: 'valid' },
  cert: META,
};
m.manager.ownAddressPair = pair(OLD);

type Answer = { t: string; output?: Record<string, unknown>; details?: { code?: string; host?: string } };
const out = <T = Record<string, unknown>>(r: unknown) => (r as { output: T }).output;
const codeOf = (r: unknown) => (r as Answer).details?.code;
const own = () => {
  const service = m.runtime.ownAddress;
  if (!service) throw new Error('no own address');
  return service;
};
const live = async (id: string) =>
  (
    await m.t.services.db
      .select({ id: appliancePasskeys.id })
      .from(appliancePasskeys)
      .where(and(eq(appliancePasskeys.id, id), isNull(appliancePasskeys.removedAt)))
  ).length === 1;

/** One credential per authenticator: one for each host's passkey. */
const authenticators = new Map<string, SoftwareAuthenticator>();
const authAt = (host: string) => {
  const found = authenticators.get(host) ?? new SoftwareAuthenticator();
  authenticators.set(host, found);
  return found;
};
let ownerId: TestIdentity;
let owner: TestSessionClient;
/** The passkeys made at the old host and at the moved one. */
let atOld = '';
let atMoved = '';

/** A box passkey made by the owner's session at `host`. */
async function register(host: string): Promise<string> {
  const session = await m.client(ownerId, { transport: door(host) });
  const begin = out<{ nonce: string; rpId: string; user: { id: string }; challenge: string }>(
    await session.request('boxPasskey.register.begin', {}),
  );
  expect(begin.rpId).toBe(host);
  const response = authAt(host).create({
    rpId: host,
    origin: `https://${host}`,
    challenge: begin.challenge,
    userId: begin.user.id,
  });
  expect(
    await session.request('boxPasskey.register', { nonce: begin.nonce, response, name: 'Firefox' }),
  ).toMatchObject({ t: 'result', output: { rpId: host } });
  session.close();
  return response.id;
}

/** A new device joining at `host` with a box passkey: the RP the box names there signs it. */
async function joinAt(host: string) {
  const me = testIdentity();
  const client = await m.client(me, { transport: door(host) });
  const raw = await client.request('boxPasskey.enroll.begin', {});
  if ((raw as Answer).t !== 'result') return { rpId: null, answer: raw as Answer };
  const begin = out<{ nonce: string; rpId: string }>(raw);
  const response = authAt(host).get({
    rpId: begin.rpId,
    origin: `https://${host}`,
    challenge: passkeyEnrollChallengeBase64url({ nonce: begin.nonce, endpoint: me.peerId }),
  });
  const answer = await client.request('boxPasskey.enroll', {
    nonce: begin.nonce,
    response,
    endpoint: { label: 'New laptop', platform: 'web' },
  });
  client.close();
  return { rpId: begin.rpId, answer: answer as Answer };
}

beforeAll(async () => {
  // Claimed on its local network with the letters on the screen.
  ownerId = testIdentity();
  const lan = await m.client(ownerId, { transport: LAN });
  const code = m.runtime.trust.ceremony.codePassword(m.t.services.clock());
  if (!code) throw new Error('no letters on the console');
  const { claimId } = out<{ claimId: string }>(await lan.request('enroll.claim.local.start', {}));
  const done = await pakeLocalClaim(lan, {
    password: code.password,
    appliancePeerId: m.appliance.peerId,
    claimId,
  });
  expect(done.claim).toMatchObject({ t: 'result' });
  lan.close();
  owner = await m.client(ownerId);
  atOld = await register(OLD);
});

describe('the move to whombat.app', () => {
  it('answers at both hosts: the old one at once, the new one once its certificate is served', async () => {
    m.manager.ownAddress = {
      v: 1,
      enabled: true,
      label: LABEL,
      host: MOVED,
      acme: { state: 'probing' },
      leaving: { label: LABEL, host: OLD, until: inDays(30) },
    };
    m.manager.ownAddressPair = null;
    await own().poll();
    expect(own().hosts()).toEqual([MOVED, OLD]);
    expect(own().webHosts()).toEqual([OLD]);
    // Browsers still get the page at the old host, so the box keeps taking `web`.
    expect(own().accepts()).toEqual(['web', 'acme']);
    expect(own().summary()).toMatchObject({ host: MOVED, state: 'starting', leaving: { host: OLD } });
    // The screen names only the current host, and only once it answers there.
    expect(m.runtime.trust.ceremony.consoleState()?.url).not.toContain(OLD);

    m.manager.ownAddress = { ...m.manager.ownAddress, acme: { state: 'valid' }, cert: META };
    m.manager.ownAddressPair = pair(MOVED);
    await own().poll();
    expect(own().webHosts()).toEqual([MOVED, OLD]);
    expect(own().contextFor(OLD)).not.toBeNull();
    expect(own().contextFor('cedar-fox-lake.whombat.app')).toBeNull();
    expect(m.runtime.trust.ceremony.consoleState()?.url).toBe(`https://${MOVED}/`);
    const made = out<{ link: string }>(await owner.request('enroll.link.create', {}));
    expect(made.link).toContain(`o=https://${MOVED}/`);
  });

  it('leaves the address out for an app before session minor 6, and names both to a newer one', async () => {
    const older = await m.client(ownerId, { minor: 5 });
    expect(out<{ ownAddress: unknown }>(await older.request('appliance.status', {})).ownAddress).toBeNull();
    expect(out<{ ownAddress: unknown }>(await older.request('ownAddress.status', {})).ownAddress).toBeNull();
    expect(out<{ ownAddress: unknown }>(await older.request('reach.get', {})).ownAddress).toBeNull();
    older.close();
    expect(out(await owner.request('ownAddress.status', {}))).toMatchObject({
      ownAddress: { host: MOVED, leaving: { host: OLD, url: `https://${OLD}/` } },
    });
  });
});

describe('box passkeys at two hosts', () => {
  it('are made only at the current host: the old one answers address_moved with the new host', async () => {
    const session = await m.client(ownerId, { transport: door(OLD) });
    const refused = (await session.request('boxPasskey.register.begin', {})) as Answer;
    expect(refused).toMatchObject({ details: { code: 'address_moved', host: MOVED } });
    session.close();
    // The apps (no own-address page) make them for the current host.
    expect(out<{ rpId: string }>(await owner.request('boxPasskey.register.begin', {})).rpId).toBe(MOVED);
    atMoved = await register(MOVED);
  });

  it('let a device in at the host they were made for, while it is served', async () => {
    const atOldHost = await joinAt(OLD);
    expect(atOldHost).toMatchObject({ rpId: OLD });
    expect(atOldHost.answer).toMatchObject({ t: 'result' });
    expect((await joinAt(MOVED)).answer).toMatchObject({ t: 'result' });
  });
});

describe('renaming', () => {
  it('checks a name at control, and answers the rules every box knows itself', async () => {
    expect(out(await owner.request('ownAddress.check', { label: 'home' }))).toEqual({
      label: 'home',
      verdict: 'free',
      host: HOME,
    });
    m.manager.checkVerdicts.set('cozy-den', 'taken');
    expect(out(await owner.request('ownAddress.check', { label: 'cozy-den' }))).toEqual({
      label: 'cozy-den',
      verdict: 'taken',
    });
    const asked = m.manager.checked.length;
    expect(out(await owner.request('ownAddress.check', { label: 'admin' }))).toMatchObject({
      verdict: 'reserved',
    });
    expect(out(await owner.request('ownAddress.check', { label: 'ab' }))).toMatchObject({
      verdict: 'invalid',
    });
    expect(m.manager.checked).toHaveLength(asked);
  });

  it('lets the assistant check a name for the person, and asks the person before a rename', async () => {
    expect(assistantAccessFor('ownAddress.check', { label: 'home' })).toBe('read');
    expect(assistantAccessFor('ownAddress.rename', { label: 'home' })).toBe('ask');
    const account = owner.connection.principal?.account;
    const [agent] = await m.t.services.db
      .select({ id: principals.id })
      .from(principals)
      .where(eq(principals.kind, 'agent'))
      .limit(1);
    if (!account) throw new Error('no account');
    expect(
      await m.runtime.dispatcher.runForAssistant(account, agent?.id ?? 'agt_test', 'ownAddress.check', {
        label: 'home',
      }),
    ).toMatchObject({ type: 'result', output: { verdict: 'free', host: HOME } });
  });

  it('carries control’s refusals as their codes, and changes nothing then', async () => {
    m.manager.renameRefusal = new ManagerCallError(
      '/v1/own-address/rename',
      409,
      'own_address.rename_limit',
      'x',
    );
    expect(codeOf(await owner.request('ownAddress.rename', { label: 'home' }))).toBe('rename_limit');
    m.manager.renameRefusal = new ManagerCallError(
      '/v1/own-address/rename',
      409,
      'own_address.label_taken',
      'x',
    );
    expect(codeOf(await owner.request('ownAddress.rename', { label: 'home' }))).toBe('label_taken');
    m.manager.renameRefusal = new ManagerCallError('/v1/own-address/rename', 503, 'control_unreachable', 'x');
    expect(codeOf(await owner.request('ownAddress.rename', { label: 'home' }))).toBe('control_unreachable');
    expect(codeOf(await owner.request('ownAddress.rename', { label: 'www' }))).toBe('label_reserved');
    expect(own().host()).toBe(MOVED);
  });

  it('renames through the manager: the address leaving keeps its date, the one in between stops at once', async () => {
    const answer = out<{ ownAddress: { host: string; leaving?: { host: string } } }>(
      await owner.request('ownAddress.rename', { label: 'home' }),
    );
    expect(m.manager.renamed.at(-1)).toBe('home');
    expect(answer.ownAddress).toMatchObject({ host: HOME, leaving: { host: OLD } });
    expect(own().hosts()).toEqual([HOME, OLD]);
    // The passkey made at the name in between goes with it; the one at the old host stays until its date.
    await vi.waitFor(async () => expect(await live(atMoved)).toBe(false));
    expect(await live(atOld)).toBe(true);
    expect((await joinAt(MOVED)).answer).toMatchObject({ details: { code: 'passkey_invalid' } });
  });
});

describe('certificates for whombat.app', () => {
  it('never calls Cloudflare’s two foreign, but any other one for the zone or for the old host', async () => {
    const [gts, le] = OWN_ADDRESS_ZONE_CERTIFICATES;
    const other = 'ab'.repeat(32);
    const atOldHost = 'cd'.repeat(32);
    const cert = (spkiSha256: string, dnsNames: string[], notAfter = '2099-01-01T00:00:00Z') => ({
      id: String(randomBytes(2).readUInt16BE()),
      spkiSha256,
      dnsNames,
      notBefore: '2026-11-18T00:00:00Z',
      notAfter,
      issuer: 'Some CA',
    });
    m.manager.ownAddressWatch = {
      v: 1,
      source: 'certspotter',
      checkingSince: '2026-11-01T00:00:00Z',
      lastFreshAt: new Date().toISOString(),
      missed: [],
      hosts: [HOME, OLD],
      certs: [
        cert(gts?.spkiSha256 ?? '', ['*.whombat.app', 'whombat.app'], gts?.notAfter),
        cert(le?.spkiSha256 ?? '', ['*.whombat.app', 'whombat.app'], le?.notAfter),
        cert(other, ['*.whombat.app']),
        cert(atOldHost, [OLD]),
      ],
      ordered: [],
    };
    await own().readCt();
    const foreign =
      own()
        .summary()
        ?.watch.foreign.map((f) => f.spkiSha256) ?? [];
    expect(foreign.sort()).toEqual([other, atOldHost].sort());
  });
});

describe('when the old host stops', () => {
  it('warns 3 days before while a device has passkeys only there', async () => {
    const until = own().leaving()?.until;
    if (!until) throw new Error('nothing leaving');
    const items = await ownAddressItems(
      own(),
      new Date(until.getTime() - 86_400_000),
      m.runtime.trust.boxPasskeys,
    );
    expect(items.map((i) => i.ref.id)).toEqual(
      expect.arrayContaining([`own_address.moved:${HOME}`, `own_address.leaving:${OLD}`]),
    );
  });

  it('stops answering there, removes its passkeys and declares the smaller set', async () => {
    const declared = await m.runtime.trust.boxPasskeys.declaredSet();
    expect(declared).toContain(atOld);
    const state = m.manager.ownAddress;
    if (!state?.leaving) throw new Error('nothing leaving');
    m.manager.ownAddress = {
      ...state,
      leaving: { ...state.leaving, until: new Date(Date.now() - 1000).toISOString() },
    };
    await own().poll();
    expect(own().hosts()).toEqual([HOME]);
    expect(own().contextFor(OLD)).toBeNull();
    await vi.waitFor(async () => expect(await live(atOld)).toBe(false));
    expect(await m.runtime.trust.boxPasskeys.declaredSet()).not.toContain(atOld);
    // A certificate found for the host it left is no opening any more.
    expect(
      own()
        .summary()
        ?.watch.foreign.map((f) => f.spkiSha256),
    ).toEqual(['ab'.repeat(32)]);
    expect(own().summary()?.leaving).toBeUndefined();
  });
});
