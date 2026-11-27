/**
 * The phone's NETWORK and HARDWARE cards, their pure part (hardware-support-android.md AP-3250…AP-3261): which card
 * NETWORK is while `host.network` answers, the Wi-Fi sheet's three steps — the list, a network's form, following the
 * change — with what each says and checks, where a refused network goes back to, and the hardware report's header for
 * this phone. The rows and every word are the shared model's (`@whombat/client` `host/`: `networkSectionView`,
 * `wifiRows`, `NETWORK_TEXT`, `hardwareSectionView`, `hardwareReportText`); this decides only what the phone shows when.
 */
import {
  type CableUse,
  type HostNetwork,
  type NetworkChange,
  type NetworkChangeView,
  type NetworkPollState,
  networkChangeRunning,
  networkChangeView,
  networkText,
  type WifiJoinInput,
  type WifiRowView,
  wifiJoinInput,
  wifiNameProblem,
  wifiNeedsPassword,
  wifiOnlyDialogView,
  wifiPasswordProblem,
} from '@whombat/client';
import { mobileTranslator } from '../i18n/translate';

/**
 * The phone's two words beyond the shared ones (AP-3261), in their voice: the alert's title when a forget is refused
 * (the change line's own words for a forget that failed) and the share sheet that didn't open.
 */
export function machineText(locale?: string | null) {
  const { t } = mobileTranslator(locale);
  return {
    forgetFailed: (ssid: string) => t('managed2.machine.forgetFailed', { ssid }),
    /** The alert's title when Use Wi-Fi only or Use the cable again is refused (network-move-app.md). */
    switchFailed: (use: CableUse) =>
      use === 'wifi' ? t('managed2.machine.wifiOnlyFailed') : t('managed2.machine.cableFailed'),
    shareFailed: t('managed2.machine.shareFailed'),
    /** The title of the screen About's HARDWARE row opens: the machine and every part. */
    hardware: t('managed2.machine.hardware'),
  } as const;
}

export const MACHINE_TEXT = machineText();

/* The card -------------------------------------------------------------------------------------------------------- */

/**
 * Use Wi-Fi only or Use the cable again, asked in the system's alert as Forget is: its title, the message
 * (what happens, the guard, and the other-network note when the Wi-Fi is another network than the cable, one paragraph each) and
 * the button that switches.
 */
export function cableConfirm(
  network: HostNetwork,
  use: CableUse,
  name: string,
  locale?: string | null,
): { title: string; message: string; submit: string } {
  const T = networkText(locale);
  if (use === 'cable')
    return { title: T.cableDialog.title, message: T.cableDialog.lead(name), submit: T.cableDialog.submit };
  const d = wifiOnlyDialogView(network, name, locale);
  return {
    title: d.title,
    message: [d.lead, d.guard, d.otherNetwork].filter(Boolean).join('\n\n'),
    submit: T.wifiOnlyDialog.submit,
  };
}

/**
 * What NETWORK is (AP-3251): nothing where there is no manager, a skeleton while the first answer comes, “The network couldn’t be read right now.” with Try again when it didn't, else the rows.
 */
export function networkCardKind(
  api: unknown,
  state: Pick<NetworkPollState, 'network' | 'reason' | 'loading'>,
): 'none' | 'loading' | 'unavailable' | 'rows' {
  if (!api || state.reason === 'not_managed') return 'none';
  if (state.network) return 'rows';
  return state.reason === 'unavailable' ? 'unavailable' : 'loading';
}

/* The Wi-Fi sheet ------------------------------------------------------------------------------------------------- */

/** The sheet's step: the list, a network's form (`null`: Other network…), or the change it started. */
export type WifiStep =
  | { at: 'list' }
  | { at: 'form'; network: WifiRowView | null }
  | { at: 'following'; id: string; ssid: string; network: WifiRowView | null };

/** What was typed in the form. */
export interface WifiForm {
  ssid: string;
  security: 'psk' | 'open';
  password: string;
}

export const EMPTY_WIFI_FORM: WifiForm = { ssid: '', security: 'psk', password: '' };

/** A problem with one field, shown under it. */
export interface WifiProblem {
  field: 'name' | 'password';
  text: string;
}

/** The form's fields: a name and security for Other network…, a password for a secured network not saved here. */
export function wifiFormFields(
  step: WifiStep,
  form: Pick<WifiForm, 'security'>,
): { name: boolean; password: boolean; savedNote: boolean } {
  if (step.at !== 'form') return { name: false, password: false, savedNote: false };
  if (!step.network) return { name: true, password: form.security === 'psk', savedNote: false };
  const password = wifiNeedsPassword(step.network);
  return { name: false, password, savedNote: !password && step.network.saved };
}

