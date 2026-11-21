/**
 * Sign in at the box without a database (signin-at-box BX-02…BX-07, BX-S01…): a fake store and the real console file.
 * The happy path both ways with the contracts' initiator, wrong letters (counted, rotated, a new file), another key,
 * replaced and expired sign-ins, a begin from before a wrong guess, the backoff and its one push, the request limits,
 * no screen or no claim, and that the letters never reach a log.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleSignIn, type ConsoleState } from '@whombat/control-contracts/local';
import {
  CLAIM_FAILURE_WINDOW_S,
  claimConfirmEqual,
  screenSignInPakeInitiator,
  screenSignInPakeInitiatorFinish,
} from '@whombat/protocol/claim';
import { SCREEN_SIGNIN_REQUESTS_PER_KEY, SCREEN_SIGNIN_REQUESTS_TOTAL } from '@whombat/protocol/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../services';
import { ClaimCeremony, type SessionScope } from './claim';
import {
  type ScreenEndpoint,
  ScreenSignInService,
  type ScreenSignInStore,
  screenBackoff,
} from './screen-signin';
import type { Identity } from './trust';

const APPLIANCE = '12D3KooWappliance';
const DEVICE = 'dev-box-1';

class FakeStore implements ScreenSignInStore {
  deviceId: string | null = DEVICE;
  endpoints = new Map<string, { accountId: string; revoked: boolean; id: string }>();
  person: { id: string; name: string; email: string } | null = {
    id: 'acc_olive',
    name: 'Olive',
    email: 'olive@example.com',
  };
  failureRows: { peerId: string; at: Date }[] = [];
  enrolled: { peerId: string; accountId: string; endpoint: ScreenEndpoint }[] = [];
  pushes: { what: string }[] = [];

  async claimedDeviceId() {
    return this.deviceId;
  }
  async endpointState(peerId: string) {
    const known = this.endpoints.get(peerId);
    return known ? { accountId: known.accountId, revoked: known.revoked } : null;
  }
  async account() {
    return this.person;
  }
  async failures(now: Date) {
    const since = now.getTime() - CLAIM_FAILURE_WINDOW_S * 1000;
    const rows = this.failureRows.filter((r) => r.at.getTime() > since);
    const latest = rows.reduce<Date | null>((a, r) => (!a || r.at > a ? r.at : a), null);
    return { n: rows.length, latest };
  }
  async recordFailure(peerId: string, at: Date) {
    this.failureRows.push({ peerId, at });
  }
  async clearFailures() {
    this.failureRows = [];
  }
  async enroll(identity: Identity, accountId: string, endpoint: ScreenEndpoint) {
    const known = this.endpoints.get(identity.peerId);
    if (known && !known.revoked && known.accountId === accountId) return known.id;
    this.enrolled.push({ peerId: identity.peerId, accountId, endpoint });
    const id = `ep_${this.enrolled.length}`;
    this.endpoints.set(identity.peerId, { accountId, revoked: false, id });
    return id;
  }
  async enrolledOutput(endpointId: string) {
    return { endpoint: { endpointId } };
  }
  async notify(what: string) {
    this.pushes.push({ what });
  }
}

let dir: string;
let file: string;
let now: Date;
let store: FakeStore;
let ceremony: ClaimCeremony;
let screen: ScreenSignInService;
const log = { info: vi.fn(), warn: vi.fn() };

function services(): Services {
  return {
    config: {
      WHOMBAT_APP_URL: 'https://app.whombat.test',
      WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none',
    },
    clock: () => now,
    log: { ...log, error: vi.fn(), debug: vi.fn() },
  } as unknown as Services;
}

function build(options: { noFile?: boolean } = {}) {
  ceremony = new ClaimCeremony(services(), options.noFile ? undefined : file);
  ceremony.setStatus({ claimed: true, deviceReady: true, retryAt: null });
  screen = new ScreenSignInService(store, ceremony, { appliancePeerId: APPLIANCE, clock: () => now, log });
}

const read = (): ConsoleState => JSON.parse(readFileSync(file, 'utf8'));
const shown = () => ConsoleSignIn.parse(read().signIn).code;
const key = (name: string): Identity => ({ peerId: `12D3KooW${name}`, publicKey: `${name}-pub` });
const phone = key('phone');
const scope = (): SessionScope => ({ claimBegin: null });
const endpoint = { label: 'Pixel 9', platform: 'android' as const };
const later = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/** The device's side: request, the PAKE with `letters` (the screen's by default), then the tag. */
async function signIn(
  who: Identity = phone,
  options: {
    letters?: string;
    session?: SessionScope;
    signinId?: string;
    appliance?: string;
  } = {},
) {
  const signinId = options.signinId ?? (await screen.request(who, { endpoint })).signinId;
  const session = options.session ?? scope();
  const start = screenSignInPakeInitiator(
    {
      password: options.letters ?? shown(),
      deviceId: DEVICE,
      appliancePeerId: options.appliance ?? APPLIANCE,
      clientPeerId: who.peerId,
      signinId,
    },
    (n) => new Uint8Array(Array.from({ length: n }, () => Math.floor(Math.random() * 256))),
  );
  const begun = await screen.begin(who, session, { signinId, share: start.share });
  const tags = screenSignInPakeInitiatorFinish(start.state, begun.share);
  return {
    signinId,
    session,
    tags,
    confirm: () => screen.confirm(who, session, { signinId, confirm: tags.client }),
  };
}

