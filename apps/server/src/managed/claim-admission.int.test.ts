/**
 * Who gets a place to set a box up (docs/decisions/own-address.md, whombat-link.md): devices nobody let in are admitted
 * apart by the way they came. Visitors at the box's own address, which anyone on the internet can find, never hold the
 * places of the local network and Tailscale; one visitor address holds at most half of the own address's; a visitor
 * whose hello shows the claim link from the box's screen gets a place kept for such visitors; and new letters asked for
 * at the box free the places that were held before the person came. The claim link itself stays as the screen shows
 * it whatever visitors try: wrong links are an address's own tries, and only new letters asked for at the box change
 * it. Postgres holds what admission reads: whether a key is one of the person's devices, whether the box is claimed,
 * and that it started with its own address only.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useManagedRuntime } from '../test/managed';
import type { SessionTransport } from './direct/transport';
import { CLAIM_LINK_TRIES_PER_PEER } from './own-address/claim-link';
import { spkiSha256 } from './own-address/state';
import {
  MAX_UNENROLLED_CLAIM_LINK_SESSIONS,
  MAX_UNENROLLED_DIRECT_SESSIONS,
  MAX_UNENROLLED_DOOR_SESSIONS,
  UNENROLLED_DOOR_PER_PEER,
} from './session/registry';
import { TestSessionClient, testIdentity } from './testing';

const LABEL = 'maple-otter-river';
const HOST = `${LABEL}.dev.whombat.app`;
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

const DOOR: SessionTransport = {
  via: 'direct',
  network: 'door',
  tls: true,
  page: { origin: `https://${HOST}`, secureContext: true },
};
const LAN: SessionTransport = {
  via: 'direct',
  network: 'lan',
  tls: false,
  page: null,
};

// A box that started with its own address only: claimed on the pages it serves, at the address with the claim link.
const m = useManagedRuntime();
m.manager.ownAddress = {
  v: 1,
  enabled: true,
  label: LABEL,
  host: HOST,
  acme: { state: 'valid' },
  cert: META,
};
m.manager.ownAddressPair = { v: 1, host: HOST, certPem, keyPem, ...META };

type Hello = { t: string; code?: string };
type Refusal = { t: string; details?: { code?: string } };
/** Why a request was refused (`details.code`), or null when it wasn't. */
const refusal = (answer: unknown) =>
  (answer as Refusal).t === 'error' ? ((answer as Refusal).details?.code ?? 'error') : null;
const LINK_LETTERS = 'abcdefghjkmnpqrtvwxy';
/** A wrong claim link in the link's own letters, a different one for each `i`, never the link on the screen. */
const wrongLink = (i: number) => {
  const end = `${LINK_LETTERS[Math.floor(i / 20) % 20]}${LINK_LETTERS[i % 20]}`;
  const link = `aaaa${end}`;
  return link === m.runtime.ownAddress?.claimLink.current ? `bbbb${end}` : link;
};
/** The link on the box's screen, as the console file names it. */
const linkOnScreen = () => m.runtime.trust.ceremony.consoleState()?.url;
const open: TestSessionClient[] = [];

/** A device nobody let in says hello: the answer is the welcome, or the refusal. */
async function arrive(
  transport: SessionTransport,
  options: { from?: string; claimLink?: string } = {},
): Promise<{ client: TestSessionClient; answer: Hello }> {
  const client = new TestSessionClient(m.runtime, testIdentity(), {
    transport,
    ...(options.from ? { doorPeer: options.from } : {}),
  });
  open.push(client);
  const answer = (await client.hello(options.claimLink ? { claimLink: options.claimLink } : {})) as Hello;
  return { client, answer };
}

async function leaveAll(): Promise<void> {
  for (const client of open.splice(0)) {
    client.close();
    await client.closed;
  }
}

const own = () => {
  const service = m.runtime.ownAddress;
  if (!service) throw new Error('no own address');
  return service;
};
const sessions = () => m.runtime.sessions;

beforeAll(async () => {
  await m.runtime.trust.refreshClaimConsole();
  expect(own().sharedRouteOff).toBe(true);
  expect(own().claimUrl()).not.toBeNull();
});

