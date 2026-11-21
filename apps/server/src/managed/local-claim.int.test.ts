/**
 * The rules of the claim on a box's own pages (docs/decisions/whombat-link.md): the proofs come before the person is
 * named, one verdict at a time across sessions, a start stays on its session, new letters asked for at the box set the
 * counters aside, a proof is good only for its letters and its time, a database that stalls or fails never leaves
 * letters usable or holds up the person at the box, and a failed account write logs nothing of the person. Postgres
 * holds what these rules count and keep: the attempts, the wrong tries and the claim itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { DESK_PATHS } from '@whombat/control-contracts/local';
import {
  CLAIM_FREE_FAILURES,
  CLAIM_WINDOW_S,
  CLAIM_WINDOW_WRONG,
  CLAIM_WINDOW_WRONG_PER_KEY,
} from '@whombat/protocol/claim';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, applianceClaimAttempts, applianceClaimFailures, applianceState } from '../db/schema/index';
import { DeskClaimRoutes } from '../desk/claim-letters';
import { DeskSocket } from '../desk/socket';
import { useManagedRuntime } from '../test/managed';
import { pakeLocalClaim, TestSessionClient, testIdentity } from './testing';
import { CLAIM_ATTEMPTS_PER_PEER, CLAIM_ATTEMPTS_TOTAL, VERDICT_WAIT_MS } from './trust';

const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'wb-local-claim-'));
const m = useManagedRuntime({ env: { WHOMBAT_EDITION: 'community' } });

type Answer = { t: string; code?: string; output?: unknown; details?: { code?: string } };
const codeOf = (a: unknown) => (a as Answer | null)?.details?.code ?? (a as Answer | null)?.code;
const trust = () => m.runtime.trust;
const now = () => m.t.services.clock();
const letters = () => {
  const code = trust().ceremony.codePassword(now());
  if (!code) throw new Error('no letters on the console');
  return code.password;
};
const wrongLetters = () => (letters() === 'AAAA' ? 'BBBB' : 'AAAA');
const ctx = (password: string) => ({ password, appliancePeerId: m.appliance.peerId });
/** The claim id a run of the helper started. */
const claimIdOf = (run: { start: unknown }) => {
  const id = (run.start as { output?: { claimId?: string } } | null)?.output?.claimId;
  if (!id) throw new Error('the claim did not start');
  return id;
};
const failures = async () => (await m.t.services.db.select().from(applianceClaimFailures)).length;

/** Every logger call of the test. */
const logged: unknown[][] = [];
/** How far the box's clock is ahead: each case starts after whatever window the one before left open. */
let ahead = 0;

beforeAll(async () => {
  m.t.services.clock = () => new Date(Date.now() + ahead);
  const log = m.t.services.log as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    const original = log[level]?.bind(log);
    if (!original) continue;
    vi.spyOn(log, level as never).mockImplementation(((...args: unknown[]) => {
      logged.push(args);
      return original(...args);
    }) as never);
  }
  await trust().refreshClaimConsole();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Each case starts with clean counters and no window.
beforeEach(async () => {
  ahead += (CLAIM_WINDOW_S + 1) * 1000;
  trust().ceremony.liveWindow(now());
  await m.t.services.db.delete(applianceClaimFailures);
  await m.t.services.db.delete(applianceClaimAttempts);
  await trust().refreshClaimConsole();
});

describe('the proofs come first', () => {
  it('names the person only after the box’s own proof, once, on the session that proved', async () => {
    const phone = await m.client();
    const proved = await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'prove' });
    expect(proved.prove).toMatchObject({ t: 'result', output: { confirm: proved.tags?.appliance } });
    // Nothing is claimed by the proofs, and another session can't use them.
    expect(await trust().isClaimed()).toBe(false);
    const claimId = claimIdOf(proved);
    const input = {
      claimId,
      account: { name: 'Nobody', email: 'nobody@example.com' },
      endpoint: { label: 'Laptop', platform: 'web' },
    };
    const other = await m.client();
    expect(codeOf(await other.request('enroll.claim.local', input))).toBe('claim_proof_missing');
    expect(await trust().isClaimed()).toBe(false);
    phone.close();
  });

  it('counts a wrong guess at the proofs, before any account was sent', async () => {
    const phone = await m.client();
    const before = letters();
    const wrong = await pakeLocalClaim(phone, ctx(wrongLetters()));
    expect(codeOf(wrong.prove)).toBe('claim_invalid');
    expect(wrong.claim).toBeNull();
    expect(await failures()).toBe(1);
    expect(letters()).not.toBe(before);
    phone.close();
  });

  it('refuses an app from before the proof round, at the start and at the claim', async () => {
    // An app at the earlier minor: told to update before it sends anything.
    const old = new TestSessionClient(m.runtime, testIdentity());
    await old.hello({}, 0);
    expect(codeOf(await old.request('enroll.claim.local.start', {}))).toBe('claim_update_app');
    old.close();
    // The earlier form itself (the client's tag and the account in one request) is refused unread: no guess counted.
    const phone = await m.client();
    const begun = await pakeLocalClaim(phone, ctx(wrongLetters()), undefined, { stop: 'begin' });
    const answer = await phone.request('enroll.claim.local', {
      claimId: claimIdOf(begun),
      confirm: begun.tags?.client,
      account: { name: 'Mara', email: 'mara@example.com' },
      endpoint: { label: 'Phone', platform: 'android' },
    });
    expect(codeOf(answer)).toBe('claim_update_app');
    expect(await failures()).toBe(0);
    expect(await trust().isClaimed()).toBe(false);
    phone.close();
  });
});

