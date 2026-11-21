/**
 * The agent turn contract. The runner builds a TurnInput from a DispatchContext and asks the provider — Hermes
 * (`HermesProvider`, hermes-engine.md HE-01) — to run a single turn; it streams TurnEvents.
 * Agents change Whombat only through the Whombat MCP server (`mcp`), never through this stream: the
 * stream is for progress, the final reply text and failures.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEffort, FastSkippedReason, ProviderModel } from '@whombat/core';
import type { DispatchContext } from '@whombat/core/contracts';
import type { Confinement } from './access';
import type { ProviderKind } from './index';
import type { TurnCredential } from './providers/turn-credential';
import type { RunSignalState } from './providers/types';
import type { UsageObservation } from './usage/types';

export type Sandbox = 'read-only' | 'workspace-write';

/** What the runner knows about the host for one turn. */
export interface TurnHost {
  /** Where the task sandbox draws its lines (`sandboxTask`). */
  confinement?: Confinement;
  /**
   * Extra environment for the agent: its commit identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`); a worktree's git finds its
   * workspace repo through its `.git` file.
   */
  env?: Record<string, string>;
  /**
   * Managed appliance (MA-10): the provider's per-identity credential home
   * (`WHOMBAT_CREDENTIALS_ROOT/<identity>/<provider>`, `credentials.ts`) instead of the host user's login: Claude's
   * `CLAUDE_CONFIG_DIR`. A ChatGPT login is Hermes's own, in the person's profile (hermes-native.md HN-03).
   */
  credentialHome?: string;
  /**
   * How the provider's processes start (docs/decisions/managed-sandbox.md MSB-01): inside the task's enforced sandbox
   * (`SandboxSession.spawn`), provider and tools together; the runner sets it for every turn. Absent: a process group on
   * the host (the provider's own unit tests).
   */
  spawn?: ProcessSpawner;
}

