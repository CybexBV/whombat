/**
 * The box's network in Settings (Whombat hardware-support.md HD-05, HD-06, HD-10, HD-11; app hardware-support-web.md
 * AP-3201…AP-3212): what This Whombat → Overview → NETWORK shows — the cable and the Wi-Fi with its signal, why there
 * is no Wi-Fi, the saved networks, a change while it runs and how it ended — the Wi-Fi dialog's list and form checks,
 * the refusals' words, and `createNetworkPoller`, which follows a change by asking `host.network` every 2 s while it
 * runs. Wi-Fi only and the cable again, and the servers following the box's new address (Whombat network-move.md;
 * app network-move-app.md): the rows' buttons, the dialogs' words, the cable change's line, the servers' move
 * and the router tip. Shared by the web and the phone. Pure, apart from the poller's timers (injectable) and
 * `networkApi`'s session.
 */

import { HOST_REPOINT_WORDS } from '@whombat/core/domain';
import type { z } from 'zod';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  type CableChange,
  type CableErrorCode,
  type CableUse,
  type HostNetwork,
  type HostNetworkOutput,
  type HostWifiJoinInput,
  type HostWifiScanOutput,
  type NetworkChange,
  type NetworkChangeFailure,
  type NetworkChangePhase,
  networkChangeDone,
  type ServerMove,
  sameSubnet,
  ssidValid,
  type WifiErrorCode,
  type WifiNetwork,
  type WifiScan,
  type WifiSecurity,
  type WifiSignal,
} from './contract';

type Dot = 'ok' | 'warn' | 'bad' | 'mut';

/** What `host.wifi.join` takes (the dialog's form makes it, `wifiJoinInput`). */
export type WifiJoinInput = z.input<typeof HostWifiJoinInput>;

/**
 * The Wi-Fi and cable refusals (`WIFI_ERROR_CODES`, `CABLE_ERROR_CODES`, in `error.details.code`) and a network that
 * can't be changed from here.
 */
export type NetworkErrorCode = WifiErrorCode | CableErrorCode | 'forbidden';

/* The ops --------------------------------------------------------------------------------------------------------- */

/** The network's session ops as one object: the managed session's, or a fixture world's (`createFakeNetwork`). */
export interface NetworkApi {
  state(): Promise<HostNetworkOutput>;
  scan(): Promise<HostWifiScanOutput>;
  join(input: WifiJoinInput): Promise<NetworkChange>;
  forget(ssid: string): Promise<NetworkChange>;
  /** Wi-Fi only (`wifi`) or the cable again (`cable`): `host.cable.set`. */
  setCable(use: CableUse): Promise<CableChange>;
}

/** The network over this session. */
export function networkApi(session: ApplianceSession): NetworkApi {
  return {
    state: () => sessionOps.hostNetwork(session),
    scan: () => sessionOps.hostWifiScan(session),
    join: async (input) => (await sessionOps.hostWifiJoin(session, input)).change,
    forget: async (ssid) => (await sessionOps.hostWifiForget(session, ssid)).change,
    setCable: async (use) => (await sessionOps.hostCableSet(session, use)).change,
  };
}

/* Words ----------------------------------------------------------------------------------------------------------- */

const q = (ssid: string) => `“${ssid}”`;
const servers = (n: number) => (n === 1 ? 'server' : 'servers');

