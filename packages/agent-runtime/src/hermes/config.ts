/**
 * A Hermes profile's config (the person's, or the outsiders' `_feedback`), rewritten before every turn. Every turn runs
 * on Hermes’s own loop: a Claude subscription through the pinned Nous DirectSDK provider (the unmodified Claude CLI is
 * the model client), a ChatGPT subscription through Hermes’s built-in `openai-codex` provider on the login Hermes keeps
 * in the profile (hermes-native.md HN-02, HN-03), API keys, the AI gateway and local models through `own-loop.ts`.
 * Hermes owns tools, history, compression and reviews; Whombat supplies policy, identity and MCP settings.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEffort } from '@whombat/core';
import { SANDBOX_BROWSER_ORIGIN, SANDBOX_GATEWAY_ORIGIN } from '../access/managed/sandbox';
import type { TurnBrowserAccess } from '../contract';
import { HERMES_BROWSER_EXEC_TOOLSET, hermesAssessmentConfig } from './assessment';
import { CLAUDE_DIRECTSDK_PROVIDER, claudeGatewayPlugins } from './claude';
import {
  COMMANDS_BACKEND,
  HERMES_LOOP_PROVIDER_PREFIX,
  type HermesLoopSource,
  hermesLoopConfig,
} from './own-loop';
import { HERMES_POLICY_FILE, type HermesPolicy, hermesPolicyJson } from './policy';
import { type HermesRoute, hermesRouteOf } from './route';
import { hermesSkillsConfig } from './skills';

/** A subscription turn's provider in Hermes: Nous's DirectSDK for Claude, Hermes's own `openai-codex` for ChatGPT. */
export type HermesRuntime = 'claude_directsdk' | 'openai_codex';

/** The plugin reads at most this much of `whombat.md` (`whombat_hermes/prompt.py`). */
export const WHOMBAT_MD_MAX = 4000;

export { CLAUDE_DIRECTSDK_PROVIDER } from './claude';
/**
 * Hermes's built-in ChatGPT provider (HN-02): the Responses API at `chatgpt.com/backend-api/codex` on the login in the
 * profile's `auth.json`. A session on it reports its model as `openai-codex:<model>`.
 */
export const CHATGPT_PROVIDER = 'openai-codex';

/**
 * Where the plugin marks a running memory and skill review (`whombat_hermes/review.py`, HN-08): one file per review,
 * there from before the answer until the review ends. Cleared before a turn starts Hermes.
 */
export const HERMES_REVIEW_DIR = 'whombat-review';

export interface HermesProfileConfig {
  runtime: HermesRuntime;
  /** The model id as the provider takes it; null: Claude Code's own default (ChatGPT turns always name one). */
  model: string | null;
  effort: AgentEffort | null;
  /**
   * Fast replies in a ChatGPT turn (chat-runtime.md CR-06): true asks Hermes for the priority tier
   * (`agent.service_tier`), false for the normal one; null or absent: Hermes's default (normal).
   */
  fast?: boolean | null;
  /** “Browse the web” at Allowed, or at Ask in a commands turn (the hook asks then): Hermes’s web tools (the policy hook decides). */
  network?: boolean;
  /**
   * Web search on the person's Brave Search key (web-search.md): the plugin's Brave backend as Hermes's search backend,
   * its key in `WEB_SEARCH_KEY_FILE` (written by `writeHermesProfile`). Off: no backend, so no `web_search`.
   */
  webSearch?: boolean;
  /** The turn's browser (HE-42, OP-S113): Hermes's browser tools on the agent's Chromium; absent or null: off. */
  browser?: TurnBrowserAccess | null;
  /** Skills switched off (HSK-05, `disabledSkills`): Hermes's `skills.disabled`. */
  disabledSkills?: readonly string[];
  /**
   * A turn outsiders' input started (one-person.md OP-17): nothing it reads is remembered — Hermes's memory and its
   * memory and skill review off.
   */
  outside?: boolean;
  /** The turn person's Vault MCP servers (`vaultMcpConfig`: placeholders only, HE-S154). */
  mcpServers?: Record<string, unknown>;
  /**
   * The person's pod (hermes-native.md HN-W09): its gateway serves every session of theirs, whatever the provider —
   * both subscriptions' plugins on, the browser always at the pod's bridge (the policy gates it per session), no profile
   * MCP server (a session's are its own), the gateway's idle exit off and its agent cache sized for the pod. A new session
   * takes the rest (its route, effort, fast replies) from the config when it is created.
   */
  pod?: boolean;
}

/** Hermes's agent cache in a pod (HN-W16): a few sessions' agents kept, for half an hour. */
export const POD_AGENT_CACHE = { max_size: 16, idle_ttl_secs: 1800 } as const;

