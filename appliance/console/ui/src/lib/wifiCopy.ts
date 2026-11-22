/**
 * The Wi-Fi sheet's, the chip's and the installer's Wi-Fi words (Whombat hardware-support.md HD-11; CG-110). HD-11's
 * words are the words; the rest says what the app's NETWORK says (whombat-app `packages/client/src/host/network.ts`,
 * `NETWORK_TEXT`), in the same voice, with “Whombat” for the box as HD-11 has it. Kinds and states come from the
 * server; the words are made here.
 */
import type {
  HostNetwork,
  NetworkChange,
  NetworkChangeFailure,
  NetworkSummary,
  WifiMissing,
  WifiNetwork,
  WifiSignal,
} from './network';
import { connectedVia } from './network';

/** The box as the words name it (HD-11: “… but Whombat couldn’t reach the internet there …”). */
const BOX = 'Whombat';

export const WIFI = {
  kicker: 'WI-FI',
  title: 'Join a Wi-Fi network',
  readOnlyTitle: 'Wi-Fi',
  cable: 'Cable',
  /** The chip on top of the screen: a word alone there has to say what it is about. */
  chipCable: 'Wired network',
  wifi: 'Wi-Fi',
  connected: 'Connected',
  notConnected: 'Not connected',
  connecting: (ssid: string | undefined) => (ssid ? `Connecting to ${ssid}…` : 'Connecting…'),
  noNetwork: 'No network',
  offline: 'Can’t reach Whombat right now',
  unreadable: 'The network couldn’t be read right now.',
  /** With a cable plugged in, the Wi-Fi waits (HD-05). */
  cableWins: 'Used when the cable is unplugged',
  saved: 'Saved',
  open: 'Open',
  secured: 'Secured',
  forget: 'Forget',
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
  join: 'Join',
  joining: 'Joining…',
  joinTitle: (ssid: string) => `Join ${ssid}`,
  back: 'Back',
  cancel: 'Cancel',
  close: 'Close',
  done: 'Done',
  tryAgain: 'Try again',
  guard: `If ${BOX} can’t reach the internet on the new network, it goes back to the one it uses now.`,
  /** HD-07: the screen may not change the Wi-Fi now. */
  readOnly: 'Unlock the screen to change Wi-Fi, or change it in the app.',
  chooseWifi: 'Choose Wi-Fi',
  /** The waiting scene, when the box has a Wi-Fi card (CG-106). */
  waitingHint: 'Connect a network cable, or choose a Wi-Fi network.',
  missing: {
    no_adapter: 'This Whombat has no Wi-Fi card. Connect a network cable.',
    no_driver: 'This Wi-Fi card has no driver yet. Connect a network cable.',
    disabled: 'Wi-Fi is switched off. Turn it on with the machine’s Wi-Fi key or switch.',
  } satisfies Record<WifiMissing, string>,
  rowReason: {
    enterprise: 'Company networks can’t be joined yet.',
    other: 'This kind of network can’t be joined.',
  } as Record<'enterprise' | 'other', string>,
  problems: {
    name: 'Type the network’s name.',
    nameLong: 'That name is too long for a Wi-Fi network.',
    password: 'A Wi-Fi password is 8 to 63 characters.',
  },
  forgetTitle: (ssid: string) => `Forget ${ssid}?`,
  forgetLead: (secured: boolean) =>
    secured
      ? `${BOX} won’t join it again until someone types its password.`
      : `${BOX} won’t join it again by itself.`,
  forgetting: 'Forgetting…',
  errors: {
    no_wifi: `${BOX} has no Wi-Fi.`,
    busy: 'Another network change is still running. Try again in a moment.',
    in_use: `${BOX} reaches the internet through this network. Plug in a cable or join another network first.`,
    not_saved: 'That network isn’t saved any more.',
    invalid_passphrase: 'A Wi-Fi password is 8 to 63 characters.',
  } as Record<string, string>,
  failed: 'That didn’t work. Try again.',
  /** The installer's step (HD-08, CG-120). */
  installer: {
    title: 'Connect to Wi-Fi',
    sub: 'There’s no network cable. Choose a Wi-Fi network so Whombat can reach the internet after the restart.',
    say: 'No cable? I can sniff out the Wi-Fi.',
    skip: 'Skip',
    checking: 'Checking the connection…',
    joinedSay: 'Got it. That one works.',
    joined: (ssid: string) => `Joined ${ssid}. Whombat uses it after the restart.`,
    missing: {
      no_adapter: 'This machine has no Wi-Fi card. Connect a network cable, then check again.',
      no_driver: 'This Wi-Fi card has no driver yet. Connect a network cable, then check again.',
      disabled: 'Wi-Fi is switched off. Turn it on with the machine’s Wi-Fi key or switch.',
    } satisfies Record<WifiMissing, string>,
  },
} as const;

/** “Strong signal”, “Good signal”, “Weak signal” (4 bars; 3–2; 1–0), as the app says. */
export function signalText(s: WifiSignal): string {
  return s >= 4 ? 'Strong signal' : s >= 2 ? 'Good signal' : 'Weak signal';
}

/** The sheet's connection line (HD-11): “Cable · Connected”, “Wi-Fi · Home · Strong signal”, … */
export function connectionLine(n: HostNetwork): string {
  const via = connectedVia(n);
  if (via === 'cable') return `${WIFI.cable} · ${WIFI.connected}`;
  const w = n.wifi;
  if (via === 'wifi' && w) {
    return [WIFI.wifi, w.ssid ?? null, w.signal === undefined ? null : signalText(w.signal)]
      .filter(Boolean)
      .join(' · ');
  }
  if (w?.state === 'connecting') return `${WIFI.wifi} · ${WIFI.connecting(w.ssid)}`;
  return WIFI.noNetwork;
}