/** Starts a provider process (the leader of everything it starts) with piped stdio. */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface TurnInput {
  /** Everything the server told the runner about this dispatch. */
  context: DispatchContext;
  /** The user-turn text: the per-turn preface and the triggering message(s) (`turnPrompt`, HE-34). */
  prompt: string;
  /** Whombat MCP server the agent must use for every action. */
  mcp: { url: string; token: string };
  /** Working directory: a prepared git worktree for coding work, the agent's work folder, else an empty directory. */
  cwd: string;
  /** Derived from the agent's keys (write key on the branch → workspace-write). */
  sandbox: Sandbox;
  /** Derived from keys (`web.browse`). */
  network: boolean;
  /** Provider model id; provider default when omitted. */
  model?: string;
  /**
   * How hard the model thinks in this turn (Whombat model-effort.md ME-02, ME-03): Claude Code's `--effort`, Codex's
   * `turn/start` `effort`. The runner sets it with `turnEffort` — the agent's own, else automatic for the kind of turn,
   * kept within what the turn's model takes by the runner's model list; null: none is sent (the model takes none).
   * Absent: the provider works it out from the context alone (`turnEffortOf`).
   */
  effort?: AgentEffort | null;
  /**
   * Fast replies in this turn (Whombat chat-runtime.md CR-06): true asks for them (Claude Code's `fastMode` flag
   * setting, Codex's `priority` service tier), false asks for the standard speed (it turns a model's default `on` off).
   * The runner sets it with `turnFast` — the agent's (or the Chat thread's) `fast`, only where the turn's model offers
   * fast replies by the runner's list. Null or absent: nothing is sent, the model's own default applies. Per turn: never
   * part of the session (a resumed session takes another speed with its next turn).
   */
  fast?: boolean | null;
  /** Resume an earlier provider session (Claude session id / Codex thread id). */
  resumeSessionId?: string;
  /**
   * When `resumeSessionId` is gone on this host — Codex: no rollout file for it any more (docs/decisions/box-health.md
   * BH-08) — start a fresh session in this turn instead of failing. Only for a turn whose prompt carries its whole
   * context (a run, a thread's first turn); a resumed chat turn, which holds only what is new since the session's last
   * turn, fails as before and the server retries it on a fresh session with the whole window (bp-memory.md BP-B17).
   */
  freshIfSessionGone?: boolean;
  /** Recover a missing answer from this session's existing findings; its tool policy blocks every tool. */
  replyOnly?: boolean;
  /** Host details for the environment and the sandbox. */
  host?: TurnHost;
  /**
   * Attachments the runner fetched for this turn (Workstream A). Providers send `image`s as image input when
   * `capabilities().images` is true; everything else is described in the prompt and readable at `path`.
   */
  attachments?: TurnAttachment[];
  /**
   * The person's provider credential for this turn (`resolveTurnCredential`, managed-providers.md PV-04). When set, the
   * provider's login comes from it alone: nothing from the runner's environment, the operator's `~/.claude` / `~/.codex`
   * or `WHOMBAT_PROVIDER_ENV`. Absent: the turn signs in to nothing (a gateway turn, a model on the person's network, the
   * scripted Hermes).
   */
  credential?: TurnCredential;
  /**
   * The turn runs in the person's pod (docs/decisions/hermes-native.md HN-W01…HN-W04; one-person.md OP-S84): one
   * Hermes, kept running across turns; the runner admitted the turn there and routes its own things by the Hermes session it names.
   */
  pod?: TurnPod;
  /**
   * Same-person follow-ups for the running turn (docs/decisions/steering.md): only for a provider whose capabilities
   * say `steering`. Absent: the turn takes none, and each follow-up runs as its own turn.
   */
  steering?: TurnSteering;
  /**
   * A turn through the burrow's AI gateway (Whombat ai-gateway.md AIG-07, AIG-10): the CLI sends its model requests to
   * `gateway.baseUrl` with the dispatch's agent token (the MCP token, `WHOMBAT_MCP_TOKEN`) as its key, and nobody's
   * sign-in is used — `credential` is absent, and the provider takes no login from the runner's environment, the
   * operator's settings or `WHOMBAT_PROVIDER_ENV`.
   */
  gateway?: TurnGateway;
  /**
   * The turn's browser (Whombat hermes-engine.md HE-42; one-person.md OP-S113): Hermes's browser tools drive the agent's
   * Chromium through the runner's CDP relay. Absent: no browser this turn, and Hermes's browser tools are off.
   */
  browser?: TurnBrowserAccess;
  /**
   * A model on the person's network (`local`, HE-32): the URL the turn reaches it at — its base URL, or in a managed turn
   * the one the sandbox's egress allowance opened (`endpointAllowance`: a local name by its address). Absent: its base
   * URL as the person set it.
   */
  modelEndpoint?: string;
  /**
   * Asks the turn's person about one tool call a key at Ask holds back (hermes-engine.md HE-44): Hermes's hook asked,
   * Hermes's approval gate sent `session/request_permission`, and the runner puts a card in front of the person and
   * waits for the answer (or says no when nobody answers in time, or the turn stops: `signal`). Absent: nobody can be
   * asked, so the call doesn't run.
   */
  askPerson?: (ask: ToolAsk, signal: AbortSignal) => Promise<ToolAskAnswer>;
  /**
   * The turn person's Vault MCP entries switched on for the agent (contracts CT-1241, hermes-engine.md HE-S154): Hermes's
   * MCP servers for this turn only, at the address the turn's egress allowance opened. Absent: none.
   */
  vaultMcpServers?: TurnVaultMcpServer[];
}

/** One Vault MCP server of a turn (`VaultMcpServer`): `vault_<entry key>`, its address, sign-in and tools on. */
export interface TurnVaultMcpServer {
  name: string;
  url: string;
  headers: { name: string; value: string }[];
  tools: string[];
}