/**
 * The browser for a turn (HE-S138, HE-S300; one-person.md OP-S113): the plugin's browser tools on the agent's Chromium
 * at the relay (`cdp_url`), which Hermes's vault fills logins on too; any address the commands' network allows
 * (`allow_private_urls`: the proxy decides, OP-S114). Without one, the toolset is off. No password manager of Hermes's
 * own: logins come from Whombat's Vault only (HE-S141).
 */
export function hermesBrowserConfig(browser: TurnBrowserAccess | null | undefined): Record<string, unknown> {
  return browser ? { cdp_url: browser.cdpUrl, allow_private_urls: true } : {};
}

/**
 * How long Hermes waits for an answer to its approval gate. The runner decides how long a person is waited for
 * (`WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`, at most two hours) and answers no itself after that.
 */
export const HERMES_APPROVAL_TIMEOUT_S = 2 * 3600;

/** `config.yaml` as an object (pure; the tests read it). */
export function hermesConfig(c: HermesProfileConfig): Record<string, unknown> {
  const claude = c.runtime === 'claude_directsdk';
  const provider = claude ? CLAUDE_DIRECTSDK_PROVIDER : CHATGPT_PROVIDER;
  const model = claude ? c.model || 'default' : (c.model ?? '');
  // In a pod the browser toolset is always there, at the pod's bridge; the turn's policy says whether it may be used.
  const browser = c.pod ? { cdpUrl: SANDBOX_BROWSER_ORIGIN, sites: null } : c.browser;
  const agent = {
    ...(c.effort ? { reasoning_effort: c.effort } : {}),
    disabled_toolsets: browser ? [HERMES_BROWSER_EXEC_TOOLSET] : [HERMES_BROWSER_EXEC_TOOLSET, 'browser'],
    // Hermes's words for its tiers (`agent/fast_mode.py`): `fast` is the priority tier, `normal` none.
    ...(!claude && typeof c.fast === 'boolean' ? { service_tier: c.fast ? 'fast' : 'normal' } : {}),
    ...(c.pod ? { agent_cache: { ...POD_AGENT_CACHE } } : {}),
  };
  return {
    model: { provider, default: model },
    agent,
    plugins: hermesPlugins(claude || Boolean(c.pod), Boolean(c.pod)),
    terminal: { backend: COMMANDS_BACKEND },
    // The agent's Chromium is Whombat's (the CDP bridge, one-person.md OP-S113): Hermes's browser stays where Hermes
    // runs, never in the commands' wrapper (which declares `supports_streams` for `exec_prefix`).
    bot_desktop: { placement: 'gateway' },
    // Hermes's own logins stay its own: never another program's (`~/.codex`, `~/.claude`), never the root's.
    auth: { adopt_external_logins: false },
    approvals: { mode: 'manual', timeout: HERMES_APPROVAL_TIMEOUT_S },
    compression: { enabled: true },
    auxiliary: {
      title_generation: { enabled: false },
      // Compression stays on the same subscription provider and model; the review takes the turn's (`auto`).
      compression: { provider, model },
      background_review: { enabled: !c.outside },
    },
    curator: { enabled: false },
    memory: { memory_enabled: !c.outside, user_profile_enabled: !c.outside },
    browser: hermesBrowserConfig(browser),
    ...(!c.pod && c.mcpServers && Object.keys(c.mcpServers).length ? { mcp_servers: c.mcpServers } : {}),
    // Whombat's logins are the plugin's login backend `wb` (its handles' prefix, vault-simplify.md VLT-20), never in an
    // outsiders' profile; password managers stay off.
    vault: { wb: { enabled: !c.outside }, onepassword: { enabled: false }, bitwarden: { enabled: false } },
    // Skills in the profile's own `skills/` (OP-08), as Hermes keeps them.
    skills: hermesSkillsConfig(c.disabledSkills),
    tools: { tool_search: { enabled: 'off' }, connectors: { enabled: false } },
    // Hermes's footer after a failed file write is developer text, and it makes the finished reply differ from what
    // streamed, so the whole reply went out again under it. The agent sees the failed write in the tool's result.
    display: { busy_input_mode: 'steer', file_mutation_verifier: false },
    updates: { check: false },
    model_catalog: { enabled: false },
    // Hermes's own traffic off (stream N, NX-43x): models.dev refused at once, no update checks of plugins on PyPI, no
    // keyless web search of its own. Web search only on the person's own Brave key (web-search.md).
    models_dev: { url: 'http://127.0.0.1:9/' },
    web: { keyless_fallback: false, ...(c.webSearch ? { search_backend: WEB_SEARCH_PROVIDER } : {}) },
    telemetry: { shared_metrics: { enabled: false, send: false } },
    security: { allow_lazy_installs: false },
    lsp: { enabled: false },
    kanban: { dispatch_in_gateway: false, notify_in_gateway: false },
    nous: { keepalive_interval_seconds: 0 },
    // A `profiles/<name>` home gets a gateway of its own only when standalone (else Hermes waits for the root's
    // multiplexer, never in the sandbox); it ends with the turn anyway (HE-S20), or in a pod when the runner stops the
    // pod (HN-W11: Hermes's own idle exit off).
    // Never delayed for starting often (HE-37; Hermes delays the 6th start in 120 s otherwise).
    gateway: {
      standalone: true,
      unmanaged_idle_exit_seconds: c.pod ? 0 : 60,
      respawn_storm: { max_starts: 0 },
    },
  };
}

