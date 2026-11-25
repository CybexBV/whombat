/**
 * Which machine the phone asks (hardware-support-android.md AP-3250): the Whombat's `host.network`, `host.wifi.*` and
 * `host.hardware` through its session, or the demo world's machine (`fixtures/machine.ts`). NETWORK follows a
 * change with the shared poller (`createNetworkPoller`): asked when the screen is in front and the app in the foreground,
 * every 2 s while a change runs, never in the background. Its `host.bluetooth*` the same way (bluetooth-android.md
 * AP-3750), followed by `createBluetoothPoller` every second while the box looks or pairs.
 */
import { useIsFocused } from '@react-navigation/native';
import {
  type BluetoothApi,
  type BluetoothPoller,
  type BluetoothPollState,
  bluetoothApi,
  createBluetoothPoller,
  createNetworkPoller,
  type HardwareLoader,
  hardwareLoader,
  type NetworkApi,
  type NetworkPoller,
  type NetworkPollState,
  networkApi,
} from '@whombat/client';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { demoMachine } from '../fixtures/machine';
import { useManaged } from './context';
import { useForeground } from './useHostStatus';

export interface MachineHere {
  /** Null where there is nothing to ask. */
  network: NetworkApi | null;
  hardware: HardwareLoader | null;
  bluetooth: BluetoothApi | null;
  /** The Whombat's name in the words (“If Burrow HQ can’t reach the internet …”). */
  name: string;
  /** The demo world's machine: read again when it starts over. */
  onReset: ((listener: () => void) => () => void) | null;
}

/** The machine's ops here: the Whombat's, or the demo's. */
export function useMachineHere(): MachineHere {
  const managed = useManaged();
  const { mode, currentBootstrap } = useBurrowBase();
  const session = managed?.session ?? null;
  const name = currentBootstrap().burrow.name;
  const demo = !session && mode === 'fixtures' ? demoMachine() : null;
  const network = useMemo(() => (session ? networkApi(session) : (demo?.network ?? null)), [session, demo]);
  const hardware = useMemo(
    () => (session ? hardwareLoader(session) : (demo?.hardware ?? null)),
    [session, demo],
  );
  const bluetooth = useMemo(
    () => (session ? bluetoothApi(session) : (demo?.bluetooth ?? null)),
    [session, demo],
  );
  return { network, hardware, bluetooth, name, onReset: demo ? demo.onChange : null };
}

/**
 * NETWORK's state (AP-3252): the shared poller over `api`, active while the screen is in front and the app in the
 * foreground; `poller.started` takes the change a join or forget started. The demo machine starting over reads again.
 */
export function useNetwork(
  api: NetworkApi | null,
  onReset: MachineHere['onReset'] = null,
): { state: NetworkPollState; poller: NetworkPoller } {
  const poller = useMemo(() => createNetworkPoller({ api }), [api]);
  useEffect(() => () => poller.dispose(), [poller]);
  const state = useSyncExternalStore(poller.subscribe, poller.getState);
  const focused = useIsFocused();
  const visible = useForeground();
  useEffect(() => poller.setActive(focused && visible), [poller, focused, visible]);
  useEffect(() => onReset?.(() => poller.refresh()), [onReset, poller]);
  return { state, poller };
}

/**
 * BLUETOOTH's state (AP-3750): the shared poller over `api`, active while the screen is in front and the app in the
 * foreground — every second while the box looks or pairs, else only when asked; `poller.scanned`, `pairing`, `device` and
 * `removed` take what the phone did. The demo machine starting over reads again.
 */
export function useBluetooth(
  api: BluetoothApi | null,
  onReset: MachineHere['onReset'] = null,
): { state: BluetoothPollState; poller: BluetoothPoller } {
  const poller = useMemo(() => createBluetoothPoller({ api }), [api]);
  useEffect(() => () => poller.dispose(), [poller]);
  const state = useSyncExternalStore(poller.subscribe, poller.getState);
  const focused = useIsFocused();
  const visible = useForeground();
  useEffect(() => poller.setActive(focused && visible), [poller, focused, visible]);
  useEffect(() => onReset?.(() => poller.refresh()), [onReset, poller]);
  return { state, poller };
}

/**
 * About opened at a card (`at`: REACH for a connection that needs it, HARDWARE for a link saved before the Hardware
 * screen): the screen scrolls to the card once it
 * and the container above it are laid out, and stops following once a finger scrolls, as Devices does
 * (AP-1247).
 */
export function useScrollToCard(active: boolean) {
  const scroller = useRef<ScrollView>(null);
  const target = useRef(active);
  const top = useRef(0);
  const y = useRef<number | null>(null);
  const scroll = () => {
    if (target.current && y.current !== null)
      scroller.current?.scrollTo({ y: Math.max(0, top.current + y.current - 8), animated: true });
  };
  return {
    scroller,
    /** On the cards' container: where it starts in the scrolled content. */
    onContainer: (e: LayoutChangeEvent) => {
      top.current = e.nativeEvent.layout.y;
      scroll();
    },
    /** On the card: where it is in the container. */
    onCard: (e: LayoutChangeEvent) => {
      y.current = e.nativeEvent.layout.y;
      scroll();
    },
    stop: () => {
      target.current = false;
    },
  };
}
