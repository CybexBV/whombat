import {
  type ControlApi,
  ControlError,
  newPhoneHandoffKey,
  PHONE_HANDOFF_POLL_MS,
  pairingErrorKey,
  phoneSignInLink,
} from '@whombat/client/managed';
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import {
  type AskingPhone,
  initialPhoneSignIn,
  isPolling,
  type PhoneSignInError,
  type PhoneSignInEvent,
  type PhoneSignInState,
  phoneSignInReducer,
} from './phoneSignIn';

/** What signing a phone in needs from the page around it. */
export interface PhoneSignInDeps {
  control: Pick<ControlApi, 'createPhoneHandoff' | 'phoneHandoff'>;
  /**
   * The Whombat open here, named in the code so the phone asks to be let in there, and its pairing calls
   * (`enroll.pair.lookup` / `enroll.pair.approve`). Null: the code only signs the phone in.
   */
  appliance: {
    device: string;
    peerId: string;
    lookup(code: string): Promise<AskingPhone>;
    approve(input: { code: string; approve: boolean; fingerprint: string }): Promise<void>;
  } | null;
  /** The hosted UI's origin (the QR code's link). */
  origin: string;
}

function subscribeVisibility(on: () => void) {
  document.addEventListener('visibilitychange', on);
  return () => document.removeEventListener('visibilitychange', on);
}

/** Whether this tab is on screen: codes are made and polled only then. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

function createError(error: unknown): PhoneSignInError {
  if (error instanceof ControlError) {
    if (error.code === 'rate_limited') return 'rateLimited';
    if (error.code === 'signed_out') return 'signedOut';
  }
  return 'unreachable';
}

/**
 * Runs the phone sign-in state machine (`phoneSignIn.ts`): makes a code while the page is visible, polls control every
 * `PHONE_HANDOFF_POLL_MS` and counts the code down (only while visible; nothing runs once unmounted), looks a reported
 * code up and lets the phone in when asked to. Every answer names the code it belongs to, so a late one for an older
 * code changes nothing.
 */
export function usePhoneSignIn(deps: PhoneSignInDeps): {
  state: PhoneSignInState;
  now: number;
  dispatch: (event: PhoneSignInEvent) => void;
} {
  const [state, dispatch] = useReducer(phoneSignInReducer, initialPhoneSignIn);
  const visible = useDocumentVisible();
  const [now, setNow] = useState(() => Date.now());
  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** The states whose call was made already (StrictMode runs effects twice; each call happens once). */
  const started = useRef(new WeakSet<PhoneSignInState>());
  const once = (s: PhoneSignInState) => {
    if (started.current.has(s)) return false;
    started.current.add(s);
    return true;
  };

  // A new code: only on screen (a background tab would burn codes nobody sees).
  const starting = state.step === 'starting' ? state : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `once` and deps are read through refs
  useEffect(() => {
    if (!starting || !visible || !once(starting)) return;
    const startingGen = starting.gen;
    const { control, appliance, origin } = depsRef.current;
    const key = newPhoneHandoffKey();
    control.createPhoneHandoff().then(
      (h) =>
        dispatch({
          type: 'created',
          gen: startingGen,
          code: {
            handoffId: h.handoffId,
            key,
            link: phoneSignInLink(origin, {
              token: h.token,
              key,
              appliance: appliance ? { device: appliance.device, peerId: appliance.peerId } : null,
            }),
            expiresAt: Date.parse(h.expiresAt),
            appliance: appliance !== null,
          },
        }),
      (error: unknown) => dispatch({ type: 'createFailed', gen: startingGen, error: createError(error) }),
    );
  }, [starting, visible]);

  // How the handoff is going, and the countdown.
  const pollId = isPolling(state) ? state.code.handoffId : null;
  const counting = state.step === 'waiting';
  useEffect(() => {
    if (!pollId || !visible) return;
    let live = true;
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      depsRef.current.control
        .phoneHandoff(pollId)
        .then(
          (view) => live && dispatch({ type: 'polled', handoffId: pollId, view }),
          (error: unknown) =>
            live &&
            dispatch({
              type: 'pollFailed',
              handoffId: pollId,
              code: error instanceof ControlError ? error.code : null,
            }),
        )
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(poll, PHONE_HANDOFF_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pollId, visible]);
  useEffect(() => {
    if (!counting || !visible) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      dispatch({ type: 'tick', now: t });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [counting, visible]);

  // Which device shows the reported code.
  const lookup = state.step === 'lookingUp' ? state : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `once` and deps are read through refs
  useEffect(() => {
    if (!lookup || !once(lookup)) return;
    const handoffId = lookup.code.handoffId;
    const appliance = depsRef.current.appliance;
    if (!appliance) return;
    appliance.lookup(lookup.pairing.code).then(
      (phone) => dispatch({ type: 'lookedUp', handoffId, phone }),
      (error: unknown) => dispatch({ type: 'lookupFailed', handoffId, error: pairingErrorKey(error) }),
    );
  }, [lookup]);

  // Let it in, or not.
  const deciding = state.step === 'confirm' && state.busy ? state : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `once` and deps are read through refs
  useEffect(() => {
    if (!deciding?.busy || !once(deciding)) return;
    const handoffId = deciding.code.handoffId;
    const approve = deciding.busy === 'approve';
    const appliance = depsRef.current.appliance;
    if (!appliance) return;
    appliance
      .approve({ code: deciding.pairing.code, approve, fingerprint: deciding.pairing.fingerprint })
      .then(
        () => dispatch({ type: 'decided', handoffId, approved: approve }),
        (error: unknown) => dispatch({ type: 'decideFailed', handoffId, error: pairingErrorKey(error) }),
      );
  }, [deciding]);

  return { state, now, dispatch };
}