const wrong = (letters: string) => (letters === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-screen-'));
  file = join(dir, 'console.json');
  now = new Date('2026-10-20T10:00:00Z');
  store = new FakeStore();
  log.info.mockClear();
  log.warn.mockClear();
  build();
});
afterEach(() => {
  ceremony.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('sign in at the box', () => {
  it('shows six letters for the device, and the right ones let it in to the person’s account', async () => {
    const { signinId, expiresAt, device } = await screen.request(phone, { endpoint });
    expect(signinId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // The box's own page has no directory: it learns the device id the exchange binds from this answer.
    expect(device).toBe(DEVICE);
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(300_000);
    expect(read()).toMatchObject({
      state: 'claimed',
      signIn: { name: 'Olive', device: 'Pixel 9', expiresAt, code: expect.stringMatching(/^[A-Z]{6}$/) },
    });
    const run = await signIn(phone, { signinId });
    const out = await run.confirm();
    // The box proves it knew the letters too: the device checks this before it pins anything.
    expect(claimConfirmEqual(run.tags.appliance, out.confirm)).toBe(true);
    expect(out).toMatchObject({ endpoint: { endpointId: 'ep_1' } });
    expect(store.enrolled).toEqual([{ peerId: phone.peerId, accountId: 'acc_olive', endpoint }]);
    // Off the screen, the counter clear, and the person told.
    expect(read().signIn).toBeUndefined();
    expect(store.pushes).toEqual([{ what: 'screen-enrolled:ep_1' }]);
    // Used once: the same sign-in is gone.
    await expect(run.confirm()).rejects.toMatchObject({ details: { code: 'screen_signin_missing' } });
  });

  it('one of the person’s devices that is in already signs in too: the box proves itself, nothing new is let in', async () => {
    // A box restored from a backup: the database knows the phone, the phone doesn't know this box yet.
    store.endpoints.set(phone.peerId, { accountId: 'acc_olive', revoked: false, id: 'ep_phone' });
    const run = await signIn(phone);
    const out = await run.confirm();
    expect(claimConfirmEqual(run.tags.appliance, out.confirm)).toBe(true);
    expect(out).toMatchObject({ endpoint: { endpointId: 'ep_phone' } });
    expect(store.enrolled).toEqual([]);
    expect(read().signIn).toBeUndefined();
  });

  it('a wrong code counts once, shows new letters at once, and keeps the sign-in open', async () => {
    const { signinId } = await screen.request(phone, { endpoint });
    const before = shown();
    const first = await signIn(phone, { signinId, letters: wrong(before) });
    await expect(first.confirm()).rejects.toMatchObject({
      code: 'forbidden',
      details: { code: 'screen_code_invalid' },
    });
    expect(store.failureRows).toHaveLength(1);
    expect(shown()).not.toBe(before);
    // The same sign-in, with the new letters, still works.
    const again = await signIn(phone, { signinId: first.signinId });
    await expect(again.confirm()).resolves.toMatchObject({ confirm: expect.any(String) });
  });

  it('a relay that swapped the box’s key gets screen_code_invalid even with the right letters', async () => {
    const relayed = await signIn(phone, { appliance: '12D3KooWrelay' });
    await expect(relayed.confirm()).rejects.toMatchObject({ details: { code: 'screen_code_invalid' } });
    expect(store.enrolled).toEqual([]);
  });

  it('only the requesting key may begin or confirm', async () => {
    const { signinId } = await screen.request(phone, { endpoint });
    const share = screenSignInPakeInitiator(
      {
        password: shown(),
        deviceId: DEVICE,
        appliancePeerId: APPLIANCE,
        clientPeerId: key('other').peerId,
        signinId,
      },
      (n) => new Uint8Array(n).fill(7),
    ).share;
    await expect(screen.begin(key('other'), scope(), { signinId, share })).rejects.toMatchObject({
      code: 'conflict',
      details: { code: 'screen_signin_missing' },
    });
    const run = await signIn(phone, { signinId });
    await expect(
      screen.confirm(key('other'), run.session, { signinId, confirm: run.tags.client }),
    ).rejects.toMatchObject({ details: { code: 'screen_signin_missing' } });
    expect(store.failureRows).toEqual([]);
  });

  it('a replaced or expired sign-in is missing, and the screen loses it when it runs out', async () => {
    vi.useFakeTimers({ now });
    const old = await signIn(phone);
    // Another request replaces it (new letters, new id).
    const { signinId } = await screen.request(key('tablet'), { endpoint });
    expect(signinId).not.toBe(old.signinId);
    await expect(old.confirm()).rejects.toMatchObject({ details: { code: 'screen_signin_missing' } });
    expect(read().signIn).toBeDefined();
    later(300_001);
    vi.advanceTimersByTime(300_100);
    expect(read()).toEqual({ v: 1, state: 'claimed', url: 'https://app.whombat.test/claim' });
    await expect(
      screen.begin(key('tablet'), scope(), { signinId, share: 'A'.repeat(43) }),
    ).rejects.toMatchObject({ details: { code: 'screen_signin_missing' } });
  });

  it('a begin from before a wrong guess, another session’s or an expired one can’t confirm', async () => {
    const early = await signIn(phone);
    // A wrong guess from another session of the same device rotates the letters.
    const bad = await signIn(phone, { signinId: early.signinId, letters: wrong(shown()) });
    await expect(bad.confirm()).rejects.toMatchObject({ details: { code: 'screen_code_invalid' } });
    await expect(early.confirm()).rejects.toMatchObject({
      code: 'conflict',
      details: { code: 'screen_begin_missing' },
    });
    // Another session, and a begin past its two minutes.
    const late = await signIn(phone, { signinId: early.signinId });
    await expect(
      screen.confirm(phone, scope(), { signinId: early.signinId, confirm: late.tags.client }),
    ).rejects.toMatchObject({ details: { code: 'screen_begin_missing' } });
    const stale = await signIn(phone, { signinId: early.signinId });
    later(120_001);
    await expect(stale.confirm()).rejects.toMatchObject({ details: { code: 'screen_begin_missing' } });
    expect(store.failureRows).toHaveLength(1);
  });

  it('after three free wrong codes the box backs off, says when, and tells the person once', async () => {
    const { signinId } = await screen.request(phone, { endpoint });
    const guess = async () => {
      const run = await signIn(phone, { signinId, letters: wrong(shown()) });
      await expect(run.confirm()).rejects.toMatchObject({ details: { code: 'screen_code_invalid' } });
    };
    for (let i = 0; i < 3; i++) await guess();
    expect(store.pushes).toEqual([]);
    await guess();
    expect(store.pushes).toEqual([{ what: expect.stringMatching(/^screen-backoff:/) }]);
    const refused = screen.begin(phone, scope(), { signinId, share: 'A'.repeat(43) });
    await expect(refused).rejects.toMatchObject({
      code: 'rate_limited',
      details: { code: 'screen_backoff', retryAt: new Date(now.getTime() + 60_000).toISOString() },
    });
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      details: { code: 'screen_backoff' },
    });
    // Over after a minute; the next wrong code doubles it without another push.
    later(60_001);
    await guess();
    expect(screenBackoff(await store.failures(now), now)?.getTime()).toBe(now.getTime() + 120_000);
    expect(store.pushes).toHaveLength(1);
    // A right code clears the counter.
    later(120_001);
    await expect((await signIn(phone, { signinId })).confirm()).resolves.toBeDefined();
    expect(store.failureRows).toEqual([]);
  });

  it('limits requests to five per key and thirty per box an hour', async () => {
    for (let i = 0; i < SCREEN_SIGNIN_REQUESTS_PER_KEY; i++) await screen.request(phone, { endpoint });
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      code: 'rate_limited',
      details: { code: 'screen_rate_limited' },
    });
    for (let i = 0; i < SCREEN_SIGNIN_REQUESTS_TOTAL - SCREEN_SIGNIN_REQUESTS_PER_KEY; i++)
      await screen.request(key(`k${i}`), { endpoint });
    await expect(screen.request(key('late'), { endpoint })).rejects.toMatchObject({
      details: { code: 'screen_rate_limited' },
    });
    later(3600_001);
    await expect(screen.request(phone, { endpoint })).resolves.toBeDefined();
  });

  it('needs a screen, a claimed box with its person, and a key that isn’t let in yet', async () => {
    store.person = null;
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      details: { code: 'screen_unavailable' },
    });
    store.person = { id: 'acc_olive', name: 'Olive', email: 'olive@example.com' };
    store.deviceId = null;
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      code: 'unavailable',
      details: { code: 'screen_unavailable' },
    });
    store.deviceId = DEVICE;
    ceremony.close();
    build({ noFile: true });
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      details: { code: 'screen_unavailable' },
    });
    build();
    store.endpoints.set(phone.peerId, { accountId: 'acc_other', revoked: false, id: 'ep_other' });
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      code: 'conflict',
      details: { code: 'endpoint_enrolled' },
    });
    store.endpoints.set(phone.peerId, { accountId: 'acc_olive', revoked: true, id: 'ep_old' });
    await expect(screen.request(phone, { endpoint })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('an invalid share is refused and costs nothing; the screen names the email or the platform when it must', async () => {
    store.person = { id: 'acc_olive', name: '​', email: 'ben@example.com' };
    const { signinId } = await screen.request(key('cli'), { endpoint: { label: '​​', platform: 'cli' } });
    expect(read().signIn).toMatchObject({ name: 'ben@example.com', device: 'Command line' });
    for (const share of ['A'.repeat(43), Buffer.alloc(32, 0xff).toString('base64url')])
      await expect(screen.begin(key('cli'), scope(), { signinId, share })).rejects.toMatchObject({
        code: 'validation_failed',
        details: { code: 'screen_share_invalid' },
      });
    expect(store.failureRows).toEqual([]);
  });

  it('a stopping runtime takes the sign-in off the screen, and the letters never reach a log', async () => {
    const seen = new Set<string>();
    const run = await signIn(phone);
    seen.add(shown());
    const bad = await signIn(phone, { signinId: run.signinId, letters: wrong(shown()) });
    await expect(bad.confirm()).rejects.toBeDefined();
    seen.add(shown());
    expect(log.info).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    const text = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    for (const letters of seen) expect(text).not.toContain(letters);
    ceremony.close();
    expect(read()).toEqual({ v: 1, state: 'claimed', url: 'https://app.whombat.test/claim' });
  });
});
