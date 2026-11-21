/**
 * The execution policy on the runner (MA-10; docs/decisions/managed-runtime.md MR-13 and managed-sandbox.md; one mode,
 * hermes-engine.md HE-48): a turn never runs without its enforced sandbox, and never with anyone's provider login but
 * the run's credential owner's. Each is refused before or at the start of the turn, with the reason the agent says in
 * the conversation — never silently run another way. One person's Whombat (one-person.md OP-09): a turn runs on the
 * person's own sign-in or the API key they added, one home per provider.
 *
 * Every live turn runs in a `ManagedSandbox` session (provider and tools together), with the egress policy below and the
 * credential owner's home as its only writable home.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CredentialOwner,
  type EgressAllowance,
  type EgressGrant,
  type EgressPolicy,
  type ManagedOutcome,
  type ManagedSandbox,
  outcomeCopy,
  type SandboxLimits,
  type SandboxTask,
  type TurnInput,
  withAllowance,
} from '@whombat/agent-runtime';
import { privateDir, runnerTmpRoot } from '@whombat/agent-runtime/host';
import {
  CLAUDE_KEY_FILE,
  claudeConfigDir,
  type DriftResult,
  type RunSignalState,
  recordRunSignal,
  resolveTurnCredential,
  type TurnCredential,
  type UsageHostJob,
  type UsageProbeHost,
} from '@whombat/agent-runtime/providers';
import type { DispatchContext } from '@whombat/core';

/**
 * The longest a turn runs, minutes (`WHOMBAT_SANDBOX_WALL_MINUTES`): no round-trip cap, a turn ends at its wall
 * time or lease (docs/decisions/resourceful-agents.md RA-14). The server's agent tokens last as long (EA-04).
 */
export const SANDBOX_WALL_MINUTES = 480;

/** What a turn needs of the task sandbox (`ManagedSandbox`; tests stand one in). */
export type TaskSandboxes = Pick<ManagedSandbox, 'node' | 'open'> & {
  readonly config: Pick<ManagedSandbox['config'], 'deniedPaths' | 'bwrap' | 'nsenter'>;
};

export interface ManagedPolicy {
  /** `WHOMBAT_CREDENTIALS_ROOT`: the person's provider logins, one home per provider (`<root>/<provider>`). */
  credentialsRoot?: string | undefined;
  /** The enforced sandbox every live turn runs in; absent = no live turn runs (fail closed). */
  sandbox?: TaskSandboxes;
  /** This runner's generation (fencing tokens, cgroup names). */
  generation?: number;
  /** Hosts every task may reach besides its provider's and GitHub (`WHOMBAT_SANDBOX_EGRESS_ALLOW`). */
  egressAllow?: readonly string[];
  /** Explicit customer-network grants (`WHOMBAT_SANDBOX_GRANTS`), for every task. Empty by default. */
  grants?: readonly EgressGrant[];
  /** Longest a turn may run (default `SANDBOX_WALL_MINUTES`, 8 hours). */
  wallMs?: number;
  /** The server's lease: a turn that can't renew it for this long stops (default 60 s). */
  leaseMs?: number;
  limits?: Partial<SandboxLimits>;
  /**
   * The drift check of Claude Code against its pinned bundle (null: matches; absent: not checked). ChatGPT runs no
   * client of its own (hermes-native.md HN-04).
   */
  drift?: (provider: 'claude') => Promise<DriftResult | null>;
}

export const MANAGED_REFUSALS = {
  sandbox: outcomeCopy('sandbox_unavailable', 'claude'),
} as const;

/** A turn that can't run for one of the managed outcomes: what the agent says, and the code the server keeps. */
export class ManagedRefusal extends Error {
  constructor(
    readonly outcome: ManagedOutcome,
    readonly refusal: string,
  ) {
    super(refusal);
    this.name = 'ManagedRefusal';
  }
}

/**
 * Where each provider's model requests and sign-in refresh go; GitHub for git over https. ChatGPT: Hermes itself calls
 * `chatgpt.com/backend-api/codex` and refreshes the login at `auth.openai.com` (HN-02); an OpenAI key goes to
 * `api.openai.com`.
 */
export const PROVIDER_ENDPOINTS: Record<string, readonly string[]> = {
  claude: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', 'claude.com', '*.claude.com'],
  codex: ['api.openai.com', '*.openai.com', 'chatgpt.com', '*.chatgpt.com'],
};
export const GITHUB_ENDPOINTS: readonly string[] = [
  'github.com',
  '*.github.com',
  'githubusercontent.com',
  '*.githubusercontent.com',
];

