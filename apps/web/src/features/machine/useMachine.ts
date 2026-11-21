/**
 * The machine on this Whombat for the web's screens (hardware-support-web.md AP-3222; bluetooth-web.md AP-3711): its
 * network, hardware and Bluetooth ops (null in fixture mode without a machine), the Whombat's name for the words, and
 * NETWORK's and BLUETOOTH's pollers.
 */
import {
  type BluetoothApi,
  type BluetoothPoller,
  type BluetoothPollState,
  createBluetoothPoller,
  createNetworkPoller,
  type HardwareLoader,
  type NetworkApi,
  type NetworkPoller,
  type NetworkPollState,
} from '@whombat/client';
import { useBootstrap } from '@whombat/client/react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAppServices } from '../../app/providers';

export interface MachineHere {
  /** Null where there is nothing to ask. */
  network: NetworkApi | null;
  hardware: HardwareLoader | null;
  bluetooth: BluetoothApi | null;
  /** The Whombat's name in the words (“If Burrow HQ can’t reach the internet …”). */
  name: string;
  timeZone: string;
}

export function useMachineHere(burrow: string): MachineHere {
  const { network, hardware, bluetooth } = useAppServices();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const name = bootstrap?.burrow.name ?? 'Whombat';
  const timeZone = bootstrap?.preferences.timeZone ?? bootstrap?.burrow.timeZone ?? 'UTC';
  return useMemo(
    () => ({ network, hardware, bluetooth, name, timeZone }),
    [network, hardware, bluetooth, name, timeZone],
  );
}

const IDLE: NetworkPollState = {
  network: null,
  reason: null,
  loading: true,
  seenRunning: false,
  cableSeenRunning: false,
  move: null,
};
const noop = () => () => {};

/** Whether the page is visible (true where the browser can't tell, as in tests). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  return visible;
}

/**
 * NETWORK's state (AP-3206): the client's poller over `api` — asked when the section opens and while the tab is
 * visible, then every 2 s while a change runs. `poller` takes the change a join or forget started.
 */
export function useNetwork(api: NetworkApi | null): {
  state: NetworkPollState;
  poller: NetworkPoller | null;
} {
  const [poller, setPoller] = useState<NetworkPoller | null>(null);
  const visible = usePageVisible();
  useEffect(() => {
    const p = createNetworkPoller({ api });
    setPoller(p);
    return () => p.dispose();
  }, [api]);
  useEffect(() => {
    poller?.setActive(visible);
  }, [poller, visible]);
  const state = useSyncExternalStore(
    poller ? poller.subscribe : noop,
    poller ? poller.getState : () => IDLE,
    () => IDLE,
  );
  return { state, poller };
}

const BLUETOOTH_IDLE: BluetoothPollState = { bluetooth: null, reason: null, loading: true };

/** Unset: the client's own interval. */
let bluetoothPollMs: number | undefined;

/**
 * Tests ask again after a few milliseconds instead of every second, so a test that waits for a pairing's next step
 * waits on the change and not on the clock. Nothing else calls it.
 */
export function setBluetoothPollMsForTests(ms: number): void {
  bluetoothPollMs = ms;
}

/**
 * BLUETOOTH's state (bluetooth-web.md AP-3706): the client's poller over `api` — asked when the section opens and while
 * the tab is visible, then every second while the box looks or pairs. `poller` takes what the section and its dialog did.
 */
export function useBluetooth(api: BluetoothApi | null): {
  state: BluetoothPollState;
  poller: BluetoothPoller | null;
} {
  const [poller, setPoller] = useState<BluetoothPoller | null>(null);
  const visible = usePageVisible();
  useEffect(() => {
    const p = createBluetoothPoller({ api, pollMs: bluetoothPollMs });
    setPoller(p);
    return () => p.dispose();
  }, [api]);
  useEffect(() => {
    poller?.setActive(visible);
  }, [poller, visible]);
  const state = useSyncExternalStore(
    poller ? poller.subscribe : noop,
    poller ? poller.getState : () => BLUETOOTH_IDLE,
    () => BLUETOOTH_IDLE,
  );
  return { state, poller };
}