/** The plugin's web search backend (`whombat_hermes/web_search.py`): Hermes's Brave backend on the key file. */
export const WEB_SEARCH_PROVIDER = 'whombat-brave';
/** The person's Brave Search key for the turn, in the profile (0600), never in `config.yaml` or the environment. */
export const WEB_SEARCH_KEY_FILE = 'whombat-web-search.key';

/** Whombat's plugin as Hermes knows it (its entry point). */
const WHOMBAT_PLUGIN = 'whombat';

/** The plugins: Whombat's, and Nous's DirectSDK provider where a Claude session may run (a Claude turn, a pod). */
export function hermesPlugins(directsdk: boolean, pod = false): Record<string, unknown> {
  // Whombat's plugin wraps `browser_vault` so Hermes's prompts ask the person on a card (VLT-45): Hermes's override door,
  // granted the way Hermes's own consent records it (the capability, and the older `allow_tool_override` key beside it,
  // which Hermes's error asks for and some of its checks still read). Written every turn, so every profile has it.
  const whombat = {
    [WHOMBAT_PLUGIN]: { granted_capabilities: ['tools.override'], allow_tool_override: true },
  };
  const plugins = directsdk
    ? {
        enabled: [WHOMBAT_PLUGIN, CLAUDE_DIRECTSDK_PROVIDER],
        auto_update_check_hours: 0,
        entries: { ...whombat, [CLAUDE_DIRECTSDK_PROVIDER]: { settings: { claude_code_telemetry: false } } },
      }
    : { enabled: [WHOMBAT_PLUGIN], auto_update_check_hours: 0, entries: whombat };
  // Every session in a pod can use the gateway, including a review after a turn on another provider (HN-W09).
  return pod ? claudeGatewayPlugins(plugins, `${SANDBOX_GATEWAY_ORIGIN}/ai-gateway/claude`, true) : plugins;
}

/** What Whombat writes for a session in a pod (HN-W06): `whombat-turns/<session>/`. */
export const HERMES_TURNS_DIR = 'whombat-turns';
export const SESSION_POLICY_FILE = 'policy.json';
export const SESSION_LOGINS_FILE = 'logins.json';

