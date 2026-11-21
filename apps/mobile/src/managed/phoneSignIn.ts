/**
 * Signing this phone in by the QR code the computer shows (CT-190, AP-530…AP-539): the decisions of the flow, kept
 * pure so they are unit-tested (`phoneSignIn.test.ts`); the screens only draw what this module says.
 *
 * 1. The scanned link's token becomes this phone's cloud session (`redeemPhoneToken`, once per token).
 * 2. With no Whombat in the code, the phone reports `signed_in` and goes on to the list. With one, the phone compares
 *    it with its pin and this organization's directory exactly as for an add-a-device link (AP-64; `planHandoff`):
 *    a new identity is pinned from the code (made by a browser that trusts the Whombat), a mismatch is a hard stop.
 *    Already let in there: `signed_in`, and it opens. Otherwise it asks the Whombat to pair (`enroll.pair.request`)
 *    and reports the code, its own fingerprint and the MAC under the QR code's key, so the computer lets it in.
 * 3. “Confirm on your computer”: the fingerprint, large, while the phone polls the pairing until it is decided.
 */
import {
  type ApplianceSummary,
  ControlError,
  type ControlSession,
  type KnownAppliance,
  type PhoneHandoffReport,
  type PhoneSignInLink,
  phoneHandoffMac,
  pinnedRecord,
  trustDecision,
} from '@whombat/client/managed';
import type { EnrollPairRequestInput } from '@whombat/protocol/session';
import type { z } from 'zod';

/* The steps and what can go wrong ------------------------------------------------------------------------------ */

/** The three steps the progress screen lists, in order. */
export const PHONE_STAGES = ['signingIn', 'asking', 'confirm'] as const;
export type PhoneStage = (typeof PHONE_STAGES)[number];

export type PhoneSignInError =
  /** The token is expired, used or not one control knows: show a new code and scan again. */
  | 'expired'
  /** The handoff's 15 minutes are over, or control no longer knows it: scan again. */
  | 'over'
  | 'tooMany'
  /** Control didn't answer (after the retries): try again. */
  | 'unreachable'
  /** The Whombat in the code isn't in this account's organization. */
  | 'notInOrg'
  /** The Whombat in the code was retired (AP-696): no phone joins it any more. */
  | 'retired'
  /** The Whombat didn't answer the enrollment session. */
  | 'whombatUnreachable'
  /** Somebody on the computer declined this phone. */
  | 'denied'
  /** Nobody confirmed before the pairing request expired. */
  | 'pairExpired'
  | 'failed';

/** What the flow shows. */
export type PhoneSignInView =
  | { kind: 'working'; stage: 'signingIn' | 'asking' }
  | { kind: 'confirm'; label: string; fingerprint: string }
  | { kind: 'failed'; stage: PhoneStage; error: PhoneSignInError };

/** `auth.redeemPhoneHandoff`'s refusals (`link_invalid` is a 401, so `signed_out`). */
export function redeemErrorOf(error: unknown): PhoneSignInError {
  if (!(error instanceof ControlError)) return 'failed';
  switch (error.code) {
    case 'signed_out':
    case 'invalid_link':
    case 'not_found':
    case 'forbidden':
      return 'expired';
    case 'rate_limited':
      return 'tooMany';
    case 'unavailable':
      return 'unreachable';
    default:
      return 'failed';
  }
}

/** `auth.reportPhoneHandoff`'s and the directory's refusals. */
export function reportErrorOf(error: unknown): PhoneSignInError {
  if (!(error instanceof ControlError)) return 'failed';
  switch (error.code) {
    case 'handoff_expired':
    case 'not_found':
    case 'signed_out':
    case 'forbidden':
      return 'over';
    case 'rate_limited':
    case 'unavailable':
      return 'unreachable';
    default:
      return 'failed';
  }
}