/** Every word of NETWORK and its dialogs (HD-11's where it has them). `name` is the Whombat's (the burrow's) name. */
export const NETWORK_TEXT = {
  section: 'NETWORK',
  cable: 'Cable',
  wifi: 'Wi-Fi',
  connected: 'Connected',
  notConnected: 'Not connected',
  connecting: (ssid: string | undefined) => (ssid ? `Connecting to ${ssid}…` : 'Connecting…'),
  /** With a cable plugged in, the Wi-Fi waits (HD-05: a cable wins). */
  cableWins: 'Used when the cable is unplugged',
  unavailable: 'The network couldn’t be read right now.',
  tryAgain: 'Try again',
  offline: 'Can’t reach Whombat right now',
  offlineMeta: 'It keeps trying. A cable or another Wi-Fi network may help.',
  missing: {
    no_adapter: { title: 'No Wi-Fi card', meta: 'This machine connects by cable.' },
    no_driver: { title: 'Wi-Fi isn’t working', meta: 'This Wi-Fi card has no driver yet.' },
    disabled: { title: 'Wi-Fi is switched off', meta: 'Turn it on with the machine’s Wi-Fi key or switch.' },
  },
  /** The Wi-Fi card is in the hardware report (About → HARDWARE). */
  seeHardware: 'See hardware',
  saved: 'Saved',
  inUse: 'In use now',
  secured: 'Secured',
  open: 'Open',
  forget: 'Forget',
  join: 'Join a Wi-Fi network',
  forgetDialog: {
    title: (ssid: string) => `Forget ${q(ssid)}?`,
    lead: (name: string, secured: boolean) =>
      secured
        ? `${name} won’t join it again until someone types its password.`
        : `${name} won’t join it again by itself.`,
    submit: 'Forget',
    busy: 'Forgetting…',
  },
  dialog: {
    title: 'Join a Wi-Fi network',
    lead: (name: string) => `Choose the network ${name} should use.`,
    nearby: 'Wi-Fi networks nearby',
    looking: 'Looking for networks…',
    none: 'No Wi-Fi networks nearby.',
    again: 'Look again',
    couldNotLook: 'Couldn’t look for networks. Try again.',
    other: 'Other network…',
    otherTitle: 'Other network',
    otherLead: 'A network that doesn’t show its name. Type it exactly.',
    name: 'Network name',
    security: 'Security',
    securities: { psk: 'Password', open: 'None' } as Record<'psk' | 'open', string>,
    password: 'Password',
    show: 'Show',
    hide: 'Hide',
    guard: (name: string) =>
      `If ${name} can’t reach the internet on the new network, it goes back to the one it uses now.`,
    savedNote: 'Saved on this Whombat: it joins without the password.',
    join: 'Join',
    joining: 'Joining…',
    back: 'Back',
    cancel: 'Cancel',
    close: 'Close',
    done: 'Done',
  },
  rowReason: {
    enterprise: 'Company networks can’t be joined yet.',
    other: 'This kind of network can’t be joined.',
  } as Record<'enterprise' | 'other', string>,
  signal: (signal: WifiSignal) =>
    signal >= 4 ? 'Strong signal' : signal >= 2 ? 'Good signal' : 'Weak signal',
  problems: {
    name: 'Type the network’s name.',
    nameLong: 'That name is too long for a Wi-Fi network.',
    password: 'A Wi-Fi password is 8 to 63 characters.',
  },
  failures: {
    wrong_password: () => 'That password didn’t work.',
    not_found: (ssid: string) => `Couldn’t find ${ssid} nearby.`,
    no_address: (ssid: string, name: string) => `${ssid} didn’t give ${name} an address.`,
    no_internet: (_ssid: string, name: string) => `${name} couldn’t reach the internet there.`,
    failed: () => 'Something went wrong. Try again.',
  } as Record<NetworkChangeFailure, (ssid: string, name: string) => string>,
  errors: {
    no_wifi: (name: string) => `${name} has no Wi-Fi.`,
    busy: () => 'Another network change is still running. Try again in a moment.',
    in_use: (name: string) =>
      `${name} reaches the internet through this network. Plug in a cable or join another network first.`,
    not_saved: () => 'That network isn’t saved any more.',
    invalid_passphrase: () => 'A Wi-Fi password is 8 to 63 characters.',
    not_connected: (name: string) => `${name}’s Wi-Fi isn’t on a network. Join one first.`,
    no_cable: (name: string) => `No cable is plugged into ${name}.`,
    unchanged: (name: string) => `${name} already works that way.`,
    forbidden: () => 'The network can’t be changed from here.',
  } as Record<NetworkErrorCode, (name: string) => string>,
  failed: 'That didn’t work. Try again.',
  /* Wi-Fi only and the cable again (Whombat network-move.md). */
  useWifiOnly: 'Use Wi-Fi only',
  useCableAgain: 'Use the cable again',
  switchedOff: 'Switched off',
  /** A switched-off cable's row: unplugging it is safe now (once Wi-Fi only is kept). */
  wifiOnlyMeta: (name: string, plugged: boolean) =>
    plugged ? `${name} uses Wi-Fi only. You can unplug the cable.` : `${name} uses Wi-Fi only.`,
  wifiOnlyDialog: {
    title: 'Use Wi-Fi only?',
    lead: (name: string, ssid: string) =>
      `${name} stops using the cable and stays on ${q(ssid)}. Your servers move with it.`,
    guard: (name: string) =>
      `If ${name} can’t reach the internet on Wi-Fi, it goes back to the cable after 2 minutes.`,
    /** The Wi-Fi's subnet isn't the cable's: agents search only their own network. */
    otherNetwork: (name: string) =>
      `This Wi-Fi is another network than the cable. Your servers can’t follow ${name} there by themselves, so ${name} will ask you to point them here.`,
    submit: 'Use Wi-Fi only',
    busy: 'Switching…',
  },
  cableDialog: {
    title: 'Use the cable again?',
    lead: (name: string) => `${name} goes back to the cable. Your servers move with it.`,
    submit: 'Use the cable',
    busy: 'Switching…',
  },
  /** A cable change's line, by what it makes the box use and its phase. */
  cableChange: {
    wifi: {
      applying: () => 'Moving to Wi-Fi…',
      confirming: (name: string) => `Checking that ${name} reaches the internet on Wi-Fi…`,
      committed: (name: string) => `${name} uses Wi-Fi only now.`,
      reverting: (name: string) => `${name} couldn’t reach the internet on Wi-Fi. Going back to the cable…`,
      reverted: (name: string) => `${name} couldn’t reach the internet on Wi-Fi, so it uses the cable again.`,
      failed: (name: string) => `${name} couldn’t switch to Wi-Fi. Nothing changed.`,
    },
    cable: {
      applying: () => 'Moving to the cable…',
      confirming: (name: string) => `Checking that ${name} reaches the internet on the cable…`,
      committed: (name: string) => `${name} uses the cable again.`,
      reverting: (name: string) => `${name} couldn’t reach the internet on the cable. Going back to Wi-Fi…`,
      reverted: (name: string) => `${name} couldn’t reach the internet on the cable, so it stays on Wi-Fi.`,
      failed: (name: string) => `${name} couldn’t switch to the cable. Nothing changed.`,
    },
  } satisfies Record<CableUse, Record<NetworkChangePhase, (name: string) => string>>,
  /** The box turned its cable back on by itself. */
  cableBackup: (name: string) => `Wi-Fi stopped reaching Whombat, so ${name} uses its cable again.`,
  /** The servers following the box's new address. */
  move: {
    progress: (found: number, total: number, name: string) =>
      `${found} of ${total} ${servers(total)} found ${name}’s new address.`,
    done: (total: number, name: string) =>
      total === 1
        ? `Your server found ${name}’s new address.`
        : `All your servers found ${name}’s new address.`,
    unplug: 'You can unplug the cable now.',
    missing: (n: number, name: string) =>
      n === 1 ? `1 server hasn’t found ${name} yet.` : `${n} servers haven’t found ${name} yet.`,
    pointHere: HOST_REPOINT_WORDS.pointThemHere,
  },
  /** How to keep the old address: the router's fixed address for the card the box uses now. */
  addressTip: (name: string, from: string, to: string, card: 'wifi' | 'cable', mac: string | null) =>
    `${name}’s address changed from ${from} to ${to}. To keep ${from}, have your router give it to ${
      card === 'wifi' ? 'the Wi-Fi card' : 'the cable'
    }${mac ? ` (${mac.toUpperCase()})` : ''}, then restart ${name}.`,
} as const;

