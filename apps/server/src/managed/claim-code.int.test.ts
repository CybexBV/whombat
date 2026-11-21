/**
 * The claim with a console code over real sessions (MA-22, CC-03, CC-06…CC-08, CC-13; docs/decisions/managed-runtime.md
 * MR-49…MR-54): the manager's lookup lease on the admin socket, the console file (the four letters only), the CPace begin and the confirmed
 * claim with the contracts' client, wrong letters and their rotation, the MITM case, stale and missing begins, the
 * backoff (kept in the database), the successful claim, and that the code never reaches a log. One throwaway database:
 * the appliance starts unclaimed and is claimed once, at the end. Then sign in at the box (signin-at-box BX-02…BX-07)
 * on the claimed box: the console file's `signIn`, a wrong code counted under its own method, and a device let in.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleState, consoleStateValid } from '@whombat/control-contracts/local';
import { claimConfirmEqual, normalizeClaimCode } from '@whombat/protocol/claim';
import { ClaimBackoffDetails, claimCardPassword } from '@whombat/protocol/session';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applianceClaimAttempts,
  applianceClaimFailures,
  applianceEndpoints,
  applianceEvents,
} from '../db/schema/index';
import type { Services } from '../services';
import { TEST_APP_URL } from '../test/harness';
import { useManagedRuntime } from '../test/managed';
import { AdminSocket } from './admin-socket';
import { verifyApplianceChain } from './audit';
import { pakeClaim, pakeScreen, type TestSessionClient, testIdentity } from './testing';
import { TrustService } from './trust';

const dir = mkdtempSync(join(tmpdir(), 'wb-claim-code-'));
const consoleFile = join(dir, 'console.json');
const adminPath = join(dir, 'admin.sock');
const m = useManagedRuntime({ env: { WHOMBAT_CONSOLE_FILE: consoleFile } });
const DEVICE = 'dev-self-01';
const URL = `${TEST_APP_URL}/claim`;
let admin: AdminSocket;

/** Every logger call of the test, and every code the console showed. */
const logged: unknown[][] = [];
const seenCodes = new Set<string>();

beforeAll(async () => {
  const log = m.t.services.log as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    const original = log[level]?.bind(log);
    if (!original) continue;
    vi.spyOn(log, level as never).mockImplementation(((...args: unknown[]) => {
      logged.push(args);
      return original(...args);
    }) as never);
  }
  admin = new AdminSocket({ runtime: m.runtime, endpoint: null });
  await admin.listen(adminPath);
});