/** Control calls worth repeating: it didn't answer, or asked us to slow down. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ControlError && (error.code === 'unavailable' || error.code === 'rate_limited');
}

/** The waits before each repeat of a control call that didn't get through (three repeats, then an error). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
/** How often the phone asks its Whombat whether the computer decided (as `PairScreen`). */
export const PAIR_POLL_MS = 1500;
/** After a failed poll (the session reconnects by itself). */
export const PAIR_POLL_RETRY_MS = 3000;
/** The handoff lives 15 minutes (`PHONE_HANDOFF_TTL_S`, CT-190): nobody can confirm after that. */
export const HANDOFF_LIFETIME_MS = 15 * 60 * 1000;

export class Cancelled extends Error {
  override name = 'Cancelled';
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** `setTimeout` as a promise that rejects with `Cancelled` when `signal` aborts. */
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** `work`, repeated after each of `delays` while it fails with a retryable error; the last error is thrown. */
export async function withRetry<T>(
  work: () => Promise<T>,
  options: { delays?: readonly number[]; sleep?: Sleep; signal?: AbortSignal } = {},
): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new Cancelled();
    try {
      return await work();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      await wait(delay, options.signal);
    }
  }
}

/* 1. The token → this phone's cloud session ------------------------------------------------------------------ */

export interface PhoneHandoff {
  handoffId: string;
  /** The QR code's key: the MAC over the pairing report. */
  key: string;
  appliance: PhoneSignInLink['appliance'];
}

const redemptions = new Map<string, Promise<{ session: ControlSession; handoffId: string }>>();

/**
 * One request per token, however often a link arrives (the same app link can be delivered twice); a failed attempt
 * is forgotten so “Try again” asks again.
 */
export function redeemPhoneToken(
  control: { redeemPhoneHandoff(token: string): Promise<{ session: ControlSession; handoffId: string }> },
  token: string,
): Promise<{ session: ControlSession; handoffId: string }> {
  let p = redemptions.get(token);
  if (!p) {
    p = control.redeemPhoneHandoff(token);
    redemptions.set(token, p);
    p.catch(() => redemptions.delete(token));
  }
  return p;
}

/* 2. The Whombat in the code, checked against this phone's pin and the directory ------------------------------- */

export type HandoffPlan =
  /** The code names no Whombat: signed in, nothing more to do. */
  | { kind: 'signedIn' }
  /** Not in this account's organization (or the directory doesn't list it). */
  | { kind: 'notInOrg' }
  /** The directory lists it retired (AP-696): nothing to ask, nothing pinned. */
  | { kind: 'retired' }
  /** This phone's pin differs from the directory (`changed`), or the code names another identity (`link`). */
  | { kind: 'stop'; stop: 'changed' | 'link'; device: string; pinned: boolean }
  /** Already let in there. */
  | { kind: 'open'; known: KnownAppliance }
  /** Ask to be let in; `isNew`: `known` is a new pin from the code, to be stored first. */
  | { kind: 'pair'; known: KnownAppliance; isNew: boolean };

export function planHandoff(input: {
  appliance: PhoneSignInLink['appliance'];
  orgId: string;
  known: KnownAppliance | undefined;
  /** This organization's directory (compared with pins, never copied into one; AP-64). */
  directory: readonly ApplianceSummary[];
}): HandoffPlan {
  const { appliance, orgId, known } = input;
  if (!appliance) return { kind: 'signedIn' };
  const entry = input.directory.find((a) => a.device === appliance.device);
  if (!entry) return { kind: 'notInOrg' };
  if (entry.state === 'retired') return { kind: 'retired' };
  const decision = trustDecision({
    pinned: known?.peerId ?? null,
    named: appliance.peerId,
    directory: entry.contentPeerId,
  });
  if (decision.kind === 'changed')
    return { kind: 'stop', stop: 'changed', device: appliance.device, pinned: !!known };
  if (decision.kind === 'mismatch' || decision.kind === 'missing')
    return { kind: 'stop', stop: 'link', device: appliance.device, pinned: !!known };
  if (decision.isNew || !known)
    return {
      kind: 'pair',
      isNew: true,
      // A browser that trusts this Whombat made the code, as it makes add-a-device links (AP-533).
      known: pinnedRecord({
        device: appliance.device,
        orgId,
        name: entry.name,
        peerId: decision.peerId,
        source: 'add-link',
      }),
    };
  const current = { ...known, name: entry.name };
  return current.enrolled ? { kind: 'open', known: current } : { kind: 'pair', known: current, isNew: false };
}