const T = NETWORK_TEXT;

/** “Strong signal”, “Good signal”, “Weak signal” (4 bars; 3–2; 1–0). */
export function wifiSignalText(signal: WifiSignal): string {
  return T.signal(signal);
}

/* The section ----------------------------------------------------------------------------------------------------- */

/** A connection row: a cable, or the Wi-Fi (with its bars), or why there is no Wi-Fi. */
export interface NetworkRowView {
  key: string;
  kind: 'cable' | 'wifi' | 'missing' | 'offline';
  title: string;
  meta: string | null;
  dot: Dot;
  /** Wi-Fi: its bars while connected. */
  signal: WifiSignal | null;
  /** No Wi-Fi because of the card (no driver, switched off): the hardware report shows it. */
  hardware: boolean;
  /**
   * The row's own button: `wifiOnly` (Use Wi-Fi only) on the Wi-Fi, `cable` (Use the cable again) on a
   * switched-off cable that is plugged in; null when it isn't offered now.
   */
  action: 'wifiOnly' | 'cable' | null;
}

/** A saved network, with Forget. */
export interface SavedNetworkView {
  ssid: string;
  security: WifiSecurity;
  meta: string;
  connected: boolean;
}

/** A change as one line (running, or how it ended). */
export interface NetworkChangeView {
  id: string;
  title: string;
  meta: string | null;
  dot: Dot;
  running: boolean;
}

/** The servers following the box's new address. */
export interface ServerMoveView {
  /** “4 of 6 servers found Home’s new address.”, or “All your servers found …” once they have. */
  title: string;
  /** “2 servers haven’t found Home yet.” once 5 minutes passed; null before, and once all have. */
  missing: string | null;
  /** Point them here beside `missing` (the web's `/things/servers?repoint=1`, the phone's RepointServers). */
  repoint: boolean;
  dot: Dot;
  /** Servers are still expected to come: the running dot. */
  running: boolean;
}

export interface NetworkSectionView {
  rows: NetworkRowView[];
  saved: SavedNetworkView[];
  /** Shown when running, or when it ended while someone watched (or went back recently); `networkChangeShown`. */
  change: NetworkChangeView | null;
  /** The cable change (Wi-Fi only, the cable again, the box's own backup): `cableChangeShown`. */
  cableChange: NetworkChangeView | null;
  /** The servers' move while servers are still to come, and for an hour after all came (`serverMoveView`). */
  move: ServerMoveView | null;
  /** How to keep the old address, while a move that changed it is known. */
  tip: string | null;
  /** There is a Wi-Fi card to join with, and nothing else is changing. */
  canJoin: boolean;
  /** A change runs (Wi-Fi or cable): Join, Forget and the cable's buttons wait. */
  busy: boolean;
}

