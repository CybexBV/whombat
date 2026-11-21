/**
 * Signing in by the computer's QR code (AP-530…AP-539): the error mapping, the plan against the pin and the directory,
 * the retries, and the run after the sign-in — with the MAC checked the way the computer checks it.
 */
import {
  type ApplianceSummary,
  ControlError,
  type ControlSession,
  type KnownAppliance,
  type PhoneHandoffReport,
  verifyPhoneHandoffReport,
} from '@whombat/client/managed';
import { EnrollPairRequestInput } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  Cancelled,
  HANDOFF_LIFETIME_MS,
  type HandoffDeps,
  type HandoffInput,
  type PairState,
  type PhoneSignInView,
  pairingReport,
  phoneErrorActions,
  planHandoff,
  redeemErrorOf,
  redeemPhoneToken,
  reportErrorOf,
  runPhoneHandoff,
  withRetry,
} from './phoneSignIn';

const PEER = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const OTHER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const FINGERPRINT = 'AB12-CD34-EF56';

const entry = (over: Partial<ApplianceSummary> = {}): ApplianceSummary => ({
  device: 'dev_1',
  orgId: 'org_1',
  name: 'Burrow HQ',
  state: 'claimed',
  contentPeerId: PEER,
  lastSeenAt: null,
  revocationsPending: 0,
  ...over,
});

const record = (over: Partial<KnownAppliance> = {}): KnownAppliance => ({
  device: 'dev_1',
  orgId: 'org_1',
  name: 'Old name',
  peerId: PEER,
  pinSource: 'claim',
  enrolled: false,
  kitPending: false,
  ...over,
});

describe('what went wrong', () => {
  it('reads control’s refusals of the token and the report', () => {
    expect(redeemErrorOf(new ControlError('signed_out', 'link_invalid'))).toBe('expired');
    expect(redeemErrorOf(new ControlError('invalid_link', 'x'))).toBe('expired');
    expect(redeemErrorOf(new ControlError('rate_limited', 'x'))).toBe('tooMany');
    expect(redeemErrorOf(new ControlError('unavailable', 'x'))).toBe('unreachable');
    expect(redeemErrorOf(new Error('boom'))).toBe('failed');
    expect(reportErrorOf(new ControlError('handoff_expired', 'x'))).toBe('over');
    expect(reportErrorOf(new ControlError('not_found', 'x'))).toBe('over');
    expect(reportErrorOf(new ControlError('unavailable', 'x'))).toBe('unreachable');
  });

  it('offers scanning again for a code that’s over, trying again for a connection, and email only signed out', () => {
    expect(phoneErrorActions('expired', false)).toEqual(['scan', 'back', 'email']);
    expect(phoneErrorActions('expired', true)).toEqual(['scan', 'back']);
    expect(phoneErrorActions('denied', true)).toEqual(['scan', 'back']);
    expect(phoneErrorActions('pairExpired', true)).toEqual(['scan', 'back']);
    expect(phoneErrorActions('unreachable', false)).toEqual(['retry', 'back', 'email']);
    expect(phoneErrorActions('whombatUnreachable', true)).toEqual(['retry', 'back']);
    expect(phoneErrorActions('notInOrg', true)).toEqual(['back']);
    expect(phoneErrorActions('retired', true)).toEqual(['back']);
    expect(phoneErrorActions('tooMany', false)).toEqual(['back', 'email']);
  });
});

