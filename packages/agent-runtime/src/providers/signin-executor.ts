/**
 * The sign-in executor (docs/decisions/managed-providers.md PV-12): the one component that runs the providers' own
 * sign-ins — Claude Code's console, Hermes's ChatGPT steps (hermes-native.md HN-03), gh — and touches credential homes. On a managed appliance it runs in the runner, as the runner's user, so
 * every home belongs to the user whose sandboxed turns use it; the server keeps the sign-in attempts, the policy and
 * the audit and relays each step over the runner protocol (`RunnerSignInBridge`). In development, tests and
 * self-hosted mode the server runs it in-process. Its requests and answers are plain JSON.
 *
 * It never decides who may do what (the server did), never logs a secret, and writes a sign-in only through a
 * private staging directory moved into place when the provider accepted it.
 *
 * One home per provider, the person's (one-person.md OP-09): `<credentials root>/<provider>`.
 *
 * A ChatGPT sign-in (`codex`: `chatgpt`, `access_token`) is Hermes's own login in the person's Hermes profile: staged in
 * `<hermes root>/signin/.staging-*`, moved into the profile by Hermes's step under Hermes's auth-store lock, and only
 * then recorded in the credential home (`whombat-credential.json` alone: no token, no CLI home). Signing out removes both.
 * An OpenAI API key stays a file in the credential home.
 */
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ConsoleSignInEvent } from '@whombat/core/contracts';
import { onPath } from '../access/sandbox';
import type { ProcessSpawner } from '../contract';
import {
  hermesBin,
  hermesInstalls,
  hermesPersonProfile,
  hermesPythonBeside,
  hermesRoot,
  lockHermesProfile,
  prepareHermesProfile,
  realCommand,
} from '../hermes/profile';
import { privateDir } from '../host';
import { apiKeyObservation, isApiKeyMode, runUsageProbe } from '../usage/probe';
import type { UsageObservation, UsageProvider } from '../usage/types';
import {
  type CredentialMeta,
  credentialHomeExists,
  ensureCredentialsRoot,
  homeLinkProblem,
  readCredentialMeta,
  writeCredentialMeta,
} from './credential-home';
import { providerExecutable } from './drift';
import {
  type ChatgptSteps,
  chatgptAccessTokenLogin,
  chatgptDeviceLogin,
  chatgptInstall,
  chatgptLoginFailure,
  chatgptRemove,
  chatgptSteps,
  chatgptUsageProbe,
  openaiApiKeyLogin,
} from './login/chatgpt';
import { claudeApiKeyLogin } from './login/claude';
import { ClaudeConsoleLogin, type ConsoleOutcome, type ConsoleStopReason } from './login/console';
import type { DeviceCode, DeviceLogin, LoginOutcome } from './login/device';
import { githubDeviceLogin, githubLogout, githubStatus, githubToken, githubTokenLogin } from './login/github';
import { type Fetch, verifyAnthropicKey, verifyOpenAIKey } from './login/verify';
import { CREDENTIAL_PROVIDERS, type CredentialProvider } from './types';

/** A sign-in of the person's (contracts 3.0 `SIGNIN_METHODS`: no owner, no label). */
export interface SignInTarget {
  loginId: string;
  provider: CredentialProvider;
  authMode: string;
}

export interface SecretSignIn extends SignInTarget {
  secret: string;
  expiresAt: string | null;
  creatorAttested: boolean;
}

export type SecretResult =
  | { ok: true; verified: 'valid' | 'unverified'; login: string | null }
  | { ok: false; code: string; message: string };

export type DeviceStartResult =
  | { ok: true; device: DeviceCode }
  | { ok: false; code: string; message: string };

/** A device sign-in finished (sent by the executor on its own, after `startDevice`). */
export type DeviceDone =
  | { loginId: string; ok: true; login: string | null }
  | { loginId: string; ok: false; state: 'expired' | 'failed' | 'cancelled'; code: string; message: string };

/** One stored sign-in (no secret). */
export interface SignInRecord {
  provider: CredentialProvider;
  meta: CredentialMeta;
}

/** Start the Claude subscription sign-in console (CT-71, `SIGNIN_METHODS.consoleStart`). */
export interface ConsoleStartJob {
  consoleId: string;
  provider: 'claude';
  authMode: 'subscription_cli';
  cols: number;
  rows: number;
  /** The executor stops the console on its own then (`expired`). */
  expiresAt: string;
}

export type ConsoleResult = { ok: true } | { ok: false; code: string; message: string };

