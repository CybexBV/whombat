/**
 * Signing in at the box's screen (Whombat signin-at-box.md BX-02…BX-08; signin-at-box-web.md AP-3500…), shared by the
 * web and the phone. A device that isn't let in asks the box for a code (`enroll.screen.request`; no email, the box is
 * one person's, CT-1509); the box shows six letters on its own screen; the person types them here; CPace bound to
 * both Noise keys (`enroll.screen.begin` → `enroll.screen`) lets this device in to the person's account, and only once the
 * box's own tag matches is anything trusted or pinned (`pinSource: 'screen'`).
 *
 * - The steps (`ScreenSignInStep`): “Show a code”, the letters, then let in (or already in), or stopped (the box is too old,
 *   has no screen, or isn't the one whose screen the person sees). `screenSignInRequest` and `screenSignInSubmit` take
 *   one step and never throw: a refusal is the step it leaves the person on, with its words (`managedCopyText().screen.errors`, in
 *   `ScreenSignInDeps.locale`).
 * - The identity (`screenSignInPeer`): a pinned device connects with its pin (a pin that differs from the directory is
 *   still the hard stop); one without a pin connects with the directory's PeerId for this exchange only and pins it
 *   after the tag checks (`screenSignedInRecord`).
 */
import {
  claimConfirmEqual,
  normalizeScreenSignInLetters,
  screenSignInPakeInitiator,
  screenSignInPakeInitiatorFinish,
} from '@whombat/protocol/claim';
import { type EndpointPlatform, ScreenBackoffDetails } from '@whombat/protocol/session';
import { OperationError, type ScreenEnrolledOutput, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { managedCopyText } from './copy';
import { pinnedRecord } from './pin';
import type { KnownAppliance } from './registry';

/* Typing the letters --------------------------------------------------------------------------------------------- */

/**
 * The letters as they are typed: upper-case, spaces and dashes dropped, at most six, shown `KXQ MTR` once there are
 * more than three. Only formats; `normalizeScreenSignInLetters` decides what is valid.
 */
export function formatScreenLettersInput(raw: string): string {
  const s = raw.toUpperCase().replace(/[\s-]/g, '').slice(0, 6);
  return s.length > 3 ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/* The exchange (BX-03) ------------------------------------------------------------------------------------------- */

/**
 * The box answered without the confirmation of the box whose screen showed the letters: this device was talking to
 * something else. Nothing was pinned.
 */
export class ScreenSignInMismatchError extends Error {
  override name = 'ScreenSignInMismatchError';
  constructor() {
    super('The box’s screen sign-in confirmation doesn’t match.');
  }
}

export interface ScreenSignInExchange {
  /** An enrollment-channel session to the box, its Noise handshake done with `appliancePeerId`. */
  session: ApplianceSession;
  signinId: string;
  /** The six letters (`normalizeScreenSignInLetters`). */
  letters: string;
  /** The box's device id (`/appliances/<device>`). */
  device: string;
  /** The box's PeerId as this side's Noise session has it: the pin, or the directory's (BX-03). */
  appliancePeerId: string;
  /** This device's PeerId (its Noise static key). */
  clientPeerId: string;
  randomBytes?: (n: number) => Uint8Array;
}

const cryptoRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/**
 * CPace over the enrollment session: `enroll.screen.begin` with this side's share, `enroll.screen` with the client
 * tag, then the box's tag must match before the result counts (`ScreenSignInMismatchError` otherwise).
 */
export async function screenSignInEnroll(input: ScreenSignInExchange): Promise<ScreenEnrolledOutput> {
  const { session, signinId } = input;
  const { share, state } = screenSignInPakeInitiator(
    {
      password: input.letters,
      deviceId: input.device,
      appliancePeerId: input.appliancePeerId,
      clientPeerId: input.clientPeerId,
      signinId,
    },
    input.randomBytes ?? cryptoRandom,
  );
  const begun = await sessionOps.screenBegin(session, { signinId, share });
  let tags: { client: string; appliance: string };
  try {
    tags = screenSignInPakeInitiatorFinish(state, begun.share);
  } catch {
    // A share that isn't a ristretto255 element: whatever answered can't be the box.
    throw new ScreenSignInMismatchError();
  }
  const out = await sessionOps.screenEnroll(session, { signinId, confirm: tags.client });
  if (!claimConfirmEqual(tags.appliance, out.confirm)) throw new ScreenSignInMismatchError();
  return out;
}

/* The steps ------------------------------------------------------------------------------------------------------ */

export type ScreenSignInStep =
  /** “Show a code”. */
  | { kind: 'start'; error: string | null }
  /**
   * The box shows letters for `signinId` until `expiresAt`: type them, or “Show a new code”. `device`: the box's device
   * id as it answered, used only where `ScreenSignInDeps.device` is null.
   */
  | { kind: 'letters'; signinId: string; expiresAt: string; device?: string; error: string | null }
  /** Let in: the box's tag matched. Pin (when new) and open it like a pairing approval. */
  | { kind: 'enrolled'; output: ScreenEnrolledOutput }
  /** This device's key is let in there already (`endpoint_enrolled`): nothing was checked, nothing to pin. */
  | { kind: 'already' }
  /** Nothing more to try here: the box is too old, has no screen, or isn't the one whose screen the person sees. */
  | { kind: 'stopped'; error: string };

/** The steps where the person does something (“Show a code”, the letters). */
export type ScreenSignInAsking = Extract<ScreenSignInStep, { kind: 'start' | 'letters' }>;
export type ScreenSignInLettersStep = Extract<ScreenSignInStep, { kind: 'letters' }>;

export function screenSignInStart(): Extract<ScreenSignInStep, { kind: 'start' }> {
  return { kind: 'start', error: null };
}

export interface ScreenSignInDeps {
  /** An enrollment-channel session to the box, connected with `appliancePeerId` (`screenSignInPeer`). */
  session: ApplianceSession;
  /** The directory's device id; null on the box's own page, which takes the box's answer to the request. */
  device: string | null;
  appliancePeerId: string;
  clientPeerId: string;
  /** What the box shows and lists this device as. */
  endpoint: { label: string; platform: EndpointPlatform };
  randomBytes?: (n: number) => Uint8Array;
  now?: () => number;
  /** The reader's language for a refusal's words (English when none is given). */
  locale?: string | null;
}

/** “Show a code” or “Show a new code” (from the letters): the box shows letters for this device. */
export async function screenSignInRequest(
  deps: ScreenSignInDeps,
  from: ScreenSignInAsking,
): Promise<ScreenSignInStep> {
  try {
    const r = await sessionOps.screenRequest(deps.session, { endpoint: deps.endpoint });
    return {
      kind: 'letters',
      signinId: r.signinId,
      expiresAt: r.expiresAt,
      ...(r.device && { device: r.device }),
      error: null,
    };
  } catch (error) {
    return screenSignInFailed(from, error, deps.now?.() ?? Date.now(), deps.locale);
  }
}

/** “Let this device in” with what was typed: the letters through CPace, then the box's tag. */
export async function screenSignInSubmit(
  deps: ScreenSignInDeps,
  at: ScreenSignInLettersStep,
  typed: string,
): Promise<ScreenSignInStep> {
  const copy = managedCopyText(deps.locale ?? 'en');
  const letters = normalizeScreenSignInLetters(typed);
  if (!letters) return { ...at, error: copy.screen.errors.letters };
  const device = deps.device ?? at.device;
  // A box that doesn't say which device it is can't be signed in to from its own page.
  if (!device) return { kind: 'stopped', error: copy.screen.errors.old };
  try {
    const output = await screenSignInEnroll({
      session: deps.session,
      signinId: at.signinId,
      letters,
      device,
      appliancePeerId: deps.appliancePeerId,
      clientPeerId: deps.clientPeerId,
      ...(deps.randomBytes && { randomBytes: deps.randomBytes }),
    });
    return { kind: 'enrolled', output };
  } catch (error) {
    return screenSignInFailed(at, error, deps.now?.() ?? Date.now(), deps.locale);
  }
}

/** Minutes until `retryAt` (at least 1), from a `screen_backoff` refusal's details. */
export function screenBackoffMinutes(error: unknown, now: number = Date.now()): number | null {
  if (!(error instanceof OperationError) || error.code !== 'screen_backoff') return null;
  const d = ScreenBackoffDetails.safeParse(error.details);
  if (!d.success) return null;
  return Math.max(1, Math.ceil((Date.parse(d.data.retryAt) - now) / 60_000));
}

/**
 * Where a refusal leaves the person, with its words: the letters for a wrong or
 * ended code, stopped for a box that can't do this (too old, no screen) or isn't the right one; anything else stays
 * where it was.
 */
export function screenSignInFailed(
  at: ScreenSignInAsking,
  error: unknown,
  now: number = Date.now(),
  locale?: string | null,
): ScreenSignInStep {
  const copy = managedCopyText(locale ?? 'en');
  const e = copy.screen.errors;
  const stay = (text: string): ScreenSignInStep => ({ ...at, error: text });
  if (error instanceof ScreenSignInMismatchError) return { kind: 'stopped', error: e.notThisOne };
  if (error instanceof OperationError)
    switch (error.code) {
      case 'unknown_op':
        return { kind: 'stopped', error: e.old };
      case 'screen_unavailable':
        return { kind: 'stopped', error: e.screen_unavailable };
      case 'endpoint_enrolled':
        return { kind: 'already' };
      case 'screen_code_invalid':
        return stay(at.kind === 'letters' ? e.screen_code_invalid : copy.claim.errors.failed);
      case 'screen_signin_missing':
        return stay(at.kind === 'letters' ? e.screen_signin_missing : copy.claim.errors.failed);
      case 'screen_backoff':
        return stay(e.screen_backoff(screenBackoffMinutes(error, now) ?? 1));
      case 'screen_rate_limited':
        return stay(e.screen_rate_limited);
      case 'rate_limited':
        return stay(copy.claim.errors.rate_limited);
      default:
        // `screen_begin_missing` (the begin was lost), `screen_share_invalid` (not a guess) and the rest: again.
        return stay(copy.claim.errors.failed);
    }
  const reason = (error as { reason?: string } | undefined)?.reason;
  // The handshake reached a key other than the one connected with (a directory that lies, BX-03): nothing was sent.
  if (reason === 'identity_mismatch') return { kind: 'stopped', error: e.notThisOne };
  if (reason === 'appliance_offline') return stay(copy.claim.errors.offline);
  return stay(copy.claim.errors.failed);
}

/* The identity (BX-03) ------------------------------------------------------------------------------------------- */

/**
 * Which identity the exchange connects with: this device's pin (`isNew: false`), or without one the directory's for
 * this exchange only (`isNew: true`, pinned with `screen` once the tag matched). A pin that differs from the directory
 * is the identity-changed hard stop (AP-64): nothing is asked.
 */
export type ScreenSignInPeer =
  | { kind: 'connect'; peerId: string; isNew: boolean }
  | { kind: 'changed'; pinned: string; directory: string };

export function screenSignInPeer(pinned: string | null | undefined, directory: string): ScreenSignInPeer {
  if (pinned && pinned !== directory) return { kind: 'changed', pinned, directory };
  return pinned
    ? { kind: 'connect', peerId: pinned, isNew: false }
    : { kind: 'connect', peerId: directory, isNew: true };
}

/**
 * The record after the box let this device in: the pinned one, now enrolled (its pin and source as they were), or a
 * new pin of the identity the exchange proved (`screen`), enrolled.
 */
export function screenSignedInRecord(input: {
  known: KnownAppliance | null | undefined;
  device: string;
  orgId: string;
  name: string | null;
  /** The identity the session connected with (`screenSignInPeer`). */
  peerId: string;
  accountId: string;
}): KnownAppliance {
  if (input.known) return { ...input.known, enrolled: true, accountId: input.accountId };
  return {
    ...pinnedRecord({
      device: input.device,
      orgId: input.orgId,
      name: input.name,
      peerId: input.peerId,
      source: 'screen',
      accountId: input.accountId,
    }),
    enrolled: true,
  };
}