/**
 * A task's egress (MSB-06): its provider's endpoints and GitHub, or any public host with the web key. A turn through the
 * burrow's AI gateway (Whombat ai-gateway.md AIG-10) doesn't get its provider's endpoints: its model requests go to the
 * gateway's bridge, never out of the sandbox, and the CLI can't fall back to Anthropic or OpenAI. With the web key any
 * public host stays open, as the key says; the CLI holds no login there to use.
 */
export function egressPolicy(
  provider: string,
  input: Pick<TurnInput, 'network'> & Partial<Pick<TurnInput, 'gateway'>>,
  policy: ManagedPolicy,
): EgressPolicy {
  const grants = policy.grants?.length ? { grants: policy.grants } : {};
  if (input.network) return { allow: 'public', ...grants };
  const endpoints = input.gateway ? [] : (PROVIDER_ENDPOINTS[provider] ?? []);
  return {
    allow: [...endpoints, ...GITHUB_ENDPOINTS, ...(policy.egressAllow ?? [])],
    ...grants,
  };
}

/**
 * Whose home a turn through the burrow's AI gateway runs with (AIG-10): the gateway's own, mounted like an organization
 * credential home — Claude's `config/` writable, nothing else of the credentials root; ChatGPT's turn is Hermes's own
 * loop calling the relay and mounts none (HN-02) — with no key file (the key is the dispatch's agent token, in the
 * environment). Never a person's.
 */
export function gatewayOwner(
  connectionId: string,
  provider: 'claude' | 'codex',
  home: string,
): CredentialOwner {
  return { account: `gateway/${connectionId}`, provider, authMode: 'subscription', home };
}

/**
 * The sandbox task of a turn: its working directory (writable when the agent may write — a checkout, or the agent's
 * work folder), what a commit needs, what stays read-only inside, what it reads (attachments, toolchain settings),
 * everything the confinement denies — and the credential owner's home, the one login it has.
 */
export function sandboxTask(
  id: string,
  provider: string,
  input: TurnInput,
  owner: CredentialOwner | null,
  policy: ManagedPolicy,
  allowance: EgressAllowance | null = null,
): SandboxTask {
  const c = input.host?.confinement;
  const write = input.sandbox === 'workspace-write';
  // Claude: only the CLI's config dir is writable (a subscription's login is refreshed there, SUB-13). An API key's
  // file is readable (Claude's and OpenAI's). Whombat's own record next to them stays outside the task. ChatGPT: nothing
  // of its home — Hermes's login is in the person's profile, the task's state directory (HN-03).
  const claude = provider === 'claude';
  const credentialHome = owner && claude ? claudeConfigDir(owner.home) : null;
  const keyFile = owner && owner.authMode === 'api_key' ? [join(owner.home, CLAUDE_KEY_FILE)] : [];
  return {
    id,
    cwd: input.cwd,
    writeCwd: write,
    writable: write ? (c?.allowWrite ?? []) : [],
    readable: [...(c?.allowRead ?? []), ...(input.attachments ?? []).map((a) => a.path), ...keyFile],
    readOnlyInside: c?.denyWrite ?? [],
    denied: c?.denyRead ?? [],
    ...(credentialHome ? { credentialHome } : {}),
    egress: withAllowance(egressPolicy(provider, input, policy), allowance),
    mcpUrl: input.mcp.url,
    ...(policy.limits ? { limits: policy.limits } : {}),
  };
}

/**
 * The provider credential of a managed live turn (docs/decisions/managed-providers.md PV-04; one-person.md OP-09): the
 * person's sign-in or API key for the agent's provider — every turn's, the ones outsiders' input starts included —
 * checked against the eligibility policy (PI when they asked, NA for their automations), the pinned runtime (drift) and
 * the sign-in's own state. Anything else is refused with the reason the agent says; nothing ever falls back to the
 * host user's login.
 */
export async function managedTurnCredential(
  policy: ManagedPolicy,
  ctx: DispatchContext,
  provider: string,
): Promise<
  | { ok: true; credential: TurnCredential; owner: CredentialOwner }
  | { ok: false; refusal: string; code: string; outcome: ManagedOutcome | null }
