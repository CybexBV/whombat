/**
 * A person's own GitHub sign-in on a managed Whombat (Whombat essentials item 6; contracts CT-181): the same `signins.*`
 * calls as Claude Code and ChatGPT, provider `github`, either GitHub's device code (`device`) or a pasted token (`token`).
 * A managed box has no shell, so this replaces “run gh auth login on the host”; a self-hosted Whombat keeps its host's
 * gh. Shared by the web (Settings → Connections → GitHub, Settings → AI) and the phone (the state and “Sign in on the
 * web”).
 */
import type { ProviderSignIn } from '@whombat/core/domain';
import type { SignInsList } from './model';

/** The two ways to sign in to GitHub (the runtime's `AUTH_MODES.github`). */
export const GITHUB_DEVICE_MODE = 'device';
export const GITHUB_TOKEN_MODE = 'token';

/** Hosts (and their subdomains) GitHub's device page may be on. */
export const GITHUB_SIGNIN_DOMAINS: readonly string[] = ['github.com'];

/** `raw` when it is an `https:` link on github.com (or a subdomain), else null: only such a page gets a button. */
export function githubSignInUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname;
  return GITHUB_SIGNIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ? url.href : null;
}

/** The person's own GitHub sign-in: a ready one first. */
export function githubSignInOf(list: SignInsList | undefined): ProviderSignIn | null {
  const mine = (list?.signIns ?? []).filter((s) => s.provider === 'github');
  return mine.find((s) => s.state === 'ready') ?? mine[0] ?? null;
}

/** Whether the runtime lets this account start a GitHub sign-in of `authMode` (absent from the list: yes). */
export function githubModeAvailable(list: SignInsList | undefined, authMode: string): boolean {
  const m = list?.modes.find((x) => x.provider === 'github' && x.authMode === authMode);
  return m ? m.available : true;
}

export const GITHUB_SIGNIN_TEXT = {
  name: 'GitHub',
  /** The row's state. */
  signedInAs: (login: string) => `Signed in as @${login}`,
  signedIn: 'Signed in',
  notSignedIn: 'Not signed in',
  signIn: 'Sign in to GitHub',
  useToken: 'Use a token instead',
  signOut: 'Sign out',
  /** Settings → AI: what the sign-in is for. */
  help: 'Connect GitHub with your own GitHub account. Your assistant then works on the repos you switch on.',

  // Settings → Connections → GitHub on a managed Whombat.
  dev: {
    notConnected: 'Not connected',
    signInFirst:
      'Sign in to GitHub with your own account, then connect it for this Whombat. Everything on GitHub happens as that account.',
    readyToConnect: (login: string | null) =>
      login
        ? `You’re signed in to GitHub as @${login}. Connect it to bring in repos; everything on GitHub happens as @${login}.`
        : 'You’re signed in to GitHub. Connect it to bring in repos; everything on GitHub happens as your account.',
  },

  // GitHub's device code, in the guided steps of the other sign-ins (AP-62).
  device: {
    label: 'GitHub sign-in',
    open: (host: string) => `Open ${host}`,
    openHint: 'Opens in a new tab. Sign in to GitHub there.',
    elsewhere: 'Or on any computer or phone:',
    enter: 'Enter this code',
    copy: 'Copy code',
    copied: 'Code copied.',
    expiresIn: (left: string) => `Expires in ${left}`,
    hint: 'GitHub then asks you to authorize the GitHub CLI for your account. Approve it for the organizations whose repos your agent works on.',
    expired: 'The code expired. Get a new one to start again.',
    newCode: 'Get a new code',
    waiting: 'Waiting for you to finish signing in…',
    completed: 'Signed in',
    cancel: 'Cancel',
    close: 'Close',
    trust: 'This is GitHub’s own sign-in: Whombat shows you its code and never sees your password.',
  },

  // A token instead.
  token: {
    label: 'GitHub token',
    hint: 'A personal access token of your GitHub account with the repo and workflow scopes. It’s kept on this Whombat and never shown again.',
    save: 'Save token',
    cancel: 'Cancel',
    saved: 'Signed in to GitHub with your token.',
  },
} as const;
