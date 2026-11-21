/**
 * Connect {Name} on the phone (phone-connect.md PC-01, PC-03, PC-05, PC-10, PC-11; AP-2903…): what the screen shows for
 * an entry and the Whombat's answers — whether you can connect it here (turned off, the app not set up), the steps and
 * their titles, the buttons a refusal brings, the button's words, where a sign-in elsewhere
 * happens. The rules and words are the web's (`@whombat/client/connections`); this keeps only what the phone adds: its
 * screen title, the paste button (the clipboard and a file, where the web has a box to drop on) and the browser where
 * the web has a tab. Pure: `ConnectScreen` renders it and the tests read it.
 */
import {
  addressReasonOf,
  addressReasonText,
  CONNECT_FORM_TEXT,
  CONNECTION_CONNECT_ERROR_TEXT,
  type ConnectionWords,
  type ConnectProblem,
  connectButtonText,
  identifies,
  NEXTCLOUD_WAIT_TEXT,
  type NextcloudPollStep,
  nextcloudEnds,
  nextcloudPollStep,
  probedSignIn,
  SERVICE_LOGIN_WAIT_TEXT,
  SETUP_STEP_TITLES,
  type SetupStep,
  type SignInChoice,
  serviceLoginCode,
  serviceLoginEnds,
  serviceLoginPollStep,
  setupSteps,
  switchText,
} from '@whombat/client/connections';
import { type CatalogEntry, type CatalogEntryStatus, catalogEntry } from '@whombat/core';
import type {
  ConnectionConnectError,
  IdentifyConnectionResponse,
  PollNextcloudLoginResponse,
  ProbeConnectionResponse,
  StartNextcloudLoginResponse,
  StartServiceLoginResponse,
} from '@whombat/core/contracts';

/** The phone's own words around the web's form. */
export const CONNECT_SCREEN_TEXT = {
  /** The screen's title (PC-03). */
  title: (name: string) => `Connect ${name}`,
  documentation: 'Documentation',
  /** The guided token's link (the web's). */
  open: (name: string) => `Open ${name}`,
  /** The paste button: the clipboard, read when pressed (the web's paste box, without the drop). */
  paste: (name: string) => `Paste what ${name} shows`,
  /** An address the phone doesn't know as a connectable entry (an older phone, a mistyped link). */
  unknown: 'Whombat can’t connect that here.',
  loading: 'Loading',
  /** A self-hosted Whombat signs in elsewhere on its web page (PC-05): the browser opens there. */
  onTheWeb: 'This sign-in finishes in your browser, on your Whombat’s page.',
  /** The demo world can't sign in anywhere. */
  demo: 'The demo can’t sign in to a service.',
} as const;

/** Why this entry can't be connected here, in the web's words; null when it can (ConnectPage's gates). */
export function connectGate(input: {
  entry: CatalogEntry;
  status: CatalogEntryStatus | undefined;
  /** False where the app doesn't offer Whombat Link (the iPhone): the secure-address line names Tailscale only. */
  offerLink?: boolean;
}): string | null {
  const { entry, status } = input;
  if (status?.available === false && status.reason === 'off')
    return `${entry.name} is turned off on this Whombat.`;
  // A link to a tracker nothing here can read: Add a connection doesn't offer it either.
  if (status?.available === false && status.reason === 'no_driver')
    return `${entry.name} can’t be connected on this Whombat yet.`;
  const address = addressReasonOf(status);
  if (address) return addressReasonText(address, { offerLink: input.offerLink });
  if (appMissing(entry, status)) return `Set up the ${entry.name} app above first, then connect.`;
  return null;
}

/** An `app_oauth` entry whose app nobody set up yet (Dropbox, CX-14). */
export function appMissing(entry: CatalogEntry, status: CatalogEntryStatus | undefined): boolean {
  return (
    entry.signIn.some((m) => m.kind === 'app_oauth') &&
    status?.available === false &&
    status.reason === 'app_not_configured'
  );
}

/** One step's header: its number and title (“What may Neo do?” in the assistant's words). */
export interface StepHeader {
  step: SetupStep;
  number: number;
  title: string;
  /** Where is it? is done once what answers is the entry. */
  done: boolean;
}

/**
 * The steps that show (CS-50): Where is it? alone until the address is identified (`revealed`), then What may agents
 * do? and How should Whombat sign in?. A runtime without `connections.sign_in_once` has no steps: the form is one part.
 */
