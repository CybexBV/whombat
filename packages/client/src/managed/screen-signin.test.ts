/**
 * Signing in at the box's screen (BX-02…BX-05, signin-at-box-web.md AP-3500…) against a fake box that runs the real
 * responder: the steps, every refusal's step and words, a man in the middle, a lying answer, and the pin rules.
 */
import { screenSignInPakeResponder } from '@whombat/protocol/claim';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import type { ApplianceSession, OperationResponse } from '../session/types';
import { COPY, managedCopyText } from './copy';
import type { KnownAppliance } from './registry';
import {
  formatScreenLettersInput,
  type ScreenSignInDeps,
  type ScreenSignInStep,
  screenSignedInRecord,
  screenSignInFailed,
  screenSignInPeer,
  screenSignInRequest,
  screenSignInStart,
  screenSignInSubmit,
} from './screen-signin';

const APPLIANCE = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const CLIENT = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const MITM = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const DEVICE = 'dev_7KQ2M4XD';
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const E = COPY.screen.errors;

interface FakeBox {
  letters: string;
  signinId: string | null;
  enrolled: boolean;
  calls: string[];
  /** A refusal for the next call of an op. */
  refuse: Record<string, { status: number; code: string; details?: Record<string, unknown> }>;
}

const newBox = (): FakeBox => ({
  letters: 'KXQMTR',
  signinId: null,
  enrolled: false,
  calls: [],
  refuse: {},
});

/**
 * An enrollment session to the box. `seenClient`/`seenAppliance`: the keys the box's own Noise session has (a man in
 * the middle makes them differ). `lying`: answers success without checking the tag.
 */
function fakeSession(
  box: FakeBox,
  opts: { seenClient?: string; seenAppliance?: string; lying?: boolean; says?: string } = {},
): ApplianceSession {
  let begun: { signinId: string; tags: { client: string; appliance: string } } | null = null;
  const err = (status: number, code: string, details?: Record<string, unknown>): OperationResponse => ({
    status,
    body: { error: { code, message: code, ...(details && { details: { code, ...details } }) } },
    requestId: 'r',
  });
  const ok = (body: unknown): OperationResponse => ({ status: 200, body, requestId: 'r' });
  const session = {
    close() {},
    async invoke(op: string, input: unknown): Promise<OperationResponse> {
      box.calls.push(op);
      const refused = box.refuse[op];
      if (refused) {
        delete box.refuse[op];
        return err(refused.status, refused.code, refused.details);
      }
      const i = input as Record<string, string>;
      if (op === 'enroll.screen.request') {
        expect(i).not.toHaveProperty('email');
        box.signinId = `ssi_${box.calls.length}abcdefgh`;
        return ok({
          signinId: box.signinId,
          expiresAt: '2026-10-20T12:05:00Z',
          ...(opts.says && { device: opts.says }),
        });
      }
      if (op === 'enroll.screen.begin') {
        if (i.signinId !== box.signinId) return err(409, 'screen_signin_missing');
        const r = screenSignInPakeResponder(
          {
            password: box.letters,
            deviceId: DEVICE,
            appliancePeerId: opts.seenAppliance ?? APPLIANCE,
            clientPeerId: opts.seenClient ?? CLIENT,
            signinId: i.signinId as string,
          },
          i.share as string,
          rand,
        );
        begun = { signinId: i.signinId as string, tags: r.tags };
        return ok({ share: r.share });
      }
      if (op === 'enroll.screen') {
        if (!begun || begun.signinId !== i.signinId) return err(409, 'screen_begin_missing');
        const tags = begun.tags;
        begun = null;
        if (!opts.lying && tags.client !== i.confirm) {
          box.letters = box.letters === 'KXQMTR' ? 'PRTVWY' : 'KXQMTR';
          return err(403, 'screen_code_invalid');
        }
        box.enrolled = true;
        return ok({
          accountId: 'acc_mara',
          name: 'Mara',
          principals: [],
          endpoint: {
            endpointId: 'end_1',
            peerId: CLIENT,
            label: 'Chrome',
            platform: 'web',
            accountId: 'acc_mara',
            createdAt: '2026-10-20T12:00:00Z',
            lastSeenAt: null,
            current: true,
            revokedAt: null,
            revocation: 'none',
          },
          authzGeneration: 1,
          confirm: opts.lying ? 'A'.repeat(43) : tags.appliance,
        });
      }
      return err(404, 'unknown_op');
    },
  };
  return session as unknown as ApplianceSession;
}

