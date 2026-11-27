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

import { hostRepointWords } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import type { z } from 'zod';
import { clientTree } from '../i18n/catalog';
import { NETWORK_WORDS } from '../i18n/messages/hostManaged/network';
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

/** Every word of NETWORK and its dialogs, in a locale (English when none is given). `name` is the Whombat's name. */
export function networkText(locale?: string | null) {
  const w = clientTree(locale, NETWORK_WORDS);
  const named = (template: string) => (name: string) => interpolate(template, { name });
  const phases = (words: Record<NetworkChangePhase, string>) =>
    Object.fromEntries(Object.entries(words).map(([phase, t]) => [phase, named(t)])) as Record<
      NetworkChangePhase,
      (name: string) => string
    >;
  return {
    section: w.section,
    cable: w.cable,
    wifi: w.wifi,
    connected: w.connected,
    notConnected: w.notConnected,
    connecting: (ssid: string | undefined) => (ssid ? interpolate(w.connectingTo, { ssid }) : w.connecting),
    /** With a cable plugged in, the Wi-Fi waits (a cable wins). */
    cableWins: w.cableWins,
    unavailable: w.unavailable,
    tryAgain: w.tryAgain,
    offline: w.offline,
    offlineMeta: w.offlineMeta,
    missing: w.missing,
    /** The Wi-Fi card is in the hardware report (About → HARDWARE). */
    seeHardware: w.seeHardware,
    saved: w.saved,
    inUse: w.inUse,
    secured: w.secured,
    open: w.open,
    forget: w.forget,
    join: w.join,
    forgetDialog: {
      title: (ssid: string) => interpolate(w.forgetDialog.title, { ssid }),
      lead: (name: string, secured: boolean) =>
        interpolate(secured ? w.forgetDialog.leadSecured : w.forgetDialog.leadOpen, { name }),
      submit: w.forgetDialog.submit,
      busy: w.forgetDialog.busy,
    },
    dialog: {
      ...w.dialog,
      lead: named(w.dialog.lead),
      securities: w.dialog.securities as Record<'psk' | 'open', string>,
      guard: named(w.dialog.guard),
    },
    rowReason: w.rowReason as Record<'enterprise' | 'other', string>,
    signal: (signal: WifiSignal) =>
      signal >= 4 ? w.signal.strong : signal >= 2 ? w.signal.good : w.signal.weak,
    problems: w.problems,
    failures: {
      wrong_password: () => w.failures.wrong_password,
      not_found: (ssid: string) => interpolate(w.failures.not_found, { ssid }),
      no_address: (ssid: string, name: string) => interpolate(w.failures.no_address, { ssid, name }),
      no_internet: (_ssid: string, name: string) => interpolate(w.failures.no_internet, { name }),
      failed: () => w.failures.failed,
    } as Record<NetworkChangeFailure, (ssid: string, name: string) => string>,
    errors: {
      no_wifi: named(w.errors.no_wifi),
      busy: () => w.errors.busy,
      in_use: named(w.errors.in_use),
      not_saved: () => w.errors.not_saved,
      invalid_passphrase: () => w.errors.invalid_passphrase,
      not_connected: named(w.errors.not_connected),
      no_cable: named(w.errors.no_cable),
      unchanged: named(w.errors.unchanged),
      forbidden: () => w.errors.forbidden,
    } as Record<NetworkErrorCode, (name: string) => string>,
    failed: w.failed,
    /* Wi-Fi only and the cable again (Whombat network-move.md). */
    useWifiOnly: w.useWifiOnly,
    useCableAgain: w.useCableAgain,
    switchedOff: w.switchedOff,
    /** A switched-off cable's row: unplugging it is safe now (once Wi-Fi only is kept). */
    wifiOnlyMeta: (name: string, plugged: boolean) =>
      interpolate(plugged ? w.wifiOnlyMeta.plugged : w.wifiOnlyMeta.unplugged, { name }),
    wifiOnlyDialog: {
      title: w.wifiOnlyDialog.title,
      lead: (name: string, ssid: string) => interpolate(w.wifiOnlyDialog.lead, { name, ssid }),
      guard: named(w.wifiOnlyDialog.guard),
      /** The Wi-Fi's subnet isn't the cable's: agents search only their own network. */
      otherNetwork: named(w.wifiOnlyDialog.otherNetwork),
      submit: w.wifiOnlyDialog.submit,
      busy: w.wifiOnlyDialog.busy,
    },
    cableDialog: { ...w.cableDialog, lead: named(w.cableDialog.lead) },
    /** A cable change's line, by what it makes the box use and its phase. */
    cableChange: {
      wifi: phases(w.cableChange.wifi),
      cable: phases(w.cableChange.cable),
    } satisfies Record<CableUse, Record<NetworkChangePhase, (name: string) => string>>,
    /** The box turned its cable back on by itself. */
    cableBackup: named(w.cableBackup),
    /** The servers following the box's new address. */
    move: {
      progress: (found: number, total: number, name: string) =>
        w.move.progress(total, { found, total, name }),
      done: (total: number, name: string) => w.move.done(total, { name }),
      unplug: w.move.unplug,
      missing: (n: number, name: string) => w.move.missing(n, { name }),
      pointHere: hostRepointWords(locale).pointThemHere,
    },
    /** How to keep the old address: the router's fixed address for the card the box uses now. */
    addressTip: (name: string, from: string, to: string, card: 'wifi' | 'cable', mac: string | null) =>
      interpolate(w.addressTip.line, {
        name,
        from,
        to,
        card: card === 'wifi' ? w.addressTip.wifiCard : w.addressTip.cable,
        mac: mac ? interpolate(w.addressTip.mac, { mac: mac.toUpperCase() }) : '',
      }),
    /** A Wi-Fi join's and forget's lines, by phase (`networkChangeView`). */
    joinChange: w.joinChange,
    forgetChange: w.forgetChange,
  } as const;
}