/** Whether a change still runs (the app asks again every 2 s while it does). */
export function networkChangeRunning(change: { phase: NetworkChangePhase } | null | undefined): boolean {
  return change ? !networkChangeDone(change.phase) : false;
}

/** How long a change that went back or failed is still told after its deadline, to someone who didn't watch it. */
export const NETWORK_CHANGE_TOLD_MS = 15 * 60_000;

/**
 * Whether NETWORK shows a change: while it runs; once it ended, when this view saw it running (the person follows it),
 * or when it went back or failed less than 15 minutes after its deadline (whoever looks next learns why the box is
 * on its old network). A change that simply worked isn't told again later.
 */
export function networkChangeShown(
  change: Pick<NetworkChange, 'phase' | 'deadline'> | null | undefined,
  { seenRunning, now }: { seenRunning: boolean; now: number },
): boolean {
  if (!change) return false;
  if (networkChangeRunning(change) || seenRunning) return true;
  if (change.phase === 'committed') return false;
  return Date.parse(change.deadline) + NETWORK_CHANGE_TOLD_MS > now;
}

/**
 * Whether NETWORK shows a cable change: as a Wi-Fi change (`networkChangeShown`), and the box's own backup
 * always while the box still reports it (5 minutes): it tells why the cable is back on.
 */
export function cableChangeShown(
  change: CableChange | null | undefined,
  { seenRunning, now }: { seenRunning: boolean; now: number },
): boolean {
  if (!change) return false;
  if (change.by === 'backup') return true;
  return networkChangeShown(change, { seenRunning, now });
}

/** A cable change in words: what runs, or how it ended. */
export function cableChangeView(change: CableChange, name: string): NetworkChangeView {
  const running = networkChangeRunning(change);
  const backup = change.by === 'backup' && change.phase === 'committed';
  const dot: Dot = backup
    ? 'warn'
    : change.phase === 'committed'
      ? 'ok'
      : change.phase === 'failed'
        ? 'bad'
        : change.phase === 'reverting' || change.phase === 'reverted'
          ? 'warn'
          : 'mut';
  return {
    id: change.id,
    title: backup ? T.cableBackup(name) : T.cableChange[change.use][change.phase](name),
    meta: change.phase === 'applying' && change.by === 'person' ? T.wifiOnlyDialog.guard(name) : null,
    dot,
    running,
  };
}

/** After all servers found the new address, how long that is still said. */
export const SERVER_MOVE_DONE_SHOWN_MS = 60 * 60_000;
/** After this long, servers that haven't found the box are named, with Point them here. */
export const SERVER_MOVE_LATE_MS = 5 * 60_000;

/**
 * The servers' move in words: “4 of 6 servers found Home’s new address.” while servers are still to
 * come; 5 minutes after `since` the ones still missing, with Point them here; once all have, “All your servers found
 * Home’s new address.” for an hour after `since` (the move doesn't say when the last one came), with “You can unplug the
 * cable now.” when the box uses Wi-Fi only and a cable is still plugged in. Nothing without servers.
 */
export function serverMoveView(
  move: ServerMove | null | undefined,
  { name, unplug, now }: { name: string; unplug: boolean; now: number },
): ServerMoveView | null {
  if (!move || move.total === 0) return null;
  const since = Date.parse(move.since);
  if (move.found >= move.total) {
    if (!(now < since + SERVER_MOVE_DONE_SHOWN_MS)) return null;
    return {
      title: unplug ? `${T.move.done(move.total, name)} ${T.move.unplug}` : T.move.done(move.total, name),
      missing: null,
      repoint: false,
      dot: 'ok',
      running: false,
    };
  }
  const late = !(now < since + SERVER_MOVE_LATE_MS);
  return {
    title: T.move.progress(move.found, move.total, name),
    missing: late ? T.move.missing(move.total - move.found, name) : null,
    repoint: late,
    dot: late ? 'warn' : 'mut',
    running: !late,
  };
}

/**
 * The router tip: while a move that changed the box's address is known, which card now carries the
 * new address (the Wi-Fi card, or the cable when the box moved to it) and its hardware address, when known.
 */
export function addressTip(
  network: HostNetwork,
  move: ServerMove | null | undefined,
  name: string,
): string | null {
  if (!move?.from || move.from === move.to) return null;
  const wifi = network.wifi;
  const cable = network.wired.find((w) => w.address === move.to) ?? network.wired.find((w) => w.mac);
  const onWifi =
    wifi?.address === move.to
      ? true
      : network.wired.some((w) => w.address === move.to)
        ? false
        : !!network.wifiOnly;
  const mac = (onWifi ? wifi?.mac : cable?.mac) ?? null;
  return T.addressTip(name, move.from, move.to, onWifi ? 'wifi' : 'cable', mac);
}

