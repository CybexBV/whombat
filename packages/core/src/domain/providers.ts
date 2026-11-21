/**
 * AI providers on the host (docs/decisions/agent-setup.md): whether the runner found Claude Code installed and logged
 * in and ChatGPT ready, what a new agent uses by default, and what a person does to fix one that isn't. The provider id
 * `codex` is ChatGPT (2.1, CT-1450): its turns run on Hermes's own loop and it needs nothing installed.
 */
import { z } from 'zod';
import { AgentProvider } from './agent.js';
import { Timestamp } from './common.js';
import type { LocalModelView } from './local-model.js';
import { ProviderModels } from './models.js';

/**
 * The providers the runner checks one by one (Claude Code, ChatGPT): one row each in the AI provider panel, each signed
 * in to per person. ChatGPT is ready whenever Hermes is (Whombat hermes-native.md HN-C07). The local model (`local`)
 * needs no CLI and no sign-in.
 */
export const LIVE_PROVIDERS = ['claude', 'codex'] as const;
export const LiveProvider = z.enum(LIVE_PROVIDERS);
export type LiveProvider = z.infer<typeof LiveProvider>;

export const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  codex: 'ChatGPT',
  local: 'Custom AI model',
};

/** What the runner found: `missing` (not installed / not on its PATH), `logged_out`, or another `error`. */
export const ProviderState = z.enum(['ready', 'logged_out', 'missing', 'error']);
export type ProviderState = z.infer<typeof ProviderState>;

export const ProviderCheck = z.object({
  provider: LiveProvider,
  state: ProviderState,
  /**
   * `2.1.278 (Claude Code)` when ready. ChatGPT's is the runner's engine (`Hermes 0.22.5`), which people never read
   * (`providerStateLabel` says “Ready”).
   */
  version: z.string().max(120).nullable(),
  /** Why it isn't ready, as the CLI said it. */
  detail: z.string().max(500).nullable(),
  /**
   * The models it offers, as the tool lists them without a sign-in (0.77, CT-333; Whombat model-effort.md ME-04).
   * Absent: the tool didn't list them.
   */
  models: ProviderModels.optional(),
});
export type ProviderCheck = z.infer<typeof ProviderCheck>;

/**
 * Whether the OS sandbox guarded agents run in works on the host (S-13). A managed appliance reads it too: a provider
 * whose sandbox can't run is not offered (`ProviderSetup.sandboxProblem`).
 */
export const SandboxCheck = z.object({ ok: z.boolean(), detail: z.string().max(500) });
export type SandboxCheck = z.infer<typeof SandboxCheck>;

/* Hermes (Whombat hermes-engine.md HE-01, HE-10) ---------------------------------------------------------------- */

/**
 * Why Hermes, the engine every turn runs on, isn't ready on this Whombat (CT-1160): `missing` — not where the runner
 * looks for it (`WHOMBAT_HERMES_BIN`); `outdated` — not the version this Whombat was built with (HE-10 pins it);
 * `broken` — it is there but doesn't start or answer; `storage` — the folder the people's Hermes profiles live in
 * (`WHOMBAT_HERMES_ROOT`) can't be written. People never read the engine's name: `ENGINE_PROBLEM_COPY` says it.
 */
export const HERMES_PROBLEMS = ['missing', 'outdated', 'broken', 'storage'] as const;
export const HermesProblem = z.enum(HERMES_PROBLEMS);
export type HermesProblem = z.infer<typeof HermesProblem>;

/** Hermes as the runner found it, beside the CLIs' checks: ready or not, its version and why not. */
export const HermesCheck = z.object({
  ready: z.boolean(),
  /** `0.22.5`, as Hermes reported it; null when it didn't (not installed, didn't start). */
  version: z.string().max(120).nullable(),
  /** Why it isn't ready; null when it is. */
  problem: HermesProblem.nullable(),
  /** What it said, for the runner's log and Whombat's support (never shown to people as it is). */
  detail: z.string().max(500).nullable(),
});
export type HermesCheck = z.infer<typeof HermesCheck>;