describe('one verdict at a time', () => {
  it('tries two proofs sent together against the same letters only once', async () => {
    const a = await m.client();
    const b = await m.client();
    const guess = wrongLetters();
    const begunA = await pakeLocalClaim(a, ctx(guess), undefined, { stop: 'begin' });
    const begunB = await pakeLocalClaim(b, ctx(guess), undefined, { stop: 'begin' });
    const prove = (c: TestSessionClient, begun: typeof begunA) =>
      c.request('enroll.claim.local.prove', {
        claimId: claimIdOf(begun),
        confirm: begun.tags?.client,
      });
    const answers = await Promise.all([prove(a, begunA), prove(b, begunB)]);
    // The first is one wrong guess; by then the letters changed, so the second was never tried against them.
    expect(answers.map(codeOf).sort()).toEqual(['claim_begin_missing', 'claim_invalid']);
    expect(await failures()).toBe(1);
    a.close();
    b.close();
  });
});

describe('new letters asked for at the box', () => {
  const backoff = async () => {
    const at = now();
    await m.t.services.db
      .insert(applianceClaimFailures)
      .values(Array.from({ length: CLAIM_FREE_FAILURES + 3 }, () => ({ method: 'code', peerId: 'x', at })));
    await trust().refreshClaimConsole();
  };
  const usedUp = async () => {
    const at = now();
    await m.t.services.db
      .insert(applianceClaimAttempts)
      .values(Array.from({ length: CLAIM_ATTEMPTS_TOTAL }, (_, i) => ({ peerId: `stranger-${i}`, at })));
  };

  it('ends the wait others caused and gives the person fresh letters that stay', async () => {
    await backoff();
    // The screen says it can be asked for, in the wait too.
    expect(trust().ceremony.consoleState()).toMatchObject({ state: 'backoff', newLetters: true });
    const phone = await m.client();
    expect(codeOf(await phone.request('enroll.claim.local.start', {}))).toBe('claim_backoff');
    const before = letters();
    const until = await trust().openClaimWindow();
    expect(until?.getTime()).toBe(now().getTime() + CLAIM_WINDOW_S * 1000);
    const shown = trust().ceremony.consoleState();
    expect(shown).toMatchObject({ state: 'claimable', lettersUntil: until?.toISOString(), newLetters: true });
    expect(shown?.code).not.toBe(before);
    // Someone else gets it wrong meanwhile: the letters stay, and the person's exchange, begun before, still stands.
    const mine = await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' });
    const stranger = await m.client();
    expect(codeOf((await pakeLocalClaim(stranger, ctx(wrongLetters()))).prove)).toBe('claim_invalid');
    expect(trust().ceremony.consoleState()?.code).toBe(shown?.code);
    const proved = await phone.request('enroll.claim.local.prove', {
      claimId: claimIdOf(mine),
      confirm: mine.tags?.client,
    });
    expect(proved).toMatchObject({ t: 'result' });
    phone.close();
    stranger.close();
  });

  it('gives every device its own tries, whatever others began in the last hour', async () => {
    await usedUp();
    const phone = await m.client();
    expect(codeOf((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin)).toBe(
      'claim_rate_limited',
    );
    await trust().openClaimWindow();
    expect((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin).toMatchObject({
      t: 'result',
    });
    phone.close();
  });

  it('gives a device that used its own tries this hour new ones', async () => {
    const phone = await m.client();
    const at = now();
    await m.t.services.db
      .insert(applianceClaimAttempts)
      .values(Array.from({ length: CLAIM_ATTEMPTS_PER_PEER }, () => ({ peerId: phone.identity.peerId, at })));
    expect(codeOf((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin)).toBe(
      'claim_rate_limited',
    );
    ahead += 1000;
    await trust().openClaimWindow();
    expect((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin).toMatchObject({
      t: 'result',
    });
    phone.close();
  });

  it('lets one device get it wrong twice, and ends early only after wrong tries from several', async () => {
    await trust().openClaimWindow();
    const shown = letters();
    const one = await m.client();
    for (let i = 0; i < CLAIM_WINDOW_WRONG_PER_KEY; i++)
      expect(codeOf((await pakeLocalClaim(one, ctx(wrongLetters()))).prove)).toBe('claim_invalid');
    // That device waits for the next letters; the window and its letters go on for everyone else.
    expect(codeOf((await pakeLocalClaim(one, ctx(letters()))).start)).toBe('claim_rate_limited');
    expect(letters()).toBe(shown);
    let wrong = CLAIM_WINDOW_WRONG_PER_KEY;
    while (wrong < CLAIM_WINDOW_WRONG) {
      const next = await m.client();
      for (let i = 0; i < CLAIM_WINDOW_WRONG_PER_KEY && wrong < CLAIM_WINDOW_WRONG; i++, wrong++)
        expect(codeOf((await pakeLocalClaim(next, ctx(wrongLetters()))).prove)).toBe('claim_invalid');
      next.close();
    }
    // The last wrong try ended it: new letters, and the usual wait again.
    expect(trust().ceremony.liveWindow(now())).toBeNull();
    expect(trust().ceremony.consoleState()).toMatchObject({ state: 'backoff' });
    expect(await failures()).toBe(CLAIM_WINDOW_WRONG);
    one.close();
  });

  it('is asked for on the desk socket, which only the console reaches', async () => {
    const path = join(dir, 'desk.sock');
    const socket = new DeskSocket(m.t.services, {} as never, [
      new DeskClaimRoutes({ newLetters: () => trust().openClaimWindow() }),
    ]);
    await socket.listen(path);
    const post = (body: unknown) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            socketPath: path,
            path: DESK_PATHS.claimLetters,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    try {
      const before = letters();
      expect(await post({ v: 1, extra: true })).toBe(400);
      expect(letters()).toBe(before);
      expect(await post({ v: 1 })).toBe(200);
      expect(letters()).not.toBe(before);
      expect(trust().ceremony.liveWindow(now())).not.toBeNull();
    } finally {
      await socket.close();
    }
  });

  it('is what a box whose manager requires a claim window waits for', async () => {
    await trust().setClaimWindow({ required: true, openUntil: null });
    try {
      const phone = await m.client();
      expect(codeOf((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin)).toBe(
        'claim_window_closed',
      );
      await trust().openClaimWindow();
      expect((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin).toMatchObject(
        { t: 'result' },
      );
      phone.close();
    } finally {
      await trust().setClaimWindow({ required: false, openUntil: null });
    }
  });
});

describe('a proof is good for its letters and its time', () => {
  const account = {
    account: { name: 'Nobody', email: 'nobody@example.com' },
    endpoint: { label: 'Laptop', platform: 'web' },
  };

  it('ends when its exchange would have: proving gives no new time', async () => {
    const phone = await m.client();
    const begun = await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' });
    // Proved near the end of the exchange's two minutes.
    ahead += 100_000;
    const claimId = claimIdOf(begun);
    expect(
      await phone.request('enroll.claim.local.prove', { claimId, confirm: begun.tags?.client }),
    ).toMatchObject({ t: 'result' });
    ahead += 21_000;
    expect(codeOf(await phone.request('enroll.claim.local', { claimId, ...account }))).toBe(
      'claim_proof_missing',
    );
    expect(await trust().isClaimed()).toBe(false);
    phone.close();
  });

  it('ends when new letters are asked for at the box', async () => {
    const phone = await m.client();
    const proved = await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'prove' });
    expect(proved.prove).toMatchObject({ t: 'result' });
    await trust().openClaimWindow();
    expect(
      codeOf(await phone.request('enroll.claim.local', { claimId: claimIdOf(proved), ...account })),
    ).toBe('claim_proof_missing');
    expect(await trust().isClaimed()).toBe(false);
    phone.close();
  });

  it('never finishes in the next window where the manager requires one', async () => {
    await trust().setClaimWindow({ required: true, openUntil: null });
    try {
      // Proved in the last seconds of the letters asked for at the box.
      await trust().openClaimWindow();
      ahead += (CLAIM_WINDOW_S - 10) * 1000;
      const phone = await m.client();
      const proved = await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'prove' });
      expect(proved.prove).toMatchObject({ t: 'result' });
      ahead += 15_000;
      await trust().openClaimWindow();
      expect(
        codeOf(await phone.request('enroll.claim.local', { claimId: claimIdOf(proved), ...account })),
      ).toBe('claim_proof_missing');
      // The manager's own window, once the letters asked for at the box ran out: a proof made in one is over with
      // it, however soon the next opens.
      ahead += (CLAIM_WINDOW_S + 1) * 1000;
      trust().ceremony.liveWindow(now());
      await trust().setClaimWindow({ required: true, openUntil: new Date(now().getTime() + 30_000) });
      const again = await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'prove' });
      expect(again.prove).toMatchObject({ t: 'result' });
      ahead += 31_000;
      await trust().setClaimWindow({ required: true, openUntil: new Date(now().getTime() + 60_000) });
      expect(
        codeOf(await phone.request('enroll.claim.local', { claimId: claimIdOf(again), ...account })),
      ).toBe('claim_proof_missing');
      expect(await trust().isClaimed()).toBe(false);
      phone.close();
    } finally {
      await trust().setClaimWindow({ required: false, openUntil: null });
    }
  });
});

