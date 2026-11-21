/**
 * Provider sign-in from a remote browser, without a terminal (docs/managed/provider-login.md; managed-providers.md
 * PV-03, PV-06, PV-12). The hosted UI drives it over session ops (contracts 0.5.0 `providers.*`); the person's own
 * sign-in or API key, in their one home per provider, is what every turn runs on (one-person.md OP-S09). This service
 * keeps the attempts, the eligibility policy, account
 * binding and the signed audit trail, and hands every step that touches a CLI or a credential home to the sign-in
 * executor — on a managed appliance the runner's (`RunnerSignInBridge`: the CLIs run as the runner's user, which
 * owns every home), in development and tests one in-process (`LocalSignInExecutor`).
 *
 * - key entry (Claude and Codex API keys, Codex access tokens, GitHub tokens): `start` opens an attempt, `submit`
 *   carries the secret inside the encrypted session; it is stored only in the owner's home, checked for free where
 *   the provider offers a check, never echoed or logged;
 * - device code (GitHub; Codex ChatGPT, a person's own since SUB-01): the CLI's verification address and one-time
 *   code are relayed to the browser — on any computer, no localhost callback;
 * - Claude subscription (`subscription_cli`, permitted since SUB-01): turns run on it (the CLI's own login in the
 *   person's home); the sign-in is Claude Code's own `claude auth login --claudeai` in a console (`consoles.ts`,
 *   CT-71): the executor runs it in a PTY with the home's `config/`, the web UI shows the output and forwards
 *   keystrokes (`signins.console*`), and only the CLI's own `claude auth status` completes it. `subscription_sdk` is
 *   no sign-in at all.
 *
 * Attempts bind to the session's account: no other account can see, continue, cancel or use one. Attempts live in
 * memory (a restart ends them; a completed sign-in lives in its home).
 */
import { randomBytes } from 'node:crypto';
import {
  AUTH_MODES,
  authModeName,
  CLAUDE_SDK_SUBSCRIPTION_GONE,
  type CredentialMeta,
  type CredentialProvider,
  checkProviderDrift,
  clientNotInstalledText,
  credentialStatus,
  type DeviceDone,
  type DriftResult,
  type Fetch,
  isAuthMode,
  jwtExpiry,
  LocalSignInExecutor,
  PROVIDER_NAMES,
  type SignInExecutor,
  type SignInRecord,
  signInEligibility,
  type UsageProbeResult,
  type UsageProvider,
} from '@whombat/agent-runtime/providers';
import type { ProviderLogin, ProviderSignIn } from '@whombat/core';
import { clientCommand, managedClientState } from '../../clients/service';
import type { Config } from '../../config';
import { ApiError } from '../../lib/errors';
import type { Services } from '../../services';
import { appendApplianceEvent } from '../audit';
import { RunnerSignInBridge } from './bridge';
import { ConsoleRelay } from './consoles';

/** Who calls a sign-in op: a session's principal (`SessionPrincipal` fits), or a REST caller (`signinCaller`). */
export interface SignInCaller {
  account: { id: string; name?: string } | null;
  endpoint: { id: string } | null;
}

type LoginState = ProviderLogin['state'];

interface Attempt {
  loginId: string;
  /** The account that started it (the only one who may continue it). */
  accountId: string;
  endpointId: string | null;
  provider: CredentialProvider;
  authMode: string;
  state: LoginState;
  device: ProviderLogin['device'];
  error: ProviderLogin['error'];
  verified: ProviderLogin['verified'];
  expiresAt: Date;
}

