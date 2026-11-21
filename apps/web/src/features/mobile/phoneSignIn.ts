/**
 * Signing a phone in by QR code, the browser's side (CT-190, AP-520…AP-522): a pure state machine the `/mobile` page
 * runs (`usePhoneSignIn` does the calls). The browser asks control for a handoff, shows its link as a QR code, polls
 * control until the phone reports, checks the report's MAC with the key only the QR code carried, looks the pairing
 * code up on its Whombat, compares the fingerprint the Whombat names with the one the phone reported, and lets the
 * phone in only after its person says so. Anything that doesn't check out ends in a fresh code, never an approval.
 */
import type { PairingErrorKey, PhoneHandoffView } from '@whombat/client/managed';
import { verifyPhoneHandoffReport } from '@whombat/client/managed';

/** One QR code: control's handoff and the key the browser made for it. */
export interface HandoffCode {
  handoffId: string;
  /** The link the QR code shows (`<ui>/auth/phone#t=…&k=…[&d=…&p=…]`). */
  link: string;
  /** The MAC key in the link; never leaves this page but in the QR code. */
  key: string;
  /** When the token stops working (ms since the epoch): a new code appears then. */
  expiresAt: number;
  /** The code named a Whombat (the phone may ask to be let in there); false: it only signs the phone in. */
  appliance: boolean;
}

/** The phone that asks to be let in, as the Whombat describes it (its lookup of the reported code). */
export interface AskingPhone {
  label: string;
  platform: string;
  fingerprint: string;
}

/** Why a fresh code is on screen (said above it); null for a plain refresh. */
export type PhoneSignInNotice =
  /** The report's MAC or fingerprint didn't check out: nothing was let in. */
  | 'refused'
  /** The person said “Not my phone”. */
  | 'declined'
  /** A phone scanned the last code but didn't finish in time. */
  | 'timedOut';

export type PhoneSignInError =
  | 'unreachable'
  | 'rateLimited'
  | 'signedOut'
  /** Looking the code up or letting the phone in failed on the Whombat. */
  | { pairing: PairingErrorKey };

export type PhoneSignInState =
  /** Asking control for a code (only while the page is visible). */
  | { step: 'starting'; gen: number; notice: PhoneSignInNotice | null }
  /** The QR code is on screen. */
  | { step: 'waiting'; gen: number; code: HandoffCode; notice: PhoneSignInNotice | null; failures: number }
  /** A phone redeemed the token and hasn't reported yet. */
  | { step: 'scanned'; gen: number; code: HandoffCode; failures: number }
  /** The report checked out: asking the Whombat which device shows its code. */
  | { step: 'lookingUp'; gen: number; code: HandoffCode; pairing: { code: string; fingerprint: string } }
  /** The person compares and decides. */
  | {
      step: 'confirm';
      gen: number;
      code: HandoffCode;
      pairing: { code: string; fingerprint: string };
      phone: AskingPhone;
      busy: 'approve' | 'decline' | null;
      note: PairingErrorKey | null;
    }
  /** Let in (`phone`), or signed in with nothing to let in (`phone: null`). */
  | { step: 'success'; gen: number; phone: AskingPhone | null }
  | { step: 'error'; gen: number; error: PhoneSignInError };

export type PhoneSignInEvent =
  | { type: 'created'; gen: number; code: HandoffCode }
  | { type: 'createFailed'; gen: number; error: PhoneSignInError }
  | { type: 'polled'; handoffId: string; view: PhoneHandoffView }
  /** `code`: control's error code (`not_found`, `handoff_expired`, `signed_out`, …) or null for anything else. */
  | { type: 'pollFailed'; handoffId: string; code: string | null }
  | { type: 'tick'; now: number }
  | { type: 'lookedUp'; handoffId: string; phone: AskingPhone }
  | { type: 'lookupFailed'; handoffId: string; error: PairingErrorKey }
  | { type: 'approve' }
  | { type: 'decline' }
  | { type: 'decided'; handoffId: string; approved: boolean }
  | { type: 'decideFailed'; handoffId: string; error: PairingErrorKey }
  /** “Try again”, “Sign in another phone”. */
  | { type: 'restart' };

/** Polls in a row that may fail quietly (a blip) before the page says control can't be reached. */
export const POLL_FAILURES_SHOWN = 4;

export const initialPhoneSignIn: PhoneSignInState = { step: 'starting', gen: 1, notice: null };

function fresh(state: PhoneSignInState, notice: PhoneSignInNotice | null = null): PhoneSignInState {
  return { step: 'starting', gen: state.gen + 1, notice };
}

