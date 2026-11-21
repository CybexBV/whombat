/**
 * Which Tailscale the phone asks (Whombat hermes-engine.md HE-51; hermes-engine-app.md AP-5378): the Whombat's
 * `host.tailscale*` through its session, or the demo world's (`fixtures/tailscale.ts`). Sign in opens Tailscale's own
 * page in the browser (the demo takes you as signed in there).
 */
import { type TailscaleApi, tailscaleApi } from '@whombat/client';
import { useMemo } from 'react';
import { Linking } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { demoTailscale } from '../fixtures/tailscale';
import { useManaged } from './context';

export interface TailscaleHere {
  api: TailscaleApi;
  /** Tailscale's own sign-in page. */
  openSignIn(url: string): void;
  /**
   * The login server row with Change (CT-1306; AP-5476): on a community box you may name your own (Headscale, a
   * company's); the commercial edition keeps Tailscale's own.
   */
  loginServer: boolean;
}

/** Tailscale here, or null (no Whombat to ask). */
export function useTailscaleHere(): TailscaleHere | null {
  const managed = useManaged();
  const { mode } = useBurrowBase();
  const session = managed?.session ?? null;
  const community = managed?.community === true;
  return useMemo(() => {
    if (session)
      return {
        api: tailscaleApi(session),
        openSignIn: (url: string) => void Linking.openURL(url).catch(() => {}),
        loginServer: community,
      };
    if (mode !== 'fixtures') return null;
    const demo = demoTailscale();
    return { api: demo.api(), openSignIn: () => demo.signedIn(), loginServer: false };
  }, [session, mode, community]);
}