/** The chip (CG-104): what the box uses, short; amber when it can't reach Whombat. */
export function chipView(s: NetworkSummary): {
  icon: 'cable' | 'wifi' | 'none';
  text: string;
  warn: boolean;
} {
  const warn = !s.online;
  if (s.via === 'cable') return { icon: 'cable', text: WIFI.chipCable, warn };
  if (s.via === 'wifi') return { icon: 'wifi', text: s.ssid ?? WIFI.wifi, warn };
  return { icon: 'none', text: WIFI.noNetwork, warn: true };
}

/** What a screen reader hears for the chip. */
export function chipLabel(s: NetworkSummary): string {
  const v = chipView(s);
  const what = s.via === 'wifi' ? `${WIFI.wifi} · ${v.text}` : v.text;
  return s.online || s.via === 'none' ? what : `${what} · ${WIFI.offline}`;
}

/** A row's second line: “Connected”, “Saved”, or why it can't be joined. */
export function rowMeta(n: WifiNetwork): string | null {
  if (n.security === 'enterprise' || n.security === 'other') return WIFI.rowReason[n.security];
  if (n.connected) return WIFI.connected;
  return n.saved ? WIFI.saved : null;
}

/** What a screen reader hears for a row: “Home, secured, strong signal, saved”. */
export function rowLabel(n: WifiNetwork): string {
  return [
    n.ssid,
    n.security === 'open' ? WIFI.open.toLowerCase() : WIFI.secured.toLowerCase(),
    signalText(n.signal).toLowerCase(),
    rowMeta(n),
  ]
    .filter(Boolean)
    .join(', ');
}

/** A typed network name's problem, or null (1–32 bytes, printable). */
export function nameProblem(name: string, valid: (s: string) => boolean): string | null {
  if (name.trim() === '') return WIFI.problems.name;
  return valid(name) ? null : WIFI.problems.nameLong;
}

const failureLine: Record<NetworkChangeFailure, (ssid: string) => string> = {
  wrong_password: () => 'That password didn’t work.',
  not_found: (ssid) => `Couldn’t find ${ssid} nearby.`,
  no_address: (ssid) => `${ssid} didn’t give ${BOX} an address.`,
  no_internet: () => `${BOX} couldn’t reach the internet there.`,
  failed: () => 'Something went wrong. Try again.',
};

export function failureText(f: NetworkChangeFailure, ssid: string): string {
  return failureLine[f](ssid);
}

/** A change on the sheet: running, worked, or how it ended (HD-11). `tone` colours the line. */
export interface ChangeView {
  running: boolean;
  title: string;
  line: string | null;
  tone: 'mut' | 'ok' | 'warn' | 'bad';
  /** A wrong password goes back to the password, with the line under it. */
  wrongPassword: boolean;
}

/** A join's or a forget's phase in words (the app's `networkChangeView`, HD-11's sentences). */
export function changeView(c: NetworkChange): ChangeView {
  const { ssid } = c;
  const prev = c.previous ?? null;
  const why = c.failure ? failureText(c.failure, ssid) : null;
  const v = (title: string, line: string | null, tone: ChangeView['tone'], running = false): ChangeView => ({
    running,
    title,
    line,
    tone,
    wrongPassword: c.failure === 'wrong_password' && c.phase === 'failed',
  });
  if (c.kind === 'join') {
    switch (c.phase) {
      case 'applying':
        return v(`Joining ${ssid}…`, prev ? WIFI.guard : null, 'mut', true);
      case 'confirming':
        return v(`Joined ${ssid}`, `Checking that ${BOX} reaches the internet there…`, 'mut', true);
      case 'committed':
        return v(`Joined ${ssid}`, null, 'ok');
      case 'reverting':
        return v(
          prev ? `Going back to ${prev}…` : `Leaving ${ssid}…`,
          why ?? failureText('no_internet', ssid),
          'warn',
          true,
        );
      case 'reverted': {
        const back = prev ? `went back to ${prev}` : 'left it again';
        return v(
          `Couldn’t switch to ${ssid}`,
          c.failure === 'no_address'
            ? `${ssid} didn’t give ${BOX} an address, so it ${back}.`
            : `Joined ${ssid}, but ${BOX} couldn’t reach the internet there, so it ${back}.`,
          'warn',
        );
      }
      default:
        return v(`Couldn’t join ${ssid}`, why ?? failureText('failed', ssid), 'bad');
    }
  }
  switch (c.phase) {
    case 'applying':
      return v(`Forgetting ${ssid}…`, null, 'mut', true);
    case 'confirming':
      return v(`Forgot ${ssid}`, `Checking that ${BOX} still reaches the internet…`, 'mut', true);
    case 'committed':
      return v(`Forgot ${ssid}`, null, 'ok');
    case 'reverting':
      return v(`Joining ${ssid} again…`, `${BOX} couldn’t reach the internet without it.`, 'warn', true);
    case 'reverted':
      return v(
        `Kept ${ssid}`,
        `${BOX} couldn’t reach the internet without ${ssid}, so it joined it again.`,
        'warn',
      );
    default:
      return v(`Couldn’t forget ${ssid}`, why ?? failureText('failed', ssid), 'bad');
  }
}

/** A refusal of a join or a forget (`{"message": code}`), in words. */
export function refusalText(code: string | null): string {
  return (code && WIFI.errors[code]) || WIFI.failed;
}