describe('retries', () => {
  it('repeats a call control didn’t answer, with growing waits, then gives up', async () => {
    const waits: number[] = [];
    let calls = 0;
    const work = async () => {
      calls++;
      throw new ControlError('unavailable', 'x');
    };
    await expect(withRetry(work, { sleep: async (ms) => void waits.push(ms) })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it('doesn’t repeat a refusal', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ControlError('handoff_expired', 'x');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ControlError);
    expect(calls).toBe(1);
  });
});

describe('the token', () => {
  const session: ControlSession = {
    account: { accountId: 'acc_1', email: 'mara@burrowhq.example', name: 'Mara' },
    orgs: [],
  };

  it('is exchanged once however often the link arrives; a failure is forgotten so it can be tried again', async () => {
    let calls = 0;
    let fail = true;
    const control = {
      redeemPhoneHandoff: async () => {
        calls++;
        if (fail) throw new ControlError('unavailable', 'x');
        return { session, handoffId: 'ph_1' };
      },
    };
    await expect(redeemPhoneToken(control, 'tok_a_0123456789abcdefghij')).rejects.toBeInstanceOf(
      ControlError,
    );
    fail = false;
    const [a, b] = await Promise.all([
      redeemPhoneToken(control, 'tok_a_0123456789abcdefghij'),
      redeemPhoneToken(control, 'tok_a_0123456789abcdefghij'),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
  });
});

describe('the Whombat in the code', () => {
  const appliance = { device: 'dev_1', peerId: PEER };

  it('signs in only when the code names none', () => {
    expect(planHandoff({ appliance: null, orgId: 'org_1', known: undefined, directory: [] })).toEqual({
      kind: 'signedIn',
    });
  });

  it('pins a new Whombat from the code (as an add-a-device link) and asks to be let in', () => {
    const plan = planHandoff({ appliance, orgId: 'org_1', known: undefined, directory: [entry()] });
    expect(plan).toEqual({
      kind: 'pair',
      isNew: true,
      known: {
        device: 'dev_1',
        orgId: 'org_1',
        name: 'Burrow HQ',
        peerId: PEER,
        pinSource: 'add-link',
        enrolled: false,
        kitPending: false,
      },
    });
  });

  it('opens a Whombat this phone is already let in to, and pairs with a pinned one it isn’t', () => {
    expect(
      planHandoff({ appliance, orgId: 'org_1', known: record({ enrolled: true }), directory: [entry()] }),
    ).toEqual({ kind: 'open', known: record({ enrolled: true, name: 'Burrow HQ' }) });
    expect(planHandoff({ appliance, orgId: 'org_1', known: record(), directory: [entry()] })).toEqual({
      kind: 'pair',
      isNew: false,
      known: record({ name: 'Burrow HQ' }),
    });
  });

  it('stops hard when the pin or the code disagree with the directory, and knows another org’s Whombat', () => {
    expect(
      planHandoff({
        appliance,
        orgId: 'org_1',
        known: record(),
        directory: [entry({ contentPeerId: OTHER })],
      }),
    ).toEqual({ kind: 'stop', stop: 'changed', device: 'dev_1', pinned: true });
    expect(
      planHandoff({
        appliance: { device: 'dev_1', peerId: OTHER },
        orgId: 'org_1',
        known: undefined,
        directory: [entry()],
      }),
    ).toEqual({ kind: 'stop', stop: 'link', device: 'dev_1', pinned: false });
    expect(planHandoff({ appliance, orgId: 'org_1', known: undefined, directory: [] })).toEqual({
      kind: 'notInOrg',
    });
    // A retired Whombat (AP-696): nothing is asked or pinned, pinned here or not.
    for (const known of [record(), undefined])
      expect(
        planHandoff({ appliance, orgId: 'org_1', known, directory: [entry({ state: 'retired' })] }),
      ).toEqual({ kind: 'retired' });
  });
});

/* The run after the sign-in, against fakes -------------------------------------------------------------------- */

interface World {
  directory: ApplianceSummary[] | Error;
  known: KnownAppliance | undefined;
  statuses: (PairState | Error)[];
  reportFailures: Error[];
  sessionFails?: boolean;
  /** The box knows this phone already (restored from a backup). */
  inAlready?: boolean;
}

function harness(world: World) {
  const log = {
    pinned: [] as KnownAppliance[],
    reports: [] as PhoneHandoffReport[],
    views: [] as PhoneSignInView[],
    requests: [] as unknown[],
    closed: 0,
    waits: [] as number[],
  };
  let clock = 0;
  const deps: HandoffDeps<{ id: string }> = {
    directory: async () => {
      if (world.directory instanceof Error) throw world.directory;
      return world.directory;
    },
    known: () => world.known,
    pin: (r) => void log.pinned.push(r),
    report: async (_id, report) => {
      const failure = world.reportFailures.shift();
      if (failure) throw failure;
      log.reports.push(report);
    },
    openSession: async () => {
      if (world.sessionFails) throw new Error('closed');
      return { id: 's' };
    },
    letIn: () => (world.inAlready ? { accountId: 'acc_7' } : null),
    pairRequest: async (_s, input) => {
      // As the session call does: a request the contract refuses never leaves the phone.
      log.requests.push(EnrollPairRequestInput.parse(input));
      return { pairingId: 'pair_1', code: '1234-5678' };
    },
    pairStatus: async () => {
      const next = world.statuses.shift() ?? 'pending';
      if (next instanceof Error) throw next;
      return next === 'approved' ? { state: next, enrolled: { accountId: 'acc_9' } } : { state: next };
    },
    close: () => void log.closed++,
    sleep: async (ms) => {
      log.waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  const input = (appliance: HandoffInput['handoff']['appliance']): HandoffInput => ({
    handoff: { handoffId: 'ph_1234abcd', key: KEY, appliance },
    orgId: 'org_1',
    label: 'Pixel 9 · Android app',
    platform: 'android',
    fingerprint: FINGERPRINT,
  });
  const run = (appliance: HandoffInput['handoff']['appliance'] = { device: 'dev_1', peerId: PEER }) =>
    runPhoneHandoff(deps, input(appliance), (v) => void log.views.push(v), new AbortController().signal);
  return { log, run, deps, input };
}

describe('after the sign-in', () => {
  it('reports the pairing with a MAC over exactly the code and fingerprint it reports, then waits for approval', async () => {
    const { log, run } = harness({
      directory: [entry()],
      known: undefined,
      statuses: ['pending', 'pending', 'approved'],
      reportFailures: [],
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'approved', accountId: 'acc_9', known: { pinSource: 'add-link' } });
    expect(log.pinned).toHaveLength(1);
    expect(log.requests).toEqual([{ endpoint: { label: 'Pixel 9 · Android app', platform: 'android' } }]);
    const report = log.reports[0];
    if (report?.kind !== 'pairing') throw new Error('expected a pairing report');
    expect(report).toMatchObject({ code: '1234-5678', fingerprint: FINGERPRINT });
    expect(verifyPhoneHandoffReport(KEY, 'ph_1234abcd', report)).toBe(true);
    expect(verifyPhoneHandoffReport(KEY, 'ph_other000', report)).toBe(false);
    expect(report).toEqual(pairingReport(KEY, 'ph_1234abcd', '1234-5678', FINGERPRINT));
    expect(log.views).toEqual([
      { kind: 'working', stage: 'asking' },
      { kind: 'confirm', label: 'Pixel 9 · Android app', fingerprint: FINGERPRINT },
    ]);
    expect(log.closed).toBe(1);
  });

  it('a Whombat that knows this phone already (restored from a backup) opens without pairing', async () => {
    const { log, run } = harness({
      directory: [entry()],
      known: undefined,
      statuses: [],
      reportFailures: [],
      inAlready: true,
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ kind: 'approved', accountId: 'acc_7', known: { pinSource: 'add-link' } });
    expect(log.pinned).toHaveLength(1);
    expect(log.requests).toEqual([]);
    expect(log.reports).toEqual([{ kind: 'signed_in' }]);
    expect(log.closed).toBe(1);
  });

  it('a code naming a retired Whombat says so: no session, no pin, no pairing report (AP-696)', async () => {
    const { log, run } = harness({
      directory: [entry({ state: 'retired' })],
      known: record(),
      statuses: [],
      reportFailures: [],
    });
    const outcome = await run();
    expect(outcome).toEqual({ kind: 'failed', stage: 'asking', error: 'retired' });
    expect(log.views.at(-1)).toEqual(outcome);
    expect(log.pinned).toEqual([]);
    expect(log.reports).toEqual([]);
    expect(log.requests).toEqual([]);
  });

  it('only reports `signed_in` without a Whombat, or when already let in (and opens it)', async () => {
    const none = harness({ directory: [], known: undefined, statuses: [], reportFailures: [] });
    expect(await none.run(null)).toEqual({ kind: 'signedIn' });
    expect(none.log.reports).toEqual([{ kind: 'signed_in' }]);

    const enrolled = harness({
      directory: [entry()],
      known: record({ enrolled: true }),
      statuses: [],
      reportFailures: [],
    });
    expect(await enrolled.run()).toMatchObject({
      kind: 'open',
      known: { device: 'dev_1', name: 'Burrow HQ' },
    });
    expect(enrolled.log.reports).toEqual([{ kind: 'signed_in' }]);
    expect(enrolled.log.requests).toEqual([]);
  });

  it('goes on when the courtesy `signed_in` report doesn’t get through', async () => {
    const h = harness({
      directory: [],
      known: undefined,
      statuses: [],
      reportFailures: [new ControlError('handoff_expired', 'x')],
    });
    expect(await h.run(null)).toEqual({ kind: 'signedIn' });
  });

  it('retries a report control didn’t take, then says so', async () => {
    const flaky = harness({
      directory: [entry()],
      known: undefined,
      statuses: ['approved'],
      reportFailures: [new ControlError('unavailable', 'x'), new ControlError('unavailable', 'x')],
    });
    expect(await flaky.run()).toMatchObject({ kind: 'approved' });
    expect(flaky.log.waits.slice(0, 2)).toEqual([1000, 2000]);

    const down = harness({
      directory: [entry()],
      known: undefined,
      statuses: [],
      reportFailures: Array.from({ length: 4 }, () => new ControlError('unavailable', 'x')),
    });
    expect(await down.run()).toEqual({ kind: 'failed', stage: 'asking', error: 'unreachable' });
    expect(down.log.closed).toBe(1);

    const over = harness({
      directory: [entry()],
      known: undefined,
      statuses: [],
      reportFailures: [new ControlError('handoff_expired', 'x')],
    });
    expect(await over.run()).toEqual({ kind: 'failed', stage: 'asking', error: 'over' });
  });

  it('says when the computer declined, nobody confirmed in time, or the Whombat didn’t answer', async () => {
    const denied = harness({
      directory: [entry()],
      known: undefined,
      statuses: ['denied'],
      reportFailures: [],
    });
    expect(await denied.run()).toEqual({ kind: 'failed', stage: 'confirm', error: 'denied' });
    const expired = harness({
      directory: [entry()],
      known: undefined,
      statuses: [new Error('reconnecting'), 'expired'],
      reportFailures: [],
    });
    expect(await expired.run()).toEqual({ kind: 'failed', stage: 'confirm', error: 'pairExpired' });
    expect(expired.log.waits).toContain(3000);
    const offline = harness({
      directory: [entry()],
      known: undefined,
      statuses: [],
      reportFailures: [],
      sessionFails: true,
    });
    expect(await offline.run()).toEqual({ kind: 'failed', stage: 'asking', error: 'whombatUnreachable' });
    expect(offline.log.reports).toEqual([]);
  });

  it('stops polling when the handoff’s 15 minutes are over', async () => {
    const h = harness({ directory: [entry()], known: undefined, statuses: [], reportFailures: [] });
    const outcome = await h.run();
    expect(outcome).toEqual({ kind: 'failed', stage: 'confirm', error: 'pairExpired' });
    expect(h.log.waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(HANDOFF_LIFETIME_MS - 2000);
  });

  it('never sends anything to a Whombat whose identity disagrees', async () => {
    const h = harness({
      directory: [entry({ contentPeerId: OTHER })],
      known: undefined,
      statuses: [],
      reportFailures: [],
    });
    expect(await h.run()).toEqual({ kind: 'stop', stop: 'link', device: 'dev_1', pinned: false });
    expect(h.log.pinned).toEqual([]);
    expect(h.log.requests).toEqual([]);
    expect(h.log.reports).toEqual([]);
  });

  it('can’t reach the directory: says so after the retries', async () => {
    const h = harness({
      directory: new ControlError('unavailable', 'x'),
      known: undefined,
      statuses: [],
      reportFailures: [],
    });
    expect(await h.run()).toEqual({ kind: 'failed', stage: 'asking', error: 'unreachable' });
  });

  it('stops quietly when cancelled, closing the session', async () => {
    const h = harness({ directory: [entry()], known: undefined, statuses: [], reportFailures: [] });
    const abort = new AbortController();
    h.deps.sleep = async (_ms, signal) => {
      abort.abort();
      if (signal?.aborted) throw new Cancelled();
    };
    const outcome = await runPhoneHandoff(
      h.deps,
      h.input({ device: 'dev_1', peerId: PEER }),
      () => {},
      abort.signal,
    );
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(h.log.closed).toBe(1);
  });
});