export function stepHeaders(
  entry: CatalogEntry,
  options: {
    steps: boolean;
    revealed: boolean;
    words: Pick<ConnectionWords, 'mayDoQuestion'>;
    identified: Pick<IdentifyConnectionResponse, 'reachable' | 'catalogId'> | null;
  },
): StepHeader[] {
  if (!options.steps) return [];
  const all = setupSteps(entry);
  const open = options.revealed ? all : all.filter((s) => s === 'where');
  return open.map((step, i) => ({
    step,
    number: i + 1,
    title: step === 'access' ? options.words.mayDoQuestion : SETUP_STEP_TITLES[step],
    done:
      step === 'where' &&
      !!options.identified?.reachable &&
      options.identified.catalogId === entry.id &&
      identifies(entry),
  }));
}

/** The main button: Continue until the address is identified, then the sign-in's own words (the web's). */
export function submitLabel(entry: CatalogEntry, choice: SignInChoice, revealed: boolean): string {
  return revealed ? connectButtonText(entry, choice) : CONNECT_FORM_TEXT.continue;
}

/** A button a refusal brings (CX-41, CT-313, CS-09): what it does and its words. */
export type FixButton =
  | { kind: 'network'; label: string }
  | { kind: 'fingerprint'; label: string }
  | { kind: 'switch'; label: string; index: number };

/**
 * The buttons beside a refusal's sentence, in the web's order. No switch to the sign-in that was just tried (`current`):
 * a password Whombat signs in with for a session is a token sign-in already (AP-3805).
 */
export function fixButtons(
  entry: CatalogEntry,
  problem: ConnectProblem,
  choices: readonly SignInChoice[],
  current = -1,
): FixButton[] {
  const out: FixButton[] = [];
  if (problem.network) out.push({ kind: 'network', label: CONNECT_FORM_TEXT.addNetwork });
  if (problem.certificate && entry.fields.some((f) => f.id === 'fingerprint'))
    out.push({ kind: 'fingerprint', label: CONNECT_FORM_TEXT.useFingerprint });
  if (problem.switchTo) {
    const index = choices.findIndex((c) => c.kind === problem.switchTo);
    if (index >= 0 && index !== current)
      out.push({ kind: 'switch', label: switchText(problem.switchTo, entry), index });
  }
  return out;
}

/**
 * The challenge the next code answers after a refusal (SG-06, SG-07; AP-3955), as the web keeps it (AP-3909): the one the
 * service asked with, or the new one a refused code came with; any refusal without one keeps what the form holds, so a
 * network blip doesn't send UniFi's code without its challenge (that would email a new one).
 */
export function keptChallenge(
  problem: Pick<ConnectProblem, 'challenge'>,
  current: string | null,
): string | null {
  return problem.challenge ?? current;
}

/** Whether a refusal opens More options by itself: a problem with the name or the fingerprint is in there. */
export function opensMore(fields: Readonly<Record<string, string>>): boolean {
  return !!(fields.label || fields.fingerprint);
}

/** The sign-in a Custom MCP server's probe picks (CX-61): its index among the choices, or null to keep the current one. */
export function probedChoice(
  choices: readonly SignInChoice[],
  probed: ProbeConnectionResponse,
): number | null {
  const want = probedSignIn(probed);
  if (!want) return null;
  const next = choices.findIndex((c) => c.kind === want);
  return next >= 0 ? next : null;
}

/** Where a sign-in elsewhere happens on this phone (PC-05). */
export type ElsewhereWay =
  /** A managed Whombat: started over the session, the provider's page in the browser, back through `/connect/`. */
  | 'session'
  /** A self-hosted Whombat: its web page in the browser, where the sign-in starts and comes back. */
  | 'web'
  /** The demo world: nowhere. */
  | 'none';

export function elsewhereWay(managed: boolean, webUrl: string | null): ElsewhereWay {
  if (managed) return 'session';
  return webUrl ? 'web' : 'none';
}

/**
 * Whether a sign-in leaves the form for the service: OAuth (the provider's page), Nextcloud's login and the service's
 * own sign-in page (Plex's, SG-01).
 */
export function signsInElsewhere(choice: Pick<SignInChoice, 'kind'>): boolean {
  return (
    choice.kind === 'ha_oauth' ||
    choice.kind === 'mcp_oauth' ||
    choice.kind === 'app_oauth' ||
    choice.kind === 'nextcloud_login' ||
    choice.kind === 'service_login'
  );
}

/**
 * Whether the phone signs in elsewhere itself, waiting on this screen while the browser is open: Nextcloud's login and
 * the service's own page (SG-01; AP-3950) start with a call that works on a managed and a self-hosted Whombat alike.
 * The other sign-ins elsewhere go by the session's OAuth or the Whombat's web page (PC-05).
 */
export function waitsHere(choice: Pick<SignInChoice, 'kind'>): boolean {
  return choice.kind === 'nextcloud_login' || choice.kind === 'service_login';
}