/** The Use Wi-Fi only dialog's words: the network it stays on, the guard, and the other-network note when it applies. */
export interface WifiOnlyDialogView {
  title: string;
  lead: string;
  guard: string;
  /** The Wi-Fi's network isn't the cable's: the servers can't follow by themselves. Null: same network, or unknown. */
  otherNetwork: string | null;
}

export function wifiOnlyDialogView(network: HostNetwork, name: string): WifiOnlyDialogView {
  const D = T.wifiOnlyDialog;
  const wifi = network.wifi;
  const cable = network.wired.find((w) => w.connected) ?? null;
  const other = wifi && cable ? sameSubnet(cable, wifi) === false : false;
  return {
    title: D.title,
    lead: D.lead(name, wifi?.ssid ?? T.wifi),
    guard: D.guard(name),
    otherNetwork: other ? D.otherNetwork(name) : null,
  };
}

/** A change in words (HD-11): what runs, or how it ended and why. */
export function networkChangeView(change: NetworkChange, name: string): NetworkChangeView {
  const { ssid } = change;
  const previous = change.previous ?? null;
  const why = change.failure ? T.failures[change.failure](ssid, name) : null;
  const line = (title: string, meta: string | null, dot: Dot) => ({
    id: change.id,
    title,
    meta,
    dot,
    running: networkChangeRunning(change),
  });
  if (change.kind === 'join')
    switch (change.phase) {
      case 'applying':
        return line(`Joining ${ssid}…`, previous ? T.dialog.guard(name) : null, 'mut');
      case 'confirming':
        return line(`Joined ${ssid}`, `Checking that ${name} reaches the internet there…`, 'mut');
      case 'committed':
        return line(`Joined ${ssid}`, null, 'ok');
      case 'reverting':
        return line(
          previous ? `Going back to ${previous}…` : `Leaving ${ssid}…`,
          why ?? `${name} couldn’t reach the internet there.`,
          'warn',
        );
      case 'reverted':
        return line(
          `Couldn’t switch to ${ssid}`,
          change.failure === 'no_address'
            ? `${ssid} didn’t give ${name} an address, so it ${previous ? `went back to ${previous}` : 'left it again'}.`
            : `Joined ${ssid}, but ${name} couldn’t reach the internet there, so it ${
                previous ? `went back to ${previous}` : 'left it again'
              }.`,
          'warn',
        );
      default:
        return line(`Couldn’t join ${ssid}`, why ?? T.failures.failed(ssid, name), 'bad');
    }
  switch (change.phase) {
    case 'applying':
      return line(`Forgetting ${ssid}…`, null, 'mut');
    case 'confirming':
      return line(`Forgot ${ssid}`, `Checking that ${name} still reaches the internet…`, 'mut');
    case 'committed':
      return line(`Forgot ${ssid}`, null, 'ok');
    case 'reverting':
      return line(`Joining ${ssid} again…`, `${name} couldn’t reach the internet without it.`, 'warn');
    case 'reverted':
      return line(
        `Kept ${ssid}`,
        `${name} couldn’t reach the internet without ${ssid}, so it joined it again.`,
        'warn',
      );
    default:
      return line(`Couldn’t forget ${ssid}`, why ?? T.failures.failed(ssid, name), 'bad');
  }
}

/**
 * What NETWORK shows (AP-3202…AP-3205): a row per cable (“Cable · Connected” and its address; with more than one, the
 * interface tells them apart), the Wi-Fi (“Wi-Fi · Home · Strong signal”, connecting, not connected — or why there is
 * none), “Can’t reach Whombat right now” first when the box couldn't, the saved networks (the one in use first) and the
 * change.
 */
