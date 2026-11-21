/**
 * HermesProvider (docs/decisions/hermes-engine.md HE-01, HE-32, HE-37; hermes-native.md HN-02; one-person.md OP-08,
 * OP-17): every turn, on Hermes Agent's own loop over ACP, in the person's profile — or, for a turn outsiders' input
 * started, in the outsiders' profile (`_feedback`: no memory, no Vault, never the person's pod). A subscription turn
 * runs on the person's own sign-in — Claude through the bundled Nous
 * DirectSDK provider, ChatGPT through Hermes's `openai-codex` provider on the login Hermes keeps in the profile — and
 * any other through its own source: the person's API key, the burrow's AI gateway, a model on the home network
 * (`local`; `own-loop.ts`). A Feedback assessment is read-only (`assessment.ts`, HE-36). One `hermes acp` per turn
 * (`acp/connection.ts`, `events.ts`, `permissions.ts`):
 *
 *   the person's profile lock → `config.yaml`, `SOUL.md` and `whombat.md` from the turn's context → spawn `hermes acp`
 *   (inside the task sandbox) with `HERMES_HOME` = the profile, Claude's sign-in home, the commands' launcher →
 *   `initialize` → `session/resume` | `session/load` | `session/new` with Whombat's MCP as a stdio bridge →
 *   `session/prompt` → `session/update`s → stop reason → the whole process group killed (Hermes's per-profile gateway
 *   daemon with it).
 *
 * - Sessions (HE-18): one Chat thread is one Hermes session; its id is reported as `hermes:<id>` where the provider
 *   session is stored, and resumed next turn (Hermes replays the conversation on resume and load: dropped, history).
 *   A resumed session runs on the turn's provider and model (hermes-native.md HN-07, `sessionFit`): another model is set
 *   with `session/set_model` before the prompt; a session on another provider isn't used (the turn fails for the
 *   server's fresh retry with the whole window, BP-B17, or starts a new session when its prompt carries it all).
 * - Permission requests: Whombat's tool policy (`decidePermission`), the walls being the commands' wrapper and the managed
 *   sandbox (HE-S22); Hermes's questions to a person (`clarify`) and model switches are declined (but the one Whombat
 *   asks for itself, HN-07) — the agent asks people in the conversation. Never `cancelled` for a no: Hermes would keep waiting for an answer.
 * - Stop: `session/cancel`, a grace for the prompt to end `cancelled`, then the group is killed. A turn Hermes lost
 *   that way is discarded before the next prompt (`/discard`, HE-S25).
 * - Follow-ups of the turn's person (steering.md, HE-S24): `/steer <text>` into the running turn (Hermes's “Steer
 *   queued” notice is the delivery, never posted); one with files, or after the first prompt ended, is the session's
 *   next prompt, the answer before it going out first.
 * - After the answer, Hermes's memory and skill review: when the plugin marks one running (`HERMES_REVIEW_DIR`, HN-08)
 *   the turn says `answered` (the answer is posted at once) and waits up to 2 minutes for it to end before Hermes goes
 *   with the turn (HE-S20); without one the turn ends at once.
 * - In the person's pod (hermes-native.md HN-09, HN-W01…HN-W13; `input.pod`, the runner's `PodManager`): no profile lock
 *   and no Hermes start — the pod's gateway runs, its spare `hermes acp` is the turn's viewer. One session at a time per
 *   person is set up (the `config.yaml` a new session takes is the turn's); the session's own files (`whombat-turns/<id>`:
 *   its policy and logins) are written and the session is bound to the turn before the prompt; a resumed session gets
 *   the turn's effort and fast replies (`/reasoning`, `/fast`, HN-L11); Vault MCP servers are the session's own; the
 *   turn ends at its answer and the review carries on in the gateway (HN-W13).
 * - Usage: `session/prompt`'s own; a turn's prompts add up.
 * - A turn whose `hermes acp` died fails retryably; nothing Hermes says about the session before this turn's prompt is
 *   sent (a lost turn's late output) is part of the reply, and a retry loads the session afresh (`session/load`).
 */
import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LoadSessionResponse,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { MCP_SERVER_NAME } from '@whombat/core/contracts';
import { agentEnv } from '../access';
import { commandInstall, resolveCommand } from '../access/managed/sandbox';
import type { AcpNegotiated } from '../acp/capabilities';
import { ACP_PROTOCOL_VERSION, negotiatedFrom } from '../acp/capabilities';
import {
  type AcpEnded,
  type AcpProcess,
  endedAsError,
  initializeAcp,
  openAcpProcess,
  withTimeout,
} from '../acp/connection';
import { AcpEventMapper } from '../acp/events';
import {
  decidePermission,
  describeToolCall,
  type KnownToolCall,
  permissionResponse,
} from '../acp/permissions';
import { acpPromptContent } from '../acp/prompt';
import type {
  AgentProvider,
  Availability,
  PodNeeds,
  ProviderCapabilities,
  SandboxNeeds,
  ToolAsk,
  ToolAskAnswer,
  ToolCategory,
  TurnEvent,
  TurnInput,
  TurnPod,
  TurnSteer,
  TurnUsage,
  TurnVaultMcpServer,
} from '../contract';
import { HERMES_PROFILE_BUSY } from '../failures';
import type { ProviderKind } from '../index';
import { turnEffortOf } from '../models/effort';
import { claudeApiModel } from '../models/list';
import { isOutsideTurn } from '../outside';
import { notesMd, soulMd, whombatMd } from '../persona/prompt';
import { CLAUDE_KEY_FILE } from '../providers/credential-home';
import { providerExecutable } from '../providers/drift';
import { type ChatgptSteps, chatgptLend, chatgptSteps } from '../providers/login/chatgpt';
import { CHATGPT_STAGING_DIR } from '../providers/signin-executor';
import { AsyncQueue } from '../support/async-queue';
import { listedProviderEnv, MCP_TOKEN_ENV, managedPassEnv } from '../support/env';
import { errorMessage, isRetryableMessage, trimMessage } from '../support/errors';
import {
  clearHermesLogins,
  HERMES_REVIEW_DIR,
  type HermesRuntime,
  writeHermesProfile,
  writeSessionFiles,
} from './config';
import type { HermesLoopSource } from './own-loop';
import { ASK_ANSWERS_DIR, hermesPolicy, pluginApproval } from './policy';
import {
  clearLentLogin,
  HERMES_PRIVATE_DIRS,
  hermesBin,
  hermesFeedbackProfile,
  hermesInstalls,
  hermesPersonProfile,
  hermesPythonBeside,
  hermesRoot,
  lockHermesProfile,
  prepareHermesProfile,
  realCommand,
} from './profile';
import { type HermesRoute, sessionFit } from './route';
import { disabledSkills, hermesSkillsDir } from './skills';
import { vaultMcpConfig, vaultMcpEnv } from './vault-mcp';

export const HERMES_LABEL = 'Hermes';
/** How Whombat stores a Hermes session id (`providerSessionId`): never mistaken for a Claude or Codex one. */
export const HERMES_SESSION_PREFIX = 'hermes:';
/** The bridge Hermes starts for Whombat's MCP tools (`node mcp-bridge.mjs <url>`). */
export const HERMES_MCP_BRIDGE = fileURLToPath(new URL('./mcp-bridge.mjs', import.meta.url));

