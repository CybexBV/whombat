/**
 * The claim ceremony (CC-06, CC-07, AP-47) against a fake appliance that runs the real responder
 * (`claimPakeResponder`): right and wrong letters, a card, a man in the middle, backoff, and the words for each.
 */
import { claimConfirmEqual, claimPakeResponder } from '@whombat/protocol/claim';
import { claimSecretHash, LOCALE_MINOR, normalizeClaimSecret } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import type { ApplianceSession, OperationResponse, SessionInfo } from '../session/types';
import {
  ClaimMismatchError,
  type ClaimRequest,
  claimAppliance,
  claimErrorText,
  formatClaimLettersInput,
  isNotNearby,
  lettersRequestOf,
  parseClaimQr,
  runClaimCeremony,
} from './claim';
import { APPLIANCE_TERMS_VERSION, type ControlApi, ControlError } from './control';

/** The appliance terms the person ticked (LC-18). */
const TERMS = { version: APPLIANCE_TERMS_VERSION };
const APPLIANCE = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const CLIENT = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const MITM = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const DEVICE = 'dev_7KQ2M4XD';
const SECRET = 'HQ4TZZPM2WXA7KCEB3NRDS5FGY';
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

interface FakeBox {
  letters: string;
  /** Wrong confirmations in the window (CC-07). */
  failures: number;
  claimed: boolean;
  backoffUntil: number | null;
  calls: string[];
}

/**
 * An enrollment session to a box. `seenClient`/`seenAppliance`: the PeerIds the box's own Noise session has (a man in
 * the middle makes them differ from the client's). `lying`: the box answers success without checking the tag.
 */
function fakeSession(
  box: FakeBox,
  opts: {
    seenClient?: string;
    seenAppliance?: string;
    lying?: boolean;
    protocol?: SessionInfo['protocol'];
    onClaim?: (input: unknown) => void;
  } = {},
): ApplianceSession {
  let begun: {
    claimId: string;
    method: 'code' | 'card';
    tags: { client: string; appliance: string };
  } | null = null;
  const err = (status: number, code: string, details?: Record<string, unknown>): OperationResponse => ({
    status,
    body: { error: { code, message: code, ...(details && { details: { code, ...details } }) } },
    requestId: 'r',
  });
  const session = {
    close() {},
    state: () => ({ status: 'open', info: { protocol: opts.protocol } }),
    async invoke(op: string, input: unknown): Promise<OperationResponse> {
      box.calls.push(op);
      const i = input as Record<string, string>;
      if (op === 'enroll.claim.begin') {
        if (box.claimed) return err(409, 'claim_used');
        if (box.backoffUntil && box.backoffUntil > Date.now())
          return err(429, 'claim_backoff', { retryAt: new Date(box.backoffUntil).toISOString() });
        const method = i.method as 'code' | 'card';
        const r = claimPakeResponder(
          {
            method,
            password: method === 'code' ? box.letters : claimSecretHash(DEVICE, SECRET),
            deviceId: DEVICE,
            appliancePeerId: opts.seenAppliance ?? APPLIANCE,
            clientPeerId: opts.seenClient ?? CLIENT,
            claimId: i.claimId as string,
          },
          i.share as string,
          rand,
        );
        begun = { claimId: i.claimId as string, method, tags: r.tags };
        return { status: 200, body: { share: r.share }, requestId: 'r' };
      }
      if (op === 'enroll.claim') {
        opts.onClaim?.(input);
        if (!begun) return err(409, 'claim_begin_missing');
        const ok = claimConfirmEqual(begun.tags.client, i.confirm as string);
        if (!ok && !opts.lying) {
          begun = null;
          box.failures += 1;
          box.letters = box.letters === 'KXQM' ? 'PRTV' : 'KXQM';
          if (box.failures > 3) box.backoffUntil = Date.now() + 90_000;
          return err(403, 'claim_invalid');
        }
        box.claimed = true;
        return {
          status: 200,
          body: {
            accountId: 'acc_mara',
            name: 'Mara',
            endpoint: {
              endpointId: 'end_1',
              peerId: CLIENT,
              label: 'Chrome',
              platform: 'web',
              accountId: 'acc_mara',
              createdAt: '2026-09-26T10:00:00Z',
              lastSeenAt: null,
              current: true,
              revokedAt: null,
              revocation: 'none',
            },
            authzGeneration: 1,
            // Runtimes since BX-01 answer false; the app ignores it either way (no kit step).
            recoveryKitRequired: false,
            confirm: begun.tags.appliance,
          },
          requestId: 'r',
        };
      }
      return err(404, 'not_found');
    },
  };
  return session as unknown as ApplianceSession;
}

const newBox = (): FakeBox => ({
  letters: 'KXQM',
  failures: 0,
  claimed: false,
  backoffUntil: null,
  calls: [],
});