export type NetworkText = ReturnType<typeof networkText>;

/** NETWORK's words in English. */
export const NETWORK_TEXT: NetworkText = networkText('en');

/** “Strong signal”, “Good signal”, “Weak signal” (4 bars; 3–2; 1–0). */
export function wifiSignalText(signal: WifiSignal, locale?: string | null): string {
  return networkText(locale).signal(signal);
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
export function cableChangeView(
  change: CableChange,
  name: string,
  locale?: string | null,
): NetworkChangeView {
  const T = networkText(locale);
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
  { name, unplug, now, locale }: { name: string; unplug: boolean; now: number; locale?: string | null },
): ServerMoveView | null {
  const T = networkText(locale);
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
  locale?: string | null,
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
  return networkText(locale).addressTip(name, move.from, move.to, onWifi ? 'wifi' : 'cable', mac);
}

/** The Use Wi-Fi only dialog's words: the network it stays on, the guard, and the other-network note when it applies. */
export interface WifiOnlyDialogView {
  title: string;
  lead: string;
  guard: string;
  /** The Wi-Fi's network isn't the cable's: the servers can't follow by themselves. Null: same network, or unknown. */
  otherNetwork: string | null;
}

export function wifiOnlyDialogView(
  network: HostNetwork,
  name: string,
  locale?: string | null,
): WifiOnlyDialogView {
  const T = networkText(locale);
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
export function networkChangeView(
  change: NetworkChange,
  name: string,
  locale?: string | null,
): NetworkChangeView {
  const T = networkText(locale);
  const { ssid } = change;
  const previous = change.previous ?? null;
  const why = change.failure ? T.failures[change.failure](ssid, name) : null;
  const say = (template: string) => interpolate(template, { ssid, name, previous: previous ?? '' });
  const line = (title: string, meta: string | null, dot: Dot) => ({
    id: change.id,
    title,
    meta,
    dot,
    running: networkChangeRunning(change),
  });
  if (change.kind === 'join') {
    const J = T.joinChange;
    switch (change.phase) {
      case 'applying':
        return line(say(J.applying), previous ? T.dialog.guard(name) : null, 'mut');
      case 'confirming':
        return line(say(J.joined), say(J.checking), 'mut');
      case 'committed':
        return line(say(J.joined), null, 'ok');
      case 'reverting':
        return line(previous ? say(J.goingBack) : say(J.leaving), why ?? say(J.noInternet), 'warn');
      case 'reverted':
        return line(
          say(J.reverted),
          change.failure === 'no_address'
            ? say(previous ? J.noAddressBack : J.noAddressLeft)
            : say(previous ? J.noInternetBack : J.noInternetLeft),
          'warn',
        );
      default:
        return line(say(J.failed), why ?? T.failures.failed(ssid, name), 'bad');
    }
  }
  const F = T.forgetChange;
  switch (change.phase) {
    case 'applying':
      return line(say(F.applying), null, 'mut');
    case 'confirming':
      return line(say(F.forgot), say(F.checking), 'mut');
    case 'committed':
      return line(say(F.forgot), null, 'ok');
    case 'reverting':
      return line(say(F.joiningAgain), say(F.noInternet), 'warn');
    case 'reverted':
      return line(say(F.kept), say(F.keptMeta), 'warn');
    default:
      return line(say(F.failed), why ?? T.failures.failed(ssid, name), 'bad');
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
    locale,
  }: {
    name: string;
    seenRunning?: boolean;
    cableSeenRunning?: boolean;
    /** `host.network`'s `move` (the poller keeps it). */
    move?: ServerMove | null;
    now?: number;
    /** The language of the words (English when none is given). */
    locale?: string | null;
  },
): NetworkSectionView {
  const T = networkText(locale);
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
        title: [T.wifi, ssid, wifi.signal === undefined ? null : T.signal(wifi.signal as WifiSignal)]
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
      ? networkChangeView(network.change, name, locale)
      : null;
  const cableChange =
    network.cableChange && cableChangeShown(network.cableChange, { seenRunning: cableSeenRunning, now })
      ? cableChangeView(network.cableChange, name, locale)
      : null;
  return {
    rows,
    saved,
    change,
    cableChange,
    move: serverMoveView(move, { name, unplug, now, locale }),
    tip: addressTip(network, move, name, locale),
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
export function wifiRows(scan: Pick<WifiScan, 'networks'>, locale?: string | null): WifiRowView[] {
  const T = networkText(locale);
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
          T.signal(n.signal as WifiSignal).toLowerCase(),
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
export function wifiPasswordProblem(password: string, locale?: string | null): string | null {
  return /^(?:[\x20-\x7e]{8,63}|[0-9A-Fa-f]{64})$/.test(password)
    ? null
    : networkText(locale).problems.password;
}

/** A typed network name's problem in words, or null (1–32 bytes, printable). */
export function wifiNameProblem(name: string, locale?: string | null): string | null {
  const T = networkText(locale);
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
  const known = (c: unknown): c is NetworkErrorCode => typeof c === 'string' && c in NETWORK_TEXT.errors;
  return known(detail) ? detail : known(error.code) ? error.code : null;
}

/** A `host.wifi.*` refusal in words (never the password). */
export function networkErrorText(error: unknown, name: string, locale?: string | null): string {
  const T = networkText(locale);
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