/** One tool call a key at Ask holds back (`TurnInput.askPerson`). */
export interface ToolAsk {
  /** The key it needs: “Browse the web”, “Use a web browser”. */
  keyId: 'web.browse' | 'browser.use';
  /** The tool as the engine names it (`web_search`, `WebFetch`, `browser_navigate`). */
  tool: string;
  /** What the call looks at, its URL(s) or query, at most 300 characters; '' when it doesn't say. */
  detail: string;
  /** The plugin's id of this ask: where the agent's words go when it doesn't run (`whombat-asks/<id>`). */
  id?: string;
}

/** A person's answer to a `ToolAsk`, and why, in Whombat's words (logged with the tool event). */
export interface ToolAskAnswer {
  allow: boolean;
  reason: string;
  /** What the agent reads when it didn't run (`commandDeclinedText`, the timeout's words); absent: a plain no. */
  message?: string;
}

/** How a turn's browser is reached (HE-S137). */
export interface TurnBrowserAccess {
  /** The relay's address for Hermes (`browser.cdp_url`): the sandbox's bridge (`SANDBOX_BROWSER_ORIGIN`). */
  cdpUrl: string;
  /** Only these sites (a Feedback assessment's look at the reported website, HE-S140); null: what the commands reach. */
  sites: readonly string[] | null;
  /**
   * The website logins of the person the turn is for (HE-S141), without a secret: Hermes's credential vault lists them
   * for this turn and asks the runner's logins service for a password when it fills one. Absent or empty: none.
   */
  logins?: readonly TurnLogin[];
}

/** A login of the turn's person as Hermes's vault lists it (contracts' `DispatchLogin`): never a secret. */
export interface TurnLogin {
  entryId: string;
  name: string;
  /** The origin of its sign-in page (`https://github.com`): Hermes fills it only there. */
  origin: string;
  username: string;
  /** It has a one-time-code seed: the runner gives the current code with the password. */
  otp: boolean;
}

/** How a provider reaches the burrow's AI gateway in one turn (AIG-10). */
export interface TurnGateway {
  /** The gateway connection's name (“Fusebox”): Codex's name for the model provider. */
  name: string;
  /**
   * Where the CLI sends its model requests: the sandbox's bridge (`SANDBOX_GATEWAY_ORIGIN`) plus `/ai-gateway/claude`
   * (Claude Code's Anthropic base URL) or `/ai-gateway/codex/v1` (Codex's Responses base URL).
   */
  baseUrl: string;
  /**
   * The gateway's home for this provider (`gatewayHomePath`, 0700): Claude Code's config dir is its `config/`; ChatGPT's
   * stays empty (Hermes's own loop calls the relay, HN-02). Never a person's.
   */
  home: string;
}

/**
 * A follow-up the runner adds to the running turn (docs/decisions/steering.md SX-03): the same person wrote again in the
 * same conversation and thread while the agent worked on their request.
 */
export interface TurnSteer {
  /** The runner's id for it (the message's id); the provider says `steered` with it once the session took it. */
  id: string;
  /** The follow-up for the model, rendered like the turn's request. */
  prompt: string;
  /** Its files the runner fetched and checked, delivered as a trigger's are (`TurnInput.attachments`). */
  attachments?: TurnAttachment[];
}

/**
 * Where a provider that can steer takes follow-ups from while its turn runs (steering.md SX-04). The provider calls
 * `open` once it can write into the running session; `take` then gets every follow-up, those that came before
 * included, in order, and answers false when the turn can't take one any more (it is ending: that follow-up runs as its
 * own turn). The provider reports each one it delivered with a `steered` event and answers it before the turn ends;
 * it calls `close` when the turn is over.
 */
export interface TurnSteering {
  open(take: (steer: TurnSteer) => boolean): void;
  close(): void;
}

/** One attachment on disk for a turn: bytes the runner fetched and checked (size, sha256). */
export interface TurnAttachment {
  id: string;
  name: string;
  /** Sniffed media type, e.g. `image/png`, `text/plain`, `application/pdf`. */
  mediaType: string;
  size: number;
  kind: 'image' | 'text' | 'document' | 'file';
  /** Absolute path of the runner-owned copy, readable by the provider for this turn only. */
  path: string;
}