const ceremony = (session: ApplianceSession, request: ClaimRequest) =>
  runClaimCeremony({
    session,
    claim: { claim: 'clm_0123456789abcdef', device: DEVICE },
    request,
    appliancePeerId: APPLIANCE,
    clientPeerId: CLIENT,
    account: { name: 'Mara', email: 'mara@burrowhq.example' },
    endpoint: { label: 'Chrome', platform: 'web' },
  });

describe('the claim ceremony', () => {
  it('claims with the right letters and checks the appliance’s confirmation; nothing more (no kit, BX-01)', async () => {
    const box = newBox();
    const out = await ceremony(fakeSession(box), { method: 'code', device: DEVICE, letters: 'KXQM' });
    expect(out.accountId).toBe('acc_mara');
    expect(box.claimed).toBe(true);
    // The claim is done here: no recovery kit is registered or confirmed as part of it.
    expect(box.calls).toEqual(['enroll.claim.begin', 'enroll.claim']);
  });

  it('wrong letters: refused, the letters rotate, and the words say so', async () => {
    const box = newBox();
    const error = await ceremony(fakeSession(box), { method: 'code', device: DEVICE, letters: 'PRTV' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OperationError);
    expect(box.claimed).toBe(false);
    expect(box.letters).toBe('PRTV');
    expect(claimErrorText(error, 'code')).toBe('That code isn’t right. Your Whombat now shows a new one.');
    expect(claimErrorText(error, 'card')).toBe('That claim code isn’t right.');
  });

  it('claims with the card (its password is the secret’s hash, CT-66)', async () => {
    const box = newBox();
    const out = await ceremony(fakeSession(box), {
      method: 'card',
      device: DEVICE,
      secret: 'hq4t zzpm 2wxa 7kce b3nr ds5f gy',
    });
    expect(out.accountId).toBeTruthy();
    expect(normalizeClaimSecret('hq4t zzpm 2wxa 7kce b3nr ds5f gy')).toBe(SECRET);
  });

  it('a man in the middle forwarding the PAKE gets refused by the box', async () => {
    const box = newBox();
    // The box's Noise session sees the middle's key, not this client's.
    const error = await ceremony(fakeSession(box, { seenClient: MITM }), {
      method: 'code',
      device: DEVICE,
      letters: 'KXQM',
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'claim_invalid' });
    expect(box.claimed).toBe(false);
  });

  it('something that answers success without the box’s key is caught before anything is trusted', async () => {
    const box = newBox();
    // The client's Noise session reached another key than the one the box has (a PeerId mismatch), and whatever
    // answered claims success anyway: the appliance tag can't match.
    const error = await ceremony(fakeSession(box, { seenAppliance: MITM, lying: true }), {
      method: 'code',
      device: DEVICE,
      letters: 'KXQM',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimMismatchError);
    expect(claimErrorText(error, 'code')).toBe('This isn’t the Whombat on your screen.');
    expect(claimErrorText(error, 'card')).toBe('This isn’t the Whombat on your card.');
  });

  it('backoff after repeated wrong letters, in minutes', async () => {
    const box = newBox();
    for (let i = 0; i < 4; i++)
      await ceremony(fakeSession(box), { method: 'code', device: DEVICE, letters: 'WXYA' }).catch(() => {});
    const error = await ceremony(fakeSession(box), {
      method: 'code',
      device: DEVICE,
      letters: box.letters,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'claim_backoff' });
    expect(claimErrorText(error, 'code')).toBe('Too many wrong codes. Try again in 2 min.');
    expect(box.calls.at(-1)).toBe('enroll.claim.begin');
  });
});

describe('claimAppliance', () => {
  const control = (onStart: (input: unknown) => void, fail?: ControlError): ControlApi =>
    ({
      async startClaim(input: unknown) {
        onStart(input);
        if (fail) throw fail;
        return {
          claim: {
            claim: 'clm_0123456789abcdef',
            device: DEVICE,
            method: 'code',
            contentPeerId: APPLIANCE,
            expiresAt: 0,
          },
          ticket: { ticket: 't', relayUrl: 'wss://relay' },
        };
      },
    }) as unknown as ControlApi;

  it('sends control only the nearby device, never the letters, and pins the PeerId it named', async () => {
    const starts: unknown[] = [];
    const box = newBox();
    const opened: string[] = [];
    const request = lettersRequestOf(DEVICE, 'kx qm');
    if (!request) throw new Error('not letters');
    const r = await claimAppliance({
      control: control((i) => starts.push(i)),
      orgId: 'org_1',
      request,
      openSession: async (t) => {
        opened.push(t.peerId);
        return fakeSession(box);
      },
      terms: TERMS,
      clientPeerId: CLIENT,
      account: { name: 'Mara', email: 'mara@burrowhq.example' },
      endpoint: { label: 'Chrome', platform: 'web' },
    });
    expect(starts).toEqual([{ orgId: 'org_1', method: 'code', device: DEVICE, terms: TERMS }]);
    expect(JSON.stringify(starts)).not.toContain('KXQM');
    expect(opened).toEqual([APPLIANCE]);
    expect(r).toMatchObject({ device: DEVICE, peerId: APPLIANCE, accountId: 'acc_mara' });
  });

  it('a card claim carries the proof, never the secret', async () => {
    const starts: Record<string, unknown>[] = [];
    await claimAppliance({
      control: control((i) => starts.push(i as Record<string, unknown>)),
      orgId: 'org_1',
      request: { method: 'card', device: DEVICE, secret: SECRET },
      openSession: async () => fakeSession(newBox()),
      terms: TERMS,
      clientPeerId: CLIENT,
      account: { name: 'Mara', email: 'mara@burrowhq.example' },
      endpoint: { label: 'Chrome', platform: 'web' },
    });
    expect(starts[0]).toMatchObject({ method: 'card', device: DEVICE, terms: TERMS });
    expect(JSON.stringify(starts)).not.toContain(SECRET);
  });

  it.each([20, LOCALE_MINOR])('gates the claim locale on protocol 5.%i', async (minor) => {
    const claims: unknown[] = [];
    await claimAppliance({
      control: control(() => {}),
      orgId: 'org_1',
      request: { method: 'code', device: DEVICE, letters: 'KXQM' },
      openSession: async () =>
        fakeSession(newBox(), { protocol: { major: 5, minor }, onClaim: (input) => claims.push(input) }),
      terms: TERMS,
      clientPeerId: CLIENT,
      account: { name: 'Mara', email: 'mara@example.com' },
      endpoint: { label: 'Chrome', platform: 'web' },
      locale: 'nl-be',
    });
    expect(claims).toHaveLength(1);
    if (minor === 20) expect(claims[0]).not.toHaveProperty('locale');
    else expect(claims[0]).toHaveProperty('locale', 'nl-BE');
  });

  it('a box that isn’t nearby any more is told apart; control’s refusals have words', async () => {
    const e = await claimAppliance({
      control: control(() => {}, new ControlError('device_not_nearby', 'no')),
      orgId: 'org_1',
      request: { method: 'code', device: DEVICE, letters: 'KXQM' },
      openSession: async () => fakeSession(newBox()),
      terms: TERMS,
      clientPeerId: CLIENT,
      account: { name: 'Mara', email: 'mara@burrowhq.example' },
      endpoint: { label: 'Chrome', platform: 'web' },
    }).catch((x: unknown) => x);
    expect(isNotNearby(e)).toBe(true);
    expect(claimErrorText(e, 'code')).toBe('We couldn’t find your Whombat.');
    expect(claimErrorText(new ControlError('already_claimed', 'no'), 'code')).toBe(
      'Someone already claimed this Whombat.',
    );
    expect(claimErrorText(new ControlError('rate_limited', 'no'), 'code')).toBe(
      'Too many tries. Wait a few minutes, then try again.',
    );
    expect(claimErrorText({ reason: 'appliance_offline' }, 'code')).toBe(
      'Your Whombat isn’t online. Check that it has power and a network cable.',
    );
  });
});

describe('typing the letters', () => {
  it('accepts any case, spaces and dashes; only the four letters are a request', () => {
    expect(formatClaimLettersInput('kx qm')).toBe('KXQM');
    expect(formatClaimLettersInput('k x-q m')).toBe('KXQM');
    expect(lettersRequestOf(DEVICE, 'kxqm')).toEqual({ method: 'code', device: DEVICE, letters: 'KXQM' });
    expect(lettersRequestOf(DEVICE, 'Kx-qM')).toEqual({ method: 'code', device: DEVICE, letters: 'KXQM' });
    // Too few, outside the alphabet, or a longer code with digits: “Enter the 4 letters from its screen.”
    for (const typed of ['KXQ', 'KXQO', 'KX-4821-QM', '4821', ''])
      expect(lettersRequestOf(DEVICE, typed)).toBeNull();
  });

  it('reads the card’s QR code: the claim link or the older text, ignoring the fingerprint', () => {
    expect(parseClaimQr(`https://app.whombat.com/claim#v=1&d=${DEVICE}&p=${APPLIANCE}&s=${SECRET}`)).toEqual({
      device: DEVICE,
      secret: SECRET,
    });
    expect(parseClaimQr(`WHOMBAT1:${DEVICE}:QI4E7-IXQHK-B5R4O-OO2EF-4IO7L:${SECRET}`)).toEqual({
      device: DEVICE,
      secret: SECRET,
    });
    expect(parseClaimQr(`WHOMBAT1:${DEVICE}:${SECRET}`)).toEqual({ device: DEVICE, secret: SECRET });
    expect(parseClaimQr('https://example.com/claim#v=1&d=x&s=short')).toBeNull();
  });
});