const CONSOLE_NOT_FOUND = {
  ok: false,
  code: 'provider.console_not_found',
  message: 'That sign-in console isn’t running. Start the sign-in again.',
} as const;

const CONSOLE_ENDED = {
  ok: false,
  code: 'provider.console_ended',
  message: 'That sign-in console has ended.',
} as const;

export interface SignInExecutor {
  submitSecret(job: SecretSignIn): Promise<SecretResult>;
  startDevice(job: SignInTarget): Promise<DeviceStartResult>;
  cancel(loginId: string): Promise<void>;
  logout(provider: CredentialProvider): Promise<{ removed: boolean; authMode: string | null }>;
  /** The person's sign-ins, one per provider. */
  list(): Promise<SignInRecord[]>;
  /** The person's GitHub token for one git operation or API call. */
  githubToken(): Promise<string | null>;
  /**
   * Starts `claude auth login --claudeai` in a PTY with a private staging home (CT-71). Output and the exit are
   * reported through `onConsoleEvent`. A running console is cancelled first.
   */
  consoleStart(job: ConsoleStartJob): Promise<ConsoleResult>;
  /** Keystrokes for a running console (never logged). */
  consoleInput(consoleId: string, data: string): Promise<ConsoleResult>;
  consoleResize(consoleId: string, cols: number, rows: number): Promise<ConsoleResult>;
  /** Stops a console; its exit is still reported. Unknown ids are ignored. */
  consoleStop(consoleId: string, reason: ConsoleStopReason): Promise<void>;
  /**
   * Reads the person's subscription usage for one provider through the CLI (`SIGNIN_METHODS.usageProbe`, UI-R05). An
   * API-key sign-in answers without running anything. Optional: test doubles and executors before contracts 0.23.
   */
  usageProbe?(provider: UsageProvider): Promise<UsageProbeResult>;
}

export type UsageProbeResult =
  | { ok: true; usage: UsageObservation }
  | { ok: false; code: string; message: string };

/** Where one usage probe runs (a managed runner: a task sandbox, like a turn's). */
export interface UsageProbeHost {
  /** A private, empty working directory. */
  cwd: string;
  /** Starts the CLI inside the sandbox; absent: a process group on the host. */
  spawn?: ProcessSpawner;
  /** Ends the sandbox and removes what it made. */
  close(): Promise<void>;
}

const PROBE_NOT_SIGNED_IN = {
  ok: false,
  code: 'provider.not_signed_in',
  message: 'There’s no sign-in to read usage from.',
} as const;

export interface LocalSignInExecutorOptions {
  root: string;
  /**
   * Fixed commands (tests); they win over `resolveClient` and Hermes's own: Claude Code, gh, and what runs one of the
   * plugin's ChatGPT steps (`[python, '-m', 'whombat_hermes.codex_auth']`).
   */
  commands?: { claude?: string; gh?: string; chatgpt?: readonly string[] };
  /**
   * Hermes (HN-03): its root, whose profiles get people's ChatGPT logins (default `WHOMBAT_HERMES_ROOT`, `hermesRoot`),
   * and the `hermes` whose Python runs the plugin's steps (default `hermesBin`).
   */
  hermes?: { root?: string; bin?: string };
  /**
   * The installed client's executable (CT-72), asked before the default (`providerExecutable`: `WHOMBAT_CLAUDE_PATH`,
   * else the pinned client installed with Whombat, else the name on PATH). When given, its answer stands: null means not
   * installed. Only Claude Code: ChatGPT runs no client of its own (HN-04).
   */
  resolveClient?: (provider: 'claude') => string | null;
  fetch?: Fetch;
  now?: () => Date;
  /** How long `startDevice` waits for the CLI's code (default 30 s). */
  codeTimeoutMs?: number;
  onDeviceDone: (done: DeviceDone) => void;
  /** Sign-in console output (in order) and exits (one per console, last). */
  onConsoleEvent?: (event: ConsoleSignInEvent) => void;
  /** The host environment the console's CLI takes PATH, locale, CA bundle and proxies from (tests). */
  hostEnv?: NodeJS.ProcessEnv;
  /**
   * Where a usage probe runs (UI-R05): a managed runner opens a task sandbox with the person's home, like a turn's — for
   * ChatGPT their Hermes profile (`home`) and Hermes's own install (`installs`, readable). Absent (tests, the server's
   * own executor): on the host, after `homeLinkProblem` (SUB-41), in a private directory.
   */
  usageHost?: (job: UsageHostJob) => Promise<UsageProbeHost>;
  /** Longest a probe may take (default 45 s). */
  usageTimeoutMs?: number;
}

