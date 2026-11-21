/**
 * Per-user GitHub sign-in through the unmodified GitHub CLI (PV-06), with GH_CONFIG_DIR = the person's GitHub
 * credential home and `--insecure-storage` (the token goes to that home's `hosts.yml`, never to an OS keyring the
 * appliance user shares between people). HOME points inside the home too, so nothing gh writes lands elsewhere.
 *
 * - `device`: `gh auth login --web` — GitHub's documented device flow (the “GitHub CLI” OAuth app, scopes `repo`,
 *   `read:org`, `gist`); without a terminal gh prints the code and the address and polls, no localhost callback.
 * - `token`: `gh auth login --with-token` reads a personal access token from stdin; gh checks it against GitHub.
 * - `githubToken` reads it back for the runner's credential route (`gh auth token`).
 */
import { join } from 'node:path';
import { GH_HOME_SUBDIR } from '../credential-home';
import { loginEnv, runCli } from './cli';
import { type DeviceLogin, githubDeviceParser, type LoginOutcome, startDeviceLogin } from './device';

export interface GitHubLoginOptions {
  command: string;
  home: string;
  hostname?: string;
  hostEnv?: NodeJS.ProcessEnv;
}

function env(o: GitHubLoginOptions): Record<string, string> {
  return loginEnv(
    {
      GH_CONFIG_DIR: o.home,
      HOME: join(o.home, GH_HOME_SUBDIR),
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      // Never launch a browser on the appliance (gh doesn't without a terminal; this makes sure).
      GH_BROWSER: 'true',
    },
    o.hostEnv,
  );
}

const host = (o: GitHubLoginOptions) => o.hostname ?? 'github.com';

const LOGIN_ARGS = (o: GitHubLoginOptions) => [
  'auth',
  'login',
  '--hostname',
  host(o),
  '--git-protocol',
  'https',
  '--skip-ssh-key',
  '--insecure-storage',
];

export function githubDeviceLogin(o: GitHubLoginOptions & { now?: () => Date }): DeviceLogin {
  return startDeviceLogin({
    command: o.command,
    args: [...LOGIN_ARGS(o), '--web'],
    env: env(o),
    parser: githubDeviceParser(),
    ...(o.now ? { now: o.now } : {}),
  });
}

export async function githubTokenLogin(o: GitHubLoginOptions, token: string): Promise<LoginOutcome> {
  const result = await runCli({
    command: o.command,
    args: [...LOGIN_ARGS(o), '--with-token'],
    env: env(o),
    stdin: token.trim(),
    timeoutMs: 60_000,
  });
  if (result.spawnError)
    return { ok: false, reason: 'missing', message: 'The GitHub CLI isn’t installed on the appliance.' };
  if (result.code !== 0)
    return {
      ok: false,
      reason: 'failed',
      message:
        result.lines.find((l) => /error|invalid|bad credentials|missing required scope/i.test(l)) ??
        'GitHub didn’t accept the token.',
    };
  return { ok: true };
}

/** Signed in, and as whom (`gh auth status`). */
export async function githubStatus(
  o: GitHubLoginOptions,
): Promise<{ signedIn: boolean; login: string | null }> {
  const result = await runCli({
    command: o.command,
    args: ['auth', 'status', '--hostname', host(o)],
    env: env(o),
    timeoutMs: 20_000,
  });
  const text = result.lines.join('\n');
  const login = /Logged in to \S+ (?:account|as) (\S+)/.exec(text)?.[1] ?? null;
  return { signedIn: result.code === 0, login };
}

/** The stored token (for one fetch or push through the runner's credential route), or null. */
export async function githubToken(o: GitHubLoginOptions): Promise<string | null> {
  let token = '';
  const result = await runCli({
    command: o.command,
    args: ['auth', 'token', '--hostname', host(o)],
    env: env(o),
    timeoutMs: 20_000,
    onLine: (line, stream) => {
      if (stream === 'stdout' && !token) token = line.trim();
    },
  });
  return result.code === 0 && token ? token : null;
}

export async function githubLogout(o: GitHubLoginOptions): Promise<void> {
  await runCli({
    command: o.command,
    args: ['auth', 'logout', '--hostname', host(o)],
    env: env(o),
    timeoutMs: 20_000,
  });
}