export function isHermesSessionId(id: string | null | undefined): id is string {
  return (
    typeof id === 'string' && id.startsWith(HERMES_SESSION_PREFIX) && id.length > HERMES_SESSION_PREFIX.length
  );
}

/** The key file of a model on the person's network, in the turn's profile (0600; the profile is the person's alone). */
export const LOCAL_MODEL_KEY_FILE = 'local-model.key';

export interface HermesProviderOptions {
  /**
   * The agent's provider (HE-32): `claude` and `codex` run on the person's own subscription (Claude through Nous's
   * DirectSDK provider, CDS-01; ChatGPT through Hermes's `openai-codex`), or on their API key or the AI gateway; `local`
   * on a model on the person's network.
   */
  kind: ProviderKind;
  /** Base environment (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** `hermes` (default `hermesBin(env)`). */
  bin?: string;
  /** Arguments (default `['acp']`; tests start a fake). */
  args?: readonly string[];
  /** `WHOMBAT_HERMES_ROOT` (default `hermesRoot(env)`). */
  root?: string;
  /** The Node that runs the MCP bridge (default this one). */
  node?: string;
  /**
   * After the answer, how long Hermes's memory and skill review may run before the turn ends (HE-S20, HN-08; default
   * 2 min), waited for only while the plugin marks one running. The answer is out first.
   */
  settleMs?: number;
  /** How long a turn waits for another turn of the same person (default 10 min). */
  lockWaitMs?: number;
  killGraceMs?: number;
  /** How long a cancelled prompt may take to end before the group is killed (default 6 s). */
  cancelGraceMs?: number;
  /** `initialize` and session setup, the gateway's start included (default 120 s). */
  requestTimeoutMs?: number;
  /** Nothing from Hermes for this long ends the turn (default 30 min: a long command says nothing). */
  idleTimeoutMs?: number;
  /** The longest turn (default 8 h). */
  turnTimeoutMs?: number;
  /** Timings and decisions, for the runner's journal. */
  log?: (message: string) => void;
  /**
   * ChatGPT's default model, as this runner's list of Hermes's ChatGPT models says (`isDefault`): what a ChatGPT turn
   * naming no model tells Hermes (HE-67). Null or absent: not known yet.
   */
  defaultModel?: () => string | null;
  /**
   * The plugin's ChatGPT steps, which lend the person's access token to a turn outsiders started (OP-S89; default the
   * Python beside `hermes`, none for development's scripted Hermes). Tests hand in a stand-in.
   */
  chatgptSteps?: ChatgptSteps | null;
}

/** Claude Code's own name for the signed-in account's default model (`--model default`, HE-67). */
const CLAUDE_DEFAULT_MODEL = 'default';

/** Hermes's tools by their names (every one's ACP `kind` is `other`), for the activity rows. */
const HERMES_CATEGORIES: Record<string, ToolCategory> = {
  exec_command: 'command',
  terminal: 'command',
  process: 'command',
  execute_code: 'command',
  apply_patch: 'edit',
  write_file: 'edit',
  patch: 'edit',
  read_file: 'read',
  search_files: 'search',
  web_search: 'web',
  web_extract: 'web',
  delegate_task: 'delegate',
};

function hermesCategory(known: KnownToolCall): ToolCategory | null {
  if (HERMES_CATEGORIES[known.name]) return HERMES_CATEGORIES[known.name] ?? null;
  if (known.name.startsWith('browser_')) return 'web';
  if (/^mcp(__|\.)/.test(known.name)) return 'mcp';
  return null;
}

/** What the agent reads when an Ask had nobody to answer it. */
const NOBODY_ASKED = 'Nobody could be asked about this here, so it didn’t happen.';

/** The agent's words for an ask that didn't run, for the plugin's hook (`whombat-asks/<id>`, 0600). */
async function writeAskAnswer(profile: string, id: string, text: string): Promise<void> {
  const dir = join(profile, ASK_ANSWERS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, id), text.slice(0, 1000), { mode: 0o600 });
}

/**
 * Hermes's own question cards (a `clarify` question, a guarded model switch): never Whombat's to answer yes to — but for
 * the switch Whombat asked for itself (`session/set_model` to the turn's model, HN-07; `MODEL_CONFIRM`).
 */
const HERMES_QUESTION = /^(clarify-|model-confirm-)/;
const MODEL_CONFIRM = 'model-confirm-';

/** The ids of the turns Hermes lost (`unknown_execution: … /discard <id> …`), from a refused prompt. */
export function lostTurns(error: unknown): string[] {
  const data = (error as { data?: unknown } | null)?.data;
  const text = `${errorMessage(error)} ${typeof data === 'string' ? data : JSON.stringify(data ?? '')}`;
  if (!text.includes('unknown_execution')) return [];
  return [...new Set([...text.matchAll(/\/discard ([A-Za-z0-9_.:-]{1,120})/g)].map((m) => m[1] as string))];
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * Whether the plugin marks Hermes's memory and skill review running in `profile` (HN-08): it writes the marker before
 * Hermes answers the prompt and removes it when the review ends, so after the answer this is the whole truth.
 */
export async function reviewRunning(profile: string): Promise<boolean> {
  const markers = await readdir(join(profile, HERMES_REVIEW_DIR)).catch(() => [] as string[]);
  return markers.length > 0;
}

/** Waits while the review runs (HE-S20, HN-08): never longer than `ms` or past `stop`. */
async function settle(profile: string, ms: number, stop: () => boolean): Promise<number> {
  const start = Date.now();
  while (!stop() && Date.now() - start < ms && (await reviewRunning(profile))) await pause(250);
  return Date.now() - start;
}

/**
 * Whether the profile holds a ChatGPT login of Hermes's (`auth.json`, HN-03): looked at, never opened — what is in it
 * is Hermes's.
 */
async function hasChatgptLogin(profile: string): Promise<boolean> {
  const info = await lstat(join(profile, 'auth.json')).catch(() => null);
  return Boolean(info?.isFile());
}

/** A turn outsiders started, on ChatGPT, when the person's sign-in couldn't be lent to it just now (OP-S89). */
export const CHATGPT_LEND_RETRY =
  'I couldn’t get your ChatGPT sign-in ready for this message just now. I’ll try again in a moment.';
/** The same where this Whombat can't lend it at all (no Hermes with Whombat's plugin: development's scripted one). */
export const CHATGPT_LEND_UNAVAILABLE =
  'I can’t answer messages from outside on your ChatGPT sign-in on this Whombat. A Claude sign-in or an API key works.';
/** At least this long left on a lent token; else the person's Hermes refreshes it first (OP-S89). */
export const LEND_MIN_MS = 10 * 60_000;

/** What a ChatGPT turn says when the login isn't in the person's profile (signed in before HN-03, or it was removed). */
export const CHATGPT_SIGN_IN_AGAIN =
  'Your ChatGPT sign-in needs to be done again on this Whombat. Sign in under Settings → AI accounts, then ask me again.';

/** Python's import race in a gateway just started (seen once in 25 cold starts): `session/new` works when asked again. */
export function importRace(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  return /deadlock detected/i.test(`${errorMessage(error)} ${JSON.stringify(data ?? '')}`);
}

/** What a follow-up says once Hermes queued it into the running turn (`gateway_commands._steer`). */
const STEER_QUEUED = '⏩ Steer queued';

/**
 * What Hermes's gateway (a turn in the person's pod) puts in place of an answer that was only `NO_REPLY`
 * (`gateway.errors.unexpected_silence`, its default language). Whombat's turns end that way on purpose and the runner
 * decides whether an answer was still owed, so it is never the agent's reply.
 */
const SILENCE_REFUSED = '⚠️ The model returned only a silence marker';

function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: cost } : {}),
  };
}