export interface ProviderLoginOptions {
  /** The sign-in executor (default: the runner's in managed mode, else one in-process). */
  executor?: SignInExecutor;
  /** `WHOMBAT_CREDENTIALS_ROOT` for the in-process executor (default: the config's). */
  root?: string | undefined;
  /** The in-process executor's commands (tests pass fakes): gh, and what runs one of the plugin's ChatGPT steps. */
  commands?: { gh?: string; chatgpt?: readonly string[] };
  /** The in-process executor's Hermes root, whose profiles get ChatGPT logins (hermes-native.md HN-03). */
  hermesRoot?: string;
  /** The in-process executor's free key checks (tests pass a fake; never a model call). */
  fetch?: Fetch;
  /** Claude Code's drift check (tests pass their own); ChatGPT runs no client of its own (HN-04). */
  drift?: (provider: 'claude') => Promise<DriftResult | null>;
  /** The in-process executor's Claude CLI for the sign-in console (tests pass a fake). */
  claude?: string;
  /** Where an installed client's executable is (the self-hosted client installer, CT-72); null: the default. */
  resolveClient?: (provider: 'claude') => string | null;
  /** Tests: a shorter console lifetime. */
  consoleTtlMs?: number;
  /** How long a key-entry attempt waits for its secret (default 10 minutes). */
  secretTtlMs?: number;
  codeTimeoutMs?: number;
}

/** Secret-entry modes; the rest are device flows. */
const SECRET_MODES = new Set(['claude:api_key', 'codex:api_key', 'codex:access_token', 'github:token']);
const DEVICE_MODES = new Set(['codex:chatgpt', 'github:device']);
const MAX_ACCESS_TOKEN_DAYS = 90;

/**
 * Where people's provider sign-ins live on the server: `WHOMBAT_CREDENTIALS_ROOT`, set only with the local executor
 * (tests). The appliance gives the root to the runner alone (appliance NX-20): the server has none there.
 */
export function credentialsRootOf(config: Pick<Config, 'WHOMBAT_CREDENTIALS_ROOT'>): string | null {
  return config.WHOMBAT_CREDENTIALS_ROOT ?? null;
}

/**
 * Whether this runtime can hold provider sign-ins (SUB-56): a credentials root of its own, or — with the runner-side
 * executor (the default) — the runner's, which the server reaches only through the sign-in bridge.
 */
export function signInsAvailable(
  config: Pick<Config, 'WHOMBAT_CREDENTIALS_ROOT' | 'WHOMBAT_SIGNIN_EXECUTOR'>,
): boolean {
  if (credentialsRootOf(config)) return true;
  return (config.WHOMBAT_SIGNIN_EXECUTOR ?? 'runner') === 'runner';
}

export function loginError(
  code: string,
  message: string,
  status: ConstructorParameters<typeof ApiError>[0] = 'conflict',
) {
  return new ApiError(status, message, { details: { code } });
}

export class ProviderLoginService {
  private readonly attempts = new Map<string, Attempt>();
  private readonly options: ProviderLoginOptions;
  private readonly driftCache = new Map<string, { at: number; result: Promise<DriftResult | null> }>();
  private executorInstance: SignInExecutor | null = null;
  readonly bridge: RunnerSignInBridge | null;

  constructor(
    private readonly services: Services,
    options: ProviderLoginOptions = {},
  ) {
    this.options = options;
    const runnerSide =
      !options.executor && (services.config.WHOMBAT_SIGNIN_EXECUTOR ?? 'runner') === 'runner';
    this.bridge = runnerSide
      ? new RunnerSignInBridge(
          (done) => void this.deviceDone(done),
          (events) => this.consoles.events(events),
        )
      : null;
    this.consoles = new ConsoleRelay({
      executor: () => this.executor,
      now: () => this.now(),
      ...(options.consoleTtlMs ? { ttlMs: options.consoleTtlMs } : {}),
      onCompleted: (c) =>
        this.audit('provider.signed_in', c.accountId, c.endpointId, {
          provider: 'claude',
          authMode: 'subscription_cli',
          accountId: c.accountId,
          verified: 'valid',
          expiresAt: null,
        }),
    });
  }

  /** The Claude sign-in consoles (CT-71). */
  readonly consoles: ConsoleRelay;

  private get root(): string | null {
    return this.options.root ?? credentialsRootOf(this.services.config);
  }

