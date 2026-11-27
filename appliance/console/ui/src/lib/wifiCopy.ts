/**
 * The Wi-Fi sheet's, the chip's and the installer's Wi-Fi words (Whombat hardware-support.md HD-11; CG-110). HD-11's
 * words are the words; the rest says what the app's NETWORK says (whombat-app `packages/client/src/host/network.ts`,
 * `NETWORK_TEXT`), in the same voice, with “Whombat” for the box as HD-11 has it. Kinds and states come from the
 * server; the words are made here.
 */
import { english, localized, type Translate } from '../i18n/translate';
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

export const wifiCopy = localized(
  (t) =>
    ({
      kicker: t('wifi.kicker'),
      title: t('wifi.title'),
      readOnlyTitle: 'Wi-Fi',
      cable: t('desk.calm.bar.cable'),
      /** The chip on top of the screen: a word alone there has to say what it is about. */
      chipCable: t('wifi.chipCable'),
      wifi: 'Wi-Fi',
      connected: t('bluetooth.connected'),
      notConnected: t('bluetooth.notConnected'),
      connecting: (ssid: string | undefined) =>
        ssid ? t('wifi.connecting.WithValue', { ssid }) : t('bluetooth.connecting'),
      noNetwork: t('desk.calm.bar.noNetwork'),
      offline: t('wifi.offline'),
      unreadable: t('wifi.unreadable'),
      /** With a cable plugged in, the Wi-Fi waits (HD-05). */
      cableWins: t('wifi.cableWins'),
      saved: t('wifi.saved'),
      open: t('wifi.open'),
      secured: t('wifi.secured'),
      forget: t('wifi.forget'),
      nearby: t('wifi.nearby'),
      looking: t('wifi.looking'),
      none: t('wifi.none'),
      again: t('bluetooth.again'),
      couldNotLook: t('wifi.couldNotLook'),
      other: t('wifi.other'),
      otherTitle: t('wifi.otherTitle'),
      otherLead: t('wifi.otherLead'),
      name: t('wifi.name'),
      security: t('wifi.security'),
      securities: { psk: t('wifi.securities.psk'), open: t('wifi.securities.open') } as Record<
        'psk' | 'open',
        string
      >,
      password: t('wifi.securities.psk'),
      show: t('wifi.show'),
      hide: t('wifi.hide'),
      join: t('wifi.join'),
      joining: t('wifi.joining'),
      joinTitle: (ssid: string) => t('wifi.joinTitle', { ssid }),
      back: t('bluetooth.back'),
      cancel: t('bluetooth.cancel'),
      close: t('bluetooth.close'),
      done: t('bluetooth.done'),
      tryAgain: t('bluetooth.tryAgain'),
      guard: t('wifi.guard'),
      /** HD-07: the screen may not change the Wi-Fi now. */
      readOnly: t('wifi.readOnly'),
      chooseWifi: t('wifi.chooseWifi'),
      /** The waiting scene, when the box has a Wi-Fi card (CG-106). */
      waitingHint: t('wifi.waitingHint'),
      missing: {
        no_adapter: t('wifi.missing.no_adapter'),
        no_driver: t('wifi.missing.no_driver'),
        disabled: t('wifi.missing.disabled'),
      } satisfies Record<WifiMissing, string>,
      rowReason: {
        enterprise: t('wifi.rowReason.enterprise'),
        other: t('wifi.rowReason.other'),
      } as Record<'enterprise' | 'other', string>,
      problems: {
        name: t('wifi.problems.name'),
        nameLong: t('wifi.problems.nameLong'),
        password: t('wifi.problems.password'),
      },
      forgetTitle: (ssid: string) => t('wifi.forgetTitle', { ssid }),
      forgetLead: (secured: boolean) =>
        secured ? t('wifi.forgetLead.WithValue') : t('wifi.forgetLead.Fallback'),
      forgetting: t('wifi.forgetting'),
      errors: {
        no_wifi: t('wifi.errors.no_wifi'),
        busy: t('wifi.errors.busy'),
        in_use: t('wifi.errors.in_use'),
        not_saved: t('wifi.errors.not_saved'),
        invalid_passphrase: t('wifi.problems.password'),
      } as Record<string, string>,
      failed: t('bluetooth.failed'),
      /** The installer's step (HD-08, CG-120). */
      installer: {
        title: t('wifi.installer.title'),
        sub: t('wifi.installer.sub'),
        say: t('wifi.installer.say'),
        skip: t('wifi.installer.skip'),
        checking: t('wifi.installer.checking'),
        joinedSay: t('wifi.installer.joinedSay'),
        joined: (ssid: string) => t('wifi.installer.joined', { ssid }),
        missing: {
          no_adapter: t('wifi.installer.missing.no_adapter'),
          no_driver: t('wifi.installer.missing.no_driver'),
          disabled: t('wifi.missing.disabled'),
        } satisfies Record<WifiMissing, string>,
      },
    }) as const,
);
export const WIFI = wifiCopy();