afterAll(async () => {
  await admin.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: adminPath, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const lease = (lookup: string | null) =>
  call('/claim-lookup', {
    v: 1,
    lookup,
    ...(lookup ? { expiresAt: new Date(Date.now() + 3600_000).toISOString() } : {}),
  });

function readConsole(): ConsoleState {
  const state = ConsoleState.parse(JSON.parse(readFileSync(consoleFile, 'utf8')));
  if (state.code) seenCodes.add(state.code);
  return state;
}

/** The four letters on the console now. */
function letters(): string {
  const n = normalizeClaimCode(readConsole().code ?? '');
  if (n.kind !== 'letters') throw new Error('no code on the console');
  return n.letters;
}

const wrongLetters = (right: string) => (right === 'AAAA' ? 'BBBB' : 'AAAA');

function code(
  c: TestSessionClient,
  password: string,
  options: { appliancePeerId?: string; beginOnly?: boolean; method?: 'code' | 'card' } = {},
) {
  return pakeClaim(
    c,
    {
      method: options.method ?? 'code',
      password,
      deviceId: DEVICE,
      appliancePeerId: options.appliancePeerId ?? m.appliance.peerId,
    },
    {
      account: { name: 'Olive', email: 'olive@example.com' },
      endpoint: { label: 'Laptop', platform: 'web' },
    },
    options.beginOnly ? { beginOnly: true } : {},
  );
}

const failures = async () => (await m.t.services.db.select().from(applianceClaimFailures)).length;
const attempts = async () => (await m.t.services.db.select().from(applianceClaimAttempts)).length;

describe('claim with a console code', () => {
  it('before provisioning the console waits, in the contract shape, mode 0640; a begin is not ready', async () => {
    expect(readConsole()).toEqual({ v: 1, state: 'waiting', url: URL });
    expect(statSync(consoleFile).mode & 0o777).toBe(0o640);
    expect((await code(await m.client(), 'ABCD')).begin).toMatchObject({
      t: 'error',
      code: 'unavailable',
      details: { code: 'claim_not_ready' },
    });
    // Nobody can sign in at the box before it is claimed (BX-02).
    expect(
      await (await m.client()).request('enroll.screen.request', {
        endpoint: { label: 'Pixel 9', platform: 'android' },
      }),
    ).toMatchObject({ t: 'error', code: 'unavailable', details: { code: 'screen_unavailable' } });
  });

  it('a self-registered device (no card) takes only the code, once the manager pushed a lookup lease', async () => {
    await m.runtime.trust.provisionClaim({ deviceId: DEVICE, secretHash: null });
    const c = await m.client();
    const card = await code(c, claimCardPassword(DEVICE, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), { method: 'card' });
    expect(card.begin).toMatchObject({
      t: 'error',
      code: 'unavailable',
      details: { code: 'claim_not_ready' },
    });
    // No lease yet: no code on the console, and none to claim with.
    expect(readConsole()).toEqual({ v: 1, state: 'waiting', url: URL });
    expect((await code(c, 'ABCD')).begin).toMatchObject({ details: { code: 'claim_not_ready' } });
    // The lease on the admin socket: `expiresAt` exactly with a number.
    expect((await call('/claim-lookup', { v: 1, lookup: '4821' })).status).toBe(400);
    expect(
      (await call('/claim-lookup', { v: 1, lookup: null, expiresAt: new Date().toISOString() })).status,
    ).toBe(400);
    expect(
      (await call('/claim-lookup', { v: 1, lookup: '48x1', expiresAt: new Date().toISOString() })).status,
    ).toBe(400);
    expect(await lease('4821')).toEqual({ status: 200, body: { v: 1, ok: true } });
    const shown = readConsole();
    expect(shown).toMatchObject({ v: 1, state: 'claimable', url: URL });
    // Only the four letters; the lookup number stays internal (CC-13).
    expect(shown.code).toMatch(/^[A-Z]{4}$/);
    expect(readFileSync(consoleFile, 'utf8')).not.toContain('4821');
    const first = letters();
    // Cleared (control unreachable): waiting; leased again: the same letters.
    expect((await lease(null)).status).toBe(200);
    expect(readConsole()).toEqual({ v: 1, state: 'waiting', url: URL });
    await lease('4821');
    expect(letters()).toBe(first);
  });

  it('an invalid share is refused and costs no attempt', async () => {
    const c = await m.client();
    const before = await attempts();
    for (const share of ['A'.repeat(43), Buffer.alloc(32, 0xff).toString('base64url')])
      expect(
        await c.request('enroll.claim.begin', { claimId: 'clm_test_0001', method: 'code', share }),
      ).toMatchObject({ t: 'error', code: 'validation_failed', details: { code: 'claim_share_invalid' } });
    expect(await attempts()).toBe(before);
    expect(await failures()).toBe(0);
  });

  it('a begin alone costs nothing; enroll.claim needs this session’s live begin for the same claim and method', async () => {
    const right = letters();
    const a = await m.client();
    const begun = await code(a, right, { beginOnly: true });
    expect(begun.begin).toMatchObject({ t: 'result', output: { share: expect.any(String) } });
    expect(await failures()).toBe(0);
    expect(letters()).toBe(right);
    const claim = (c: TestSessionClient, over: Record<string, unknown> = {}) =>
      c.request('enroll.claim', {
        claimId: 'clm_test_0001',
        method: 'code',
        confirm: begun.tags?.client,
        account: { name: 'Olive', email: 'olive@example.com' },
        endpoint: { label: 'Laptop', platform: 'web' },
        ...over,
      });
    // Another session can't use it, even with the right tag.
    expect(await claim(await m.client())).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'claim_begin_missing' },
    });
    // Another claim id: missing — and the begin is used up by that request.
    expect(await claim(a, { claimId: 'clm_test_other' })).toMatchObject({
      details: { code: 'claim_begin_missing' },
    });
    expect(await claim(a)).toMatchObject({ details: { code: 'claim_begin_missing' } });
    // Another method, and an expired begin.
    const b = await m.client();
    const again = await code(b, right, { beginOnly: true });
    expect(await claim(b, { method: 'card', confirm: again.tags?.client })).toMatchObject({
      details: { code: 'claim_begin_missing' },
    });
    await code(b, right, { beginOnly: true });
    const scope = b.connection.scope;
    if (!scope.claimBegin) throw new Error('no begin');
    scope.claimBegin.expiresAt = new Date(Date.now() - 1);
    expect(await claim(b)).toMatchObject({ details: { code: 'claim_begin_missing' } });
    // Nothing was guessed, so nothing counted and nothing rotated.
    expect(await failures()).toBe(0);
    expect(letters()).toBe(right);
  });

  it('wrong letters: claim_invalid, one failure, and new letters on the console at once', async () => {
    const before = letters();
    const { begin, claim } = await code(await m.client(), wrongLetters(before));
    expect(begin).toMatchObject({ t: 'result' });
    expect(claim).toMatchObject({
      t: 'error',
      code: 'forbidden',
      message: 'That code isn’t right. Your Whombat now shows a new one.',
      details: { code: 'claim_invalid' },
    });
    const rows = await m.t.services.db.select().from(applianceClaimFailures);
    expect(rows).toMatchObject([{ method: 'code' }]);
    expect(readConsole()).toMatchObject({ state: 'claimable' });
    expect(letters()).not.toBe(before);
  });

  it('MITM: a client bound to another appliance key gets claim_invalid even with the right letters', async () => {
    const right = letters();
    const relayed = await code(await m.client(), right, { appliancePeerId: testIdentity().peerId });
    expect(relayed.begin).toMatchObject({ t: 'result' });
    expect(relayed.claim).toMatchObject({ t: 'error', details: { code: 'claim_invalid' } });
    expect(await failures()).toBe(2);
    expect(letters()).not.toBe(right);
  });

  it('a begin made before a failure can’t be confirmed any more (the letters it used are gone)', async () => {
    const early = await m.client();
    const begun = await code(early, letters(), { beginOnly: true });
    expect(begun.begin).toMatchObject({ t: 'result' });
    expect((await code(await m.client(), wrongLetters(letters()))).claim).toMatchObject({
      details: { code: 'claim_invalid' },
    });
    expect(await failures()).toBe(3);
    expect(
      await early.request('enroll.claim', {
        claimId: 'clm_test_0001',
        method: 'code',
        confirm: begun.tags?.client,
        account: { name: 'Olive', email: 'olive@example.com' },
        endpoint: { label: 'Laptop', platform: 'web' },
      }),
    ).toMatchObject({ t: 'error', code: 'conflict', details: { code: 'claim_begin_missing' } });
    // Three failures are free: no backoff yet.
    expect(readConsole().state).toBe('claimable');
    expect(await failures()).toBe(3);
  });

  it('after three free failures a begin is refused until retryAt; the console says so; a restart keeps it', async () => {
    expect((await code(await m.client(), wrongLetters(letters()))).claim).toMatchObject({
      details: { code: 'claim_invalid' },
    });
    const refused = (await code(await m.client(), 'ABCD')).begin;
    expect(refused).toMatchObject({ t: 'error', code: 'rate_limited', details: { code: 'claim_backoff' } });
    const { retryAt } = ClaimBackoffDetails.parse((refused as { details: unknown }).details);
    const [latest] = await m.t.services.db
      .select({ at: sql<Date>`max(${applianceClaimFailures.at})` })
      .from(applianceClaimFailures);
    expect(new Date(retryAt).getTime()).toBe(new Date(latest?.at as Date).getTime() + 60_000);
    expect(readConsole()).toEqual({ v: 1, state: 'backoff', url: URL, retryAt });
    // A restarted runtime reads the same backoff from the database (its console isn't written here).
    const quiet = {
      ...m.t.services,
      config: { ...m.t.services.config, WHOMBAT_CONSOLE_FILE: undefined },
    } as Services;
    const restarted = new TrustService(quiet, m.manager, m.appliance.peerId);
    expect((await restarted.refreshClaimConsole()).retryAt?.toISOString()).toBe(retryAt);
    restarted.ceremony.close();

    // The backoff ends by itself: the console shows a code again without anything else happening.
    await m.t.services.db.update(applianceClaimFailures).set({ at: new Date(Date.now() - 59_700) });
    const soon = await m.runtime.trust.refreshClaimConsole();
    expect(soon.retryAt).not.toBeNull();
    expect(readConsole().state).toBe('backoff');
    await new Promise((r) => setTimeout(r, 800));
    expect(readConsole().state).toBe('claimable');
    // The next failure doubles it (5 in the window: 120 s).
    expect((await code(await m.client(), wrongLetters(letters()))).claim).toMatchObject({
      details: { code: 'claim_invalid' },
    });
    const next = readConsole();
    expect(next.state).toBe('backoff');
    expect(new Date(next.retryAt ?? 0).getTime() - Date.now()).toBeGreaterThan(110_000);
    // Wait it out (moved into the past here); the five failures still count in the 24 h window.
    await m.t.services.db.update(applianceClaimFailures).set({ at: new Date(Date.now() - 3600_000) });
    await m.runtime.trust.refreshClaimConsole();
    expect(readConsole().state).toBe('claimable');
    expect(await failures()).toBe(5);
  });

  const owner = testIdentity();
  it('the right code claims: the appliance’s tag answers, counters clear, the console says claimed', async () => {
    const c = await m.client(owner);
    const { claim, tags } = await code(c, letters());
    expect(claim).toMatchObject({
      t: 'result',
      // No recovery kit at the claim any more (BX-01).
      output: { name: 'Olive', recoveryKitRequired: false, endpoint: { current: true } },
    });
    const output = (claim as unknown as { output: { confirm: string } }).output;
    expect(claimConfirmEqual(tags?.appliance ?? '', output.confirm)).toBe(true);
    expect(await failures()).toBe(0);
    expect(readConsole()).toEqual({ v: 1, state: 'claimed', url: URL });
    const [attempt] = await m.t.services.db
      .select()
      .from(applianceClaimAttempts)
      .where(eq(applianceClaimAttempts.peerId, owner.peerId));
    expect(attempt?.ok).toBe(1);
    await m.runtime.trust.reportPending();
    expect(m.manager.claimed).toEqual([{ claimId: 'clm_test_0001', claimedAt: expect.any(String) }]);
    // Claimed: a begin is answered claim_used; a late lease doesn't bring a code back.
    expect((await code(await m.client(), 'ABCD')).begin).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'claim_used' },
    });
    expect((await lease('4821')).status).toBe(200);
    expect(readConsole()).toEqual({ v: 1, state: 'claimed', url: URL });
  });

  it('the code never reaches a log', () => {
    expect(seenCodes.size).toBeGreaterThanOrEqual(5);
    // The wrong confirmations were logged (so the spy works), without any code or letters.
    expect(logged.some((args) => JSON.stringify(args).includes('wrong confirmation'))).toBe(true);
    const text = logged.map((args) => JSON.stringify(args, (_k, v) => (v instanceof Error ? String(v) : v)));
    for (const shown of seenCodes) {
      const n = normalizeClaimCode(shown);
      if (n.kind !== 'letters') throw new Error('bad code');
      const alone = new RegExp(`(^|[^A-Za-z0-9])${n.letters}([^A-Za-z0-9]|$)`);
      for (const line of text) expect(line).not.toMatch(alone);
    }
  });
});