  /** The executor, created on first use. */
  get executor(): SignInExecutor {
    if (!this.executorInstance) {
      if (this.options.executor) this.executorInstance = this.options.executor;
      else if (this.bridge) this.executorInstance = this.bridge;
      else
        this.executorInstance = new LocalSignInExecutor({
          root: this.requireRoot(),
          ...(this.options.hermesRoot ? { hermes: { root: this.options.hermesRoot } } : {}),
          ...(this.options.commands || this.options.claude
            ? {
                commands: {
                  ...this.options.commands,
                  ...(this.options.claude ? { claude: this.options.claude } : {}),
                },
              }
            : {}),
          // The installed client (SUB-09): the self-hosted installer's, the operator's pin, or the default lookup.
          resolveClient: this.options.resolveClient ?? ((provider) => clientCommand(this.services, provider)),
          onConsoleEvent: (event) => void this.consoles.events([event]),
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          now: () => this.now(),
          ...(this.options.codeTimeoutMs ? { codeTimeoutMs: this.options.codeTimeoutMs } : {}),
          onDeviceDone: (done) => void this.deviceDone(done),
        });
    }
    return this.executorInstance;
  }

  private now(): Date {
    return this.services.clock();
  }

  private requireAccount(principal: SignInCaller): string {
    const id = principal.account?.id;
    if (!id) throw new ApiError('unauthorized', 'Enroll this device first.');
    return id;
  }

  /** Sign-ins can be held here: an executor given, the runner's bridge, or a root of the server's own (SUB-56). */
  private get available(): boolean {
    return Boolean(this.options.executor || this.bridge || this.root);
  }

  /**
   * The sign-ins can be read right now without waiting on nobody: held here, and — through the runner's bridge — a
   * runner is polling it. For reads that only show something (the appliance's status, diagnostics).
   */
  get readable(): boolean {
    if (!this.available) return false;
    return Boolean(this.options.executor) || !this.bridge || this.bridge.runnerSeen;
  }

  private requireAvailable(): void {
    if (!this.available)
      throw loginError(
        'provider.not_configured',
        'This appliance has no place for provider sign-ins yet.',
        'conflict',
      );
  }

  private requireRoot(): string {
    const root = this.root;
    if (!root)
      throw loginError(
        'provider.not_configured',
        'This appliance has no place for provider sign-ins yet.',
        'conflict',
      );
    return root;
  }

  private view(a: Attempt): ProviderLogin {
    if (['awaiting_secret', 'awaiting_user'].includes(a.state) && a.expiresAt <= this.now())
      this.finish(a, 'expired');
    return {
      loginId: a.loginId,
      provider: a.provider,
      authMode: a.authMode,
      state: a.state,
      device: a.device,
      error: a.error,
      verified: a.verified,
      expiresAt: a.expiresAt.toISOString(),
    };
  }

  private finish(a: Attempt, state: LoginState, error: ProviderLogin['error'] = null): void {
    if (!['awaiting_secret', 'awaiting_user'].includes(a.state)) return;
    const device = a.state === 'awaiting_user';
    a.state = state;
    a.error =
      error ??
      (state === 'expired'
        ? {
            code: 'provider.login_expired',
            message: 'This sign-in expired before it was finished. Start again.',
          }
        : null);
    if (device) void this.executor.cancel(a.loginId).catch(() => {});
  }

  /**
   * The attempt, if it is this account's (anyone else gets “not found”, never a hint it exists). An organization
   * credential's attempt also needs the account to be an owner **now** (review L-3).
   */
  private own(principal: SignInCaller, loginId: string): Attempt {
    const a = this.attempts.get(loginId);
    if (!a || a.accountId !== principal.account?.id)
      throw loginError('provider.login_not_found', 'No sign-in with that id.', 'not_found');
    return a;
  }

  private sweep(): void {
    const cutoff = this.now().getTime() - 3600_000;
    for (const [id, a] of this.attempts) {
      if (a.expiresAt <= this.now()) this.view(a);
      if (a.expiresAt.getTime() < cutoff) this.attempts.delete(id);
    }
  }

  /** What each mode allows this account to start, with the reason when it doesn't. */
  modes(): { provider: CredentialProvider; authMode: string; available: boolean; reason: string | null }[] {
    const out: {
      provider: CredentialProvider;
      authMode: string;
      available: boolean;
      reason: string | null;
    }[] = [];
    for (const provider of ['claude', 'codex', 'github'] as const)
      for (const authMode of AUTH_MODES[provider]) {
        const unavailable = this.unimplemented(provider, authMode);
        const verdict = signInEligibility({ provider, authMode });
        out.push({
          provider,
          authMode,
          available: !unavailable && verdict.allowed,
          reason: unavailable ?? verdict.explanation,
        });
      }
    return out;
  }