describe('places at the box’s own address', () => {
  it('are apart from the local network’s: visitors on the internet never take the person’s', async () => {
    // Two visitor addresses take every place the address has for devices nobody let in.
    for (const from of ['203.0.113.7', '203.0.113.8'])
      for (let i = 0; i < UNENROLLED_DOOR_PER_PEER; i++)
        expect((await arrive(DOOR, { from })).answer.t).toBe('welcome');
    expect(sessions().unenrolledDoorSize).toBe(MAX_UNENROLLED_DOOR_SESSIONS);
    expect((await arrive(DOOR, { from: '203.0.113.9' })).answer).toMatchObject({
      t: 'error',
      code: 'too_many',
    });
    // The person at home still gets in, on every place the local network has.
    for (let i = 0; i < MAX_UNENROLLED_DIRECT_SESSIONS; i++)
      expect((await arrive(LAN)).answer.t).toBe('welcome');
    expect(sessions().unenrolledDirectSize).toBe(MAX_UNENROLLED_DIRECT_SESSIONS);
    await leaveAll();
  });

  it('are shared: one visitor address holds no more than its part', async () => {
    for (let i = 0; i < UNENROLLED_DOOR_PER_PEER; i++)
      expect((await arrive(DOOR, { from: '203.0.113.7' })).answer.t).toBe('welcome');
    expect((await arrive(DOOR, { from: '203.0.113.7' })).answer).toMatchObject({
      t: 'error',
      code: 'too_many',
    });
    expect((await arrive(DOOR, { from: '203.0.113.8' })).answer.t).toBe('welcome');
    await leaveAll();
  });

  it('keep some for the visitor whose hello shows the claim link from the box’s screen', async () => {
    for (const from of ['203.0.113.7', '203.0.113.8'])
      for (let i = 0; i < UNENROLLED_DOOR_PER_PEER; i++)
        expect((await arrive(DOOR, { from })).answer.t).toBe('welcome');
    // A stranger without the link, or with a wrong one, finds the address full.
    expect((await arrive(DOOR, { from: '203.0.113.9' })).answer.t).toBe('error');
    expect((await arrive(DOOR, { from: '203.0.113.9', claimLink: 'aaaaaa' })).answer.t).toBe('error');
    // The person with the link gets in all the same, even from an address a stranger shares, and starts the claim.
    const link = own().claimLink.current;
    const person = await arrive(DOOR, { from: '203.0.113.7', claimLink: link });
    expect(person.answer.t).toBe('welcome');
    expect(sessions().unenrolledClaimLinkSize).toBe(1);
    expect(await person.client.request('enroll.claim.local.start', { link })).toMatchObject({ t: 'result' });
    // The kept places are few, and showing the link in the hello opens nothing by itself.
    for (let i = 1; i < MAX_UNENROLLED_CLAIM_LINK_SESSIONS; i++)
      expect((await arrive(DOOR, { from: '203.0.113.10', claimLink: link })).answer.t).toBe('welcome');
    expect((await arrive(DOOR, { from: '203.0.113.11', claimLink: link })).answer.t).toBe('error');
    const shown = await arrive(LAN, { claimLink: link });
    expect(shown.answer.t).toBe('welcome');
    expect(sessions().unenrolledClaimLinkSize).toBe(MAX_UNENROLLED_CLAIM_LINK_SESSIONS);
    await leaveAll();
  });
});