describe('a device’s tries on letters asked for at the box', () => {
  it('are its own however many exchanges it began before its first wrong one', async () => {
    await trust().openClaimWindow();
    const device = testIdentity();
    const guess = wrongLetters();
    // One device, several sessions, each with an exchange begun before any verdict.
    const sessions = [];
    for (let i = 0; i <= CLAIM_WINDOW_WRONG_PER_KEY; i++) {
      const session = await m.client(device);
      sessions.push({
        session,
        begun: await pakeLocalClaim(session, ctx(guess), undefined, { stop: 'begin' }),
      });
    }
    const answers = await Promise.all(
      sessions.map(({ session, begun }) =>
        session.request('enroll.claim.local.prove', {
          claimId: claimIdOf(begun),
          confirm: begun.tags?.client,
        }),
      ),
    );
    // The device's tries, then a refusal that tries nothing.
    expect(answers.map(codeOf).sort()).toEqual([
      ...Array.from({ length: CLAIM_WINDOW_WRONG_PER_KEY }, () => 'claim_invalid'),
      'claim_rate_limited',
    ]);
    expect(await failures()).toBe(CLAIM_WINDOW_WRONG_PER_KEY);
    for (const { session } of sessions) session.close();
  });

  it('counts the exchanges it began on those letters, whatever the clock says', async () => {
    // The clock stands still: every exchange is recorded at the very moment the letters were asked for.
    const stopped = now();
    const clock = m.t.services.clock;
    m.t.services.clock = () => stopped;
    try {
      await trust().openClaimWindow();
      const phone = await m.client();
      for (let i = 0; i < CLAIM_ATTEMPTS_PER_PEER; i++)
        expect(
          (await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin,
        ).toMatchObject({ t: 'result' });
      expect(codeOf((await pakeLocalClaim(phone, ctx(letters()), undefined, { stop: 'begin' })).begin)).toBe(
        'claim_rate_limited',
      );
      // Another device has its own.
      const other = await m.client();
      expect((await pakeLocalClaim(other, ctx(letters()), undefined, { stop: 'begin' })).begin).toMatchObject(
        {
          t: 'result',
        },
      );
      phone.close();
      other.close();
    } finally {
      m.t.services.clock = clock;
    }
  });
});

describe('a database that stalls or fails', () => {
  const db = () => m.t.services.db;

  it('never holds up a verdict or new letters, and the wrong try still counts', async () => {
    const phone = await m.client();
    const begun = await pakeLocalClaim(phone, ctx(wrongLetters()), undefined, { stop: 'begin' });
    const before = letters();
    // Someone else holds the table the wrong try is counted in.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken = () => {};
    const locked = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const lock = db().transaction(async (tx) => {
      await tx.execute(sql`lock table appliance_claim_failures in access exclusive mode`);
      taken();
      await held;
    });
    await locked;
    trust().verdictWaitMs = 400;
    try {
      const answer = await phone.request('enroll.claim.local.prove', {
        claimId: claimIdOf(begun),
        confirm: begun.tags?.client,
      });
      // The try is spent and what it was tried against is gone, though nothing could be written.
      expect(codeOf(answer)).toBe('claim_invalid');
      expect(letters()).not.toBe(before);
      // The person at the box isn't kept waiting either.
      expect(await trust().openClaimWindow()).not.toBeNull();
    } finally {
      trust().verdictWaitMs = VERDICT_WAIT_MS;
      release();
      await lock;
    }
    // Counted once the database takes it.
    await trust().claimBackoff(now());
    expect(await failures()).toBe(1);
    phone.close();
  });

  it('retires letters asked for at the box when a wrong try on them can’t be counted', async () => {
    await trust().openClaimWindow();
    const shown = letters();
    const phone = await m.client();
    const begun = await pakeLocalClaim(phone, ctx(wrongLetters()), undefined, { stop: 'begin' });
    await db().execute(sql`alter table appliance_claim_failures rename to appliance_claim_failures_away`);
    try {
      const answer = await phone.request('enroll.claim.local.prove', {
        claimId: claimIdOf(begun),
        confirm: begun.tags?.client,
      });
      expect(codeOf(answer)).toBe('claim_invalid');
      expect(trust().ceremony.liveWindow(now())).toBeNull();
      expect(letters()).not.toBe(shown);
    } finally {
      await db().execute(sql`alter table appliance_claim_failures_away rename to appliance_claim_failures`);
    }
    await trust().claimBackoff(now());
    expect(await failures()).toBe(1);
    phone.close();
  });
});

describe('the claim itself', () => {
  it('logs nothing of the person when the account can’t be written', async () => {
    const phone = await m.client();
    // Postgres refuses a NUL in text: the insert fails with the name and email among its values.
    const name = 'Zebedee\u0000Quince';
    const email = 'zebedee.quince@example.com';
    const failed = await pakeLocalClaim(phone, ctx(letters()), {
      account: { name, email },
      endpoint: { label: 'Phone', platform: 'android' },
    });
    expect(failed.claim).toMatchObject({ t: 'error', code: 'internal' });
    const said = JSON.stringify(logged);
    expect(said).toContain('DatabaseFailure');
    expect(said).not.toContain('Zebedee');
    expect(said).not.toContain('zebedee.quince');
    expect(await trust().isClaimed()).toBe(false);
    phone.close();
  });

  it('makes the person from a proved session, and tells a second phone it is taken', async () => {
    const phone = await m.client();
    const other = await m.client();
    const waiting = await pakeLocalClaim(other, ctx(letters()), undefined, { stop: 'prove' });
    const done = await pakeLocalClaim(phone, ctx(letters()), {
      account: { name: 'Mara', email: 'mara@example.com' },
      endpoint: { label: 'Phone', platform: 'android' },
    });
    expect(done.claim).toMatchObject({ t: 'result', output: { name: 'Mara' } });
    const [state] = await m.t.services.db.select().from(applianceState).where(eq(applianceState.id, 1));
    const [account] = await m.t.services.db
      .select()
      .from(accounts)
      .where(eq(accounts.email, 'mara@example.com'));
    expect(state?.claimedByAccountId).toBe(account?.id);
    // The other phone proved in time but lost: its claim says so, and it starts nothing new.
    const lost = await other.request('enroll.claim.local', {
      claimId: claimIdOf(waiting),
      account: { name: 'Other', email: 'other@example.com' },
      endpoint: { label: 'Laptop', platform: 'web' },
    });
    expect(codeOf(lost)).toBe('claim_used');
    expect(codeOf(await other.request('enroll.claim.local.start', {}))).toBe('claim_used');
    expect(await trust().openClaimWindow()).toBeNull();
    phone.close();
    other.close();
  });
});