/**
 * What a provider can do, shown in the AI provider panel's capability matrix and used by the runner to
 * decide how to deliver attachments and sessions. `false` means unsupported, never "maybe".
 */
export interface ProviderCapabilities {
  /** Image input as model content (not a file path). */
  images: boolean;
  /** PDF documents as model content. */
  documents: boolean;
  /** Resume an earlier provider session. */
  sessionResume: boolean;
  /** Stop a turn mid-way (interrupt / cancel) before killing the process group. */
  cancel: boolean;
  /** Reports token usage. */
  usage: boolean;
  /**
   * Takes follow-ups into a running turn (`TurnInput.steering`, docs/decisions/steering.md). Not in the AI provider
   * panel's matrix (the contract's `ProviderCapabilities`); absent: no.
   */
  steering?: boolean;
}

/**
 * What kind of tool a provider says a call is, from its own fields (Claude's tool name, Codex's item type and
 * command actions, ACP's `kind`), so the runner doesn't have to guess from names (work-supervision WS-11).
 */
export type ToolCategory =
  | 'read'
  | 'edit'
  | 'command'
  | 'search'
  | 'web'
  | 'delegate'
  /** An MCP tool: Whombat's own (`name` is its bare name) or another server's. */
  | 'mcp'
  | 'other';

/** Longest output tail a provider keeps on a `tool_result` (the runner redacts and bounds it again). */
export const TOOL_OUTPUT_TAIL = 8000;

/**
 * A finished tool call's outcome as the provider reported it. Nothing is inferred from output text: `exitCode` is
 * set only when the provider gave one, `error` only when it said the call failed, was declined or cancelled.
 */
export interface ToolOutcome {
  exitCode?: number;
  error?: 'error' | 'denied' | 'cancelled';
  /** The tail of what the tool returned (≤ TOOL_OUTPUT_TAIL chars), unredacted: the runner redacts it. */
  output?: string;
  /** A Whombat MCP tool's structured result (its commit outcome: `ok`, `pending_approval`, `blocked`). */
  structured?: Record<string, unknown>;
}

/** Fields every tool event may carry (all optional: older providers and test doubles send none). */
export interface ToolEventIds {
  /** The provider's own id of the call (Claude `tool_use.id`, Codex `item.id`, ACP `toolCallId`). */
  id?: string;
  /** The call a subagent made this one in (Claude `parent_tool_use_id`). */
  parentId?: string;
}

