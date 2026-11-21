/**
 * “How it’s doing”, live while it is on screen (Whombat box-status.md BS-08, BS-12; AP-1151): the shared poller
 * (`createHostPoller`) over this session's `host.metrics`, asking only
 * while This Whombat is the screen in front and the app is in the foreground. Leaving the screen, opening another one
 * on top or putting the phone away stops it; coming back catches up (only the new points) and goes on.
 */
import { useIsFocused } from '@react-navigation/native';
import {
  createHostPoller,
  type HostMetricsLoader,
  type HostPollState,
  type HostSpend,
  hostMetricsLoader,
} from '@whombat/client';
import type { HostMetricsRange } from '@whombat/protocol/session';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useManagedOrThrow } from './context';

/**
 * Whether the app shows (not `background`; an unknown start counts as showing). `inactive` still shows: the app beside
 * another in Split View on the iPhone Duo (docs/app/decisions/iphone-duo.md), or under a pulled-down notice.
 */
const foreground = (state: string | null | undefined) => state !== 'background';

export function useForeground(): boolean {
  const [active, setActive] = useState(foreground(AppState.currentState));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(foreground(next)));
    return () => sub.remove();
  }, []);
  return active;
}

/** A poller over `loadMetrics` and `loadSpend` (both stable), active while the screen is in front and the app foreground. */
export function useHostPoller(
  loadMetrics: HostMetricsLoader | null,
  loadSpend: () => Promise<HostSpend>,
): { state: HostPollState; setRange: (range: HostMetricsRange) => void } {
  const poller = useMemo(() => createHostPoller({ loadMetrics, loadSpend }), [loadMetrics, loadSpend]);
  useEffect(() => () => poller.dispose(), [poller]);
  const state = useSyncExternalStore(poller.subscribe, poller.getState);
  const focused = useIsFocused();
  const visible = useForeground();
  useEffect(() => poller.setActive(focused && visible), [poller, focused, visible]);
  return { state, setRange: poller.setRange };
}

/** No spend to read: what the AI used is Spend's, in Settings → Advanced, and the section shows the machine. */
const noSpend = async (): Promise<HostSpend> => ({ daily: null, overview: null });

/** This session's `host.metrics`. */
export function useHostStatus(): { state: HostPollState; setRange: (range: HostMetricsRange) => void } {
  const { session } = useManagedOrThrow();
  const loadMetrics = useMemo(() => hostMetricsLoader(session), [session]);
  return useHostPoller(loadMetrics, noSpend);
}