export function phoneSignInReducer(state: PhoneSignInState, event: PhoneSignInEvent): PhoneSignInState {
  switch (event.type) {
    case 'restart':
      return fresh(state);
    case 'created':
      if (state.step !== 'starting' || event.gen !== state.gen) return state;
      return { step: 'waiting', gen: state.gen, code: event.code, notice: state.notice, failures: 0 };
    case 'createFailed':
      if (state.step !== 'starting' || event.gen !== state.gen) return state;
      return { step: 'error', gen: state.gen, error: event.error };
    case 'tick':
      // The token ran out unused: a new code (a scanned one no longer needs its token).
      if (state.step === 'waiting' && event.now >= state.code.expiresAt) return fresh(state);
      return state;
    case 'polled': {
      if ((state.step !== 'waiting' && state.step !== 'scanned') || state.code.handoffId !== event.handoffId)
        return state;
      return afterPoll(state, event.view);
    }
    case 'pollFailed': {
      if ((state.step !== 'waiting' && state.step !== 'scanned') || state.code.handoffId !== event.handoffId)
        return state;
      // Gone at control: its 15 minutes are over.
      if (event.code === 'not_found' || event.code === 'handoff_expired')
        return fresh(state, state.step === 'scanned' ? 'timedOut' : null);
      if (event.code === 'signed_out') return { step: 'error', gen: state.gen, error: 'signedOut' };
      const failures = state.failures + 1;
      if (failures >= POLL_FAILURES_SHOWN)
        return {
          step: 'error',
          gen: state.gen,
          error: event.code === 'rate_limited' ? 'rateLimited' : 'unreachable',
        };
      return { ...state, failures };
    }
    case 'lookedUp': {
      if (state.step !== 'lookingUp' || state.code.handoffId !== event.handoffId) return state;
      // The Whombat's device must be the one the phone reported (and the MAC vouched for): else it's another device
      // showing that code, and nothing is let in.
      if (event.phone.fingerprint !== state.pairing.fingerprint) return fresh(state, 'refused');
      return {
        step: 'confirm',
        gen: state.gen,
        code: state.code,
        pairing: state.pairing,
        phone: event.phone,
        busy: null,
        note: null,
      };
    }
    case 'lookupFailed':
      if (state.step !== 'lookingUp' || state.code.handoffId !== event.handoffId) return state;
      return { step: 'error', gen: state.gen, error: { pairing: event.error } };
    case 'approve':
    case 'decline':
      if (state.step !== 'confirm' || state.busy) return state;
      return { ...state, busy: event.type, note: null };
    case 'decided':
      if (state.step !== 'confirm' || state.code.handoffId !== event.handoffId) return state;
      return event.approved
        ? { step: 'success', gen: state.gen, phone: state.phone }
        : fresh(state, 'declined');
    case 'decideFailed': {
      if (state.step !== 'confirm' || state.code.handoffId !== event.handoffId) return state;
      // A blip: the same question again. Anything else means the request is gone or changed hands.
      if (event.error === 'failed' || event.error === 'rateLimited')
        return { ...state, busy: null, note: event.error };
      return { step: 'error', gen: state.gen, error: { pairing: event.error } };
    }
  }
}

function afterPoll(
  state: Extract<PhoneSignInState, { step: 'waiting' | 'scanned' }>,
  view: PhoneHandoffView,
): PhoneSignInState {
  const polled = { ...state, failures: 0 };
  const report = view.report;
  if (view.state === 'expired') return fresh(state, state.step === 'scanned' ? 'timedOut' : null);
  if (report?.kind === 'signed_in' || (view.state === 'done' && !report))
    return { step: 'success', gen: state.gen, phone: null };
  if (report?.kind === 'pairing') {
    // Control only relays the report: it counts only with the MAC under this code's key, and only for a code that
    // named a Whombat.
    if (!state.code.appliance || !verifyPhoneHandoffReport(state.code.key, state.code.handoffId, report))
      return fresh(state, 'refused');
    return {
      step: 'lookingUp',
      gen: state.gen,
      code: state.code,
      pairing: { code: report.code, fingerprint: report.fingerprint },
    };
  }
  if (view.state === 'scanned' || view.state === 'ready')
    return { step: 'scanned', gen: state.gen, code: state.code, failures: 0 };
  return polled;
}

/** Whether the page asks control about the handoff now (a code on screen or a phone on its way). */
export function isPolling(
  state: PhoneSignInState,
): state is Extract<PhoneSignInState, { step: 'waiting' | 'scanned' }> {
  return state.step === 'waiting' || state.step === 'scanned';
}

/** `m:ss` until the code refreshes (never below 0:00). */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