export type TurnEvent =
  /** Provider session id, so a paused run can resume on the same session. */
  | { type: 'session'; sessionId: string }
  /** Still working: keeps "{name} is thinking" alive. */
  | { type: 'thinking' }
  | { type: 'text_delta'; text: string }
  | ({
      type: 'tool_call';
      name: string;
      input: unknown;
      category?: ToolCategory;
      /** Paths the provider says the call touches (ACP `locations`, Codex file changes / read actions). */
      paths?: string[];
    } & ToolEventIds)
  | ({ type: 'tool_result'; name: string; ok: boolean; outcome?: ToolOutcome } & ToolEventIds)
  /**
   * A permission the provider asked for and Whombat's policy answered (Claude `can_use_tool`, an ACP
   * `session/request_permission`, a Codex approval request): `id` is the call it was asked for, when the provider
   * named one.
   */
  | ({ type: 'permission'; tool: string; allowed: boolean; reason?: string; target?: string } & ToolEventIds)
  /**
   * What the provider said about its subscription's usage windows during the turn (Claude `rate_limit_event`, Codex
   * `account/rateLimits/updated`; docs/decisions/ui-improvements.md UI-R03). Sparse: the runner merges readings.
   */
  | { type: 'rate_limits'; usage: UsageObservation }
  /**
   * How fast the turn's model calls ran, as the tool said at the end of the turn (chat-runtime.md CR-07, CR-08): `fast`
   * whether they ran fast; `skipped` why not, only when the turn asked for fast replies (`TurnInput.fast` true). Claude
   * Code says so in its result (`fast_mode_state`, `fast_mode_disabled_reason`) and its credits notice; Codex says
   * nothing (the runner reports what was asked). The last one of a turn counts.
   */
  | { type: 'speed'; fast: boolean; skipped?: FastSkippedReason }
  /**
   * The reply to post unless that same text was already delivered through MCP. A turn that took a follow-up (`steered`) after
   * it had answered may give another: each is the answer so far, `usage` the turn's total so far.
   */
  | { type: 'final'; text: string; usage?: TurnUsage }
  /**
   * The turn's answer is complete — its last `final` stands — and what the provider still does is its own upkeep (Hermes's
   * memory and skill review after a Claude Code turn, hermes-engine.md HE-S20): the runner posts the answer now rather
   * than when the turn ends. Follow-ups are no longer taken.
   */
  | { type: 'answered' }
  /**
   * The running session took a follow-up (`TurnSteer.id`, docs/decisions/steering.md): it is in the conversation now and
   * the provider answers it before the turn ends. What came before it was the answer to what came before.
   */
  | { type: 'steered'; id: string }
  | {
      type: 'error';
      message: string;
      retryable: boolean;
      /** What the failure says about the credential (quota, revoked, expired, outage), for its state (PV-05). */
      credentialState?: RunSignalState;
      /** Until when that state holds, when the provider said (a subscription's usage limit resets), ISO. */
      credentialUntil?: string;
      /**
       * The provider's own code for the failure, when it gave one: Claude Code's `assistant.error` (`model_not_found`,
       * `rate_limit`, …), Codex's `codexErrorInfo` (`badRequest`, `other`, …). Read with the message (`modelRefused`).
       */
      code?: string;
    };

/**
 * What a turn's model calls used, as the provider bills them (docs/decisions/prompt-efficiency.md PE-04). Every call
 * resends the system prompt, the tools and the history, so a turn is the sum of its calls; how much of that came from
 * the provider's prompt cache decides what it costs, and the largest single call is how full the context got.
 */
export interface TurnUsage {
  /** All input tokens of the turn's calls: uncached, written to the cache and read from it. */
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, read from the prompt cache (billed at about a tenth). Absent: the provider didn't say. */
  cacheReadTokens?: number;
  /** Of `inputTokens`, written to the prompt cache (Claude bills them at 1.25×; Codex reports none). */
  cacheWriteTokens?: number;
  /** The largest single call's input: the context the turn reached (session rotation, the checkpoint nudge). */
  largestCallInputTokens?: number;
  costUsd?: number;
}

/** `available()`: ready with a version, or why not (`kind`, else `unavailableKind` of the reason). */
export type Availability =
  | { ok: true; version: string }
  | { ok: false; reason: string; kind?: 'missing' | 'logged_out' | 'error' };

/** Why a provider is unavailable, from its reason when it didn't say: not installed, not logged in, other. */
export function unavailableKind(result: { reason: string; kind?: 'missing' | 'logged_out' | 'error' }) {
  if (result.kind) return result.kind;
  if (/ENOENT|not found|no such file|executable/i.test(result.reason)) return 'missing';
  if (/not logged in|log ?in|authenticat|unauthori[sz]ed|api key/i.test(result.reason)) return 'logged_out';
  return 'error';
}

/** A provider that supports nothing optional (test doubles, and the base the others extend). */
export const BASIC_CAPABILITIES: ProviderCapabilities = Object.freeze({
  images: false,
  documents: false,
  sessionResume: false,
  cancel: true,
  usage: false,
});

/**
 * What a provider adds to its turn's managed task sandbox besides what the runner gives every turn (a Hermes profile,
 * the CLI Hermes starts, the MCP bridge): hermes-engine.md HE-S18.
 */