/** A sign-in elsewhere this screen waits for (CX-11; SG-01): Nextcloud's login, or the service's own page (Plex's). */
export type PendingLogin =
  | { kind: 'nextcloud'; flow: StartNextcloudLoginResponse }
  | { kind: 'service'; flow: StartServiceLoginResponse; name: string };

/**
 * What the wait says (the web's words with the phone's browser): its title, its line, the buttons, a code to type, and
 * why it ended without a connection.
 */
export interface WaitWords {
  title: string;
  line: string;
  open: string;
  cancel: string;
  /** A device-code service's code (`userCode`, CT-738): shown large with Copy; null for Plex and Nextcloud. */
  code: { text: string; value: string } | null;
  /** Past the flow's deadline. */
  tooLong: string;
  /** A poll that failed without the Whombat's words. */
  failed: string;
}

export function waitWords(login: PendingLogin): WaitWords {
  if (login.kind === 'nextcloud')
    return {
      title: NEXTCLOUD_WAIT_TEXT.title,
      line: NEXTCLOUD_WAIT_TEXT.phone,
      open: NEXTCLOUD_WAIT_TEXT.open,
      cancel: NEXTCLOUD_WAIT_TEXT.cancel,
      code: null,
      tooLong: NEXTCLOUD_WAIT_TEXT.tooLong,
      failed: NEXTCLOUD_WAIT_TEXT.failed,
    };
  const value = serviceLoginCode(login.flow);
  return {
    title: SERVICE_LOGIN_WAIT_TEXT.title(login.name),
    line: SERVICE_LOGIN_WAIT_TEXT.phone,
    open: SERVICE_LOGIN_WAIT_TEXT.open(login.name),
    cancel: SERVICE_LOGIN_WAIT_TEXT.cancel,
    code: value ? { text: SERVICE_LOGIN_WAIT_TEXT.userCode(login.name), value } : null,
    tooLong: SERVICE_LOGIN_WAIT_TEXT.tooLong,
    failed: SERVICE_LOGIN_WAIT_TEXT.failed(login.name),
  };
}

/** When the wait gives up: the flow's own expiry, at most 10 minutes from now. */
export function waitEnds(login: PendingLogin, now: number): number {
  return login.kind === 'nextcloud' ? nextcloudEnds(login.flow, now) : serviceLoginEnds(login.flow, now);
}

/** What a poll's answer means for the wait: connected, failed (with why, in the service's name) or ask again. */
export function waitStep(login: PendingLogin, r: PollNextcloudLoginResponse): NextcloudPollStep {
  return login.kind === 'nextcloud' ? nextcloudPollStep(r) : serviceLoginPollStep(r, login.name);
}

/**
 * Whether the browser opens by itself once a wait starts (AP-3953): not in the demo world (no Whombat, so `way` is
 * `none`), whose sign-in page has no service behind it; the wait's button still opens it.
 */
export function opensItself(way: ElsewhereWay): boolean {
  return way !== 'none';
}

/** What a sign-in elsewhere's `connect_error=` means on the entry's form (the web's ConnectPage words); null for none. */
export function catalogConnectErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  return CONNECTION_CONNECT_ERROR_TEXT[code as ConnectionConnectError] ?? 'That didn’t connect. Try again.';
}

/** What the screens under Connect {Name} and an account's screen are called, for “‹ …” (AP-1711's rule). */
const SCREEN_WORDS: Record<string, string> = {
  AddConnection: 'Add a connection',
  Connections: 'Connections',
};

/**
 * The “‹ …” label when a link opened the screen without one: where Back goes — a tab by its name, Add a connection,
 * Connections, another entry's Connect {Name}, an account's screen by its name, a connection's page or any screen with
 * a `title` — and Back only when that isn't known.
 */
export function underLabel(
  under: { name: string; params?: unknown; state?: unknown } | undefined,
  tabWords: Readonly<Record<string, string>>,
): string {
  if (!under) return 'Back';
  if (under.name === 'Tabs') {
    const tabs = under.state as { index?: number; routes?: { name: string }[] } | undefined;
    const tab =
      tabs?.routes?.[tabs.index ?? 0]?.name ?? (under.params as { screen?: string } | undefined)?.screen;
    return (tab && tabWords[tab]) || 'Back';
  }
  const named = SCREEN_WORDS[under.name];
  if (named) return named;
  const params = under.params as { title?: unknown; catalogId?: unknown; page?: unknown } | undefined;
  if (under.name === 'Connect' && typeof params?.catalogId === 'string') {
    const entry = catalogEntry(params.catalogId);
    if (entry) return CONNECT_SCREEN_TEXT.title(entry.name);
  }
  if (under.name === 'ConnectAccount' && typeof params?.page === 'string') {
    const entry = catalogEntry(params.page);
    if (entry) return entry.name;
  }
  const title = params?.title;
  return typeof title === 'string' && title ? title : 'Back';
}