/** What a runner reports about its host in its heartbeats. */
export const RunnerStatus = z.object({
  /** Hermes, which runs every turn (CT-1160). */
  hermes: HermesCheck,
  /** One check per CLI. */
  providers: z.array(ProviderCheck).max(LIVE_PROVIDERS.length),
  sandbox: z.object({ claude: SandboxCheck.optional(), codex: SandboxCheck.optional() }).optional(),
  checkedAt: Timestamp,
});
export type RunnerStatus = z.infer<typeof RunnerStatus>;

/** A provider as Settings and onboarding show it: `unknown` until a runner has reported. */
export const ProviderSetup = z.object({
  provider: LiveProvider,
  state: z.union([ProviderState, z.literal('unknown')]),
  version: z.string().nullable(),
  detail: z.string().nullable(),
  /** The guarded sandbox can't run on the host (only said for a ready provider). */
  sandboxProblem: z.string().nullable(),
  /**
   * The models an agent can pick for it (0.77, CT-333), once a runner has listed them. Absent: not known (older
   * runtimes and runners): Configure offers only the default then.
   */
  models: ProviderModels.optional(),
});
export type ProviderSetup = z.infer<typeof ProviderSetup>;

/** `host.agents`: can the agent on this Whombat reply, and with what. */
export const AgentSetupStatus = z.object({
  runner: z.object({
    /** A runner has been in touch within the last two minutes. */
    connected: z.boolean(),
    seenAt: Timestamp.nullable(),
  }),
  /** Hermes as the connected runner last reported it (CT-1160); null until one has. */
  hermes: HermesCheck.nullable(),
  /** Claude Code, then ChatGPT. */
  providers: z.array(ProviderSetup),
  /** What a new agent uses when nobody picks (`defaultAgentProvider`). */
  defaultProvider: AgentProvider,
  /** When the runner last checked the providers. */
  checkedAt: Timestamp.nullable(),
  /** A re-check was asked for and the runner hasn't answered yet. */
  recheckPending: z.boolean(),
});
export type AgentSetupStatus = z.infer<typeof AgentSetupStatus>;

/**
 * A new agent's provider when nobody picks one: the first ready provider (Claude Code, then ChatGPT), else Claude Code
 * so it works once that is set up.
 */
export function defaultAgentProvider(
  providers: readonly Pick<ProviderSetup, 'provider' | 'state'>[],
): AgentProvider {
  for (const p of LIVE_PROVIDERS)
    if (providers.some((c) => c.provider === p && c.state === 'ready')) return p;
  return 'claude';
}

type RunnableStatus = Pick<AgentSetupStatus, 'runner' | 'hermes' | 'providers'>;

/** The burrow's model on its network (`Burrow.localModel`), as far as these checks read it. */
type LocalModelSet = Pick<LocalModelView, 'model'> | null | undefined;

/** Whether turns can run at all: a runner is connected and Hermes is ready there. */
export function engineReady(status: Pick<AgentSetupStatus, 'runner' | 'hermes'>): boolean {
  return status.runner.connected && status.hermes?.ready === true;
}

/**
 * Whether an agent configured for `provider` gets its turns run on this Whombat right now: `local` once the burrow has
 * a model on its network (`localModel`, `Burrow.localModel`), Claude Code and ChatGPT once the runner says they're
 * ready.
 */
export function providerRunnable(
  status: RunnableStatus,
  provider: AgentProvider,
  localModel?: LocalModelSet,
): boolean {
  if (!engineReady(status)) return false;
  if (provider === 'local') return !!localModel;
  return status.providers.some((p) => p.provider === provider && p.state === 'ready');
}

/**
 * The agent can reply: a runner is connected, Hermes is ready there, and a CLI is ready or the burrow has a model on its
 * network (`localModel`).
 */
export function agentsCanReply(status: RunnableStatus, localModel?: LocalModelSet): boolean {
  if (!engineReady(status)) return false;
  return !!localModel || status.providers.some((p) => p.state === 'ready');
}
