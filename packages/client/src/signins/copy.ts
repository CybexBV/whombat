/**
 * Words of setting up the AI (SUB-01…SUB-11; not in the mocks): choosing Claude Code and ChatGPT, installing Claude Code
 * (ChatGPT needs nothing installed, chatgpt-no-client.md AP-5610), and signing in with the person's own subscription or
 * API key (one sign-in per provider, Whombat one-person.md OP-09). Shared by the web (onboarding's “Set up your AI”, Settings → AI, an
 * agent's RUNS ON) and the phone (the state and a link to the web, SUB-11). Curly quotes and the middle dot as in the
 * mocks. The UI may say a client “runs Claude Code”; product and feature names stay Whombat's own (SUB-06).
 */
import { LIVE_PROVIDERS, type LiveProvider, PROVIDER_LABELS } from '@whombat/core/domain';

/**
 * People's name for each provider in AI setup: Claude Code, the client Whombat installs, and ChatGPT, which people sign
 * in to and which needs nothing installed — the contracts' `PROVIDER_LABELS` (2.1, CT-1450; AP-5611, AP-5622). Where
 * the app shows any provider (Runs on, the provider rows) it reads `PROVIDER_LABELS` itself, and a provider's state
 * `providerStateLabel` with the provider (ChatGPT's “Ready” without the runner's version, CT-1451).
 */
export const CLIENT_NAMES: Readonly<Record<LiveProvider, string>> = PROVIDER_LABELS;

/** “Claude Code or ChatGPT” (every provider people sign in to, AP-5611). */
export const ANY_PROVIDER = LIVE_PROVIDERS.map((p) => CLIENT_NAMES[p]).join(' or ');

export const SIGNIN_TEXT = {
  /** The one line on whose account the agent works on (SUB-04; one-person.md OP-09). */
  model: 'Your agent works on your own sign-in.',
  clientBlurb: {
    claude: 'By Anthropic · a Claude Pro, Max, Team or Enterprise plan, or an API key',
    codex: 'By OpenAI · a ChatGPT plan, or an API key',
  } as Record<LiveProvider, string>,
  choose: (name: string) => `Use ${name}`,

  // The client itself (CT-72). Clients update themselves: there is no update button.
  notInstalled: 'Not installed',
  installing: (progress: number | null) => (progress == null ? 'Installing…' : `Installing · ${progress}%`),
  installed: (version: string) => `Installed · ${version}`,
  updating: (version: string) => `Installed · ${version} · updating`,
  fromHost: (version: string) => `${version} · found on this machine`,
  installFailed: 'Install failed',
  install: 'Install',
  retryInstall: 'Try again',
  remove: 'Remove',
  removeConfirm: (name: string) =>
    `Remove ${name}? Your agent stops using it until it’s installed again. Sign-ins stay.`,
  latest: (version: string) => `Latest tested ${version}`,
  noLatest: 'No tested version for this machine yet',
  autoUpdates: 'Updates itself to each version Whombat has tested.',

  // Signing in (SUB-03, SUB-04, SUB-05).
  signedIn: {
    subscription_cli: 'Signed in with your Claude subscription',
    chatgpt: 'Signed in with your ChatGPT plan',
    api_key: 'Signed in with your API key',
    access_token: 'Signed in with an access token',
  } as Record<string, string>,
  signedInOther: 'Signed in',
  notSignedIn: 'Not signed in',
  subscription: 'Sign in with your subscription',
  ownKey: 'Use your own API key',
  signOut: 'Sign out',
  signingOut: 'Signing out…',
  modeUnavailable: 'Not available on this Whombat',
  needsInstall: (name: string) =>
    `Signing in with your subscription runs ${name}: it waits until ${name} is installed.`,

  // Claude's guided sign-in (CT-71, AP-62): steps in front of Claude Code's own console.
  console: {
    label: 'Claude Code sign-in',
    starting: 'Starting Claude Code’s sign-in…',
    open: 'Open claude.ai to sign in',
    openHint: 'Opens in a new tab. Approve there, then copy the code it shows.',
    noLink: 'Open the link in Claude Code’s output below, approve, then copy the code it shows.',
    code: 'Paste the code from claude.ai',
    paste: 'Paste',
    pasteDenied: 'Your browser didn’t let Whombat read the clipboard. Paste with Ctrl+V or ⌘V.',
    signIn: 'Sign in',
    waiting: 'Waiting for the code from claude.ai…',
    checking: 'Checking with Claude…',
    completed: 'Signed in',
    codeFailed: 'That code didn’t work. Codes work once and expire after a few minutes.',
    failed: 'Claude Code’s sign-in didn’t work.',
    expired: 'The sign-in timed out. Links work for a few minutes, so start with a new one.',
    cancelled: 'The sign-in stopped.',
    newLink: 'Get a new link',
    tryAgain: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    output: 'Show Claude Code’s output',
    outputLabel: 'Claude Code’s output',
    trust: 'This is Claude Code’s own sign-in: Whombat passes your code to it and never sees your login.',
    /** Typed into the terminal itself: Claude Code hides the code (no echo), so say that something arrived. */
    entered: (n: number) => `Code entered (${n} characters) · press Enter`,
    loadFailed: 'Couldn’t open Claude Code’s sign-in. Try again.',
  },

  // ChatGPT's device code (SUB-03, AP-62): OpenAI's own sign-in (Whombat hermes-native.md HN-03; AP-5612).
  device: {
    label: 'ChatGPT sign-in',
    open: (host: string) => `Open ${host}`,
    openHint: 'Opens in a new tab. Sign in to ChatGPT there.',
    elsewhere: 'Or on any computer or phone:',
    enter: 'Enter this code',
    copy: 'Copy code',
    copied: 'Code copied.',
    expiresIn: (left: string) => `Expires in ${left}`,
    hint: 'Device code sign-in has to be turned on in ChatGPT’s security settings (or by your workspace admin).',
    expired: 'The code expired. Get a new one to start again.',
    newCode: 'Get a new code',
    waiting: 'Waiting for you to finish signing in…',
    completed: 'Signed in',
    cancel: 'Cancel',
    close: 'Close',
    trust: 'This is OpenAI’s own sign-in: Whombat shows you its code and never sees your login.',
  },

  // Keys.
  key: {
    label: 'API key',
    nameLabel: 'Name',
    namePlaceholder: 'My key',
    save: 'Save key',
    cancel: 'Cancel',
    valid: 'Signed in. The key works.',
    unverified: 'Saved. It’s checked the first time your agent uses it.',
  },

  failed: 'That didn’t work. Try again.',
  loadFailed: 'Couldn’t load this. Try again.',
  retry: 'Retry',

  // Onboarding's “YOUR AGENT USES” (one agent, hermes-engine-app.md AP-5010).
  picker: {
    label: 'YOUR AGENT USES',
    none: `Sign in to ${ANY_PROVIDER} above, then pick one here.`,
    ready: (name: string) => `${name} is ready.`,
  },

  // Settings → AI (was AI accounts; settings-simplify.md SS-01).
  tab: 'AI',
  signIns: 'YOUR AI SIGN-INS',
  signInsHelp: 'What you ask your agent runs on your own sign-in.',
  clients: 'AI CLIENTS',
  clientsNotHere: 'This Whombat runs Claude Code from the machine it’s installed on.',

  // The phone (SUB-11): state only, and a way to the web.
  onWeb: 'Sign in on the web',
  onWebNote: 'You sign in to Claude Code and ChatGPT in Whombat on a computer.',
} as const;