  private unimplemented(provider: CredentialProvider, authMode: string): string | null {
    if (provider === 'claude' && authMode === 'subscription_sdk') return CLAUDE_SDK_SUBSCRIPTION_GONE;
    if (provider === 'claude' && authMode === 'cloud')
      return 'Signing in with a Bedrock, Google Cloud or Foundry credential isn’t built yet. Use an Anthropic API key.';
    return null;
  }

  /** `providers.login.start`: a sign-in for the session's own account. */
  start(
    principal: SignInCaller,
    input: { provider: CredentialProvider; authMode: string },
  ): Promise<ProviderLogin> {
    return this.open(principal, this.requireAccount(principal), input);
  }

  private async open(
    principal: SignInCaller,
    accountId: string,
    input: { provider: CredentialProvider; authMode: string },
  ): Promise<ProviderLogin> {
    this.requireAvailable();
    this.sweep();
    const { provider, authMode } = input;
    if (!isAuthMode(provider, authMode))
      throw new ApiError(
        'validation_failed',
        `${PROVIDER_NAMES[provider]} has no sign-in called ${authMode}.`,
      );
    const unavailable = this.unimplemented(provider, authMode);
    if (unavailable) throw loginError('provider.login_unavailable', unavailable, 'not_allowed');
    if (provider === 'claude' && authMode === 'subscription_cli')
      throw loginError(
        'provider.login_unavailable',
        'A Claude subscription signs in in Claude Code’s own sign-in, in a console: start it with signins.consoleStart.',
        'validation_failed',
      );
    const verdict = signInEligibility({ provider, authMode });
    if (!verdict.allowed)
      throw new ApiError('not_allowed', verdict.explanation ?? 'Not available on this appliance.', {
        details: { code: verdict.code, managed: true, reason: `${provider}:${authMode}` },
      });
    // One attempt per provider (the person's one home for it): a new one replaces what was pending.
    for (const a of this.attempts.values()) if (a.provider === provider) this.finish(a, 'cancelled');
    const key = `${provider}:${authMode}`;
    const attempt: Attempt = {
      loginId: `plg_${randomBytes(12).toString('base64url')}`,
      accountId,
      endpointId: principal.endpoint?.id ?? null,
      provider,
      authMode,
      state: 'awaiting_secret',
      device: null,
      error: null,
      verified: null,
      expiresAt: new Date(this.now().getTime() + (this.options.secretTtlMs ?? 10 * 60_000)),
    };
    this.attempts.set(attempt.loginId, attempt);
    if (SECRET_MODES.has(key)) return this.view(attempt);
    if (!DEVICE_MODES.has(key))
      throw new ApiError('validation_failed', `${authModeName(provider, authMode)} has no sign-in flow.`);
    attempt.state = 'awaiting_user';
    const started = await this.executor.startDevice({ loginId: attempt.loginId, provider, authMode });
    if (started.ok) {
      attempt.device = started.device;
      attempt.expiresAt = new Date(started.device.expiresAt);
    } else this.finish(attempt, 'failed', { code: started.code, message: started.message });
    return this.view(attempt);
  }

  private async deviceDone(done: DeviceDone): Promise<void> {
    const a = this.attempts.get(done.loginId);
    if (a?.state !== 'awaiting_user') return;
    if (!done.ok) {
      a.state = done.state;
      a.error = { code: done.code, message: done.message };
      return;
    }
    a.verified = 'valid';
    await this.audit(
      'provider.signed_in',
      a.accountId,
      a.endpointId,
      this.auditPayload(a, 'valid', null, done.login),
    );
    // Connected before the sign-in shows as completed, so a client that connects too finds it done (RA-DS52).
    await this.afterSignedIn(a);
    a.state = 'completed';
  }