/** The pairing report: the code the Whombat gave, this phone's fingerprint and the MAC over exactly those two. */
export function pairingReport(
  key: string,
  handoffId: string,
  code: string,
  fingerprint: string,
): PhoneHandoffReport {
  return { kind: 'pairing', code, fingerprint, mac: phoneHandoffMac(key, handoffId, code, fingerprint) };
}

/* 2–3. The run after the sign-in ---------------------------------------------------------------------------- */

export type PairState = 'pending' | 'approved' | 'denied' | 'expired';

export interface HandoffDeps<S> {
  /** `control.appliances(orgId)`. */
  directory(): Promise<ApplianceSummary[]>;
  known(device: string): KnownAppliance | undefined;
  /** Stores a new pin (`registry.put`). */
  pin(record: KnownAppliance): void;
  report(handoffId: string, report: PhoneHandoffReport): Promise<void>;
  /** An enrollment-channel session with the pinned identity, resolved once its handshake is done. */
  openSession(known: KnownAppliance): Promise<S>;
  /** The box says this phone is in already (`letInAlready`): a box restored from a backup knows it. */
  letIn(session: S): { accountId: string | null } | null;
  /** Typed from the contract, so a field it drops is a type error here, not a refusal on the phone. */
  pairRequest(
    session: S,
    input: z.input<typeof EnrollPairRequestInput>,
  ): Promise<{ pairingId: string; code: string }>;
  pairStatus(
    session: S,
    pairingId: string,
  ): Promise<{ state: PairState; enrolled?: { accountId: string } | undefined }>;
  close(session: S): void;
  sleep?: Sleep;
  now?: () => number;
}

export interface HandoffInput {
  handoff: PhoneHandoff;
  orgId: string;
  /** This phone's name and platform, as the computer will show them. */
  label: string;
  platform: 'android' | 'ios';
  /** `pairingFingerprint(own PeerId)`. */
  fingerprint: string;
}

export type HandoffOutcome =
  | { kind: 'signedIn' }
  | { kind: 'open'; known: KnownAppliance }
  | { kind: 'approved'; known: KnownAppliance; accountId: string | null }
  | { kind: 'stop'; stop: 'changed' | 'link'; device: string; pinned: boolean }
  | { kind: 'failed'; stage: PhoneStage; error: PhoneSignInError }
  | { kind: 'cancelled' };

/**
 * Everything after the sign-in, with its steps reported through `onView`. Resolves with what to do next; never
 * rejects (errors become `failed`, an abort `cancelled`).
 */