/** What a usage probe's host is opened for. */
export interface UsageHostJob {
  provider: UsageProvider;
  /** Claude: the credential home; ChatGPT: the person's Hermes profile, where Hermes keeps the login. */
  home: string;
  authMode: string;
  /** Hermes's install, readable in the sandbox (ChatGPT: Hermes reads the usage itself). */
  installs?: readonly string[];
}

/** Where ChatGPT logins are staged under the Hermes root (`<root>/signin/.staging-*`), on the profiles' filesystem. */
export const CHATGPT_STAGING_DIR = 'signin';

/** Codex auth modes that are Hermes's own login in the person's profile (HN-03); `api_key` is a key file. */
const HERMES_LOGIN_MODES: ReadonlySet<string> = new Set(['chatgpt', 'access_token']);

interface ConsoleEntry {
  job: ConsoleStartJob;
  login: ClaudeConsoleLogin;
  /** Settles once the sign-in was kept or dropped, the staging home removed and the exit reported. */
  finished: Promise<void>;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** How a device sign-in that didn't sign in is told (`DeviceDone`). */
function deviceFailed(loginId: string, outcome: Extract<LoginOutcome, { ok: false }>): DeviceDone {
  const state =
    outcome.reason === 'expired' ? 'expired' : outcome.reason === 'cancelled' ? 'cancelled' : 'failed';
  return { loginId, ok: false, state, code: `provider.login_${outcome.reason}`, message: outcome.message };
}

/** A regular file with one name (never a link): what Hermes may open outside a sandbox. */
async function plainFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return Boolean(info?.isFile() && info.nlink === 1);
}

export class LocalSignInExecutor implements SignInExecutor {
  private readonly device = new Map<
    string,
    { handle: DeviceLogin; staging: string; hermesStaging: string | null; target: SignInTarget }
  >();
  /** Ends the waits of sign-outs for a profile to be free (`forgetChatgptWhenFree`). */
  private readonly closing = new AbortController();

  private readonly consoles = new Map<string, ConsoleEntry>();
  private consoleStarts: Promise<unknown> = Promise.resolve();
  /** Recently ended consoles (bounded), so a late request says `console_ended` and a retried start starts nothing. */
  private readonly endedConsoles = new Set<string>();

  /**
   * The start-up sweep of staging homes a crash left behind (SUB-43, review CON-5): a console killed after
   * `claude auth login` wrote its credential but before it was moved into place. New staging waits for it.
   */
  private readonly swept: Promise<void>;

  constructor(private readonly options: LocalSignInExecutorOptions) {
    this.swept = this.sweepStaging().catch(() => {});
  }

  /** Removes every `.staging-*` in the credentials root and every staged ChatGPT login under the Hermes root (`signin/`). */
  private async sweepStaging(): Promise<void> {
    const hermes = this.options.hermes?.root;
    if (hermes && isAbsolute(hermes))
      await rm(join(hermes, CHATGPT_STAGING_DIR), { recursive: true, force: true }).catch(() => {});
    if (isAbsolute(this.options.root)) await this.removeStaging(null);
  }

  /** Removes the root's staging homes (of one provider, or all). */
  private async removeStaging(provider: CredentialProvider | null): Promise<void> {
    const prefix = provider ? `.staging-${provider}-` : '.staging-';
    for (const name of await readdir(this.options.root).catch(() => [] as string[]))
      if (name.startsWith(prefix)) await rm(join(this.options.root, name), { recursive: true, force: true });
  }

  /** The person's home for a provider (`<root>/<provider>`, OP-09). */
  private homeOf(provider: CredentialProvider): string {
    if (!isAbsolute(this.options.root)) throw new Error('WHOMBAT_CREDENTIALS_ROOT must be an absolute path.');
    return join(this.options.root, provider);
  }

  /** Resolves once the start-up sweep is done (tests). */
  ready(): Promise<void> {
    return this.swept;
  }

  private command(_name: 'gh'): string {
    return this.options.commands?.gh ?? (process.env.WHOMBAT_GH_PATH?.trim() || 'gh');
  }

  private hostEnv(): NodeJS.ProcessEnv {
    return this.options.hostEnv ?? process.env;
  }

  /** Hermes's root (`WHOMBAT_HERMES_ROOT`): the person's profile, where their ChatGPT login lives. */
  private hermesRoot(): string {
    return this.options.hermes?.root ?? hermesRoot(this.hostEnv());
  }