/** Sign-in states as people read them (`ProviderSignInState`). */
export const SIGNIN_STATES: Record<string, string> = {
  ready: 'Ready',
  not_signed_in: 'Not signed in',
  quota_exhausted: 'Out of quota for now',
  auth_expired: 'Sign-in expired',
  auth_revoked: 'Sign-in was revoked',
  outage: 'The provider is down right now',
  version_drift: 'Being updated',
  gated: 'Not available on this Whombat',
};

/** Turn refusals about the sign-in (CT-69) and the person's words for them. `signIn`: signing in fixes it. */
export const REFUSAL_TEXT: Record<string, { text: (provider: string) => string; signIn: boolean }> = {
  'provider.requester_not_signed_in': {
    text: (provider) =>
      `You haven’t signed in to ${provider} yet, so your agent can’t work for you. Sign in with your subscription or an API key.`,
    signIn: true,
  },
  'provider.no_requester': {
    text: (provider) =>
      `This work needs your ${provider} sign-in. Sign in with your subscription or an API key.`,
    signIn: true,
  },
  'provider.not_signed_in': {
    text: (provider) =>
      `You haven’t signed in to ${provider} yet. Sign in with your subscription or an API key.`,
    signIn: true,
  },
  'client.not_installed': {
    text: (provider) => `${provider} isn’t installed on this Whombat. Install it in Settings → AI.`,
    signIn: false,
  },
};

/** What the agent runs on, in the person's words (RUNS ON; one-person.md OP-09): their own sign-in. */
export const SOURCE_TEXT = {
  title: (provider: string) => `Your own ${provider} sign-in`,
  note: 'Your agent works on your subscription or your own API key.',
  meSignedOut: (provider: string) =>
    `You haven’t signed in to ${provider}, so your agent can’t work for you yet.`,
  signIn: 'Sign in',
} as const;

/** `m:ss` until `expiresAt` (0:00 once past). */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