/** “Strong signal”, “Good signal”, “Weak signal” (4 bars; 3–2; 1–0), as the app says. */
export function signalText(s: WifiSignal, t: Translate = english): string {
  return s >= 4 ? t('wifiCopy.strongSignal') : s >= 2 ? t('wifiCopy.goodSignal') : t('wifiCopy.weakSignal');
}

/** The sheet's connection line (HD-11): “Cable · Connected”, “Wi-Fi · Home · Strong signal”, … */
export function connectionLine(n: HostNetwork, t: Translate = english): string {
  const WIFI = wifiCopy(t);

  const via = connectedVia(n);
  if (via === 'cable') return `${WIFI.cable} · ${WIFI.connected}`;
  const w = n.wifi;
  if (via === 'wifi' && w) {
    return [WIFI.wifi, w.ssid ?? null, w.signal === undefined ? null : signalText(w.signal, t)]
      .filter(Boolean)
      .join(' · ');
  }
  if (w?.state === 'connecting') return `${WIFI.wifi} · ${WIFI.connecting(w.ssid)}`;
  return WIFI.noNetwork;
}

/** The chip (CG-104): what the box uses, short; amber when it can't reach Whombat. */
export function chipView(
  s: NetworkSummary,
  t: Translate = english,
): {
  icon: 'cable' | 'wifi' | 'none';
  text: string;
  warn: boolean;
} {
  const WIFI = wifiCopy(t);

  const warn = !s.online;
  if (s.via === 'cable') return { icon: 'cable', text: WIFI.chipCable, warn };
  if (s.via === 'wifi') return { icon: 'wifi', text: s.ssid ?? WIFI.wifi, warn };
  return { icon: 'none', text: WIFI.noNetwork, warn: true };
}

/** What a screen reader hears for the chip. */
export function chipLabel(s: NetworkSummary, t: Translate = english): string {
  const WIFI = wifiCopy(t);

  const v = chipView(s, t);
  const what = s.via === 'wifi' ? `${WIFI.wifi} · ${v.text}` : v.text;
  return s.online || s.via === 'none' ? what : `${what} · ${WIFI.offline}`;
}

/** A row's second line: “Connected”, “Saved”, or why it can't be joined. */
export function rowMeta(n: WifiNetwork, t: Translate = english): string | null {
  const WIFI = wifiCopy(t);

  if (n.security === 'enterprise' || n.security === 'other') return WIFI.rowReason[n.security];
  if (n.connected) return WIFI.connected;
  return n.saved ? WIFI.saved : null;
}