/** The form's first problem (the name, then the password), or null when it can be sent. */
export function wifiFormProblem(step: WifiStep, form: WifiForm, locale?: string | null): WifiProblem | null {
  const fields = wifiFormFields(step, form);
  const name = fields.name ? wifiNameProblem(form.ssid, locale) : null;
  if (name) return { field: 'name', text: name };
  const password = fields.password ? wifiPasswordProblem(form.password, locale) : null;
  return password ? { field: 'password', text: password } : null;
}

/** `host.wifi.join`'s input from the form: the network's name (typed, trimmed, and `hidden`), the password if asked. */
export function wifiFormInput(step: Extract<WifiStep, { at: 'form' }>, form: WifiForm): WifiJoinInput {
  const other = step.network === null;
  const fields = wifiFormFields(step, form);
  return wifiJoinInput({
    ssid: other ? form.ssid.trim() : (step.network?.ssid ?? ''),
    security: other ? form.security : (step.network?.security ?? 'psk'),
    ...(fields.password ? { password: form.password } : {}),
    hidden: other,
  });
}

/**
 * The sheet's title and lead: “Join a Wi-Fi network” and which network to choose; a network's name and the guard's note
 * (“If {name} can’t reach the internet on the new network, it goes back to the one it uses now.”); Other network… and
 * “Type it exactly”; following, the network's name (the one typed, for Other network…) and the guard's note.
 */
export function wifiSheetHead(
  step: WifiStep,
  name: string,
  locale?: string | null,
): { title: string; lead: string } {
  const D = networkText(locale).dialog;
  if (step.at === 'list') return { title: D.title, lead: D.lead(name) };
  if (step.at === 'following') return { title: step.ssid, lead: D.guard(name) };
  if (!step.network) return { title: D.otherTitle, lead: D.otherLead };
  return { title: step.network.ssid, lead: D.guard(name) };
}

/**
 * The line the following step shows (AP-3256): “Joining…” until NETWORK's poller has the change, then the shared
 * `networkChangeView` — “Joining Home…”, “Joined Home” and its check, how it went back — and whether it still runs.
 * The guard's note is the sheet's lead already, so the line leaves it out.
 */
export function wifiFollowLine(
  change: NetworkChange | null,
  name: string,
  locale?: string | null,
): Pick<NetworkChangeView, 'title' | 'meta' | 'dot' | 'running'> {
  const D = networkText(locale).dialog;
  if (!change) return { title: D.joining, meta: null, dot: 'mut', running: true };
  const v = networkChangeView(change, name, locale);
  const meta = v.meta === D.guard(name) ? null : v.meta;
  return { title: v.title, meta, dot: v.dot, running: networkChangeRunning(change) };
}

/**
 * After the change the sheet follows moved (AP-3257): a network that refused (a wrong password, not found, failed) takes
 * the sheet back to its form with why — under the password for a wrong one (the password emptied), else above the
 * buttons — so it can be typed again. Anything else (still running, joined, went back) stays on the line; null.
 */
export function wifiAfterChange(
  step: WifiStep,
  change: NetworkChange | null,
  name: string,
  locale?: string | null,
): { step: Extract<WifiStep, { at: 'form' }>; problem: WifiProblem | null; note: string | null } | null {
  const T = networkText(locale);
  if (step.at !== 'following' || !change || change.id !== step.id || change.phase !== 'failed') return null;
  const back = { at: 'form', network: step.network } as const;
  if (change.failure === 'wrong_password')
    return {
      step: back,
      problem: { field: 'password', text: T.failures.wrong_password(change.ssid, name) },
      note: null,
    };
  return { step: back, problem: null, note: networkChangeView(change, name, locale).meta };
}

/* The hardware report ---------------------------------------------------------------------------------------------- */

/**
 * The report's header for this phone (AP-3260): the Whombat's name, and which Whombat and app made it —
 * “Whombat 0.111.1 · Android app 0.104.0 · build 104000” (the Whombat's version left out while unknown), so support
 * can tell a report shared from the phone from one downloaded on the web.
 */
export function hardwareReportAbout(input: {
  burrow: string;
  app: string | null | undefined;
  build: string | number | null | undefined;
  runtime: string | null | undefined;
  platform: 'android' | 'ios' | string;
}): { burrow: string; version: string } {
  const os = input.platform === 'ios' ? 'iOS' : 'Android';
  const app = [
    `${os} app ${input.app || 'unknown'}`,
    input.build !== null && input.build !== undefined && input.build !== '' ? `build ${input.build}` : null,
  ];
  const parts = [input.runtime ? `Whombat ${input.runtime}` : null, ...app].filter(Boolean);
  return { burrow: input.burrow, version: parts.join(' · ') };
}
