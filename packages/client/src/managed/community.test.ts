/**
 * The community edition's shared steps (AP-5400…AP-5406): the claim on the box's page against a box that runs the real
 * responder (`localClaimPakeResponder`), links the box made, and what a session's edition leaves out.
 */
import { DEVICE_LINK } from '@whombat/fixtures';
import { claimConfirmEqual, localClaimPakeResponder } from '@whombat/protocol/claim';
import { LOCALE_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import {
  type ApplianceSession,
  ConnectionLostError,
  NotDeliveredError,
  type OperationResponse,
  OutcomeUnknownError,
  type SessionInfo,
} from '../session/types';
import { ClaimMismatchError } from './claim';
import {
  COMMUNITY_TEXT,
  isCommunity,
  joinWithLink,
  LINK_TEXT,
  LocalClaimAccountError,
  LocalClaimLettersError,
  linkErrorText,
  linkTimeLeft,
  localClaimAccountProblem,
  localClaimAlreadyClaimed,
  localClaimErrorText,
  localClaimLettersReady,
  localClaimNext,
  localClaimWantsLetters,
  readLocalLink,
  runLocalClaim,
  sessionHas,
} from './community';

const APPLIANCE = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const CLIENT = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const MITM = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

const ENDPOINT = {
  endpointId: 'end_1',
  peerId: CLIENT,
  label: 'Firefox',
  platform: 'web',
  accountId: 'acc_mara',
  createdAt: '2026-10-24T10:00:00Z',
  lastSeenAt: null,
  current: true,
  revokedAt: null,
  revocation: 'none',
};
const ENROLLED = { accountId: 'acc_mara', name: 'Mara', endpoint: ENDPOINT, authzGeneration: 1 };

interface Box {
  letters: string;
  community: boolean;
  claimed: boolean;
  calls: { op: string; input: Record<string, unknown> }[];
  /** Something that only poses as the box: it answers the proofs with a tag of its own making. */
  impostor?: boolean;
  /** The proof ran out before the claim came (or the letters changed under it). */
  proofGone?: boolean;
  /** Another device claimed it between this one's proofs and its claim. */
  takenMeanwhile?: boolean;
  /** A box from before the proof round: it doesn't know `enroll.claim.local.prove`. */
  noProofRound?: boolean;
  /** The connection drops before this step is sent. */
  dropBefore?: string;
  /** The tie each call carried. */
  ties: unknown[];
}

const err = (status: number, code: string): OperationResponse => ({
  status,
  body: { error: { code, message: code, details: { code } } },
  requestId: 'r',
});
const ok = (body: unknown): OperationResponse => ({ status: 200, body, requestId: 'r' });

/** An enrollment session to a box; `seenClient`: the PeerId the box's Noise session has (a man in the middle differs). */
function box(
  b: Box,
  opts: { seenClient?: string; protocol?: SessionInfo['protocol'] } = {},
): ApplianceSession {
  let started: string | null = null;
  let tags: { client: string; appliance: string } | null = null;
  let proved = false;
  return {
    close() {},
    state: () => ({ status: 'open', info: { protocol: opts.protocol } }),
    async invoke(op: string, raw: unknown, options?: { tie?: unknown }) {
      const input = raw as Record<string, unknown>;
      b.calls.push({ op, input });
      b.ties.push(options?.tie);
      // As the session does: a later step of a tied exchange is refused unsent once its connection is gone.
      if (b.dropBefore === op) throw new ConnectionLostError(op, 'r');
      switch (op) {
        case 'enroll.claim.local.start':
          if (!b.community) return err(403, 'claim_local_unavailable');
          if (b.claimed) return err(409, 'claim_used');
          started = 'lcl_8Hq2mXk3pZ';
          return ok({ claimId: started, expiresAt: '2026-10-24T10:05:00.000Z' });
        case 'enroll.claim.local.begin': {
          if (input.claimId !== started) return err(409, 'claim_start_missing');
          const r = localClaimPakeResponder(
            {
              password: b.letters,
              appliancePeerId: APPLIANCE,
              clientPeerId: opts.seenClient ?? CLIENT,
              claimId: started as string,
            },
            input.share as string,
            rand,
          );
          tags = r.tags;
          return ok({ share: r.share });
        }
        case 'enroll.claim.local.prove': {
          if (b.noProofRound) return err(404, 'unknown_op');
          const mine = tags;
          tags = null;
          if (!mine) return err(409, 'claim_begin_missing');
          if (b.impostor) return ok({ confirm: 'B'.repeat(43) });
          if (!claimConfirmEqual(mine.client, input.confirm as string)) {
            b.letters = b.letters === 'KXQM' ? 'PRTV' : 'KXQM';
            return err(403, 'claim_invalid');
          }
          proved = true;
          return ok({ confirm: mine.appliance });
        }
        case 'enroll.claim.local':
          if (!proved || b.proofGone) return err(409, 'claim_proof_missing');
          proved = false;
          if (b.takenMeanwhile) return err(409, 'claim_used');
          b.claimed = true;
          return ok(ENROLLED);
        case 'enroll.link.accept':
          return ok(ENROLLED);
        default:
          return err(404, 'unknown_op');
      }
    },
  } as unknown as ApplianceSession;
}

const ACCOUNT = { name: 'Mara', email: 'mara@lumio.example.org' };
const claim = (session: ApplianceSession, letters: string, account = ACCOUNT, locale?: string) =>
  runLocalClaim({
    session,
    letters,
    appliancePeerId: APPLIANCE,
    clientPeerId: CLIENT,
    account,
    endpoint: { label: 'Firefox on Mara’s laptop', platform: 'web' },
    randomBytes: rand,
    locale,
  });

/** Whether anything sent names the person or their device. */
const namesThePerson = (calls: Box['calls']) => {
  const sent = JSON.stringify(calls);
  return ['Mara', 'lumio.example.org', 'Firefox'].some((word) => sent.includes(word));
};

const newBox = (over: Partial<Box> = {}): Box => ({
  letters: 'KXQM',
  community: true,
  claimed: false,
  calls: [],
  ties: [],
  ...over,
});

describe('the claim on the box’s page', () => {
  it('makes the first owner with the four letters: the proofs first, then who the person is', async () => {
    const b = newBox();
    const out = await claim(box(b), 'kx-qm');
    expect(out.accountId).toBe('acc_mara');
    expect(b.calls.map((c) => c.op)).toEqual([
      'enroll.claim.local.start',
      'enroll.claim.local.begin',
      'enroll.claim.local.prove',
      'enroll.claim.local',
    ]);
    // Up to and with the proofs nothing names the person; the claim that follows carries no tag.
    expect(namesThePerson(b.calls.slice(0, 3))).toBe(false);
    expect(Object.keys(b.calls[2]?.input ?? {}).sort()).toEqual(['claimId', 'confirm']);
    expect(b.calls[3]?.input).toEqual({
      claimId: 'lcl_8Hq2mXk3pZ',
      account: ACCOUNT,
      endpoint: { label: 'Firefox on Mara’s laptop', platform: 'web' },
    });
  });

  it.each([20, LOCALE_MINOR])('gates the local claim locale on protocol 5.%i', async (minor) => {
    const b = newBox();
    await claim(box(b, { protocol: { major: 5, minor } }), 'KXQM', ACCOUNT, 'nl-be');
    const sent = b.calls.find((call) => call.op === 'enroll.claim.local');
    expect(sent).toBeDefined();
    if (minor === 20) expect(sent?.input).not.toHaveProperty('locale');
    else expect(sent?.input).toHaveProperty('locale', 'nl-BE');
  });

  it('tells something that only poses as the box nothing about the person', async () => {
    const b = newBox({ impostor: true });
    const e = await claim(box(b), 'KXQM').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClaimMismatchError);
    expect(b.calls.map((c) => c.op)).not.toContain('enroll.claim.local');
    expect(namesThePerson(b.calls)).toBe(false);
  });

  it('checks the name and email by the box’s rules before anything is sent', async () => {
    for (const [account, field] of [
      [{ ...ACCOUNT, email: 'mara@lumio' }, 'email'],
      [{ ...ACCOUNT, name: 'x'.repeat(121) }, 'name'],
      [{ ...ACCOUNT, name: '  ' }, 'name'],
    ] as const) {
      const b = newBox();
      const e = await claim(box(b), 'KXQM', account).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LocalClaimAccountError);
      expect((e as LocalClaimAccountError).field).toBe(field);
      expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.account.errors[field]);
      expect(localClaimWantsLetters(e)).toBe(false);
      // No exchange: no try spent on the box.
      expect(b.calls).toEqual([]);
    }
    expect(localClaimAccountProblem(ACCOUNT)).toBeNull();
    expect(localClaimAccountProblem({ ...ACCOUNT, email: 'x' })).toBe(COMMUNITY_TEXT.account.errors.email);
  });

  it('knows four letters of the box’s alphabet from four letters', () => {
    expect(localClaimLettersReady('kxqm')).toBe(true);
    expect(localClaimLettersReady('KX-QM')).toBe(true);
    // No I, L, O, S, U or Z on a box's screen.
    expect(localClaimLettersReady('SOUL')).toBe(false);
    expect(localClaimLettersReady('KXQ')).toBe(false);
  });

  it('goes back to the letters when the proof ran out', async () => {
    const e = await claim(box(newBox({ proofGone: true })), 'KXQM').catch((x: unknown) => x);
    expect((e as OperationError).code).toBe('claim_proof_missing');
    expect(localClaimWantsLetters(e)).toBe(true);
    expect(localClaimAlreadyClaimed(e)).toBe(false);
    expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.tooLong);
  });

  it('says so when another device claimed it first, so the box’s state is read again', async () => {
    const e = await claim(box(newBox({ takenMeanwhile: true })), 'KXQM').catch((x: unknown) => x);
    expect(localClaimAlreadyClaimed(e)).toBe(true);
    expect(localClaimWantsLetters(e)).toBe(false);
    expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.taken);
    const before = await claim(box(newBox({ claimed: true })), 'KXQM').catch((x: unknown) => x);
    expect(localClaimAlreadyClaimed(before)).toBe(true);
  });

  it('sends the person to the right step after each failure', async () => {
    const after = async (b: Box, letters = 'KXQM', account = ACCOUNT) =>
      localClaimNext(await claim(box(b), letters, account).catch((x: unknown) => x));
    // Wrong letters, or a proof that ran out: the letters again.
    expect(await after(newBox(), 'PRTV')).toEqual({ to: 'letters', text: COMMUNITY_TEXT.claim.errors.wrong });
    // The proof is gone, or the connection dropped on the way: the box is asked what it is now, then the letters.
    expect(await after(newBox({ proofGone: true }))).toEqual({
      to: 'reread',
      text: COMMUNITY_TEXT.claim.errors.tooLong,
    });
    expect(await after(newBox({ dropBefore: 'enroll.claim.local' }))).toEqual({
      to: 'reread',
      text: COMMUNITY_TEXT.claim.errors.lostTouch,
    });
    // Claimed by another device: the box as it is now, with nothing to say here.
    expect(await after(newBox({ takenMeanwhile: true }))).toEqual({ to: 'taken' });
    // A name or email the box wouldn't take, or something posing as the box: it stays where the person is.
    expect(await after(newBox(), 'KXQM', { ...ACCOUNT, email: 'mara' })).toEqual({
      to: 'account',
      text: COMMUNITY_TEXT.account.errors.email,
    });
    expect((await after(newBox({ impostor: true }))).to).toBe('account');
  });

  it('keeps the whole exchange on one connection, and never names the person after it dropped', async () => {
    const b = newBox();
    await claim(box(b), 'KXQM');
    // One tie for the four steps: the connection that delivered the box's proof carries the person's details.
    expect(b.ties).toHaveLength(4);
    expect(b.ties[0]).toBeDefined();
    expect(new Set(b.ties).size).toBe(1);
    const dropped = newBox({ dropBefore: 'enroll.claim.local' });
    const e = await claim(box(dropped), 'KXQM').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConnectionLostError);
    expect(dropped.claimed).toBe(false);
  });

  it('asks the box again after it lost touch: a dropped connection, a lost answer, a box it never reached', () => {
    for (const e of [
      new ConnectionLostError('enroll.claim.local', 'r'),
      new OutcomeUnknownError('enroll.claim.local', 'r'),
      new NotDeliveredError('enroll.claim.local.start', 'r'),
    ])
      expect(localClaimNext(e).to).toBe('reread');
    expect(localClaimErrorText(new OutcomeUnknownError('enroll.claim.local', 'r'))).toBe(
      COMMUNITY_TEXT.claim.errors.lostTouch,
    );
    // Never reached at all: the words say so, should the box answer when it is asked again.
    expect(localClaimErrorText(new NotDeliveredError('enroll.claim.local.start', 'r'))).toBe(
      COMMUNITY_TEXT.claim.errors.unreachable,
    );
    const busy = new OperationError('enroll.claim.local.prove', 503, 'claim_busy', 'x');
    expect(localClaimNext(busy)).toEqual({ to: 'account', text: COMMUNITY_TEXT.claim.errors.busy });
  });

  it('points at New letters on the box’s screen when the tries are used up', () => {
    for (const code of ['claim_rate_limited', 'claim_window_closed']) {
      const e = new OperationError('enroll.claim.local.begin', 429, code, 'x', { code });
      expect(localClaimWantsLetters(e)).toBe(true);
      expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.newLetters);
    }
    const old = new OperationError('enroll.claim.local.start', 503, 'claim_update_app', 'x');
    expect(localClaimErrorText(old)).toBe(COMMUNITY_TEXT.claim.errors.updateApp);
  });

  it('never names the person to a box from before the proof round: it says the box needs an update', async () => {
    const b = newBox({ noProofRound: true });
    const e = await claim(box(b), 'KXQM').catch((x: unknown) => x);
    expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.boxTooOld);
    expect(localClaimNext(e).to).toBe('account');
    expect(b.calls.map((c) => c.op)).not.toContain('enroll.claim.local');
    expect(namesThePerson(b.calls)).toBe(false);
  });

  it('a wrong guess is the box’s, and asks for the letters again', async () => {
    const b = newBox();
    const e = await claim(box(b), 'PRTV').catch((x: unknown) => x);
    expect(localClaimWantsLetters(e)).toBe(true);
    expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.wrong);
    expect(b.claimed).toBe(false);
  });

  it('sends nothing for letters that aren’t four', async () => {
    const b = newBox();
    const e = await claim(box(b), 'ABCDE').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalClaimLettersError);
    expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.letters);
    expect(b.calls).toEqual([]);
  });

  it('a man in the middle can’t answer with the box’s tag', async () => {
    const e = await claim(box(newBox(), { seenClient: MITM }), 'KXQM').catch((x: unknown) => x);
    // The box saw another key: its tags differ, so the guess counts as wrong there and nothing is trusted here.
    expect(e instanceof ClaimMismatchError || localClaimWantsLetters(e)).toBe(true);
  });

  it('too many wrong guesses say how long to wait; a box that never answered says it wasn’t reached', () => {
    const now = Date.parse('2026-11-20T23:00:00Z');
    const backoff = new OperationError('claim.local.begin', 429, 'claim_backoff', 'wait', {
      code: 'claim_backoff',
      retryAt: '2026-11-20T23:03:00Z',
    });
    expect(localClaimWantsLetters(backoff)).toBe(true);
    expect(localClaimErrorText(backoff, now)).toBe(COMMUNITY_TEXT.claim.errors.tooMany(3));
    const nobody = new NotDeliveredError('claim.local.start', 'req-1');
    expect(localClaimWantsLetters(nobody)).toBe(false);
    expect(localClaimErrorText(nobody)).toBe(COMMUNITY_TEXT.claim.errors.unreachable);
  });

  it('a commercial box says it’s claimed in the app', async () => {
    const e = await claim(box(newBox({ community: false })), 'KXQM').catch((x: unknown) => x);
    expect(localClaimErrorText(e)).toBe(COMMUNITY_TEXT.claim.errors.notCommunity);
  });
});