> {
  if (provider !== 'claude' && provider !== 'codex')
    return {
      ok: false,
      refusal: outcomeCopy('not_signed_in', 'claude'),
      code: 'provider.not_signed_in',
      outcome: null,
    };
  if (!policy.credentialsRoot)
    return {
      ok: false,
      refusal: outcomeCopy('not_signed_in', provider),
      code: 'provider.not_signed_in',
      outcome: 'not_signed_in',
    };
  const drift = provider === 'claude' ? ((await policy.drift?.(provider)) ?? null) : null;
  const result = await resolveTurnCredential({
    root: policy.credentialsRoot,
    provider,
    trigger: ctx.dispatch.trigger,
    drift,
  });
  if (!result.ok) {
    const outcome = OUTCOME_OF[result.state] ?? null;
    return {
      ok: false,
      refusal: result.explanation,
      code: result.code,
      outcome:
        outcome === 'version_drift' && drift && !drift.ok && drift.reason === 'missing'
          ? 'provider_missing'
          : outcome,
    };
  }
  const c = result.credential;
  return {
    ok: true,
    credential: c,
    // What the sandbox needs of the person (their home is the task's one writable home).
    owner: {
      account: 'person',
      provider: c.provider,
      authMode: c.authMode === 'api_key' ? 'api_key' : 'subscription',
      home: c.home,
    },
  };
}

/** The sandbox's outcome code of a credential state (`gated` has none: it's a policy refusal). */
const OUTCOME_OF: Partial<Record<string, ManagedOutcome>> = {
  not_signed_in: 'not_signed_in',
  auth_expired: 'auth_expired',
  auth_revoked: 'auth_expired',
  quota_exhausted: 'quota_exhausted',
  outage: 'provider_outage',
  version_drift: 'version_drift',
};

/** After a turn: what it said about its credential (quota, revoked, expired, outage), or cleared after success. */
export async function recordCredentialOutcome(
  credential: TurnCredential,
  outcome: { ok: true } | { ok: false; state?: RunSignalState; until?: string },
): Promise<void> {
  if (!outcome.ok && !outcome.state) return;
  await recordRunSignal(
    credential.home,
    outcome.ok ? null : { state: outcome.state as RunSignalState, until: outcome.until ?? null },
  ).catch(() => {});
}

/** Claude Code's drift checks, cached for ten minutes (an update replaces the binary and restarts us anyway). */
export function cachedDrift(
  check: (provider: 'claude') => Promise<DriftResult>,
  ttlMs = 10 * 60_000,
): (provider: 'claude') => Promise<DriftResult | null> {
  const cache = new Map<string, { at: number; result: Promise<DriftResult> }>();
  return async (provider) => {
    const hit = cache.get(provider);
    if (!hit || Date.now() - hit.at > ttlMs) cache.set(provider, { at: Date.now(), result: check(provider) });
    const result = await (cache.get(provider)?.result as Promise<DriftResult>);
    return result.ok ? null : result;
  };
}

/**
 * Where a usage probe runs on a managed appliance (docs/decisions/ui-improvements.md UI-R05): a task sandbox of its
 * own, like a turn's — the person's home the only writable home (Claude: its `config/`; ChatGPT: their Hermes profile,
 * where Hermes may refresh the login, with Hermes's install readable), network only to the provider's endpoints, a
 * throwaway working directory in the runner's private scratch space. No sandbox: no probe (never the CLI outside one on
 * a home a turn can write, SUB-41).
 */
export function managedUsageHost(
  policy: () => ManagedPolicy | null,
): (job: UsageHostJob) => Promise<UsageProbeHost> {
  return async (job) => {
    const sandbox = policy()?.sandbox;
    if (!sandbox) throw new Error('this appliance has no task sandbox');
    const root = runnerTmpRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await privateDir(root);
    const cwd = await mkdtemp(join(root, 'usage-'));
    let session: Awaited<ReturnType<TaskSandboxes['open']>>;
    try {
      session = await sandbox.open({
        id: `usage_${randomBytes(6).toString('hex')}`,
        cwd,
        writeCwd: true,
        ...(job.provider === 'claude'
          ? { credentialHome: claudeConfigDir(job.home) }
          : { stateDirs: [job.home], env: { HERMES_HOME: job.home } }),
        ...(job.installs?.length ? { installs: job.installs } : {}),
        egress: { allow: [...(PROVIDER_ENDPOINTS[job.provider] ?? [])] },
        ...(policy()?.limits ? { limits: policy()?.limits } : {}),
      });
    } catch (err) {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return {
      cwd,
      spawn: (command, args, options) => session.spawn(command, args, options),
      close: async () => {
        await session.close().catch(() => {});
        await rm(cwd, { recursive: true, force: true }).catch(() => {});
      },
    };
  };
}