const deps = (
  session: ApplianceSession,
  now = () => Date.parse('2026-10-20T12:00:00Z'),
): ScreenSignInDeps => ({
  session,
  device: DEVICE,
  appliancePeerId: APPLIANCE,
  clientPeerId: CLIENT,
  endpoint: { label: 'Chrome', platform: 'web' },
  now,
});

type Letters = Extract<ScreenSignInStep, { kind: 'letters' }>;
async function lettersStep(d: ScreenSignInDeps): Promise<Letters> {
  const step = await screenSignInRequest(d, screenSignInStart());
  if (step.kind !== 'letters') throw new Error(`not the letters: ${JSON.stringify(step)}`);
  return step;
}

describe('the screen sign-in’s steps', () => {
  it('Show a code → the box shows letters → typed with spaces in any case → let in, after the box’s tag', async () => {
    const box = newBox();
    const d = deps(fakeSession(box));
    const at = await lettersStep(d);
    expect(at).toMatchObject({ signinId: box.signinId, error: null });
    const done = await screenSignInSubmit(d, at, 'kxq mtr');
    expect(done).toMatchObject({ kind: 'enrolled', output: { accountId: 'acc_mara' } });
    expect(box.calls).toEqual(['enroll.screen.request', 'enroll.screen.begin', 'enroll.screen']);
  });

  it('wrong letters: the box shows new ones and the same code goes on; then the right ones let it in', async () => {
    const box = newBox();
    const d = deps(fakeSession(box));
    const at = await lettersStep(d);
    const wrong = await screenSignInSubmit(d, at, 'PRTVWY');
    expect(wrong).toEqual({ ...at, error: E.screen_code_invalid });
    expect(box.letters).toBe('PRTVWY');
    expect(await screenSignInSubmit(d, wrong as Letters, box.letters)).toMatchObject({ kind: 'enrolled' });
  });

  it('what isn’t six letters of the alphabet is refused before anything is sent', async () => {
    const box = newBox();
    const d = deps(fakeSession(box));
    const at = await lettersStep(d);
    for (const typed of ['KXQ', 'KXQMTO', 'KXQMTR1', ''])
      expect(await screenSignInSubmit(d, at, typed)).toEqual({ ...at, error: E.letters });
    expect(box.calls).toEqual(['enroll.screen.request']);
  });

  it('“Show a new code” after it ran out asks again', async () => {
    const box = newBox();
    const d = deps(fakeSession(box));
    const at = await lettersStep(d);
    box.signinId = 'ssi_replaced0';
    const ended = await screenSignInSubmit(d, at, 'KXQMTR');
    expect(ended).toEqual({ ...at, error: E.screen_signin_missing });
    const again = await screenSignInRequest(d, ended as Letters);
    expect(again).toMatchObject({ kind: 'letters', signinId: box.signinId });
  });

  it('on the box’s own page (no directory) the device id the box names is the one the exchange binds', async () => {
    const box = newBox();
    const d = { ...deps(fakeSession(box, { says: DEVICE })), device: null };
    const at = await lettersStep(d);
    expect(at.device).toBe(DEVICE);
    expect(await screenSignInSubmit(d, at, 'KXQMTR')).toMatchObject({ kind: 'enrolled' });
  });

  it('the directory’s device id wins over the box’s answer, and a box that names none stops the own page', async () => {
    const box = newBox();
    const d = deps(fakeSession(box, { says: 'dev_SOMEONE' }));
    expect(await screenSignInSubmit(d, await lettersStep(d), 'KXQMTR')).toMatchObject({ kind: 'enrolled' });
    const quiet = newBox();
    const own = { ...deps(fakeSession(quiet)), device: null };
    expect(await screenSignInSubmit(own, await lettersStep(own), 'KXQMTR')).toEqual({
      kind: 'stopped',
      error: E.old,
    });
    expect(quiet.calls).toEqual(['enroll.screen.request']);
  });

  it('a man in the middle forwarding the exchange is refused by the box (its keys don’t match)', async () => {
    const box = newBox();
    const d = deps(fakeSession(box, { seenClient: MITM }));
    const at = await lettersStep(d);
    expect(await screenSignInSubmit(d, at, 'KXQMTR')).toEqual({ ...at, error: E.screen_code_invalid });
    expect(box.enrolled).toBe(false);
  });

  it('a success without the box’s key stops: “this isn’t the Whombat”, nothing to pin', async () => {
    const box = newBox();
    const d = deps(fakeSession(box, { seenAppliance: MITM, lying: true }));
    const at = await lettersStep(d);
    expect(await screenSignInSubmit(d, at, 'KXQMTR')).toEqual({ kind: 'stopped', error: E.notThisOne });
  });

  it('every refusal lands where the person can act on it, with its words', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const start: Extract<ScreenSignInStep, { kind: 'start' }> = { kind: 'start', error: null };
    const letters: Letters = {
      kind: 'letters',
      signinId: 'ssi_12345678',
      expiresAt: '2026-10-20T12:05:00Z',
      error: null,
    };
    const op = (code: string, details?: unknown) =>
      new OperationError('enroll.screen', 400, code, code, details);
    expect(screenSignInFailed(start, op('unknown_op'), now)).toEqual({ kind: 'stopped', error: E.old });
    expect(screenSignInFailed(start, op('screen_unavailable'), now)).toEqual({
      kind: 'stopped',
      error: E.screen_unavailable,
    });
    expect(screenSignInFailed(start, op('endpoint_enrolled'), now)).toEqual({ kind: 'already' });
    expect(screenSignInFailed(letters, op('screen_code_invalid'), now)).toEqual({
      ...letters,
      error: E.screen_code_invalid,
    });
    expect(screenSignInFailed(letters, op('screen_signin_missing'), now)).toEqual({
      ...letters,
      error: E.screen_signin_missing,
    });
    // The backoff in whole minutes, rounded up, at least one.
    const backoff = (retryAt: string) =>
      screenSignInFailed(letters, op('screen_backoff', { code: 'screen_backoff', retryAt }), now);
    expect(backoff('2026-10-20T12:03:30Z')).toEqual({ ...letters, error: E.screen_backoff(4) });
    expect(backoff('2026-10-20T12:00:10Z')).toEqual({ ...letters, error: E.screen_backoff(1) });
    // Asking for a code can be refused the same way (CT-622): the first step stays.
    expect(
      screenSignInFailed(
        start,
        op('screen_backoff', { code: 'screen_backoff', retryAt: '2026-10-20T12:02:00Z' }),
        now,
      ),
    ).toEqual({ ...start, error: E.screen_backoff(2) });
    expect(E.screen_backoff(4)).toContain('4 min');
    expect(screenSignInFailed(start, op('screen_rate_limited'), now)).toEqual({
      ...start,
      error: E.screen_rate_limited,
    });
    expect(screenSignInFailed(start, op('rate_limited'), now)).toEqual({
      ...start,
      error: COPY.claim.errors.rate_limited,
    });
    for (const code of ['screen_begin_missing', 'screen_share_invalid', 'something_new'])
      expect(screenSignInFailed(letters, op(code), now)).toEqual({
        ...letters,
        error: COPY.claim.errors.failed,
      });
    expect(screenSignInFailed(start, { reason: 'identity_mismatch' }, now)).toEqual({
      kind: 'stopped',
      error: E.notThisOne,
    });
    expect(screenSignInFailed(start, { reason: 'appliance_offline' }, now)).toEqual({
      ...start,
      error: COPY.claim.errors.offline,
    });
    expect(screenSignInFailed(start, new Error('lost'), now)).toEqual({
      ...start,
      error: COPY.claim.errors.failed,
    });
  });

  it('an older Whombat (no such operation) stops at the first step and says it needs an update', async () => {
    const box = newBox();
    box.refuse['enroll.screen.request'] = { status: 404, code: 'unknown_op' };
    expect(await screenSignInRequest(deps(fakeSession(box)), screenSignInStart())).toEqual({
      kind: 'stopped',
      error: E.old,
    });
  });

  it('a refusal speaks the reader’s language when the deps name one, English without', async () => {
    const NL = managedCopyText('nl-NL').screen.errors;
    expect(NL.screen_code_invalid).not.toBe(E.screen_code_invalid);
    const box = newBox();
    const d = { ...deps(fakeSession(box)), locale: 'nl-NL' };
    const at = await lettersStep(d);
    expect(await screenSignInSubmit(d, at, 'KX')).toEqual({ ...at, error: NL.letters });
    expect(await screenSignInSubmit(d, at, 'PRTVWY')).toMatchObject({ error: NL.screen_code_invalid });
    const now = Date.parse('2026-10-20T12:00:00Z');
    const backoff = new OperationError('enroll.screen', 400, 'screen_backoff', 'screen_backoff', {
      code: 'screen_backoff',
      retryAt: '2026-10-20T12:03:30Z',
    });
    expect(screenSignInFailed(at, backoff, now, 'nl-NL')).toEqual({ ...at, error: NL.screen_backoff(4) });
    expect(screenSignInFailed(at, backoff, now)).toEqual({ ...at, error: E.screen_backoff(4) });
  });
});

