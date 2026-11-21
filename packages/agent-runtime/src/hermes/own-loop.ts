/**
 * Turns on Hermes's own loop (docs/decisions/hermes-engine.md HE-08, HE-32, HE-S48…S53): the person's API key, the
 * burrow's AI gateway, or a model on the person's network (`local`). Subscriptions are on Hermes's loop too, through
 * their own providers (`config.ts`: Nous's DirectSDK for Claude, Hermes's `openai-codex` for ChatGPT); this module
 * configures the API transports and the native Claude gateway provider.
 *
 * API routes name a provider in Hermes's `providers:` (`whombat-<kind>-<hex>`, `hermesLoopProviderName`); the native
 * Claude gateway names its own external-process provider. Neither adopts unrelated keys or programs' logins:
 *
 * - `key`: Anthropic's Messages API or an OpenAI-compatible one, at the provider's own URL (or one the person set); the
 *   key comes from a file through Hermes's `key_cmd` — the managed sandbox passes no variable named like a secret.
 * - `gateway`: Claude Code through DirectSDK, or Codex's Responses client, to the relay of the burrow's gateway
 *   (`/ai-gateway/claude`, `/ai-gateway/codex/v1`, AIG-09), through the sandbox's forwarder (`127.0.0.1:47104`, managed)
 *   or the server itself; the key is the turn's agent token (`WHOMBAT_MCP_TOKEN`), which the relay swaps for the
 *   gateway's own (it never reaches the sandbox).
 * - `local`: an OpenAI-compatible Chat Completions endpoint (base URL and model, set by the person), a key only when it
 *   needs one; the sandbox's egress lets the turn reach exactly that address and port (`modelEndpointAllowance`).
 *
 * Hermes's own terminal and file tools run in the commands' wrapper (`terminal.backend: whombat_commands`, HE-S11).
 * Claude gateway turns also load the DirectSDK plugin. Context compression and review stay on the same route/model.
 */
import { createHash } from 'node:crypto';
import { MCP_TOKEN_ENV } from '../support/env';
import { CLAUDE_GATEWAY_PROVIDER, claudeGatewayPlugins } from './claude';

/** What every provider entry a turn on Hermes's own loop uses starts with (`hermesLoopProviderName`). */
export const HERMES_LOOP_PROVIDER_PREFIX = 'whombat-';
/** `terminal.backend` of the plugin's commands backend (HE-S11, one-person.md OP-07). */
export const COMMANDS_BACKEND = 'whombat_commands';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const OPENAI_API = 'https://api.openai.com/v1';

/** Hermes's wire shapes (`model.api_mode` / a provider's `transport`). */
export type HermesTransport = 'anthropic_messages' | 'codex_responses' | 'chat_completions';

export type HermesLoopSource =
  | {
      kind: 'key';
      /** Anthropic's Messages API, or an OpenAI-compatible one. */
      api: 'anthropic' | 'openai';
      model: string;
      /** A file holding exactly the key (0600, readable in the turn's sandbox), read on each request. */
      keyFile: string;
      /** Another endpoint than the provider's own (an OpenAI-compatible service the person set). */
      baseUrl?: string;
    }
  | {
      kind: 'gateway';
      /** The agent's provider: Claude through Messages, Codex models through the Responses API. */
      provider: 'claude' | 'codex';
      model: string;
      /** Where the relay is: the sandbox's forwarder (`SANDBOX_GATEWAY_ORIGIN`) when managed, else the server. */
      origin: string;
    }
  | {
      kind: 'local';
      model: string;
      /** The OpenAI-compatible base URL, `/v1` included (`http://192.168.1.20:11434/v1`). */
      baseUrl: string;
      /** A key file when the endpoint wants one. */
      keyFile?: string;
    };

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * The key a pod's Hermes sends to the AI gateway (hermes-native.md HN-W08): a placeholder; the pod's forwarder puts the
 * agent token of the person's newest live gateway turn in its place, so no turn's token ever enters Hermes.
 */
export const POD_GATEWAY_KEY = 'whombat-pod';