/** A turn's place in its person's pod (hermes-native.md HN-W01…HN-W04; the runner's `PodManager`). */
export interface TurnPod {
  /** Whombat's MCP endpoint as Hermes reaches it inside the pod (each session's bridge gets the turn's token). */
  readonly mcpUrl: string | undefined;
  /** The pod's spare `hermes acp`, the session's folder `cwd` made as an empty placeholder there (HN-W02, HN-W03). */
  spawnAcp(cwd: string): ChildProcessWithoutNullStreams;
  /** The Hermes session the turn runs in: its commands, logins, browser and model requests reach this turn (HN-W04). */
  bind(session: string): void;
}

/**
 * What a provider's pod holds for the turn's person (hermes-native.md HN-W03), fixed for the pod's life: two turns whose
 * needs are the same share a pod. Never a token, a Vault value or a turn's path.
 */
export interface PodNeeds {
  /** The profile (`HERMES_HOME`) the pod serves: its only writable state. */
  profile: string;
  /** `hermes` (absolute, inside one of `installs`). */
  bin: string;
  installs: string[];
  readable: string[];
  path: string[];
  env: Record<string, string>;
  /**
   * The variables the turn's sign-in brings (Claude's config home): part of the pod's credential, which a turn with
   * another sign-in waits to replace while the pod is idle (HN-W03). Never a secret.
   */
  credentialEnv: Record<string, string>;
  /** Paths inside the profile its Hermes never sees (the runner's own folders in the root, one-person.md OP-08). */
  denied?: string[];
}

export interface SandboxNeeds {
  /** Directories the provider keeps its own state in (a Hermes profile): writable, whatever the working directory. */
  stateDirs?: string[];
  /** Installs it runs besides its own command (read-only). */
  installs?: string[];
  /** Files and directories it reads (read-only). */
  readable?: string[];
  /** Paths inside the state directories it never sees (the runner's own folders in the Hermes root, OP-08). */
  denied?: string[];
  /** Variables its processes get inside, set after the sandbox's allowlist: the runner's own values, never a secret. */
  env?: Record<string, string>;
  /** Folders put first on its `PATH` inside (where a Hermes environment keeps agent-browser, HE-S300). */
  path?: string[];
}

/** How the runner asks a provider for its models (`AgentProvider.listModels`). */
export interface ModelListRequest {
  /** The executable a turn would run (the installed client); default the provider's own. */
  executable?: string;
  /** Where the throwaway home is made (default the system's temporary directory). */
  tmpRoot?: string;
  timeoutMs?: number;
}

export interface AgentProvider {
  readonly kind: ProviderKind;
  /** Checks the CLI/SDK is installed and logged in; used by the runner before claiming work. */
  available(): Promise<Availability>;
  /** What this provider supports (static per provider instance). */
  capabilities(): ProviderCapabilities;
  /**
   * What its turn's task sandbox must also hold (`SandboxNeeds`), asked once the turn's commands are set up and
   * before the sandbox opens; the provider may prepare those directories here. Providers that need nothing omit it.
   */
  sandboxNeeds?(input: TurnInput): Promise<SandboxNeeds>;
  /**
   * The turn runs in its person's pod instead of a task sandbox of its own (hermes-native.md HN-W01): what the pod holds
   * (`PodNeeds`); null when this turn has a task sandbox of its own (a Feedback assessment, HN-W14). Providers without
   * pods omit it.
   */
  podNeeds?(input: TurnInput): Promise<PodNeeds | null>;
  /**
   * The models the tool offers, as it lists them itself without a sign-in, a network call or a model call (Whombat
   * model-effort.md ME-04). Null when it didn't list them; never throws. Providers that have no models omit it.
   */
  listModels?(options?: ModelListRequest): Promise<ProviderModel[] | null>;
  /**
   * Runs one turn. Must stop promptly and kill the whole process group when `signal` aborts
   * (pause, take over, cancel, runner shutdown).
   */
  runTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<TurnEvent>;
}