describe('typing the six letters', () => {
  it('upper-case, spaces and dashes dropped, grouped 3 + 3 as typed', () => {
    expect(formatScreenLettersInput('kxq')).toBe('KXQ');
    expect(formatScreenLettersInput('kxqm')).toBe('KXQ M');
    expect(formatScreenLettersInput('KXQ MTR')).toBe('KXQ MTR');
    expect(formatScreenLettersInput('k-x q m t r x')).toBe('KXQ MTR');
    // Backspace over the space: the group closes again.
    expect(formatScreenLettersInput('KXQ ')).toBe('KXQ');
  });
});

describe('the identity it connects with and pins (BX-03)', () => {
  const known: KnownAppliance = {
    device: DEVICE,
    orgId: 'org_1',
    name: 'Burrow HQ',
    peerId: APPLIANCE,
    pinSource: 'add-link',
    enrolled: false,
    kitPending: false,
  };
  it('a pin is used as it is; one that differs from the directory is the hard stop; none: the directory’s', () => {
    expect(screenSignInPeer(APPLIANCE, APPLIANCE)).toEqual({
      kind: 'connect',
      peerId: APPLIANCE,
      isNew: false,
    });
    expect(screenSignInPeer(APPLIANCE, MITM)).toEqual({
      kind: 'changed',
      pinned: APPLIANCE,
      directory: MITM,
    });
    expect(screenSignInPeer(null, APPLIANCE)).toEqual({ kind: 'connect', peerId: APPLIANCE, isNew: true });
  });
  it('after the tag: the pinned record is let in as it was; a new one pins with `screen`', () => {
    const common = {
      device: DEVICE,
      orgId: 'org_1',
      name: 'Burrow HQ',
      peerId: APPLIANCE,
      accountId: 'acc_mara',
    };
    expect(screenSignedInRecord({ ...common, known })).toEqual({
      ...known,
      enrolled: true,
      accountId: 'acc_mara',
    });
    expect(screenSignedInRecord({ ...common, known: null })).toEqual({
      device: DEVICE,
      orgId: 'org_1',
      name: 'Burrow HQ',
      peerId: APPLIANCE,
      pinSource: 'screen',
      enrolled: true,
      kitPending: false,
      accountId: 'acc_mara',
    });
  });
});