export async function runPhoneHandoff<S>(
  deps: HandoffDeps<S>,
  input: HandoffInput,
  onView: (view: PhoneSignInView) => void,
  signal: AbortSignal,
): Promise<HandoffOutcome> {
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const retry = <T>(work: () => Promise<T>) => withRetry(work, { sleep: wait, signal });
  const { handoff } = input;
  const started = now();
  let session: S | null = null;
  let stage: PhoneStage = 'asking';
  const fail = (error: PhoneSignInError): HandoffOutcome => {
    const out = { kind: 'failed', stage, error } as const;
    onView(out);
    return out;
  };
  // A courtesy to the computer: it stops waiting. The phone goes on even if control misses it (AP-535).
  const signedIn = async () => {
    await retry(() => deps.report(handoff.handoffId, { kind: 'signed_in' })).catch((e) => {
      if (e instanceof Cancelled) throw e;
    });
    if (signal.aborted) throw new Cancelled();
  };

  onView({ kind: 'working', stage: 'asking' });
  try {
    if (!handoff.appliance) {
      await signedIn();
      return { kind: 'signedIn' };
    }
    let directory: ApplianceSummary[];
    try {
      directory = await retry(() => deps.directory());
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      return fail('unreachable');
    }
    if (signal.aborted) throw new Cancelled();
    const plan = planHandoff({
      appliance: handoff.appliance,
      orgId: input.orgId,
      known: deps.known(handoff.appliance.device),
      directory,
    });
    if (plan.kind === 'signedIn') return { kind: 'signedIn' };
    if (plan.kind === 'notInOrg') return fail('notInOrg');
    if (plan.kind === 'retired') return fail('retired');
    if (plan.kind === 'stop') return plan;
    if (plan.kind === 'open') {
      await signedIn();
      return plan;
    }
    if (plan.isNew) deps.pin(plan.known);

    try {
      session = await deps.openSession(plan.known);
    } catch (e) {
      if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
      return fail('whombatUnreachable');
    }
    if (signal.aborted) throw new Cancelled();
    // In already (a box restored from a backup): the link pinned it, so there is nothing to pair.
    const letIn = deps.letIn(session);
    if (letIn) {
      await signedIn();
      return { kind: 'approved', known: plan.known, accountId: letIn.accountId };
    }
    let request: { pairingId: string; code: string };
    try {
      request = await deps.pairRequest(session, {
        endpoint: { label: input.label, platform: input.platform },
      });
    } catch {
      if (signal.aborted) throw new Cancelled();
      return fail('failed');
    }
    try {
      await retry(() =>
        deps.report(
          handoff.handoffId,
          pairingReport(handoff.key, handoff.handoffId, request.code, input.fingerprint),
        ),
      );
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      return fail(reportErrorOf(e));
    }
    if (signal.aborted) throw new Cancelled();

    stage = 'confirm';
    onView({ kind: 'confirm', label: input.label, fingerprint: input.fingerprint });
    for (;;) {
      if (now() - started > HANDOFF_LIFETIME_MS) return fail('pairExpired');
      let state: Awaited<ReturnType<HandoffDeps<S>['pairStatus']>>;
      try {
        state = await deps.pairStatus(session, request.pairingId);
      } catch {
        if (signal.aborted) throw new Cancelled();
        await wait(PAIR_POLL_RETRY_MS, signal);
        continue;
      }
      if (signal.aborted) throw new Cancelled();
      if (state.state === 'approved')
        return { kind: 'approved', known: plan.known, accountId: state.enrolled?.accountId ?? null };
      if (state.state === 'denied') return fail('denied');
      if (state.state === 'expired') return fail('pairExpired');
      await wait(PAIR_POLL_MS, signal);
    }
  } catch (e) {
    if (e instanceof Cancelled || signal.aborted) return { kind: 'cancelled' };
    return fail('failed');
  } finally {
    if (session !== null) deps.close(session);
  }
}

/* What a failure offers ---------------------------------------------------------------------------------------- */

export type PhoneAction = 'scan' | 'retry' | 'back' | 'email';

/**
 * The buttons under an error, most useful first. `signedIn`: the phone has a cloud session (back goes to the list;
 * signed out, back goes to the sign-in screen, which also offers email).
 */
export function phoneErrorActions(error: PhoneSignInError, signedIn: boolean): PhoneAction[] {
  const back: PhoneAction[] = signedIn ? ['back'] : ['back', 'email'];
  switch (error) {
    case 'expired':
    case 'over':
    case 'pairExpired':
    case 'denied':
      return ['scan', ...back];
    case 'unreachable':
    case 'whombatUnreachable':
    case 'failed':
      return ['retry', ...back];
    case 'tooMany':
    case 'notInOrg':
    case 'retired':
      return back;
  }
}
