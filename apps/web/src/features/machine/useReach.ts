/**
 * How this Whombat is reached (`reach.get`, 4.4; Whombat docs/decisions/whombat-link.md): Link, its own address and
 * Tailscale, asked again every few seconds while Link starts (the person confirms the code elsewhere), with turning
 * Link on and off. `undefined` while asked the first time; `null` on a box before Link (`unknown_op`) or one that
 * couldn't say.
 */
import { linkPollMs, readReach, whombatLinkErrorText } from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import type { ReachGetOutput } from '@whombat/protocol/session';
import { useCallback, useEffect, useState } from 'react';

export interface Reach {
  reach: ReachGetOutput | null | undefined;
  busy: 'on' | 'off' | null;
  error: string | null;
  turnOn: () => Promise<void>;
  turnOff: () => Promise<boolean>;
  reload: () => void;
}

export function useReach(session: ApplianceSession | null | undefined): Reach {
  const [reach, setReach] = useState<ReachGetOutput | null | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState<'on' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` asks again.
  useEffect(() => {
    if (!session) return;
    let live = true;
    readReach(session).then(
      (r) => live && setReach(r),
      // A blip keeps what was shown; nothing shown yet reads as “can't say”.
      () => live && setReach((prev) => prev ?? null),
    );
    return () => {
      live = false;
    };
  }, [session, asked]);

  const poll = linkPollMs(reach?.link);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer asks again after its own wait.
  useEffect(() => {
    if (!poll) return;
    const t = setTimeout(() => setAsked((n) => n + 1), poll);
    return () => clearTimeout(t);
  }, [poll, reach]);

  const turn = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (!session) return false;
      setBusy(on ? 'on' : 'off');
      setError(null);
      try {
        const out = on ? await sessionOps.linkOn(session) : await sessionOps.linkOff(session);
        setReach((r) => (r ? { ...r, link: out.link } : r));
        return true;
      } catch (e) {
        setError(whombatLinkErrorText(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [session],
  );

  return {
    reach,
    busy,
    error,
    turnOn: async () => {
      await turn(true);
    },
    turnOff: () => turn(false),
    reload: () => setAsked((n) => n + 1),
  };
}

/** The clock, once a second while `on` (a code's time left). */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
