/**
 * How this Whombat is reached on the phone (`reach.get`, 4.4; Whombat docs/decisions/whombat-link.md LNK-42, LNK-44):
 * Link, its own address and Tailscale, asked again while Link starts, with turning Link on and off; and turning
 * Tailscale on from where Link's end is said, following it to Tailscale's sign-in link. `undefined` while asked the
 * first time; `null` on a box before Link.
 */
import {
  type HostTailscaleOutput,
  tailscaleAnswer,
  tailscaleApi,
  tailscaleErrorText,
  tailscaleView,
} from '@whombat/client';
import { linkPollMs, readReach, whombatLinkErrorText } from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import type { ReachGetOutput } from '@whombat/protocol/session';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useI18n } from '../i18n';

/**
 * The iPhone shows no price, no sign-up and no way to buy (LNK-44): Link's state is said, but turning it on and the
 * account site are left out there.
 */
export const OFFER_LINK = Platform.OS !== 'ios';

export interface PhoneReach {
  reach: ReachGetOutput | null | undefined;
  busy: 'on' | 'off' | null;
  error: string | null;
  turnOn: () => void;
  turnOff: () => void;
  reload: () => void;
}

export function usePhoneReach(session: ApplianceSession, options: { pollMs?: number } = {}): PhoneReach {
  const { rawLocale } = useI18n();
  const [reach, setReach] = useState<ReachGetOutput | null | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState<'on' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` asks again.
  useEffect(() => {
    let live = true;
    readReach(session).then(
      (r) => live && setReach(r),
      () => live && setReach((prev) => prev ?? null),
    );
    return () => {
      live = false;
    };
  }, [session, asked]);
  const poll = linkPollMs(reach?.link) ?? options.pollMs ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer asks again after its own wait.
  useEffect(() => {
    if (!poll) return;
    const t = setTimeout(() => setAsked((n) => n + 1), poll);
    return () => clearTimeout(t);
  }, [poll, reach]);
  const turn = useCallback(
    async (on: boolean) => {
      setBusy(on ? 'on' : 'off');
      setError(null);
      try {
        const out = on ? await sessionOps.linkOn(session) : await sessionOps.linkOff(session);
        setReach((r) => (r ? { ...r, link: out.link } : r));
      } catch (e) {
        setError(whombatLinkErrorText(e, rawLocale));
      } finally {
        setBusy(null);
      }
    },
    [session, rawLocale],
  );
  return {
    reach,
    busy,
    error,
    turnOn: () => void turn(true),
    turnOff: () => void turn(false),
    reload: () => setAsked((n) => n + 1),
  };
}

/**
 * Tailscale's last answer per session, shared by the strip and Reach: turned on in one, the other shows it too instead
 * of still offering “Turn on Tailscale”.
 */
const tailscaleAnswers = new WeakMap<
  ApplianceSession,
  { answer: HostTailscaleOutput | null; listeners: Set<() => void> }
>();

function tailscaleAnswerOf(session: ApplianceSession) {
  let entry = tailscaleAnswers.get(session);
  if (!entry) {
    entry = { answer: null, listeners: new Set() };
    tailscaleAnswers.set(session, entry);
  }
  return entry;
}

function useSharedTailscaleAnswer(
  session: ApplianceSession,
): [HostTailscaleOutput | null, (answer: HostTailscaleOutput) => void] {
  const entry = tailscaleAnswerOf(session);
  const answer = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      [entry],
    ),
    () => entry.answer,
  );
  const set = useCallback(
    (next: HostTailscaleOutput) => {
      entry.answer = next;
      for (const listener of [...entry.listeners]) listener();
    },
    [entry],
  );
  return [answer, set];
}

/** Turning Tailscale on from the Link-ended strip or Reach (LNK-06a), followed until Tailscale's sign-in link shows. */
export function useTailscaleTurnOn(session: ApplianceSession) {
  const { rawLocale } = useI18n();
  const api = useMemo(() => tailscaleApi(session), [session]);
  const [answer, setAnswer] = useSharedTailscaleAnswer(session);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const v = tailscaleView(answer, rawLocale);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer asks again after its own wait.
  useEffect(() => {
    if (!v.pollMs) return;
    const t = setTimeout(() => api.state().then(setAnswer, () => {}), v.pollMs);
    return () => clearTimeout(t);
  }, [v.pollMs, answer, api]);
  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      setAnswer(tailscaleAnswer(await api.on()));
    } catch (error) {
      setNote(tailscaleErrorText(error, rawLocale));
    } finally {
      setBusy(false);
    }
  };
  const state = answer?.tailscale ?? null;
  return {
    /** Tailscale as last asked from this phone's strip or Reach (null until turned on there). */
    state,
    signInUrl: state?.state === 'needs_sign_in' ? v.loginUrl : null,
    busy,
    note,
    turnOn: () => void turnOn(),
  };
}