/** Sessions being set up in a profile's pod, one after the other (`podSetup`). */
const podSetups = new Map<string, Promise<void>>();

/**
 * One session at a time is set up per pod (hermes-native.md HN-W09): a new session takes its route, effort and fast
 * replies from the `config.yaml` written just before it, so no other turn of the person may write it meanwhile. Resolves
 * with the release.
 */
async function podSetup(profile: string): Promise<() => void> {
  const before = podSetups.get(profile) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const queued = before.then(() => mine);
  podSetups.set(profile, queued);
  await before;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (podSetups.get(profile) === queued) podSetups.delete(profile);
  };
}

/** A turn person's Vault MCP servers as the session's own (HN-W07): http with headers, in Hermes's memory only. */
export function vaultEditorServers(servers: readonly TurnVaultMcpServer[]): McpServer[] {
  return servers.map((s) => ({
    type: 'http' as const,
    name: s.name,
    url: s.url,
    headers: s.headers.map((h) => ({ name: h.name, value: h.value })),
  }));
}

/**
 * The person's Brave Search key for a turn (web-search.md): with “Browse the web” open to it, or in a pod, where the
 * policy gates it per session; never in an outsiders' turn (the server sends no key there either). Null: no web search.
 */
export function turnSearchKey(
  input: Pick<TurnInput, 'context' | 'network'>,
  turn: { outside: boolean; pod: boolean },
): string | null {
  if (turn.outside || !(input.network || turn.pod)) return null;
  return input.context.webSearch?.apiKey ?? null;
}

export class HermesProvider implements AgentProvider {
  readonly kind: ProviderKind;
  readonly label = HERMES_LABEL;
  /** Marks a Hermes provider for the runner (its prompt, session and sandbox are Hermes's). */
  readonly hermes = true;
  readonly #options: HermesProviderOptions;

  constructor(options: HermesProviderOptions) {
    this.#options = options;
    this.kind = options.kind;
  }

  /** The provider of this kind's subscription turns (`local` has none). */
  get runtime(): HermesRuntime {
    return this.kind === 'claude' ? 'claude_directsdk' : 'openai_codex';
  }

  /**
   * What a turn runs on besides a CLI (HE-32), from what the runner set up: a model on the person's network (`local`), the
   * burrow's AI gateway (`input.gateway`), the person's API key (a managed sign-in of `api_key`), each with the
   * model's API id. Null: the person's own subscription.
   */
  loopSource(input: TurnInput, profile: string): HermesLoopSource | null {
    const kind = this.kind;
    if (kind === 'local') {
      const local = input.context.localModel;
      if (!local) return null;
      return {
        kind: 'local',
        model: input.model?.trim() || local.model,
        baseUrl: input.modelEndpoint ?? local.baseUrl,
        ...(local.apiKey ? { keyFile: join(profile, LOCAL_MODEL_KEY_FILE) } : {}),
      };
    }
    const model = input.model?.trim()
      ? kind === 'claude'
        ? claudeApiModel(input.model.trim())
        : input.model.trim()
      : '';
    if (input.gateway)
      return { kind: 'gateway', provider: kind, model, origin: new URL(input.gateway.baseUrl).origin };
    if (input.credential?.authMode === 'api_key')
      return {
        kind: 'key',
        api: kind === 'claude' ? 'anthropic' : 'openai',
        model,
        keyFile: join(input.credential.home, CLAUDE_KEY_FILE),
      };
    return null;
  }

  /**
   * The model a subscription turn tells Hermes (HE-67): the turn's, else the default by name — Claude Code's own
   * `default`, ChatGPT's from the runner's list of Hermes's models; null: not known.
   */
  cliModel(input: TurnInput): string | null {
    const named = input.model?.trim();
    if (named) return named;
    if (this.kind === 'claude') return CLAUDE_DEFAULT_MODEL;
    return this.#options.defaultModel?.()?.trim() || null;
  }