/** A Hermes session id as a folder name (the plugin's own check, `settings.valid_session`). */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * The files of a turn's session in its person's pod (HN-W06): its tool policy, and its logins (entry, name, origin,
 * username, `otp`; never a secret), which the plugin's hook and Hermes's vault read by the session a call runs in. The
 * logins go when the turn ends (the runner's `PodManager`), the policy stays for the review after the answer.
 */
export async function writeSessionFiles(
  profile: string,
  session: string,
  files: { policy: HermesPolicy; logins: TurnBrowserAccess['logins'] | null },
): Promise<void> {
  if (!SESSION_ID.test(session) || session === '.' || session === '..')
    throw new Error('Hermes named a session Whombat can’t keep files for.');
  const dir = join(profile, HERMES_TURNS_DIR, session);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(join(dir, SESSION_POLICY_FILE), hermesPolicyJson(files.policy), 0o600);
  const logins = files.logins ?? [];
  if (logins.length) {
    const listed = logins.map(({ entryId, name, origin, username, otp }) => ({
      entryId,
      name,
      origin,
      username,
      otp,
    }));
    await writeAtomic(join(dir, SESSION_LOGINS_FILE), `${JSON.stringify({ logins: listed })}\n`, 0o600);
  } else await rm(join(dir, SESSION_LOGINS_FILE), { force: true });
}

/**
 * The providers the pod's `config.yaml` names already (HN-W09): a session keeps its route, and the providers of the
 * person's other sessions stay defined beside the turn's (`whombat-*` entries only: Hermes's own are named in `model`).
 */
async function podProviders(profile: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(join(profile, 'config.yaml'), 'utf8');
    const parsed = JSON.parse(text.replace(/^#.*\n/, '')) as { providers?: unknown };
    const providers = parsed.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {};
    return Object.fromEntries(
      Object.entries(providers as Record<string, unknown>).filter(([name]) =>
        name.startsWith(HERMES_LOOP_PROVIDER_PREFIX),
      ),
    );
  } catch {
    return {};
  }
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.whombat-${process.pid}`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/** The turn's logins for Hermes's credential vault (our plugin's `logins.py`, HE-S141): no secret in it. */
export const LOGINS_FILE = 'whombat-logins.json';
/** Hermes's own credential store in a profile (`$HERMES_HOME/vault`): never Whombat's, wiped after every turn. */
export const HERMES_VAULT_DIR = 'vault';

/**
 * What of a turn's logins stays in the profile after it: nothing (HE-S141). The logins file goes, and Hermes's own
 * credential store with whatever the agent saved there (a login lives in Whombat's Vault, HE-43).
 */
export async function clearHermesLogins(profile: string): Promise<void> {
  await rm(join(profile, LOGINS_FILE), { force: true });
  await rm(join(profile, HERMES_VAULT_DIR), { recursive: true, force: true });
}

/**
 * Writes the turn's `config.yaml`, `SOUL.md` and `whombat.md` into `profile` and clears what a Hermes before it may
 * have left of a review (`HERMES_REVIEW_DIR`). `loop`: the turn runs on another source than the person's subscription
 * (the person's API key, the AI gateway, a model on the home network: HE-32, `hermesLoopConfig`); `assessment`: a
 * Feedback assessment, read-only (HE-36, `hermesAssessmentConfig`). Returns the provider and model the config names:
 * what a resumed session must run on (hermes-native.md HN-07, `sessionFit`).
 */
export async function writeHermesProfile(
  profile: string,
  c: HermesProfileConfig,
  extras: {
    soul: string;
    whombat: string;
    /** `whombat-notes.md`, the person's notes (HE-S120); empty: none, and the file goes. */
    notes?: string;
    loop?: HermesLoopSource | null;
    assessment?: boolean;
    /** The turn's tool policy (`hermesPolicy`); absent: none is written (the plugin then allows every tool). */
    policy?: HermesPolicy;
    /** The person's Brave Search key while `c.webSearch` is on; otherwise the key file goes. */
    webSearchKey?: string | null;
  },
): Promise<HermesRoute> {
  const base = hermesConfig(c);
  const looped = extras.loop ? hermesLoopConfig(base, extras.loop, { pod: Boolean(c.pod) }) : base;
  const assessed = extras.assessment
    ? hermesAssessmentConfig(looped, c.runtime, { browser: Boolean(c.browser) })
    : looped;
  const config = c.pod
    ? {
        ...assessed,
        providers: {
          ...(await podProviders(profile)),
          ...((assessed.providers as Record<string, unknown> | undefined) ?? {}),
        },
      }
    : assessed;
  const yaml = `# Written by Whombat before every turn; changes here are overwritten.\n${JSON.stringify(config, null, 2)}\n`;
  await writeAtomic(join(profile, 'config.yaml'), yaml, 0o600);
  if (extras.policy)
    await writeAtomic(join(profile, HERMES_POLICY_FILE), hermesPolicyJson(extras.policy), 0o600);
  await writeAtomic(join(profile, 'SOUL.md'), `${extras.soul.trim()}\n`, 0o600);
  await writeAtomic(
    join(profile, 'whombat.md'),
    `${extras.whombat.trim().slice(0, WHOMBAT_MD_MAX)}\n`,
    0o600,
  );
  const searchKey = c.webSearch ? (extras.webSearchKey?.trim() ?? '') : '';
  if (searchKey) await writeAtomic(join(profile, WEB_SEARCH_KEY_FILE), `${searchKey}\n`, 0o600);
  else await rm(join(profile, WEB_SEARCH_KEY_FILE), { force: true });
  const notes = extras.notes?.trim().slice(0, WHOMBAT_MD_MAX) ?? '';
  if (notes) await writeAtomic(join(profile, 'whombat-notes.md'), `${notes}\n`, 0o600);
  else await rm(join(profile, 'whombat-notes.md'), { force: true });
  // In a pod the logins and the policy are the session's (`writeSessionFiles`), and a review marker may be another
  // session's, running now (HN-W13).
  if (c.pod) return hermesRouteOf(config);
  // The turn's logins (HE-S141): only with its browser, only this turn's.
  const logins = c.browser?.logins ?? [];
  if (logins.length) {
    const listed = logins.map(({ entryId, name, origin, username, otp }) => ({
      entryId,
      name,
      origin,
      username,
      otp,
    }));
    await writeAtomic(join(profile, LOGINS_FILE), `${JSON.stringify({ logins: listed })}\n`, 0o600);
  } else await clearHermesLogins(profile);
  // No Hermes runs in the profile now (its lock is held): a marker left here is a killed Hermes's, not a review.
  await rm(join(profile, HERMES_REVIEW_DIR), { recursive: true, force: true });
  return hermesRouteOf(config);
}