/** Where a source's model requests go, in which wire shape, with which credential. */
function loopEndpoint(
  source: HermesLoopSource,
  pod = false,
): {
  baseUrl: string;
  transport: HermesTransport;
  credential: Record<string, string>;
} {
  const keyCmd = (file: string) => ({ key_cmd: `cat ${shellQuote(file)}` });
  switch (source.kind) {
    case 'key':
      return source.api === 'anthropic'
        ? {
            baseUrl: trimSlash(source.baseUrl ?? ANTHROPIC_API),
            transport: 'anthropic_messages',
            credential: keyCmd(source.keyFile),
          }
        : {
            baseUrl: trimSlash(source.baseUrl ?? OPENAI_API),
            // OpenAI's own API takes the Responses API; another OpenAI-compatible service Chat Completions.
            transport:
              source.baseUrl && trimSlash(source.baseUrl) !== OPENAI_API
                ? 'chat_completions'
                : 'codex_responses',
            credential: keyCmd(source.keyFile),
          };
    case 'gateway': {
      const credential: Record<string, string> = pod
        ? { api_key: POD_GATEWAY_KEY }
        : { key_env: MCP_TOKEN_ENV };
      return source.provider === 'claude'
        ? {
            baseUrl: `${trimSlash(source.origin)}/ai-gateway/claude`,
            transport: 'anthropic_messages',
            credential,
          }
        : {
            baseUrl: `${trimSlash(source.origin)}/ai-gateway/codex/v1`,
            transport: 'codex_responses',
            credential,
          };
    }
    case 'local':
      return {
        baseUrl: trimSlash(source.baseUrl),
        transport: 'chat_completions',
        credential: source.keyFile ? keyCmd(source.keyFile) : { api_key: 'no-key-required' },
      };
  }
}

/**
 * The provider entry's name for an API source (hermes-native.md HN-L06): `whombat-<kind>-<8 hex>`, the hex from its endpoint
 * and wire shape (`whombat-key-…`, `whombat-gateway-…`, `whombat-local-…`). Hermes keeps a session's provider, endpoint
 * and model from when it began (HN-07), and says only the provider's name and the model when it resumes one: another
 * endpoint (Claude's key after OpenAI's, the gateway after a key, a moved model on the network) must be another name for
 * the runner to see the session is on another route (`sessionFit`). Native Claude gateway turns use their own fixed
 * external-process provider, distinct from the old API route and from the person's subscription (CDS-04).
 */
export function hermesLoopProviderName(source: HermesLoopSource): string {
  if (source.kind === 'gateway' && source.provider === 'claude') return CLAUDE_GATEWAY_PROVIDER;
  const { baseUrl, transport } = loopEndpoint(source);
  const hex = createHash('sha256').update(`${baseUrl}|${transport}`).digest('hex').slice(0, 8);
  return `${HERMES_LOOP_PROVIDER_PREFIX}${source.kind}-${hex}`;
}

/** Hermes's provider entry for a source (`providers.<hermesLoopProviderName>`); `pod`: in a person's pod (HN-W08). */
export function hermesLoopProvider(source: HermesLoopSource, pod = false): Record<string, unknown> {
  const { baseUrl, transport, credential } = loopEndpoint(source, pod);
  return {
    name: hermesLoopProviderName(source),
    base_url: baseUrl,
    transport,
    default_model: source.model,
    ...credential,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `base` (a turn's `config.yaml` object, `hermesConfig`) as a turn on Hermes's own loop. `model` is replaced as a
 * whole — a subscription's provider left there would run the turn on the person's subscription. Plugins keep the
 * commands/policy hook, plus DirectSDK for the native Claude gateway (or a pod's other sessions). Pure.
 */
export function hermesLoopConfig(
  base: Record<string, unknown>,
  source: HermesLoopSource,
  options: { pod?: boolean } = {},
): Record<string, unknown> {
  const auxiliary = isObject(base.auxiliary) ? base.auxiliary : {};
  const terminal = isObject(base.terminal) ? base.terminal : {};
  const name = hermesLoopProviderName(source);
  const nativeGateway = source.kind === 'gateway' && source.provider === 'claude';
  const plugins = options.pod
    ? (base.plugins as Record<string, unknown>)
    : {
        enabled: ['whombat'],
        auto_update_check_hours: 0,
      };
  // Fast replies are a subscription's (chat-runtime.md CR-06): never through a key, the gateway or a local model.
  const { service_tier: _fast, ...agent } = isObject(base.agent) ? base.agent : {};
  return {
    ...base,
    ...(isObject(base.agent) ? { agent } : {}),
    model: { provider: name, default: source.model },
    providers: nativeGateway ? {} : { [name]: hermesLoopProvider(source, options.pod) },
    // A pod's gateway serves the person's Claude sessions too (HN-W09): its plugins stay.
    plugins: nativeGateway
      ? claudeGatewayPlugins(plugins, loopEndpoint(source).baseUrl, Boolean(options.pod))
      : plugins,
    terminal: { ...terminal, backend: COMMANDS_BACKEND },
    // Hermes keeps the context itself here, on the same model.
    compression: { enabled: true },
    auxiliary: {
      ...auxiliary,
      title_generation: { enabled: false },
      compression: { provider: name, model: source.model },
      // `auto`: the turn's own model, replaying the conversation.
      background_review: { enabled: true },
    },
  };
}

/** The endpoint a source's model requests leave the sandbox for (null: the relay, through the forwarder). */
export function hermesLoopEndpoint(source: HermesLoopSource): string | null {
  switch (source.kind) {
    case 'key':
      return source.baseUrl ?? (source.api === 'anthropic' ? ANTHROPIC_API : OPENAI_API);
    case 'gateway':
      return null;
    case 'local':
      return source.baseUrl;
  }
}