describe('the claim link on the box’s screen', () => {
  it('stays good whatever visitors try: wrong links never change it', async () => {
    const link = own().claimLink.current;
    const shown = linkOnScreen();
    expect(shown).toBe(`https://${HOST}/c/${link}`);
    // Strangers who found the address: wrong links in their hellos, and at the claim's start, with and without one.
    for (let i = 0; i < 12; i++) {
      const from = `203.0.113.${20 + i}`;
      const stranger = await arrive(DOOR, { from, claimLink: wrongLink(i) });
      expect(stranger.answer.t).toBe('welcome');
      for (let j = 0; j < 5; j++)
        expect(
          refusal(await stranger.client.request('enroll.claim.local.start', { link: wrongLink(i + j) })),
        ).toBe('claim_link');
      expect(refusal(await stranger.client.request('enroll.claim.local.start', {}))).toBe('claim_link');
      stranger.client.close();
      await stranger.client.closed;
    }
    // The link is the one the screen showed all along, and the person who read it there sets the box up.
    expect(own().claimLink.current).toBe(link);
    expect(linkOnScreen()).toBe(shown);
    const person = await arrive(DOOR, { from: '198.51.100.7', claimLink: link });
    expect(person.answer.t).toBe('welcome');
    expect(sessions().unenrolledClaimLinkSize).toBe(1);
    expect(refusal(await person.client.request('enroll.claim.local.start', { link }))).toBeNull();
    // None of it reached the claim's own wait.
    expect(await m.runtime.trust.claimBackoff(m.t.services.clock())).toBeNull();
    await leaveAll();
  });

  it('gives each visitor address tries of its own: one that used them is refused unread, the next is not', async () => {
    const link = own().claimLink.current;
    const from = '203.0.113.60';
    const stranger = await arrive(DOOR, { from });
    for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER; i++)
      expect(refusal(await stranger.client.request('enroll.claim.local.start', { link: wrongLink(i) }))).toBe(
        'claim_link',
      );
    // That address guessed its fill: even the right link is no longer read from it, in a start or in a hello.
    expect(refusal(await stranger.client.request('enroll.claim.local.start', { link }))).toBe('claim_link');
    const again = await arrive(DOOR, { from, claimLink: link });
    expect(again.answer.t).toBe('welcome');
    expect(sessions().unenrolledClaimLinkSize).toBe(0);
    // Someone else's address is untouched by it.
    const person = await arrive(DOOR, { from: '198.51.100.7', claimLink: link });
    expect(sessions().unenrolledClaimLinkSize).toBe(1);
    expect(refusal(await person.client.request('enroll.claim.local.start', { link }))).toBeNull();
    expect(own().claimLink.current).toBe(link);
    await leaveAll();
  });

  it('counts a page left open on an old link once, however often it connects again', async () => {
    const link = own().claimLink.current;
    const home = '198.51.100.9';
    for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER * 2; i++) {
      const stale = await arrive(DOOR, { from: home, claimLink: wrongLink(0) });
      expect(refusal(await stale.client.request('enroll.claim.local.start', { link: wrongLink(0) }))).toBe(
        'claim_link',
      );
      stale.client.close();
      await stale.client.closed;
    }
    const person = await arrive(DOOR, { from: home, claimLink: link });
    expect(refusal(await person.client.request('enroll.claim.local.start', { link }))).toBeNull();
    await leaveAll();
  });
});

describe('new letters asked for at the box', () => {
  it('free the places devices nobody let in were holding, so the person’s device gets one', async () => {
    const link = own().claimLink.current;
    const strangers = [];
    for (let i = 0; i < MAX_UNENROLLED_DIRECT_SESSIONS; i++) strangers.push(await arrive(LAN));
    const visitor = await arrive(DOOR, { from: '203.0.113.7' });
    const shown = await arrive(DOOR, { from: '203.0.113.8', claimLink: link });
    expect((await arrive(LAN)).answer).toMatchObject({ t: 'error', code: 'too_many' });

    expect(await m.runtime.trust.openClaimWindow()).not.toBeNull();
    // Each closes as the box's own doing, which never counts against a device's address.
    for (const held of [...strangers, visitor, shown]) expect(await held.client.closed).toBe('new_letters');
    expect(sessions().unenrolledDirectSize).toBe(0);
    expect(sessions().unenrolledDoorSize).toBe(0);
    expect(sessions().unenrolledClaimLinkSize).toBe(0);
    expect((await arrive(LAN)).answer.t).toBe('welcome');
    await leaveAll();
  });

  it('come with a new claim link, drawn on the same screen: the old one opens nothing any more', async () => {
    const old = own().claimLink.current;
    const home = '198.51.100.11';
    // An address that used its tries on the old link starts again with the new one.
    const guesser = await arrive(DOOR, { from: home });
    for (let i = 0; i < CLAIM_LINK_TRIES_PER_PEER; i++)
      await guesser.client.request('enroll.claim.local.start', { link: wrongLink(i) });
    expect(own().claimLink.spent(home)).toBe(true);

    expect(await m.runtime.trust.openClaimWindow()).not.toBeNull();
    const link = own().claimLink.current;
    expect(link).not.toBe(old);
    expect(linkOnScreen()).toBe(`https://${HOST}/c/${link}`);
    const stale = await arrive(DOOR, { from: '203.0.113.8', claimLink: old });
    expect(sessions().unenrolledClaimLinkSize).toBe(0);
    expect(refusal(await stale.client.request('enroll.claim.local.start', { link: old }))).toBe('claim_link');
    const person = await arrive(DOOR, { from: home, claimLink: link });
    expect(sessions().unenrolledClaimLinkSize).toBe(1);
    expect(refusal(await person.client.request('enroll.claim.local.start', { link }))).toBeNull();
    await leaveAll();
  });
});