export function networkSectionView(
  network: HostNetwork,
  {
    name,
    seenRunning = false,
    cableSeenRunning = false,
    move = null,
    now = Date.now(),
  }: {
    name: string;
    seenRunning?: boolean;
    cableSeenRunning?: boolean;
    /** `host.network`'s `move` (the poller keeps it). */
    move?: ServerMove | null;
    now?: number;
  },
): NetworkSectionView {
  const rows: NetworkRowView[] = [];
  const base = { signal: null, hardware: false, action: null } as const;
  const busy = networkChangeRunning(network.change) || networkChangeRunning(network.cableChange);
  const wifiOnly = network.wifiOnly === true;
  const plugged = network.wired.some((w) => w.plugged === true);
  // Unplugging is safe only once Wi-Fi only is kept: while it is still being checked it may go back to the cable.
  const unplug = wifiOnly && plugged && !networkChangeRunning(network.cableChange);
  if (!network.online && network.checkedAt !== null)
    rows.push({
      ...base,
      key: 'offline',
      kind: 'offline',
      title: T.offline,
      meta: T.offlineMeta,
      dot: 'warn',
    });
  const many = network.wired.length > 1;
  // Wi-Fi only: the cables are switched off; the first one plugged in offers the cable again.
  const again = wifiOnly && !busy ? network.wired.find((w) => w.plugged === true) : undefined;
  for (const w of network.wired)
    rows.push(
      wifiOnly
        ? {
            ...base,
            key: `cable:${w.interface}`,
            kind: 'cable',
            title: `${T.cable} · ${T.switchedOff}`,
            meta: join([T.wifiOnlyMeta(name, unplug && w.plugged === true), many ? w.interface : null]),
            dot: 'mut',
            action: w === again ? 'cable' : null,
          }
        : {
            ...base,
            key: `cable:${w.interface}`,
            kind: 'cable',
            title: `${T.cable} · ${w.connected ? T.connected : T.notConnected}`,
            meta: join([w.connected ? (w.address ?? null) : null, many ? w.interface : null]),
            dot: w.connected ? 'ok' : 'mut',
          },
    );
  // A USB adapter that was pulled out leaves no interface: the choice is still said.
  if (wifiOnly && network.wired.length === 0)
    rows.push({
      ...base,
      key: 'cable:off',
      kind: 'cable',
      title: `${T.cable} · ${T.switchedOff}`,
      meta: T.wifiOnlyMeta(name, false),
      dot: 'mut',
    });
  const cable = network.wired.some((w) => w.connected);
  const wifi = network.wifi;
  // A manager that knows Wi-Fi only says whether it is on, or whether a cable is plugged in (contracts 3.13).
  const knowsWifiOnly = network.wifiOnly !== undefined || network.wired.some((w) => w.plugged !== undefined);
  if (wifi) {
    const ssid = wifi.ssid;
    if (wifi.state === 'connected' && ssid)
      rows.push({
        ...base,
        key: 'wifi',
        kind: 'wifi',
        title: [T.wifi, ssid, wifi.signal === undefined ? null : wifiSignalText(wifi.signal as WifiSignal)]
          .filter(Boolean)
          .join(' · '),
        meta: join([wifi.address ?? null, cable ? T.cableWins : null]),
        dot: 'ok',
        signal: (wifi.signal ?? null) as WifiSignal | null,
        action: cable && !wifiOnly && !busy && knowsWifiOnly ? 'wifiOnly' : null,
      });
    else if (wifi.state === 'connecting')
      rows.push({
        ...base,
        key: 'wifi',
        kind: 'wifi',
        title: `${T.wifi} · ${T.connecting(ssid)}`,
        meta: null,
        dot: 'mut',
      });
    else
      rows.push({
        ...base,
        key: 'wifi',
        kind: 'wifi',
        title: `${T.wifi} · ${T.notConnected}`,
        meta: null,
        dot: 'mut',
      });
  } else if (network.wifiMissing) {
    const m = T.missing[network.wifiMissing];
    rows.push({
      key: 'wifi-missing',
      kind: 'missing',
      title: m.title,
      meta: m.meta,
      dot: network.wifiMissing === 'no_adapter' ? 'mut' : 'warn',
      signal: null,
      hardware: network.wifiMissing !== 'no_adapter',
      action: null,
    });
  }
  const current = wifi?.state === 'connected' ? wifi.ssid : undefined;
  const saved = (wifi?.saved ?? [])
    .map((s) => ({
      ssid: s.ssid,
      security: s.security,
      connected: s.ssid === current,
      meta: join([
        s.ssid === current ? T.inUse : T.saved,
        s.security === 'open' ? T.open : T.secured,
      ]) as string,
    }))
    .sort((a, b) => Number(b.connected) - Number(a.connected));
  const change =
    network.change && networkChangeShown(network.change, { seenRunning, now })
      ? networkChangeView(network.change, name)
      : null;
  const cableChange =
    network.cableChange && cableChangeShown(network.cableChange, { seenRunning: cableSeenRunning, now })
      ? cableChangeView(network.cableChange, name)
      : null;
  return {
    rows,
    saved,
    change,
    cableChange,
    move: serverMoveView(move, { name, unplug, now }),
    tip: addressTip(network, move, name),
    canJoin: wifi !== null && !busy,
    busy,
  };
}