  /** The `hermes` whose Python runs the plugin's steps. */
  private hermesBin(): string {
    return this.options.hermes?.bin ?? hermesBin(this.hostEnv());
  }

  /** The plugin's ChatGPT steps: the Python beside `hermes`, or null without a real Hermes. */
  private chatgpt(): ChatgptSteps | null {
    const fixed = this.options.commands?.chatgpt;
    if (fixed) return { command: fixed, ...this.hostEnvOption() };
    return chatgptSteps(hermesPythonBeside(this.hermesBin(), this.hostEnv()), this.hostEnv());
  }

  /** The person's Hermes profile (the root, Hermes's default profile: OP-08), made private if it isn't there yet. */
  private async profile(): Promise<string> {
    const root = this.hermesRoot();
    const profile = hermesPersonProfile(root);
    await prepareHermesProfile(root, profile);
    return profile;
  }

  /** A private staging Hermes home for a ChatGPT login (on the profiles' filesystem, so it is moved, never copied). */
  private async stageChatgpt(): Promise<string> {
    await this.swept;
    const root = this.hermesRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await privateDir(root);
    const dir = await privateDir(join(root, CHATGPT_STAGING_DIR));
    const staging = join(dir, `.staging-${randomBytes(6).toString('hex')}`);
    await mkdir(staging, { mode: 0o700 });
    return staging;
  }

  /** Moves a staged ChatGPT login into the person's profile, through Hermes's step under its auth-store lock. */
  private async keepChatgpt(steps: ChatgptSteps, staging: string): Promise<void> {
    await chatgptInstall(steps, staging, await this.profile());
  }

  /** Whether the person's ChatGPT sign-in is recorded (a sign-out, or a sign-in since). */
  private async chatgptRecorded(): Promise<boolean> {
    const meta = await readCredentialMeta(this.homeOf('codex'));
    return Boolean(meta && HERMES_LOGIN_MODES.has(meta.authMode));
  }

  /**
   * Signs the person out of ChatGPT in Hermes (HN-03): the login in their profile goes now, through Hermes's step under
   * its own lock (or, without a real Hermes, as a file), and again once their Hermes isn't running — a turn that was
   * running keeps the access token it has until it ends, and Hermes could write its own credential state back meanwhile.
   */
  private async forgetChatgpt(): Promise<void> {
    const profile = hermesPersonProfile(this.hermesRoot());
    if (!(await lstat(profile).catch(() => null))?.isDirectory()) return;
    await this.removeChatgptLogin(profile);
    void this.forgetChatgptWhenFree(profile);
  }

  private async removeChatgptLogin(profile: string): Promise<void> {
    const steps = this.chatgpt();
    if (steps) {
      const scratch = await privateDir(join(this.hermesRoot(), CHATGPT_STAGING_DIR)).catch(() => null);
      if (scratch && (await chatgptRemove(steps, profile, scratch).catch(() => null))) return;
    }
    // No Hermes to ask: unlinking never follows a link.
    await unlink(join(profile, 'auth.json')).catch(() => {});
  }

  private async forgetChatgptWhenFree(profile: string): Promise<void> {
    let lock: Awaited<ReturnType<typeof lockHermesProfile>>;
    try {
      lock = await lockHermesProfile(this.hermesRoot(), profile, {
        holder: 'chatgpt-signout',
        waitMs: 9 * 3_600_000,
        signal: this.closing.signal,
      });
    } catch {
      return;
    }
    try {
      if (!(await this.chatgptRecorded())) await this.removeChatgptLogin(profile);
    } finally {
      await lock.release();
    }
  }

  /** Claude Code's executable as configured (not checked). */
  private client(provider: 'claude'): string | null {
    const fixed = this.options.commands?.[provider];
    if (fixed) return fixed;
    if (this.options.resolveClient) return this.options.resolveClient(provider);
    return providerExecutable(provider);
  }

  /** Claude Code's executable when it exists and can run: an absolute path, or the name found on PATH. */
  private installedClient(provider: 'claude'): string | null {
    const command = this.client(provider);
    if (!command) return null;
    if (isAbsolute(command)) return executable(command) ? command : null;
    if (command.includes('/')) return null;
    return onPath(command, this.options.hostEnv ?? process.env);
  }