  #env(): NodeJS.ProcessEnv {
    return this.#options.env ?? process.env;
  }

  bin(): string {
    return this.#options.bin ?? hermesBin(this.#env());
  }

  root(): string {
    return this.#options.root ?? hermesRoot(this.#env());
  }

  /**
   * Images as image blocks (Hermes takes them); no PDFs; resume by session; Hermes's skills are its own, not the
   * runner's folder; cancel; usage; follow-ups (steering.md). Confinement is the managed sandbox's, not Hermes's.
   */
  capabilities(): ProviderCapabilities {
    return {
      images: true,
      documents: false,
      sessionResume: true,
      cancel: true,
      usage: true,
      steering: true,
    };
  }

  async available(): Promise<Availability> {
    const bin = realCommand(this.bin(), this.#env());
    try {
      await access(bin, constants.X_OK);
      return { ok: true, version: `Hermes Agent (${bin})` };
    } catch {
      return { ok: false, kind: 'missing', reason: `Hermes isn’t installed at ${this.bin()}.` };
    }
  }

  /**
   * The profile (`HERMES_HOME`) of a turn (OP-08, OP-17): the person's own (the root, Hermes's default profile), or the
   * outsiders' for a turn outsiders' input started (a Feedback assessment, a tracker's customer, incoming mail).
   */
  profileOf(input: Pick<TurnInput, 'context'>): string {
    return isOutsideTurn(input.context)
      ? hermesFeedbackProfile(this.root())
      : hermesPersonProfile(this.root());
  }

  /** The runner's own folders in the person's profile, never visible to their Hermes (`HERMES_PRIVATE_DIRS`). */
  #privateDirs(profile: string): string[] {
    return profile === hermesPersonProfile(this.root())
      ? HERMES_PRIVATE_DIRS.map((d) => join(profile, d))
      : [];
  }

  /** The turn's Vault MCP servers: none in a turn outsiders started (OP-17), whatever came. */
  #vaultServers(input: TurnInput): TurnVaultMcpServer[] {
    return isOutsideTurn(input.context) ? [] : (input.vaultMcpServers ?? []);
  }

  /**
   * Claude Code's real file (the installed client the runner prepared, `WHOMBAT_CLAUDE_PATH`), DirectSDK's model client;
   * null for ChatGPT and `local`, which run no CLI.
   */
  cli(): string | null {
    if (this.kind !== 'claude') return null;
    return realCommand(providerExecutable(this.kind, this.#env()), this.#env());
  }

  /** Claude Code is the model client for personal subscriptions and Claude gateway turns. */
  #modelCli(input: TurnInput, profile: string): string | null {
    const loop = this.loopSource(input, profile);
    return !loop || (loop.kind === 'gateway' && loop.provider === 'claude') ? this.cli() : null;
  }

  /** What Hermes's processes get besides the agent's environment: its home, the Vault MCP servers'. */
  #hermesEnv(input: TurnInput, profile: string): Record<string, string> {
    const cli = this.#modelCli(input, profile);
    return {
      HERMES_HOME: profile,
      ...(cli ? { CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: cli } : {}),
      // The person's Vault MCP servers' addresses and sign-ins (HE-S154): here, never in a file.
      ...vaultMcpEnv(this.#vaultServers(input)),
    };
  }

  /**
   * The managed task's extras (HE-S18): the turn's profile writable — the only one, ChatGPT's login in the person's —
   * with the runner's own folders in it out of sight, Claude Code's install and Hermes's environment readable, the
   * bridge readable, `HERMES_HOME` and the Vault servers' variables set inside.
   */
  async sandboxNeeds(input: TurnInput): Promise<SandboxNeeds> {
    const profile = this.profileOf(input);
    await prepareHermesProfile(this.root(), profile);
    const env = this.#env();
    const bin = realCommand(this.bin(), env);
    const cli = this.#modelCli(input, profile);
    return {
      stateDirs: [profile],
      denied: this.#privateDirs(profile),
      // A venv's own files beside its `bin/` and the Python it links to (development; the image's store paths are
      // mounted anyway); Claude Code's install only when DirectSDK runs the turn.
      installs: [...(cli ? commandInstall(cli, env.PATH) : []), ...hermesInstalls(bin)],
      readable: [dirname(HERMES_MCP_BRIDGE)],
      env: this.#hermesEnv(input, profile),
      // agent-browser beside `hermes` (HE-S300: `pnpm hermes:install`'s, or the image's), for the plugin's browser tools.
      ...(input.browser ? { path: [dirname(bin)] } : {}),
    };
  }

  /**
   * What the person's pod holds (hermes-native.md HN-W01, HN-W03; one-person.md OP-08): the same for every turn of
   * theirs, whatever its provider — their profile (the runner's own folders in it out of sight), Hermes and Claude
   * Code's install, the bridge, agent-browser on the `PATH` and DirectSDK's command; the sign-in's
   * own variables (`credentialEnv`: Claude's config home) go with the turn's credential. A turn outsiders started has a
   * sandbox of its own in their profile (HN-W14, OP-17): null.
   */
  async podNeeds(input: TurnInput): Promise<PodNeeds | null> {
    if (isOutsideTurn(input.context)) return null;
    const profile = this.profileOf(input);
    await prepareHermesProfile(this.root(), profile);
    const env = this.#env();
    const bin = realCommand(this.bin(), env);
    // Claude Code for DirectSDK, whichever provider this turn's is: the pod serves the person's Claude sessions too.
    const claude = resolveCommand(providerExecutable('claude', env), env.PATH)
      ? realCommand(providerExecutable('claude', env), env)
      : null;
    return {
      profile,
      bin,
      installs: [...(claude ? commandInstall(claude, env.PATH) : []), ...hermesInstalls(bin)],
      readable: [dirname(HERMES_MCP_BRIDGE)],
      denied: this.#privateDirs(profile),
      path: [dirname(bin)],
      env: {
        HERMES_HOME: profile,
        ...(claude ? { CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: claude } : {}),
      },
      credentialEnv: { ...(input.credential?.env ?? {}) },
    };
  }

  /** Whombat's MCP server for a session: the stdio bridge to the dispatch's MCP endpoint, its token in its env. */
  mcpServer(input: Pick<TurnInput, 'mcp'>): McpServer {
    return {
      name: MCP_SERVER_NAME,
      command: this.#options.node ?? process.execPath,
      args: [HERMES_MCP_BRIDGE, input.mcp.url],
      env: [{ name: MCP_TOKEN_ENV, value: input.mcp.token }],
    };
  }

  /**
   * The environment of `hermes acp` (and of everything it starts): no login variable but Claude Code's own home. A
   * ChatGPT login is Hermes's own, in the profile (HN-03).
   */
  processEnv(input: TurnInput, profile: string): NodeJS.ProcessEnv {
    const base = this.#env();
    const home =
      input.host?.credentialHome && !input.credential && this.kind === 'claude'
        ? { CLAUDE_CONFIG_DIR: input.host.credentialHome }
        : {};
    // Hermes never gets the operator's tokens (a `gh` login would become a Copilot credential of its own, a model key a
    // provider of its own), only the sign-in the turn runs on.
    const env = agentEnv({
      env: base,
      login: () => false,
      pass: managedPassEnv(listedProviderEnv(base)),
      extra: { ...(input.host?.env ?? {}), ...home, ...(input.credential?.env ?? {}) },
      mcpToken: input.mcp.token,
    });
    return { ...env, ...this.#hermesEnv(input, profile) };
  }

  /**
   * Lends the person's ChatGPT access token to the outsiders' profile for one turn (OP-S89): the plugin's `lend` step,
   * Hermes's own code on the person's profile, refreshing it there first when it has less than the turn's budget (at
   * least `LEND_MIN_MS`) left. The outsiders' profile gets the access token alone. Null when lent, else the turn's error.
   */
  async #lendChatgpt(
    to: string,
    signal: AbortSignal,
    log: (m: string) => void,
  ): Promise<Extract<TurnEvent, { type: 'error' }> | null> {
    const env = this.#env();
    const steps =
      this.#options.chatgptSteps !== undefined
        ? this.#options.chatgptSteps
        : chatgptSteps(hermesPythonBeside(this.bin(), env), env);
    if (!steps) return { type: 'error', message: CHATGPT_LEND_UNAVAILABLE, retryable: false };
    const root = this.root();
    const lent = await chatgptLend(steps, {
      profile: hermesPersonProfile(root),
      to,
      minSeconds: Math.max(LEND_MIN_MS, this.#options.turnTimeoutMs ?? 8 * 3_600_000) / 1000,
      scratchParent: join(root, CHATGPT_STAGING_DIR),
      signal,
    });
    if (lent.ok) {
      log(
        `lent the ChatGPT access token to the outsiders' profile${lent.expiresAt ? ` until ${lent.expiresAt}` : ''}`,
      );
      return null;
    }
    log(`no ChatGPT token lent (${lent.refusal}): ${lent.detail}`);
    if (lent.refusal === 'sign_in')
      return {
        type: 'error',
        message: CHATGPT_SIGN_IN_AGAIN,
        retryable: false,
        credentialState: 'auth_revoked',
      };
    if (lent.refusal === 'unavailable')
      return { type: 'error', message: CHATGPT_LEND_UNAVAILABLE, retryable: false };
    return { type: 'error', message: CHATGPT_LEND_RETRY, retryable: true };
  }

  async *runTurn(input: TurnInput, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    if (signal.aborted) return;
    const log = (m: string) => this.#options.log?.(`hermes · ${m}`);
    const t0 = Date.now();
    const profile = this.profileOf(input);
    try {
      await prepareHermesProfile(this.root(), profile);
    } catch (error) {
      yield { type: 'error', message: trimMessage(errorMessage(error)), retryable: false };
      return;
    }
    // A subscription turn without a model runs on the default, named, since Hermes keeps no session without a model
    // (HE-67): Claude Code's `default`, ChatGPT's listed default. Another source needs the API's model id (HE-S48), and
    // `local` its model on the person's network.
    const loop = this.loopSource(input, profile);
    const cliModel = loop ? null : this.cliModel(input);
    if (this.kind === 'local' && !loop) {
      yield {
        type: 'error',
        message:
          'I can’t reply yet: the model on your network isn’t set up. Set it up in Settings → AI, then ask me again.',
        retryable: false,
      };
      return;
    }
    if (loop && !loop.model) {
      yield {
        type: 'error',
        message:
          'I can’t start: this turn needs a model and none is set. You can pick one under Settings → Agent.',
        retryable: false,
      };
      return;
    }
    if (!loop && !cliModel) {
      yield {
        type: 'error',
        message:
          'I can’t start yet: I don’t know which ChatGPT model to use by default. Ask me again in a minute, or pick one under Settings → Agent.',
        retryable: false,
      };
      return;
    }
    // A ChatGPT turn on the person's own subscription needs Hermes's login in their profile (HN-03): without it Hermes
    // would only say it has no credentials, after starting. (A turn with no sign-in at all is the scripted Hermes's.)
    const chatgpt = input.credential?.authMode === 'chatgpt' || input.credential?.authMode === 'access_token';
    // A turn outsiders started borrows the person's access token for its run (OP-S89), below, under its profile's lock.
    const lend = this.kind === 'codex' && !loop && chatgpt && isOutsideTurn(input.context);
    if (this.kind === 'codex' && !loop && chatgpt && !lend && !(await hasChatgptLogin(profile))) {
      yield {
        type: 'error',
        message: CHATGPT_SIGN_IN_AGAIN,
        retryable: false,
        credentialState: 'auth_revoked',
      };
      return;
    }
    // In the person's pod (HN-W01): the pod holds the profile; the runner admitted the turn under the person's cap.
    if (input.pod) {
      yield* this.#turn(input, signal, profile, loop, log, input.pod);
      return;
    }
    let lock: Awaited<ReturnType<typeof lockHermesProfile>>;
    try {
      lock = await lockHermesProfile(this.root(), profile, {
        holder: input.context.dispatch.id,
        waitMs: this.#options.lockWaitMs ?? 10 * 60_000,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      log(`profile busy: ${errorMessage(error)}`);
      yield { type: 'error', message: HERMES_PROFILE_BUSY, retryable: true };
      return;
    }
    if (Date.now() - t0 > 1000) log(`waited ${Date.now() - t0} ms for the profile`);
    try {
      if (lend) {
        const refused = await this.#lendChatgpt(profile, signal, log);
        if (refused) {
          yield refused;
          return;
        }
      }
      yield* this.#turn(input, signal, profile, loop, log, null);
    } finally {
      // The turn's logins and whatever Hermes stored of a login go with it (HE-S141), a lent token too (OP-S89).
      await clearHermesLogins(profile).catch((err) => log(`logins not cleared: ${errorMessage(err)}`));
      if (lend)
        await clearLentLogin(this.root()).catch((err) => log(`lent login not cleared: ${errorMessage(err)}`));
      await lock.release();
    }
  }

  async *#turn(
    input: TurnInput,
    signal: AbortSignal,
    profile: string,
    loop: HermesLoopSource | null,
    log: (m: string) => void,
    pod: TurnPod | null,
  ): AsyncGenerator<TurnEvent> {
    const label = this.label;
    const events = new AsyncQueue<TurnEvent>();
    const mapper = new AcpEventMapper({ notices: 'without-message-id', category: hermesCategory });
    let opened: AcpProcess | null = null;
    let sessionId: string | null = null;
    /**
     * Until this turn's prompt is sent, what Hermes says about the session is history (a resume's and a load's replay)
     * or a lost turn's late output: never this turn's reply (HE-37).
     */
    let replaying = true;
    /** Whombat's own `session/set_model` to the turn's model is under way: Hermes's confirmation of it is a yes. */
    let settingModel = false;
    let finished = false;
    let stoppingNow = false;
    let tornDown = false;
    /** The prompt running now (Stop waits for it), whether the first one ended, whether the turn is ending. */
    let livePrompt: Promise<unknown> | null = null;
    let mainDone = false;
    let ending = false;
    /** The answer went out (`answered`) and only Hermes's own review runs: nothing that ends Hermes now fails the turn. */
    let answeredOut = false;
    const timers: NodeJS.Timeout[] = [];
    let idle: NodeJS.Timeout | null = null;
    const idleMs = this.#options.idleTimeoutMs ?? 30 * 60_000;
    const capMs = this.#options.turnTimeoutMs ?? 8 * 60 * 60_000;
    /** `/steer`ed follow-ups, in order: whether Hermes said it took them into the running turn, whether delivered. */
    const steers: { steer: TurnSteer; answer: Promise<unknown>; noticed: boolean; delivered: boolean }[] = [];
    /** Follow-ups waiting for the running prompt to end (with files, or after it), in order. */
    const held: TurnSteer[] = [];
    const deliveredIds = new Set<string>();
    /** Asks waiting for a person (HE-44): given up when the turn stops or ends. */
    const asking = new Set<AbortController>();

    const finish = (event?: TurnEvent) => {
      if (finished) return;
      finished = true;
      // A Hermes that dies or is stopped during its review after the answer: the turn is still answered, not failed
      // (a failure would be retried and the person would get the answer twice).
      if (event?.type === 'error' && answeredOut) {
        log(`after the answer: ${event.message}`);
        event = undefined;
      }
      for (const a of asking) a.abort();
      if (idle) clearTimeout(idle);
      for (const t of timers) clearTimeout(t);
      if (event) events.push(event);
      events.close();
      if (event?.type === 'error') void opened?.close();
    };
    const touch = () => {
      if (finished) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(
        () =>
          finish({
            type: 'error',
            message: `${label} stopped answering (nothing for ${Math.round(idleMs / 60_000)} minutes), so Whombat stopped it.`,
            retryable: true,
          }),
        idleMs,
      );
      idle.unref?.();
    };
    const deliverId = (id: string) => {
      if (deliveredIds.has(id) || finished) return;
      deliveredIds.add(id);
      events.push({ type: 'steered', id });
    };
    const deliver = (s: (typeof steers)[number]) => {
      if (s.delivered) return;
      s.delivered = true;
      deliverId(s.steer.id);
    };

    const onUpdate = (n: SessionNotification) => {
      touch();
      if (finished || replaying || stoppingNow) return;
      if (sessionId && n.sessionId !== sessionId) return;
      const u = n.update;
      if (u.sessionUpdate === 'user_message_chunk') return;
      // Hermes's notice that it took a follow-up into the running turn: the oldest one not yet taken.
      if (
        u.sessionUpdate === 'agent_message_chunk' &&
        !u.messageId &&
        u.content.type === 'text' &&
        u.content.text.startsWith(STEER_QUEUED)
      ) {
        const s = steers.find((x) => !x.noticed && !x.delivered);
        if (s) {
          s.noticed = true;
          deliver(s);
        }
      }
      if (
        u.sessionUpdate === 'agent_message_chunk' &&
        u.content.type === 'text' &&
        u.content.text.trimStart().startsWith(SILENCE_REFUSED)
      )
        return;
      for (const event of mapper.map(u)) events.push(event);
    };
    const askPerson = async (
      request: RequestPermissionRequest,
      plugin: { tool: string; ask: ToolAsk | null },
    ): Promise<RequestPermissionResponse> => {
      const id = request.toolCall.toolCallId;
      const ask = plugin.ask;
      let answer: ToolAskAnswer;
      if (!ask) answer = { allow: false, reason: 'only a key’s Ask goes to a person' };
      else if (!input.askPerson) answer = { allow: false, reason: 'nobody can be asked in this turn' };
      else {
        const controller = new AbortController();
        asking.add(controller);
        // A person may take a while: the turn isn't idle meanwhile.
        const keepAlive = setInterval(touch, 60_000);
        keepAlive.unref?.();
        try {
          answer = await input.askPerson(ask, controller.signal);
        } catch (error) {
          answer = { allow: false, reason: `the ask failed: ${errorMessage(error)}` };
        } finally {
          clearInterval(keepAlive);
          asking.delete(controller);
        }
      }
      touch();
      if (stoppingNow || finished || signal.aborted) return permissionResponse(request, 'cancelled');
      // What the agent reads instead of Hermes's own “denied” (HE-S149): the plugin's hook picks it up by the ask's id.
      if (!answer.allow && ask?.id)
        await writeAskAnswer(profile, ask.id, answer.message ?? NOBODY_ASKED).catch((err: unknown) =>
          log(`couldn’t leave the ask’s words: ${errorMessage(err)}`),
        );
      events.push({
        type: 'permission',
        tool: plugin.tool,
        allowed: answer.allow,
        reason: answer.reason,
        id,
        ...(ask?.detail ? { target: ask.detail } : {}),
      });
      return permissionResponse(request, answer);
    };
    const onPermission = (
      request: RequestPermissionRequest,
    ): RequestPermissionResponse | Promise<RequestPermissionResponse> => {
      touch();
      if (stoppingNow || finished || signal.aborted) return permissionResponse(request, 'cancelled');
      const id = request.toolCall.toolCallId;
      const raw = (request.toolCall.rawInput ?? {}) as Record<string, unknown>;
      // Whombat's policy asked (HE-44): a key at Ask, a person answers.
      const plugin = pluginApproval(raw);
      if (plugin) return askPerson(request, plugin);
      const target = typeof raw.command === 'string' ? raw.command.slice(0, 300) : undefined;
      if (settingModel && id.startsWith(MODEL_CONFIRM))
        return permissionResponse(request, { allow: true, reason: 'the turn’s model, set by Whombat' });
      if (HERMES_QUESTION.test(id)) {
        const decision = {
          allow: false,
          reason: id.startsWith('clarify-')
            ? 'questions go to the person in the conversation, not through Hermes'
            : 'the model is Whombat’s to set',
        };
        events.push({
          type: 'permission',
          tool: id.startsWith('clarify-') ? 'clarify' : 'model',
          allowed: false,
          reason: decision.reason,
          id,
        });
        return permissionResponse(request, decision);
      }
      const known = mapper.tool(id);
      const asked = describeToolCall({ ...(known?.fields ?? {}), ...defined(request.toolCall) });
      const tool = known?.known.whombat ? known.known : asked;
      const decision = decidePermission(tool, { network: input.network });
      events.push({
        type: 'permission',
        tool: tool.name,
        allowed: decision.allow,
        reason: decision.reason,
        id,
        ...(target ? { target } : {}),
      });
      return permissionResponse(request, decision);
    };

    let stopping: Promise<void> | null = null;
    const stop = () => {
      stopping ??= (async () => {
        stoppingNow = true;
        for (const a of asking) a.abort();
        const o = opened as AcpProcess | null;
        if (o && sessionId && livePrompt && !finished) {
          await o.connection.agent.notify('session/cancel', { sessionId }).catch(() => {});
          const grace = new Promise((r) => setTimeout(r, this.#options.cancelGraceMs ?? 6000).unref?.());
          await Promise.race([livePrompt.catch(() => {}), grace, o.ended]);
        }
        finish();
        await o?.close();
      })();
      return stopping;
    };
    const onAbort = () => void stop();
    signal.addEventListener('abort', onAbort, { once: true });

    const env = this.processEnv(input, profile);
    /** The pod's setup turn (`podSetup`), held until the session is there. */
    let setupDone: (() => void) | null = null;
    const drive = async () => {
      const assessment = input.context.dispatch.trigger === 'feedback';
      if (pod) setupDone = await podSetup(profile);
      const local = input.context.localModel;
      if (loop?.kind === 'local' && loop.keyFile && local?.apiKey)
        await writeFile(loop.keyFile, `${local.apiKey}\n`, { mode: 0o600 });
      // Hermes's file tools stay out of Claude Code's sign-in home as well as the profile.
      const privateDirs = (['CLAUDE_CONFIG_DIR'] as const)
        .map((name) => env[name])
        .filter((dir): dir is string => !!dir && isAbsolute(dir));
      const outside = isOutsideTurn(input.context);
      const vault = this.#vaultServers(input);
      // Switched off (HSK-05).
      const disabled = await disabledSkills(hermesSkillsDir(profile)).catch(() => [] as string[]);
      const policy = hermesPolicy(input.context, {
        replyOnly: input.replyOnly,
        privateDirs,
        ...(assessment && input.browser
          ? { assessorBrowser: { logins: (input.browser.logins?.length ?? 0) > 0 } }
          : {}),
        // In a pod a session's tools were fixed when it began: the policy is the gate (HN-W07, HN-W09).
        ...(pod
          ? {
              pod: {
                browser: Boolean(input.browser),
                vault: vault.map((v) => ({ name: v.name, tools: [...v.tools] })),
              },
            }
          : {}),
      });
      const searchKey = turnSearchKey(input, { outside, pod: Boolean(pod) });
      const route = await writeHermesProfile(
        profile,
        {
          runtime: this.runtime,
          model: loop ? null : this.cliModel(input),
          effort: turnEffortOf(input),
          // Fast replies on ChatGPT's own provider only (CR-06): never through the gateway or a key.
          ...(this.kind === 'codex' && !loop ? { fast: input.fast ?? null } : {}),
          network: input.network,
          ...(searchKey ? { webSearch: true } : {}),
          browser: input.browser ?? null,
          disabledSkills: disabled,
          ...(outside ? { outside: true } : {}),
          ...(vault.length && !pod ? { mcpServers: vaultMcpConfig(vault) } : {}),
          ...(pod ? { pod: true } : {}),
        },
        {
          soul: soulMd(input.context),
          whombat: whombatMd(input.context),
          notes: notesMd(input.context),
          loop,
          assessment,
          // A pod's policy is the session's (`writeSessionFiles` below).
          ...(pod ? {} : { policy }),
          webSearchKey: searchKey,
        },
      );
      log(
        loop?.kind === 'gateway' && this.kind === 'claude'
          ? 'on Claude DirectSDK through the AI gateway'
          : loop
            ? `on ${loop.kind === 'key' ? 'an API key' : loop.kind === 'gateway' ? 'the AI gateway' : 'a local model'}`
            : `on ${this.runtime === 'claude_directsdk' ? 'Claude DirectSDK' : 'ChatGPT (openai-codex)'}`,
      );
      if (tornDown || signal.aborted) return;
      const started = Date.now();
      const o = openAcpProcess({
        label,
        command: this.bin(),
        args: this.#options.args ?? ['acp'],
        cwd: input.cwd,
        env,
        ...(input.host?.spawn ? { spawn: input.host.spawn } : {}),
        ...(this.#options.killGraceMs !== undefined ? { killGraceMs: this.#options.killGraceMs } : {}),
        onUpdate,
        onPermission,
        onActivity: touch,
      });
      opened = o;
      if (tornDown) {
        await o.close();
        return;
      }
      touch();
      const cap = setTimeout(
        () =>
          finish({
            type: 'error',
            message: `${label} took longer than ${Math.round(capMs / 60_000)} minutes, so Whombat stopped it.`,
            retryable: false,
          }),
        capMs,
      );
      cap.unref?.();
      timers.push(cap);
      void o.ended.then((e) => {
        if (finished || stoppingNow || signal.aborted) return;
        finish({
          type: 'error',
          message: e.reason,
          retryable: !e.violation && e.code !== 'ENOENT' && isRetryableMessage(e.reason),
        });
      });
      const setupMs = this.#options.requestTimeoutMs ?? 120_000;
      const negotiated = negotiatedFrom(await initializeAcp(o, label, setupMs));
      if (negotiated.protocolVersion !== ACP_PROTOCOL_VERSION) {
        finish({
          type: 'error',
          message: `${label} speaks ACP v${negotiated.protocolVersion}; Whombat speaks v${ACP_PROTOCOL_VERSION}.`,
          retryable: false,
        });
        return;
      }
      const initialized = Date.now();
      const request = <T>(p: Promise<T>, what: string) =>
        withTimeout(Promise.race([p, endedAsError(o.ended)]), setupMs, `${label}’s ${what}`);
      // In a pod the Vault's servers are the session's own (HN-W07), with this turn's sign-ins.
      const mcpServers = [
        this.mcpServer(input),
        ...(pod ? vaultEditorServers(this.#vaultServers(input)) : []),
      ];
      const resumeId = isHermesSessionId(input.resumeSessionId)
        ? input.resumeSessionId.slice(HERMES_SESSION_PREFIX.length)
        : null;
      // Hermes replays the conversation first, on resume as on load: history, not this turn (`replaying`).
      let moved = false;
      if (resumeId) {
        const resumed = await this.#resume(o, negotiated, input, resumeId, mcpServers, request, log, {
          route,
          setting: (on) => {
            settingModel = on;
          },
        });
        sessionId = resumed.sessionId;
        moved = resumed.moved;
      }
      if (resumeId && !sessionId) {
        if (!input.freshIfSessionGone) {
          // The server retries a failed resume with a fresh session and the whole window (bp-memory.md BP-B17): a
          // session on another provider as a gone one (HN-07).
          finish({
            type: 'error',
            message: `${label} couldn’t pick up this conversation again.`,
            retryable: true,
          });
          return;
        }
        log(
          moved
            ? 'its session runs on another provider; a fresh one started'
            : 'its session was gone; a fresh one started',
        );
      }
      const resumed = sessionId !== null;
      if (!sessionId) sessionId = await this.#newSession(o, input, mcpServers, request, log);
      if (pod) {
        // The session is the turn's from here (HN-W04, HN-W06): its files, then its route to this turn's things.
        await writeSessionFiles(profile, sessionId, { policy, logins: input.browser?.logins ?? null });
        pod.bind(sessionId);
        // A resumed session keeps the effort and fast replies it began with (HN-L11): the turn's, for this session only.
        if (resumed) await this.#sessionSettings(o, sessionId, input, loop, request, log);
        setupDone?.();
      }
      log(
        `started in ${initialized - started} ms, ${resumeId ? 'resumed' : 'new'} session in ${Date.now() - initialized} ms`,
      );
      events.push({ type: 'session', sessionId: `${HERMES_SESSION_PREFIX}${sessionId}` });
      if (tornDown || stoppingNow) return;
      const sid = sessionId;
      const prompt = (text: string, attachments = input.attachments ?? []) =>
        acpPromptContent(text, attachments, negotiated, label).then(
          (blocks): Promise<PromptResponse> =>
            Promise.race([
              o.connection.agent.request('session/prompt', { sessionId: sid, prompt: blocks }),
              endedAsError(o.ended),
            ]),
        );
      /** The prompt, once more after discarding what Hermes lost when a turn was killed (HE-S25). */
      const promptOnce = async (
        text: string,
        attachments = input.attachments ?? [],
      ): Promise<PromptResponse> => {
        try {
          return await prompt(text, attachments);
        } catch (error) {
          const lost = lostTurns(error);
          if (!lost.length || finished || stoppingNow) throw error;
          log(`discarding ${lost.length} turn(s) Hermes lost`);
          for (const id of lost) await prompt(`/discard ${id}`, []).catch(() => {});
          return prompt(text, attachments);
        }
      };
      /** The prompt running now: Stop waits for it to end `cancelled`. */
      const track = <T>(p: Promise<T>): Promise<T> => {
        livePrompt = p;
        return p;
      };
      replaying = false;
      const first = track(promptOnce(input.prompt));
      input.steering?.open(take);
      let result = await first.finally(() => {
        mainDone = true;
      });
      log(`answered in ${Date.now() - initialized} ms`);
      let usage: TurnUsage | undefined;
      // Each round: the answer so far, then the follow-ups held meanwhile as the session's next prompt (HE-S24) — or,
      // after `/steer`, one Hermes queued itself because the turn was ending — until none is left.
      for (;;) {
        if (finished) return;
        usage = addUsage(usage, mapper.usage(result.usage));
        if (result.stopReason === 'cancelled') {
          if (stoppingNow || signal.aborted) finish();
          else finish({ type: 'error', message: `${label} cancelled the turn on its own.`, retryable: true });
          return;
        }
        if (result.stopReason === 'refusal') {
          finish({ type: 'error', message: `${label} refused to continue this turn.`, retryable: false });
          return;
        }
        const leftover = steers.find((x) => !x.delivered);
        const batch = leftover ? [] : held.splice(0);
        if (!leftover && !batch.length) break;
        events.push({ type: 'final', text: mapper.text, ...(usage ? { usage } : {}) });
        mapper.restart();
        if (leftover) {
          deliver(leftover);
          result = ((await track(leftover.answer).catch(() => null)) as PromptResponse | null) ?? {
            stopReason: 'end_turn',
          };
          continue;
        }
        for (const steer of batch) deliverId(steer.id);
        result = await track(
          promptOnce(
            batch.map((x) => x.prompt).join('\n\n'),
            batch.flatMap((x) => x.attachments ?? []),
          ),
        );
        log(`answered ${batch.length} follow-up(s)`);
      }
      ending = true;
      // Follow-ups taken into the running turn were answered in it; any still being sent are waited for.
      await Promise.allSettled(steers.map((x) => x.answer));
      // In a pod the review carries on in the gateway after the answer (HN-W13): the turn ends here.
      const settleMs = pod ? 0 : (this.#options.settleMs ?? 120_000);
      if (settleMs <= 0 || finished || !(await reviewRunning(profile))) {
        finish({ type: 'final', text: mapper.text, ...(usage ? { usage } : {}) });
        return;
      }
      // The answer goes out now; Hermes's memory and skill review still runs (HE-S20, HN-08).
      events.push({ type: 'final', text: mapper.text, ...(usage ? { usage } : {}) });
      input.steering?.close();
      answeredOut = true;
      events.push({ type: 'answered' });
      const waited = await settle(profile, settleMs, () => finished || stoppingNow || signal.aborted);
      log(`a review after the answer for ${waited} ms`);
      finish();
    };

    // A follow-up (steering.md SX-04), in order: `/steer` into the running turn (Hermes's notice is the delivery); with
    // files, or once the first prompt ended, held until the running prompt ends, then the session's next prompt — one
    // live admission at a time, so Stop cancels the right one.
    let chain: Promise<unknown> = Promise.resolve();
    const take = (steer: TurnSteer): boolean => {
      const o = opened as AcpProcess | null;
      if (finished || ending || stoppingNow || tornDown || signal.aborted || !o || !sessionId) return false;
      const files = (steer.attachments ?? []).length > 0;
      if (files || mainDone) {
        held.push(steer);
        return true;
      }
      const sid = sessionId;
      const answer = chain.then(async () => {
        const blocks = await acpPromptContent(
          `/steer ${steer.prompt}`,
          [],
          { image: false, embeddedContext: false },
          label,
        );
        return Promise.race([
          o.connection.agent.request('session/prompt', { sessionId: sid, prompt: blocks }),
          endedAsError(o.ended),
        ]);
      });
      chain = answer;
      answer.catch(() => {});
      steers.push({ steer, answer, noticed: false, delivered: false });
      return true;
    };

    void drive()
      .finally(() => (setupDone as (() => void) | null)?.())
      .catch(async (error: unknown) => {
        if (signal.aborted || finished || stoppingNow) return;
        const o = opened as AcpProcess | null;
        const ended =
          (error as { ended?: AcpEnded }).ended ??
          o?.endedNow() ??
          (o
            ? await Promise.race([
                o.ended,
                new Promise<null>((r) => setTimeout(() => r(null), 1000).unref?.()),
              ])
            : null);
        if (signal.aborted || finished || stoppingNow) return;
        if (ended) {
          finish({
            type: 'error',
            message: ended.reason,
            retryable: !ended.violation && ended.code !== 'ENOENT' && isRetryableMessage(ended.reason),
          });
          return;
        }
        // What Hermes said before it failed the turn (“No Codex credentials stored …”) is the better reason.
        const said = mapper.text.trim();
        const stderr = o?.stderr.slice(-2).join(' ');
        const message = trimMessage(said || `${errorMessage(error)}${stderr ? ` (${stderr})` : ''}`);
        finish({ type: 'error', message, retryable: isRetryableMessage(message) });
      });

    try {
      for await (const event of events) {
        if (signal.aborted) break;
        yield event;
      }
    } finally {
      input.steering?.close();
      signal.removeEventListener('abort', onAbort);
      tornDown = true;
      finish();
      if (stopping) await stopping;
      // Hermes and its gateway end with the turn (HE-S20): the next turn starts both with its own settings.
      await (opened as AcpProcess | null)?.close();
    }
  }

  /**
   * `session/new` for the turn's cwd and MCP servers. A fresh gateway once refused it with Python's import race
   * (`deadlock detected by _ModuleLock`, hermes-native.md HN-W12): asked once more then.
   */
  async #newSession(
    o: AcpProcess,
    input: TurnInput,
    mcpServers: McpServer[],
    request: <T>(p: Promise<T>, what: string) => Promise<T>,
    log: (m: string) => void,
  ): Promise<string> {
    const ask = () =>
      request(o.connection.agent.request('session/new', { cwd: input.cwd, mcpServers }), 'session/new');
    try {
      return (await ask()).sessionId;
    } catch (error) {
      if ((error as { ended?: AcpEnded }).ended || !importRace(error)) throw error;
      log('session/new met a fresh gateway’s import race; asked again');
      return (await ask()).sessionId;
    }
  }

  /**
   * A resumed session's effort and fast replies (hermes-native.md HN-L11, HN-W09): Hermes keeps what a session began
   * with whatever `config.yaml` says now, so the turn's are pinned for this session alone with Hermes's own commands —
   * `/reasoning <level>`, and on ChatGPT's own subscription `/fast fast|normal` (CR-06). Their replies come before the
   * turn's prompt and are never the turn's (`replaying`). A refusal leaves the session as it was.
   */
  async #sessionSettings(
    o: AcpProcess,
    sessionId: string,
    input: TurnInput,
    loop: HermesLoopSource | null,
    request: <T>(p: Promise<T>, what: string) => Promise<T>,
    log: (m: string) => void,
  ): Promise<void> {
    const effort = turnEffortOf(input);
    const commands = [
      ...(effort ? [`/reasoning ${effort}`] : []),
      ...(this.kind === 'codex' && !loop && typeof input.fast === 'boolean'
        ? [`/fast ${input.fast ? 'fast' : 'normal'}`]
        : []),
    ];
    for (const text of commands)
      await request(
        o.connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
        text.split(' ')[0] as string,
      ).catch((error: unknown) => {
        if ((error as { ended?: AcpEnded }).ended) throw error;
        log(`${text} refused: ${trimMessage(errorMessage(error), 200)}`);
      });
  }

  /**
   * `session/resume`, else `session/load` (both replay the conversation first: history, dropped), on the turn's provider
   * and model (HN-07): another model is set with `session/set_model` first. `sessionId` null when Hermes has the session
   * no more, or it is on another provider (`moved`: a retired route such as `claude-cli` too) or Hermes refused to move
   * it to the turn's model — the turn doesn't run there (`sessionFit`).
   */
  async #resume(
    o: AcpProcess,
    negotiated: AcpNegotiated,
    input: TurnInput,
    id: string,
    mcpServers: McpServer[],
    request: <T>(p: Promise<T>, what: string) => Promise<T>,
    log: (m: string) => void,
    turn: { route: HermesRoute; setting: (on: boolean) => void },
  ): Promise<{ sessionId: string | null; moved: boolean }> {
    const params = { sessionId: id, cwd: input.cwd, mcpServers };
    const resume = negotiated.resumeSession ? (['session/resume'] as const) : [];
    const load = negotiated.loadSession ? (['session/load'] as const) : [];
    // A retry (the attempt before may have died mid-turn, its Hermes with it) loads the session afresh from what Hermes
    // stored, rather than resuming the state it was left in (HE-37).
    const retry = (input.context.dispatch.attempts ?? 1) > 1;
    const tries: ('session/resume' | 'session/load')[] = retry ? [...load, ...resume] : [...resume, ...load];
    for (const method of tries) {
      let resumed: LoadSessionResponse & { models?: { currentModelId?: string } | null };
      try {
        // Hermes includes the experimental ACP model state, absent from the SDK's stable response type.
        resumed = await request(o.connection.agent.request(method, params), method);
      } catch (error) {
        if ((error as { ended?: AcpEnded }).ended) throw error;
        log(`${method} refused: ${trimMessage(errorMessage(error), 200)}`);
        continue;
      }
      // Hermes keeps a session's provider and model from when it began, whatever the config says now (HN-07).
      const fit = sessionFit(resumed.models?.currentModelId, turn.route);
      if (fit.fit === 'provider') {
        log(`its session runs on ${fit.from}, this turn on ${turn.route.provider}: not resumed`);
        return { sessionId: null, moved: true };
      }
      if (fit.fit === 'model') {
        turn.setting(true);
        try {
          await request(
            o.connection.agent.request('session/set_model', { sessionId: id, modelId: fit.modelId }),
            'session/set_model',
          );
          log(`its session moved from ${fit.from} to ${turn.route.model}`);
        } catch (error) {
          if ((error as { ended?: AcpEnded }).ended) throw error;
          log(`session/set_model refused: ${trimMessage(errorMessage(error), 200)}; not resumed`);
          return { sessionId: null, moved: true };
        } finally {
          turn.setting(false);
        }
      }
      return { sessionId: id, moved: false };
    }
    return { sessionId: null, moved: false };
  }
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