describe('sign in at the box', () => {
  const phone = testIdentity();
  let signinId = '';
  const pixel = { label: 'Pixel 9', platform: 'android' as const };
  const seenLetters = new Set<string>();

  const raw = () => ConsoleState.parse(JSON.parse(readFileSync(consoleFile, 'utf8')));
  const screenLetters = () => {
    const code = raw().signIn?.code;
    if (!code) throw new Error('no sign-in on the console');
    seenLetters.add(code);
    return code;
  };
  const screen = (c: TestSessionClient, letters: () => string, signinId?: string) =>
    pakeScreen(c, {
      endpoint: pixel,
      deviceId: DEVICE,
      appliancePeerId: m.appliance.peerId,
      letters,
      ...(signinId ? { signinId } : {}),
    });
  const wrong6 = (right: string) => (right === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA');
  const screenFailures = async () =>
    (await m.t.services.db.select().from(applianceClaimFailures)).filter((r) => r.method === 'screen').length;

  it('Olive’s new phone asks: the console shows whose device it is and six letters', async () => {
    // The box from the claim above is Olive's.
    expect(await m.runtime.trust.isClaimed()).toBe(true);
    const asked = await (await m.client(phone)).request('enroll.screen.request', { endpoint: pixel });
    expect(asked).toMatchObject({ t: 'result', output: { signinId: expect.any(String) } });
    signinId = (asked as unknown as { output: { signinId: string } }).output.signinId;
    const shown = raw();
    expect(shown).toMatchObject({
      state: 'claimed',
      signIn: { name: 'Olive', device: 'Pixel 9', code: expect.stringMatching(/^[A-Z]{6}$/) },
    });
    screenLetters();
    expect(consoleStateValid(shown)).toBe(true);
  });

  it('a wrong code counts under its own method and the console shows new letters; the claim’s counter is untouched', async () => {
    const before = screenLetters();
    const wrong = await screen(await m.client(phone), () => wrong6(before), signinId);
    expect(wrong.begin).toMatchObject({ t: 'result' });
    expect(wrong.enroll).toMatchObject({
      t: 'error',
      code: 'forbidden',
      details: { code: 'screen_code_invalid' },
    });
    expect(await screenFailures()).toBe(1);
    expect(await m.runtime.trust.claimBackoff(new Date())).toBeNull();
    expect(screenLetters()).not.toBe(before);
  });

  it('the right letters let the phone in as Olive: enrolled via the screen, signed, the person told, off the screen', async () => {
    // Olive's laptop (her claiming device) has a push handle, to hear of the new device.
    await m.t.services.db
      .update(applianceEndpoints)
      .set({ pushHandle: 'push-handle-olive-laptop' })
      .where(eq(applianceEndpoints.label, 'Laptop'));
    const pushes = m.manager.pushes.length;
    const signedIn = await screen(await m.client(phone), screenLetters, signinId);
    expect(signedIn.enroll).toMatchObject({
      t: 'result',
      output: { name: 'Olive', endpoint: { label: 'Pixel 9', current: true } },
    });
    const out = (
      signedIn.enroll as unknown as { output: { confirm: string; endpoint: { endpointId: string } } }
    ).output;
    expect(claimConfirmEqual(signedIn.tags?.appliance ?? '', out.confirm)).toBe(true);
    const [row] = await m.t.services.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, phone.peerId));
    expect(row).toMatchObject({
      id: out.endpoint.endpointId,
      enrolledVia: 'screen',
      enrolledByEndpointId: null,
    });
    const [event] = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(eq(applianceEvents.endpointId, out.endpoint.endpointId));
    expect(event).toMatchObject({ type: 'endpoint.enrolled', payload: { via: 'screen', by: null } });
    expect(await verifyApplianceChain(m.t.services.db, m.t.services.custody)).toMatchObject({ ok: true });
    // Off the screen, the counter clear, and a content-free security push to her laptop.
    expect(raw().signIn).toBeUndefined();
    expect(await screenFailures()).toBe(0);
    await vi.waitFor(() =>
      expect(m.manager.pushes.slice(pushes)).toEqual([
        expect.objectContaining({ kind: 'security', handles: ['push-handle-olive-laptop'] }),
      ]),
    );
    // The phone's session is now an enrolled one.
    const again = await m.client(phone);
    expect(await again.request('endpoints.list', {})).toMatchObject({ t: 'result' });
  });

  it('a device that is in already signs in again (a box restored from a backup): it keeps its endpoint', async () => {
    const endpoints = (await m.t.services.db.select().from(applianceEndpoints)).length;
    const events = (await m.t.services.db.select().from(applianceEvents)).length;
    const again = await screen(await m.client(phone), screenLetters);
    const out = (again.enroll as unknown as { output: { confirm: string; endpoint: { endpointId: string } } })
      .output;
    expect(claimConfirmEqual(again.tags?.appliance ?? '', out.confirm)).toBe(true);
    const [row] = await m.t.services.db
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.peerId, phone.peerId));
    expect(out.endpoint.endpointId).toBe(row?.id);
    expect((await m.t.services.db.select().from(applianceEndpoints)).length).toBe(endpoints);
    // No second endpoint.enrolled: nothing new was let in.
    expect((await m.t.services.db.select().from(applianceEvents)).length).toBe(events);
    expect(raw().signIn).toBeUndefined();
  });

  it('the letters never reach a log', () => {
    expect(seenLetters.size).toBeGreaterThanOrEqual(2);
    expect(logged.some((args) => JSON.stringify(args).includes('screen sign-in'))).toBe(true);
    const text = logged.map((args) => JSON.stringify(args, (_k, v) => (v instanceof Error ? String(v) : v)));
    for (const letters of seenLetters) for (const line of text) expect(line).not.toContain(letters);
  });
});