  private hostEnvOption(): { hostEnv?: NodeJS.ProcessEnv } {
    return this.options.hostEnv ? { hostEnv: this.options.hostEnv } : {};
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** A private staging directory in the credentials root (moved into place on success). */
  private async stage(provider: CredentialProvider): Promise<string> {
    this.homeOf(provider);
    await this.swept;
    const dir = await ensureCredentialsRoot(this.options.root);
    const staging = join(dir, `.staging-${provider}-${randomBytes(6).toString('hex')}`);
    await mkdir(staging, { mode: 0o700 });
    if (provider === 'github') await mkdir(join(staging, 'home'), { mode: 0o700 });
    return staging;
  }

  private async install(
    target: SignInTarget,
    staging: string,
    meta: Pick<CredentialMeta, 'verified' | 'expiresAt' | 'creatorAttested' | 'login'>,
  ): Promise<void> {
    const at = this.now();
    await writeCredentialMeta(staging, {
      v: 1,
      provider: target.provider,
      authMode: target.authMode,
      createdAt: at.toISOString(),
      verifiedAt: meta.verified === 'valid' ? at.toISOString() : null,
      signal: null,
      ...meta,
    });
    const home = this.homeOf(target.provider);
    await rm(home, { recursive: true, force: true });
    await rename(staging, home);
  }

  async submitSecret(job: SecretSignIn): Promise<SecretResult> {
    const staging = await this.stage(job.provider);
    try {
      const outcome = await this.loginWithSecret(job, staging);
      if (!outcome.ok)
        return { ok: false, code: `provider.login_${outcome.reason}`, message: outcome.message };
      let verified: 'valid' | 'unverified' = job.provider === 'github' ? 'valid' : 'unverified';
      if (job.authMode === 'api_key') {
        const check =
          job.provider === 'claude'
            ? await verifyAnthropicKey(job.secret.trim(), this.options.fetch)
            : await verifyOpenAIKey(job.secret.trim(), this.options.fetch);
        if (check.result === 'invalid')
          return { ok: false, code: 'provider.secret_invalid', message: check.message };
        verified = check.result === 'valid' ? 'valid' : 'unverified';
      }
      const login =
        job.provider === 'github'
          ? (await githubStatus({ command: this.command('gh'), home: staging })).login
          : null;
      await this.install(job, staging, {
        verified,
        expiresAt: job.expiresAt,
        creatorAttested: job.creatorAttested,
        login,
      });
      return { ok: true, verified, login };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async loginWithSecret(job: SecretSignIn, home: string): Promise<LoginOutcome> {
    const secret = job.secret.trim();
    if (job.provider === 'claude') return claudeApiKeyLogin(home, secret);
    if (job.provider === 'github') return githubTokenLogin({ command: this.command('gh'), home }, secret);
    if (job.authMode !== 'access_token') return openaiApiKeyLogin(home, secret);
    // A Codex access token is Hermes's own credential in the person's profile (HN-03); the record follows it.
    const steps = this.chatgpt();
    if (!steps) return { ok: false, ...chatgptLoginFailure('missing') };
    const staging = await this.stageChatgpt();
    try {
      const outcome = await chatgptAccessTokenLogin(steps, staging, secret);
      if (outcome.ok) await this.keepChatgpt(steps, staging);
      return outcome;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async startDevice(job: SignInTarget): Promise<DeviceStartResult> {
    let handle: DeviceLogin;
    let hermesStaging: string | null = null;
    if (job.provider === 'github') {
      const staging = await this.stage(job.provider);
      handle = githubDeviceLogin({ command: this.command('gh'), home: staging, now: () => this.now() });
      this.device.set(job.loginId, { handle, staging, hermesStaging, target: job });
    } else {
      // ChatGPT through Hermes's device-code login (HN-03): one person's own, into their profile.
      const steps = this.chatgpt();
      if (!steps) {
        const why = chatgptLoginFailure('missing');
        return { ok: false, code: `provider.login_${why.reason}`, message: why.message };
      }
      const staging = await this.stage(job.provider);
      hermesStaging = await this.stageChatgpt();
      handle = chatgptDeviceLogin({ steps, home: hermesStaging, now: () => this.now() });
      this.device.set(job.loginId, { handle, staging, hermesStaging, target: job });
    }
    void handle.done.then((outcome) => this.deviceDone(job.loginId, outcome));
    try {
      const code = await Promise.race([
        handle.code,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), this.options.codeTimeoutMs ?? 30_000).unref?.(),
        ),
      ]);
      return { ok: true, device: code };
    } catch {
      const outcome = await Promise.race([
        handle.done,
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);
      handle.cancel();
      return {
        ok: false,
        code: `provider.login_${outcome && !outcome.ok ? outcome.reason : 'failed'}`,
        message:
          outcome && !outcome.ok ? outcome.message : 'The provider didn’t give a sign-in code. Try again.',
      };
    }
  }

  private async deviceDone(loginId: string, outcome: LoginOutcome): Promise<void> {
    const entry = this.device.get(loginId);
    if (!entry) return;
    this.device.delete(loginId);
    let done: DeviceDone;
    try {
      done = outcome.ok ? await this.keepDevice(loginId, entry) : deviceFailed(loginId, outcome);
    } catch (err) {
      done = {
        loginId,
        ok: false,
        state: 'failed',
        code: 'provider.login_failed',
        message: `The sign-in couldn’t be kept (${err instanceof Error ? err.message : String(err)}).`,
      };
    } finally {
      // Gone before the outcome is told: nothing staged outlives the sign-in.
      await rm(entry.staging, { recursive: true, force: true });
      if (entry.hermesStaging)
        await rm(entry.hermesStaging, { recursive: true, force: true }).catch(() => {});
    }
    this.options.onDeviceDone(done);
  }

  /** A finished device sign-in kept: Hermes's login into the person's profile first, then the record. */
  private async keepDevice(
    loginId: string,
    entry: { staging: string; hermesStaging: string | null; target: SignInTarget },
  ): Promise<DeviceDone> {
    const login =
      entry.target.provider === 'github'
        ? (await githubStatus({ command: this.command('gh'), home: entry.staging })).login
        : null;
    // A recorded ChatGPT sign-in always has its login in the profile.
    if (entry.hermesStaging) {
      const steps = this.chatgpt();
      if (!steps) throw new Error('Hermes isn’t on this Whombat');
      await this.keepChatgpt(steps, entry.hermesStaging);
    }
    await this.install(entry.target, entry.staging, {
      verified: 'valid',
      expiresAt: null,
      creatorAttested: false,
      login,
    });
    return { loginId, ok: true, login };
  }

  async cancel(loginId: string): Promise<void> {
    this.device.get(loginId)?.handle.cancel();
  }

  async logout(provider: CredentialProvider): Promise<{ removed: boolean; authMode: string | null }> {
    const home = this.homeOf(provider);
    const meta = await readCredentialMeta(home);
    // Claude and Codex: removing the home is the sign-out (SUB-41). Their CLIs never run outside a sandbox on a home a
    // turn could write (a planted `.claude.json` link would make `claude auth logout` rewrite any file of this user).
    // gh's home is never a turn's.
    if (meta && provider === 'github')
      await githubLogout({ command: this.command('gh'), home }).catch(() => {});
    const info = await lstat(home).catch(() => null);
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new Error(`${home} is not a credential home.`);
    if (info) await rm(home, { recursive: true, force: true });
    // A ChatGPT login is Hermes's, in the person's profile (HN-03): it goes too, whatever the record said.
    if (provider === 'codex') await this.forgetChatgpt();
    for (const [id, entry] of this.device) if (entry.target.provider === provider) await this.cancel(id);
    if (provider === 'claude')
      for (const id of [...this.consoles.keys()]) await this.consoleStop(id, 'cancelled');
    // And whatever sign-in is still being staged (a crash, a cancelled console): gone too (SUB-43).
    await this.removeStaging(provider);
    return { removed: Boolean(info), authMode: meta?.authMode ?? null };
  }

  /** The person's sign-ins, one per provider. */
  async list(): Promise<SignInRecord[]> {
    const out: SignInRecord[] = [];
    for (const provider of CREDENTIAL_PROVIDERS) {
      const meta = await readCredentialMeta(this.homeOf(provider));
      if (meta) out.push({ provider, meta });
    }
    return out;
  }

  async githubToken(): Promise<string | null> {
    const home = this.homeOf('github');
    if (!(await readCredentialMeta(home))) return null;
    return githubToken({ command: this.command('gh'), home });
  }

  /* The sign-in console (CT-71) -------------------------------------------------------------------------------- */

  /** Starts run one at a time, so two starts can't both win. */
  consoleStart(job: ConsoleStartJob): Promise<ConsoleResult> {
    const started = this.consoleStarts.then(() => this.startConsole(job));
    this.consoleStarts = started.catch(() => {});
    return started;
  }

  private async startConsole(job: ConsoleStartJob): Promise<ConsoleResult> {
    const known = this.consoles.get(job.consoleId);
    // A repeated start (the server retried) answers like the first did.
    if (known) return known.login.running ? { ok: true } : CONSOLE_ENDED;
    if (this.endedConsoles.has(job.consoleId)) return CONSOLE_ENDED;
    // A newer console takes over.
    for (const id of [...this.consoles.keys()]) await this.consoleStop(id, 'cancelled');
    const command = this.installedClient('claude');
    if (!command)
      return {
        ok: false,
        code: 'client.not_installed',
        message: 'Claude Code isn’t installed on this Whombat. Install it, then sign in again.',
      };
    const staging = await this.stage('claude');
    let login: ClaudeConsoleLogin;
    try {
      login = await ClaudeConsoleLogin.start({
        command,
        home: staging,
        cols: job.cols,
        rows: job.rows,
        expiresAt: new Date(job.expiresAt),
        now: () => this.now(),
        ...this.hostEnvOption(),
        onOutput: (offset, data) =>
          this.options.onConsoleEvent?.({
            kind: 'output',
            consoleId: job.consoleId,
            offset,
            data: data.toString('base64'),
          }),
      });
    } catch {
      await rm(staging, { recursive: true, force: true });
      return {
        ok: false,
        code: 'provider.login_failed',
        message: 'Claude Code’s sign-in couldn’t be started. Try again.',
      };
    }
    this.consoles.set(job.consoleId, {
      job,
      login,
      finished: login.done.then((outcome) => this.consoleEnded(job, staging, outcome)),
    });
    return { ok: true };
  }

  /** Keeps a completed sign-in (replacing the person's earlier Claude sign-in), drops anything else, reports the exit. */
  private async consoleEnded(job: ConsoleStartJob, staging: string, outcome: ConsoleOutcome): Promise<void> {
    let result = outcome;
    try {
      if (outcome.state === 'completed')
        await this.install(
          { loginId: job.consoleId, provider: 'claude', authMode: 'subscription_cli' },
          staging,
          { verified: 'valid', expiresAt: null, creatorAttested: false, login: null },
        );
    } catch (err) {
      result = {
        state: 'failed',
        exitCode: outcome.exitCode,
        error: {
          code: 'provider.login_failed',
          message: `The sign-in couldn’t be kept (${err instanceof Error ? err.message : String(err)}).`,
        },
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      this.consoles.delete(job.consoleId);
      this.endedConsoles.add(job.consoleId);
      for (const id of this.endedConsoles) {
        if (this.endedConsoles.size <= 256) break;
        this.endedConsoles.delete(id);
      }
    }
    this.options.onConsoleEvent?.({
      kind: 'exit',
      consoleId: job.consoleId,
      exitCode: result.exitCode,
      state: result.state,
      error: result.error,
    });
  }

  /** The running console, or why there is none. */
  private runningConsole(consoleId: string): ClaudeConsoleLogin | ConsoleResult {
    const entry = this.consoles.get(consoleId);
    if (entry?.login.running) return entry.login;
    return entry || this.endedConsoles.has(consoleId) ? CONSOLE_ENDED : CONSOLE_NOT_FOUND;
  }

  async consoleInput(consoleId: string, data: string): Promise<ConsoleResult> {
    const login = this.runningConsole(consoleId);
    if (!(login instanceof ClaudeConsoleLogin)) return login;
    login.write(data);
    return { ok: true };
  }

  async consoleResize(consoleId: string, cols: number, rows: number): Promise<ConsoleResult> {
    const login = this.runningConsole(consoleId);
    if (!(login instanceof ClaudeConsoleLogin)) return login;
    login.resize(cols, rows);
    return { ok: true };
  }

  async consoleStop(consoleId: string, reason: ConsoleStopReason): Promise<void> {
    const entry = this.consoles.get(consoleId);
    if (!entry) return;
    entry.login.stop(reason);
    await entry.finished;
  }

  /* Usage probes (UI-R05) ------------------------------------------------------------------------------------- */

  /** One probe per subscription at a time: a second ask while one runs gets its answer. */
  private readonly probes = new Map<string, Promise<UsageProbeResult>>();

  usageProbe(provider: UsageProvider): Promise<UsageProbeResult> {
    const key = provider;
    const running = this.probes.get(key);
    if (running) return running;
    const probe = this.probe(provider).finally(() => this.probes.delete(key));
    this.probes.set(key, probe);
    return probe;
  }

  private async probe(provider: UsageProvider): Promise<UsageProbeResult> {
    let home: string;
    try {
      home = this.homeOf(provider);
    } catch {
      return PROBE_NOT_SIGNED_IN;
    }
    if (!(await credentialHomeExists(home))) return PROBE_NOT_SIGNED_IN;
    const meta = await readCredentialMeta(home);
    if (!meta) return PROBE_NOT_SIGNED_IN;
    // Pay as you go: nothing to read, nothing run (UI-R06).
    if (isApiKeyMode(provider, meta.authMode))
      return { ok: true, usage: apiKeyObservation(provider, this.now().toISOString()) };
    if (provider === 'codex') return this.probeChatgpt(meta.authMode);
    const command = this.installedClient(provider);
    if (!command)
      return {
        ok: false,
        code: 'client.not_installed',
        message: 'Claude Code isn’t installed on this Whombat.',
      };
    let host: UsageProbeHost;
    if (this.options.usageHost) {
      try {
        host = await this.options.usageHost({ provider, home, authMode: meta.authMode });
      } catch (err) {
        return {
          ok: false,
          code: 'sandbox_unavailable',
          message:
            `The usage check couldn’t start its sandbox: ${err instanceof Error ? err.message : String(err)}`.slice(
              0,
              500,
            ),
        };
      }
    } else {
      // On the host, as the CLI's user: never on a home with a link in it (SUB-41).
      const problem = await homeLinkProblem(home);
      if (problem)
        return {
          ok: false,
          code: 'provider.home_unsafe',
          message: 'This sign-in’s folder holds a link, so Whombat won’t run the CLI on it to read usage.',
        };
      const cwd = await mkdtemp(join(tmpdir(), 'wb-usage-'));
      host = { cwd, close: () => rm(cwd, { recursive: true, force: true }) };
    }
    try {
      const usage = await runUsageProbe({
        provider,
        home,
        authMode: meta.authMode,
        command,
        cwd: host.cwd,
        ...(host.spawn ? { spawn: host.spawn } : {}),
        ...this.hostEnvOption(),
        timeoutMs: this.options.usageTimeoutMs ?? 45_000,
        now: () => this.now(),
      });
      return { ok: true, usage };
    } catch (err) {
      return {
        ok: false,
        code: 'provider.usage_failed',
        message: `Usage couldn’t be read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      };
    } finally {
      await host.close().catch(() => {});
    }
  }

  /**
   * ChatGPT's usage, read by Hermes on the person's own login in their profile (HN-03, CR-09): in a task sandbox like a
   * turn's (the profile writable — Hermes may refresh the login — and Hermes's install readable), or, without one, on the
   * host once Hermes's two files there are plain files.
   */
  private async probeChatgpt(authMode: string): Promise<UsageProbeResult> {
    const steps = this.chatgpt();
    if (!steps)
      return {
        ok: false,
        code: 'provider.usage_failed',
        message: 'Reading ChatGPT’s usage needs Hermes, which isn’t on this Whombat.',
      };
    const profile = hermesPersonProfile(this.hermesRoot());
    if (!(await plainFile(join(profile, 'auth.json')))) return PROBE_NOT_SIGNED_IN;
    let host: UsageProbeHost;
    if (this.options.usageHost) {
      try {
        host = await this.options.usageHost({
          provider: 'codex',
          home: profile,
          authMode,
          installs: hermesInstalls(realCommand(this.hermesBin(), this.hostEnv())),
        });
      } catch (err) {
        return {
          ok: false,
          code: 'sandbox_unavailable',
          message:
            `The usage check couldn’t start its sandbox: ${err instanceof Error ? err.message : String(err)}`.slice(
              0,
              500,
            ),
        };
      }
    } else {
      // On the host, as the runner's user: Hermes opens `auth.json` and `auth.lock` there, so neither may be a link.
      const lock = join(profile, 'auth.lock');
      if ((await lstat(lock).catch(() => null)) && !(await plainFile(lock)))
        return {
          ok: false,
          code: 'provider.home_unsafe',
          message: 'This sign-in’s folder holds a link, so Whombat won’t read usage from it.',
        };
      const cwd = await mkdtemp(join(tmpdir(), 'wb-usage-'));
      host = { cwd, close: () => rm(cwd, { recursive: true, force: true }) };
    }
    try {
      const usage = await chatgptUsageProbe({
        steps,
        profile,
        cwd: host.cwd,
        ...(host.spawn ? { spawn: host.spawn } : {}),
        timeoutMs: this.options.usageTimeoutMs ?? 45_000,
        now: () => this.now(),
      });
      return { ok: true, usage };
    } finally {
      await host.close().catch(() => {});
    }
  }

  /** Ends every device sign-in and console (shutdown); resolves once the consoles' staging homes are gone. */
  async close(): Promise<void> {
    this.closing.abort();
    for (const entry of this.device.values()) entry.handle.cancel();
    await Promise.all([...this.consoles.keys()].map((id) => this.consoleStop(id, 'cancelled')));
  }
}
