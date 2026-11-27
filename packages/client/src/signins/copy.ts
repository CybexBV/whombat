/**
 * Words of setting up the AI (SUB-01…SUB-11; not in the mocks): choosing Claude Code and ChatGPT, installing Claude Code
 * (ChatGPT needs nothing installed, chatgpt-no-client.md AP-5610), and signing in with the person's own subscription or
 * API key (one sign-in per provider, Whombat one-person.md OP-09). Shared by the web (onboarding's “Set up your AI”, Settings → AI, an
 * agent's RUNS ON) and the phone (the state and a link to the web, SUB-11). Curly quotes and the middle dot as in the
 * mocks. The UI may say a client “runs Claude Code”; product and feature names stay Whombat's own (SUB-06).
 */
import { LIVE_PROVIDERS, type LiveProvider, PROVIDER_LABELS } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { SETTINGS_AREA_WORDS } from '../i18n/messages/chatWork/settings';

/**
 * People's name for each provider in AI setup: Claude Code, the client Whombat installs, and ChatGPT, which people sign
 * in to and which needs nothing installed — the contracts' `PROVIDER_LABELS` (2.1, CT-1450; AP-5611, AP-5622). Where
 * the app shows any provider (Runs on, the provider rows) it reads `PROVIDER_LABELS` itself, and a provider's state
 * `providerStateLabel` with the provider (ChatGPT's “Ready” without the runner's version, CT-1451).
 */
export const CLIENT_NAMES: Readonly<Record<LiveProvider, string>> = PROVIDER_LABELS;

const words = (locale?: string | null) => clientTree(locale, SETTINGS_AREA_WORDS).signin;

/** “Claude Code or ChatGPT” (every provider people sign in to), in a locale (English when none). */
export function anyProvider(locale?: string | null): string {
  const or = words(locale).or;
  return LIVE_PROVIDERS.map((p) => CLIENT_NAMES[p]).reduce((first, second) =>
    interpolate(or, { first, second }),
  );
}

export const ANY_PROVIDER = anyProvider();

/** Every word of AI setup and sign-in, in a locale (English when none). */
export function signinText(locale?: string | null) {
  const w = words(locale);
  return {
    /** The one line on whose account the agent works on. */
    model: w.model,
    clientBlurb: { ...w.clientBlurb } as Record<LiveProvider, string>,
    choose: (name: string) => interpolate(w.choose, { name }),

    // The client itself. Clients update themselves: there is no update button.
    notInstalled: w.notInstalled,
    installing: (progress: number | null) =>
      progress == null ? w.installingNow : interpolate(w.installing, { progress }),
    installed: (version: string) => interpolate(w.installed, { version }),
    updating: (version: string) => interpolate(w.updating, { version }),
    fromHost: (version: string) => interpolate(w.fromHost, { version }),
    installFailed: w.installFailed,
    install: w.install,
    retryInstall: w.retryInstall,
    remove: w.remove,
    removeConfirm: (name: string) => interpolate(w.removeConfirm, { name }),
    latest: (version: string) => interpolate(w.latest, { version }),
    noLatest: w.noLatest,
    autoUpdates: w.autoUpdates,

    // Signing in.
    signedIn: { ...w.signedIn } as Record<string, string>,
    signedInOther: w.signedInOther,
    notSignedIn: w.notSignedIn,
    subscription: w.subscription,
    ownKey: w.ownKey,
    signOut: w.signOut,
    signingOut: w.signingOut,
    modeUnavailable: w.modeUnavailable,
    needsInstall: (name: string) => interpolate(w.needsInstall, { name }),

    // Claude's guided sign-in: steps in front of Claude Code's own console.
    console: {
      ...w.console,
      /** Typed into the terminal itself: Claude Code hides the code (no echo), so say that something arrived. */
      entered: (n: number) => interpolate(w.console.entered, { n }),
    },

    // ChatGPT's device code: OpenAI's own sign-in.
    device: {
      ...w.device,
      open: (host: string) => interpolate(w.device.open, { host }),
      expiresIn: (left: string) => interpolate(w.device.expiresIn, { left }),
    },

    // Keys.
    key: { ...w.key },

    failed: w.failed,
    loadFailed: w.loadFailed,
    retry: w.retry,

    // Onboarding's “YOUR AGENT USES” (one agent).
    picker: {
      label: w.picker.label,
      none: interpolate(w.picker.none, { providers: anyProvider(locale) }),
      ready: (name: string) => interpolate(w.picker.ready, { name }),
    },

    // Settings → AI.
    tab: w.tab,
    signIns: w.signIns,
    signInsHelp: w.signInsHelp,
    clients: w.clients,
    clientsNotHere: w.clientsNotHere,

    // The phone: state only, and a way to the web.
    onWeb: w.onWeb,
    onWebNote: w.onWebNote,
  };
}

export const SIGNIN_TEXT = signinText();

/** Sign-in states as people read them (`ProviderSignInState`), in a locale (English when none). */
export function signinStates(locale?: string | null): Record<string, string> {
  return { ...words(locale).states };
}

export const SIGNIN_STATES: Record<string, string> = signinStates();

/** Turn refusals about the sign-in and the person's words for them, in a locale. `signIn`: signing in fixes it. */
export function refusalText(
  locale?: string | null,
): Record<string, { text: (provider: string) => string; signIn: boolean }> {
  const r = words(locale).refusal;
  const say = (line: string) => (provider: string) => interpolate(line, { provider });
  return {
    'provider.requester_not_signed_in': { text: say(r.requesterNotSignedIn), signIn: true },
    'provider.no_requester': { text: say(r.noRequester), signIn: true },
    'provider.not_signed_in': { text: say(r.notSignedIn), signIn: true },
    'client.not_installed': { text: say(r.notInstalled), signIn: false },
  };
}

export const REFUSAL_TEXT = refusalText();

/** What the agent runs on, in the person's words (RUNS ON): their own sign-in, in a locale (English when none). */
export function sourceText(locale?: string | null) {
  const w = words(locale).source;
  return {
    title: (provider: string) => interpolate(w.title, { provider }),
    note: w.note,
    meSignedOut: (provider: string) => interpolate(w.meSignedOut, { provider }),
    signIn: w.signIn,
  };
}

export const SOURCE_TEXT = sourceText();

/** `m:ss` until `expiresAt` (0:00 once past). */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