const join = (parts: readonly (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length ? kept.join(' · ') : null;
};

/* The Wi-Fi dialog ----------------------------------------------------------------------------------------------- */

/** One network in the dialog's list. */
export interface WifiRowView {
  ssid: string;
  security: WifiSecurity;
  signal: WifiSignal;
  /** The lock. */
  secured: boolean;
  saved: boolean;
  connected: boolean;
  /** “Connected”, “Saved”, or why it can't be joined. */
  meta: string | null;
  /** Company (802.1X) and WEP networks are listed but can't be joined yet (HD-05). */
  joinable: boolean;
  /** What a screen reader hears: “Home, secured, strong signal, saved”. */
  label: string;
}

/** The dialog's list: the network in use first, then as the scan has them (strongest first). */
export function wifiRows(scan: Pick<WifiScan, 'networks'>): WifiRowView[] {
  return [...scan.networks]
    .sort((a, b) => Number(b.connected) - Number(a.connected))
    .map((n) => {
      const joinable = n.security === 'open' || n.security === 'psk';
      const reason = joinable ? null : T.rowReason[n.security as 'enterprise' | 'other'];
      const state = n.connected ? T.connected : n.saved ? T.saved : null;
      return {
        ssid: n.ssid,
        security: n.security,
        signal: n.signal as WifiSignal,
        secured: n.security !== 'open',
        saved: n.saved,
        connected: n.connected,
        meta: reason ?? state,
        joinable,
        label: [
          n.ssid,
          n.security === 'open' ? T.open.toLowerCase() : T.secured.toLowerCase(),
          wifiSignalText(n.signal as WifiSignal).toLowerCase(),
          state?.toLowerCase() ?? null,
          reason,
        ]
          .filter(Boolean)
          .join(', '),
      };
    });
}

/** Whether joining asks for a password: a secured network this Whombat hasn't saved (a saved one joins without). */
export function wifiNeedsPassword(network: Pick<WifiNetwork, 'security' | 'saved'>): boolean {
  return network.security === 'psk' && !network.saved;
}

/** The password's problem in words, or null (8–63 characters, or 64 hex digits). */
export function wifiPasswordProblem(password: string): string | null {
  return /^(?:[\x20-\x7e]{8,63}|[0-9A-Fa-f]{64})$/.test(password) ? null : T.problems.password;
}

/** A typed network name's problem in words, or null (1–32 bytes, printable). */
export function wifiNameProblem(name: string): string | null {
  if (name.trim() === '') return T.problems.name;
  if (!ssidValid(name)) return T.problems.nameLong;
  return null;
}

/** `host.wifi.join`'s input from the dialog: the password only for a secured network, `hidden` for one typed in. */
export function wifiJoinInput(form: {
  ssid: string;
  security: WifiSecurity;
  password?: string;
  hidden?: boolean;
}): WifiJoinInput {
  return {
    ssid: form.ssid,
    ...(form.security === 'psk' && form.password ? { passphrase: form.password } : {}),
    ...(form.hidden ? { hidden: true } : {}),
  };
}

/** The refusal's code: the network's code in `details` before the error's own (as the desk's, CT-525). */
export function networkErrorCode(error: unknown): NetworkErrorCode | null {
  if (!(error instanceof OperationError)) return null;
  const detail = (error.details as { code?: unknown } | undefined)?.code;
  const known = (c: unknown): c is NetworkErrorCode => typeof c === 'string' && c in T.errors;
  return known(detail) ? detail : known(error.code) ? error.code : null;
}

/** A `host.wifi.*` refusal in words (never the password). */
export function networkErrorText(error: unknown, name: string): string {
  const code = networkErrorCode(error);
  return code ? T.errors[code](name) : T.failed;
}

/* Following a change --------------------------------------------------------------------------------------------- */

/** How often a running change is asked about (§2.3: no realtime). */
export const NETWORK_POLL_MS = 2_000;
/** How often the servers' move is asked about while servers are still to come. */
export const NETWORK_MOVE_POLL_MS = 5_000;
/** For how long at most a move is followed, from when it started (or was first seen here, if later). */
export const NETWORK_MOVE_FOLLOW_MS = 10 * 60_000;
/**
 * After a cable change ends it is asked about a while longer (every `movePollMs`): the cable's address and the servers'
 * move with it come a few seconds after the change.
 */
export const NETWORK_CABLE_SETTLE_MS = 60_000;

export interface NetworkPollState {
  network: HostNetwork | null;
  /** `not_managed`: no manager; `unavailable`: it couldn't be read (and nothing was shown before). */
  reason: HostNetworkOutput['reason'] | null;
  loading: boolean;
  /** The change on screen was seen running here (its ending is told; `networkChangeShown`). */
  seenRunning: boolean;
  /** The cable change on screen was seen running here (`cableChangeShown`). */
  cableSeenRunning: boolean;
  /** The servers following the box's address (`host.network`'s `move`); null: none. */
  move: ServerMove | null;
}

export interface NetworkPoller {
  getState(): NetworkPollState;
  subscribe(listener: () => void): () => void;
  /** Ask now (on open, after a change was refused). */
  refresh(): void;
  /** A change the app just started: shown at once, then followed. */
  started(change: NetworkChange): void;
  /** A cable change the app just started (Use Wi-Fi only, Use the cable again): shown at once, then followed. */
  cableStarted(change: CableChange): void;
  /** On screen and visible, or not (stop asking). */
  setActive(active: boolean): void;
  dispose(): void;
}

export interface NetworkPollerOptions {
  api: NetworkApi | null;
  pollMs?: number;
  movePollMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * NETWORK, live while a change runs (AP-3206): `host.network` once when it becomes active, then every 2 s while the
 * answer's change runs, and no more once it ended. While a change runs an answer that fails is ignored: switching
 * networks can drop the box's connection for a moment, so the change stays on screen and is asked about again. A cable
 * change is followed the same way; after it, for a minute (the cable's address and the servers' new move come a few
 * seconds later) and while the answer's `move` has servers still to come, it asks every 5 s for at most 10 minutes. UI-free: the web wraps it in a hook, Android in its screen; state is replaced on
 * every change (`useSyncExternalStore`).
 */
export function createNetworkPoller(options: NetworkPollerOptions): NetworkPoller {
  const api = options.api;
  const pollMs = options.pollMs ?? NETWORK_POLL_MS;
  const movePollMs = options.movePollMs ?? NETWORK_MOVE_POLL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state: NetworkPollState = {
    network: null,
    reason: api ? null : 'not_managed',
    loading: api !== null,
    seenRunning: false,
    cableSeenRunning: false,
    move: null,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let disposed = false;
  let asking = false;
  let again = false;
  let timer: unknown = null;
  /** Bumped by every change started here: an answer asked for before it is dropped (it can't know the change). */
  let generation = 0;

  const set = (patch: Partial<NetworkPollState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const running = () =>
    networkChangeRunning(state.network?.change) || networkChangeRunning(state.network?.cableChange);
  /** The move being followed: when it started (its `since`) and until when it is asked about. */
  let following: { since: string; until: number } | null = null;
  /** When a cable change seen running here was seen ended. */
  let cableEndedAt: number | null = null;
  const settling = () => cableEndedAt !== null && now() < cableEndedAt + NETWORK_CABLE_SETTLE_MS;
  const moving = () => {
    const move = state.move;
    if (!move || move.found >= move.total) return false;
    if (following?.since !== move.since) {
      const start = Date.parse(move.since);
      following = {
        since: move.since,
        until: (Number.isNaN(start) ? now() : Math.min(start, now())) + NETWORK_MOVE_FOLLOW_MS,
      };
    }
    return now() < following.until;
  };
  const schedule = () => {
    stop();
    if (!active || disposed) return;
    if (running()) timer = setTimer(ask, pollMs);
    else if (moving() || settling()) timer = setTimer(ask, movePollMs);
  };

  /** Whether the answer's change is the one seen running here. */
  const seen = (next: HostNetwork): boolean => {
    const change = next.change;
    if (!change) return false;
    if (networkChangeRunning(change)) return true;
    return state.seenRunning && state.network?.change?.id === change.id;
  };
  const cableSeen = (next: HostNetwork): boolean => {
    const change = next.cableChange;
    if (!change) return false;
    if (networkChangeRunning(change)) return true;
    return state.cableSeenRunning && state.network?.cableChange?.id === change.id;
  };

  function ask() {
    timer = null;
    if (!api || disposed) return;
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    const mine = generation;
    api.state().then(
      (out) => {
        asking = false;
        if (disposed) return;
        if (mine !== generation) again = true;
        else if (out.network) {
          if (
            networkChangeRunning(state.network?.cableChange) &&
            !networkChangeRunning(out.network.cableChange)
          )
            cableEndedAt = now();
          set({
            network: out.network,
            reason: null,
            loading: false,
            seenRunning: seen(out.network),
            cableSeenRunning: cableSeen(out.network),
            move: out.move ?? null,
          });
        } else if (!running()) set({ network: null, reason: out.reason ?? 'unavailable', loading: false });
        after();
      },
      () => {
        asking = false;
        if (disposed) return;
        if (mine !== generation) again = true;
        // A running change keeps its line (the box may be between networks); otherwise what was shown stays.
        if (!running() && !state.network) set({ reason: 'unavailable', loading: false });
        after();
      },
    );
  }

  const after = () => {
    if (again) {
      again = false;
      ask();
    } else schedule();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      if (disposed || !api) return;
      stop();
      ask();
    },
    started(change) {
      if (disposed) return;
      generation += 1;
      const network = state.network;
      if (network) set({ network: { ...network, change }, seenRunning: true });
      stop();
      if (active) ask();
    },
    cableStarted(change) {
      if (disposed) return;
      generation += 1;
      const network = state.network;
      if (network) set({ network: { ...network, cableChange: change }, cableSeenRunning: true });
      stop();
      if (active) ask();
    },
    setActive(next) {
      if (disposed || next === active) return;
      active = next;
      if (active) ask();
      else stop();
    },
    dispose() {
      disposed = true;
      active = false;
      stop();
      listeners.clear();
    },
  };
}