  /**
   * The person's GitHub sign-in connects their burrow when nobody connected it yet (resourceful-agents.md RA-DS52),
   * whatever client they signed in from. Best effort: the sign-in stands whatever happens here.
   */
  private async afterSignedIn(a: Attempt): Promise<void> {
    if (a.provider !== 'github') return;
    const accountId = a.accountId;
    try {
      const { connectOwnBurrows } = await import('../../github/auto-connect');
      await connectOwnBurrows(this.services, accountId);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'GitHub sign-in: could not connect the owner’s burrows');
    }
  }

  private auditPayload(a: Attempt, verified: string, expiresAt: string | null, login: string | null) {
    return {
      provider: a.provider,
      authMode: a.authMode,
      accountId: a.accountId,
      verified,
      expiresAt,
      ...(login ? { login } : {}),
    };
  }

  async submit(
    principal: SignInCaller,
    input: {
      loginId: string;
      secret: string;
      expiresAt?: string | undefined;
      creatorAttested?: boolean | undefined;
    },
  ): Promise<ProviderLogin> {
    const a = this.own(principal, input.loginId);
    this.view(a);
    if (a.state !== 'awaiting_secret')
      throw loginError('provider.login_not_waiting', 'This sign-in isn’t waiting for a key. Start again.');
    const secret = input.secret.trim();
    if (/\s/.test(secret))
      throw new ApiError('validation_failed', 'Paste the key on its own, without spaces or line breaks.');
    let expiresAt: string | null = null;
    if (a.provider === 'codex' && a.authMode === 'access_token') {
      if (input.creatorAttested !== true)
        throw loginError(
          'provider.token_creator_required',
          'Only the person who created a Codex access token may use it here. Confirm you created it.',
          'validation_failed',
        );
      const entered = input.expiresAt ? new Date(input.expiresAt) : null;
      const max = this.now().getTime() + MAX_ACCESS_TOKEN_DAYS * 86400_000;
      if (!entered || entered <= this.now() || entered.getTime() > max)
        throw loginError(
          'provider.token_expiry_required',
          `Enter when the token expires (at most ${MAX_ACCESS_TOKEN_DAYS} days from now); Whombat stops using it then.`,
          'validation_failed',
        );
      const claimed = jwtExpiry(secret);
      expiresAt = (claimed && claimed < entered ? claimed : entered).toISOString();
    }
    const result = await this.executor.submitSecret({
      loginId: a.loginId,
      provider: a.provider,
      authMode: a.authMode,
      secret,
      expiresAt,
      creatorAttested: input.creatorAttested === true,
    });
    if (!result.ok) {
      this.finish(a, 'failed', { code: result.code, message: result.message });
      return this.view(a);
    }
    a.verified = result.verified;
    await this.audit(
      'provider.signed_in',
      a.accountId,
      a.endpointId,
      this.auditPayload(a, result.verified, expiresAt, result.login),
    );
    await this.afterSignedIn(a);
    a.state = 'completed';
    return this.view(a);
  }

  status(principal: SignInCaller, input: { loginId: string }): ProviderLogin {
    return this.view(this.own(principal, input.loginId));
  }

  cancel(principal: SignInCaller, input: { loginId: string }): ProviderLogin {
    const a = this.own(principal, input.loginId);
    this.finish(a, 'cancelled');
    return this.view(a);
  }

  /** Signs the person out of a provider: its sign-in goes (a ChatGPT one from Hermes's profile too, HN-03). */
  async logout(
    principal: SignInCaller,
    input: { provider: CredentialProvider },
  ): Promise<{ removed: boolean }> {
    const accountId = this.requireAccount(principal);
    const provider = input.provider;
    this.requireAvailable();
    const out = await this.executor.logout(provider);
    for (const a of this.attempts.values()) if (a.provider === provider) this.finish(a, 'cancelled');
    if (out.removed)
      await this.audit('provider.signed_out', accountId, principal.endpoint?.id ?? null, {
        provider,
        authMode: out.authMode,
        accountId,
      });
    return { removed: out.removed };
  }

  private async audit(
    type: 'provider.signed_in' | 'provider.signed_out',
    accountId: string,
    endpointId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.services.pipeline.transactAccount(async (tx) => {
      await appendApplianceEvent(tx, this.services.custody, {
        type,
        actorAccountId: accountId,
        endpointId,
        payload,
        at: this.now(),
      });
    });
  }

  private drift(provider: 'claude'): Promise<DriftResult | null> {
    if (this.options.drift) return this.options.drift(provider);
    // A manager-installed client replaces the image's pins (SUB-49, SUB-52): the runner checks its path and digest
    // before every turn, so here only “installed or not” matters.
    const installed = managedClientState(this.services, provider);
    if (installed === 'installed') return Promise.resolve(null);
    if (installed === 'missing')
      return Promise.resolve({
        ok: false,
        reason: 'missing',
        explanation: clientNotInstalledText(provider),
        expected: { version: '', sha256: null },
        found: { version: null, sha256: null },
      });
    const hit = this.driftCache.get(provider);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result;
    const result = checkProviderDrift(provider).then((r) => (r.ok ? null : r));
    this.driftCache.set(provider, { at: Date.now(), result });
    return result;
  }

  /** The person's sign-in for a provider (no secret), or null (one-person.md OP-S09: one home per provider). */
  async record(provider: CredentialProvider): Promise<CredentialMeta | null> {
    if (!this.available) return null;
    return (await this.executor.list()).find((r) => r.provider === provider)?.meta ?? null;
  }

  /**
   * The person's Claude and Codex sign-ins (no secrets) for the usage service (docs/decisions/ui-improvements.md
   * UI-R09); none where sign-ins can't be held.
   */
  async personSignIns(): Promise<SignInRecord[]> {
    if (!this.available) return [];
    return (await this.executor.list()).filter((r) => r.provider === 'claude' || r.provider === 'codex');
  }

  /**
   * Reads a person's subscription usage through the executor (UI-R05): the server's own when self-hosted, the
   * runner's in a task sandbox on an appliance. Null when this Whombat can't: no place for sign-ins, or an executor
   * without probes (a runner of an older release, `unsupported`).
   */
  async usageProbe(
    provider: UsageProvider,
  ): Promise<UsageProbeResult | { ok: false; code: 'unsupported' | 'runner_away'; message: string } | null> {
    if (!this.available) return null;
    const executor = this.executor;
    if (!executor.usageProbe)
      return { ok: false, code: 'unsupported', message: 'This Whombat can’t read usage yet.' };
    try {
      return await executor.usageProbe(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // No runner took it in time (restarting, busy): not the sign-in's fault either; the schedule waits a little.
      if (
        err instanceof ApiError &&
        (err.extra.details as { code?: unknown } | undefined)?.code === 'provider.signin_unavailable'
      )
        return {
          ok: false,
          code: 'runner_away',
          message: 'The runner didn’t answer; usage will be read again soon.',
        };
      // A runner of an older release doesn't know the method: not an error of the sign-in (UI-R13).
      if (/unknown sign-in method/i.test(message))
        return {
          ok: false,
          code: 'unsupported',
          message: 'Usage can be read once this Whombat’s runner is updated.',
        };
      return { ok: false, code: 'provider.usage_failed', message: message.slice(0, 300) };
    }
  }

  /** The person's GitHub token (for one git operation or GitHub API call), or null. */
  githubToken(): Promise<string | null> {
    return this.available ? this.executor.githubToken() : Promise.resolve(null);
  }

  private async rows(records: SignInRecord[]): Promise<ProviderSignIn[]> {
    const out: ProviderSignIn[] = [];
    for (const { provider, meta } of records) {
      const verdict = signInEligibility({ provider, authMode: meta.authMode });
      const status = credentialStatus(
        {
          refused: verdict.allowed ? null : { explanation: verdict.explanation ?? '' },
          drift: provider === 'claude' ? driftOf(await this.drift(provider)) : null,
          signedIn: true,
          expiresAt: meta.expiresAt,
          signal: meta.signal,
          now: this.now(),
        },
        { provider: PROVIDER_NAMES[provider] },
      );
      out.push({
        provider,
        authMode: meta.authMode,
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        verified: meta.verified,
        login: meta.login,
        state: status.state,
        explanation: status.explanation,
      });
    }
    return out;
  }

  /** `providers.list` / `signins.list`: the person's sign-ins, attempts, consoles and what they may start. */
  async list(principal: SignInCaller) {
    const accountId = this.requireAccount(principal);
    this.sweep();
    const records = this.available ? await this.executor.list() : [];
    return {
      signIns: await this.rows(records),
      logins: [...this.attempts.values()].filter((a) => a.accountId === accountId).map((a) => this.view(a)),
      modes: this.modes(),
      consoles: this.consoles.list(accountId),
    };
  }

  /* The Claude sign-in console (CT-71) ---------------------------------------------------------------------------- */

  /**
   * `signins.consoleStart`: Claude Code's own sign-in (`claude auth login --claudeai`, nothing else) in a console for
   * the caller's own account. A key-entry attempt for Claude of the same account is cancelled (one sign-in at a time).
   */
  async consoleStart(
    principal: SignInCaller,
    input: { provider: 'claude'; authMode: 'subscription_cli'; cols: number; rows: number },
  ) {
    const accountId = this.requireAccount(principal);
    this.requireAvailable();
    const verdict = signInEligibility({ provider: input.provider, authMode: input.authMode });
    if (!verdict.allowed)
      throw new ApiError('not_allowed', verdict.explanation ?? 'Not available on this appliance.', {
        details: { code: verdict.code, managed: true, reason: `${input.provider}:${input.authMode}` },
      });
    for (const a of this.attempts.values()) if (a.provider === 'claude') this.finish(a, 'cancelled');
    return this.consoles.start(
      { accountId, endpointId: principal.endpoint?.id ?? null },
      { cols: input.cols, rows: input.rows },
    );
  }

  consoleRead(
    principal: SignInCaller,
    consoleId: string,
    query: { cursor: number; waitMs: number },
    signal?: AbortSignal,
  ) {
    return this.consoles.read(this.requireAccount(principal), consoleId, query, signal);
  }

  consoleWrite(principal: SignInCaller, consoleId: string, input: { seq: number; data: string }) {
    return this.consoles.write(this.requireAccount(principal), consoleId, input);
  }

  consoleResize(principal: SignInCaller, consoleId: string, input: { cols: number; rows: number }) {
    return this.consoles.resize(this.requireAccount(principal), consoleId, input);
  }

  consoleCancel(principal: SignInCaller, consoleId: string) {
    return this.consoles.cancel(this.requireAccount(principal), consoleId);
  }

  /**
   * `appliance.status.providers[]` (CT-24): each model provider's sign-in with its state; a provider without one gets a
   * `not_signed_in` row.
   */
  async statusRows(_principal: SignInCaller) {
    const records = this.available ? await this.executor.list() : [];
    const rows = (await this.rows(records))
      .filter((s) => s.provider !== 'github')
      .map((s) => ({
        provider: s.provider,
        authMode: s.authMode,
        state: s.state,
        explanation: s.explanation,
      }));
    for (const provider of ['claude', 'codex'] as const)
      if (!rows.some((r) => r.provider === provider))
        rows.push({
          provider,
          authMode: 'api_key',
          state: 'not_signed_in',
          explanation: `You haven’t signed in to ${PROVIDER_NAMES[provider]} on this Whombat.`,
        });
    return rows.slice(0, 64);
  }

  /** Ends every pending attempt (shutdown). */
  close(): void {
    void this.consoles.close();
    for (const a of this.attempts.values()) this.finish(a, 'cancelled');
    this.bridge?.close();
  }
}

function driftOf(d: DriftResult | null): { explanation: string } | null {
  return d && !d.ok ? { explanation: d.explanation } : null;
}

const services = new WeakMap<Services, ProviderLoginService>();

/** The appliance's one sign-in service (attempts are per process). */
export function providerLogins(s: Services, options?: ProviderLoginOptions): ProviderLoginService {
  let svc = services.get(s);
  if (!svc) {
    svc = new ProviderLoginService(s, options);
    services.set(s, svc);
  }
  return svc;
}