describe('links the box makes', () => {
  it('reads the fixtures’ device link', () => {
    const device = readLocalLink(DEVICE_LINK.link);
    expect(device?.kind).toBe('device');
    expect(device?.routes.length).toBeGreaterThan(0);
    expect(readLocalLink('https://example.com/join#s=x')).toBeNull();
  });

  it('lets this device in with a device link', async () => {
    const b = newBox();
    const out = await joinWithLink(
      box(b),
      { secret: 'Dev7mXk3pZQ7rT2vW9yB8nC6' },
      {
        label: 'Firefox',
        platform: 'web',
      },
    );
    expect(out.accountId).toBe('acc_mara');
    expect(b.calls.map((c) => c.op)).toEqual(['enroll.link.accept']);
  });

  it('says why a link didn’t work, by code', async () => {
    const refused = async (code: string) => {
      const s = {
        invoke: async () => err(403, code),
      } as unknown as ApplianceSession;
      return linkErrorText(
        await joinWithLink(s, { secret: 'Dev7mXk3pZQ7rT2vW9yB8nC6' }, { label: 'x', platform: 'web' }).catch(
          (e: unknown) => e,
        ),
      );
    };
    expect(await refused('link_expired')).toBe(LINK_TEXT.errors.expired);
    expect(await refused('link_used')).toBe(LINK_TEXT.errors.used);
    expect(await refused('endpoint_enrolled')).toBe(LINK_TEXT.errors.enrolled);
    expect(await refused('something_new')).toBe(LINK_TEXT.errors.failed);
  });

  it('counts down a five-minute link', () => {
    const now = Date.parse('2026-10-24T10:00:00.000Z');
    expect(linkTimeLeft('2026-10-24T10:05:00.000Z', now)).toBe('5:00');
    expect(linkTimeLeft('2026-10-24T10:00:09.500Z', now)).toBe('0:10');
    expect(linkTimeLeft('2026-10-24T10:00:00.000Z', now)).toBeNull();
  });
});

describe('the edition', () => {
  it('leaves out what a community box doesn’t have', () => {
    expect(isCommunity('community')).toBe(true);
    expect(isCommunity(undefined)).toBe(false);
    expect(sessionHas({ edition: 'community' }, 'remote_help')).toBe(false);
    expect(sessionHas({ edition: 'community' }, 'local_claim')).toBe(true);
    expect(sessionHas({ edition: 'commercial' }, 'licence')).toBe(true);
    expect(sessionHas(null, 'relay')).toBe(true);
  });
});