/** What a screen reader hears for a row: “Home, secured, strong signal, saved”. */
export function rowLabel(n: WifiNetwork, t: Translate = english): string {
  const WIFI = wifiCopy(t);

  return [
    n.ssid,
    n.security === 'open' ? WIFI.open.toLowerCase() : WIFI.secured.toLowerCase(),
    signalText(n.signal, t).toLowerCase(),
    rowMeta(n, t),
  ]
    .filter(Boolean)
    .join(', ');
}

/** A typed network name's problem, or null (1–32 bytes, printable). */
export function nameProblem(
  name: string,
  valid: (s: string) => boolean,
  t: Translate = english,
): string | null {
  const WIFI = wifiCopy(t);

  if (name.trim() === '') return WIFI.problems.name;
  return valid(name) ? null : WIFI.problems.nameLong;
}

const failurelineCopy = localized(
  (t): Record<NetworkChangeFailure, (ssid: string) => string> => ({
    wrong_password: () => t('wifi.failure.wrong_password'),
    not_found: (ssid) => t('wifi.failure.not_found', { ssid }),
    no_address: (ssid) => t('wifi.failure.no_address', { ssid }),
    no_internet: () => t('wifi.failure.no_internet'),
    failed: () => t('wifi.failure.failed'),
  }),
);

export function failureText(f: NetworkChangeFailure, ssid: string, t: Translate = english): string {
  const failureLine = failurelineCopy(t);

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
export function changeView(c: NetworkChange, t: Translate = english): ChangeView {
  const WIFI = wifiCopy(t);

  const { ssid } = c;
  const prev = c.previous ?? null;
  const why = c.failure ? failureText(c.failure, ssid, t) : null;
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
        return v(t('wifiCopy.joining', { ssid }), prev ? WIFI.guard : null, 'mut', true);
      case 'confirming':
        return v(t('wifiCopy.joined', { ssid }), t('wifiCopy.checkingThatWhombatReachesThe'), 'mut', true);
      case 'committed':
        return v(t('wifiCopy.joined', { ssid }), null, 'ok');
      case 'reverting':
        return v(
          prev ? t('wifiCopy.goingBackTo', { prev }) : t('wifiCopy.leaving', { ssid }),
          why ?? failureText('no_internet', ssid, t),
          'warn',
          true,
        );
      case 'reverted': {
        const back = prev ? t('wifiCopy.wentBackTo', { prev }) : t('wifiCopy.leftItAgain');
        return v(
          t('wifiCopy.couldntSwitchTo', { ssid }),
          c.failure === 'no_address'
            ? t('wifiCopy.didntGiveWhombatAnAddress', { ssid, back })
            : t('wifiCopy.joinedButWhombatCouldntReach', { ssid, back }),
          'warn',
        );
      }
      default:
        return v(t('wifiCopy.couldntJoin', { ssid }), why ?? failureText('failed', ssid, t), 'bad');
    }
  }
  switch (c.phase) {
    case 'applying':
      return v(t('wifiCopy.forgetting', { ssid }), null, 'mut', true);
    case 'confirming':
      return v(t('wifiCopy.forgot', { ssid }), t('wifiCopy.checkingThatWhombatStillReaches'), 'mut', true);
    case 'committed':
      return v(t('wifiCopy.forgot', { ssid }), null, 'ok');
    case 'reverting':
      return v(
        t('wifiCopy.joiningAgain', { ssid }),
        t('wifiCopy.whombatCouldntReachTheInternet'),
        'warn',
        true,
      );
    case 'reverted':
      return v(
        t('wifiCopy.kept', { ssid }),
        t('wifiCopy.whombatCouldntReachTheInternetAlt', { ssid }),
        'warn',
      );
    default:
      return v(t('wifiCopy.couldntForget', { ssid }), why ?? failureText('failed', ssid, t), 'bad');
  }
}

/** A refusal of a join or a forget (`{"message": code}`), in words. */
export function refusalText(code: string | null, t: Translate = english): string {
  const WIFI = wifiCopy(t);

  return (code && WIFI.errors[code]) || WIFI.failed;
}
