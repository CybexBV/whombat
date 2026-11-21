/**
 * The model on the owner's network (Whombat hermes-engine.md HE-08, HE-32; CT-1170…CT-1179): an OpenAI-compatible
 * server (Ollama, LM Studio, vLLM, llama.cpp's server …) an owner points the Whombat at — the API's base URL, the model
 * to ask for, an optional name people read and an optional API key. One per burrow (`Burrow.localModel`); owners set,
 * test and clear it (`burrows.setLocalModel`, `burrows.testLocalModel`, `burrows.clearLocalModel`). An agent or a Chat
 * thread on the provider `local` runs on Hermes's own loop against it.
 *
 * The key stays on the server: it goes only to the runner, for the turn's Hermes (`LocalModelDispatchContext`), and
 * into a backup file. No client read model carries it (`LocalModelView.hasApiKey`). Pure: no DNS, no sockets; the
 * server resolves a name and checks every address it gets with `localModelAddressProblem`.
 */
import { z } from 'zod';
import { type AddressClass, classifyAddress, parseIp, parseVaultUrl } from '../vault/network.js';
import { Timestamp } from './common.js';
import { ModelId, PROVIDER_MODELS_MAX, type ProviderModel } from './models.js';

/** The longest base URL (the Vault's URL bound, `parseVaultUrl`). */
export const LOCAL_MODEL_URL_MAX = 2000;
/** The longest name people read for it (“Llama on the NAS”). */
export const LOCAL_MODEL_LABEL_MAX = 60;
/** The longest API key. */
export const LOCAL_MODEL_KEY_MAX = 4096;

/* The base URL ---------------------------------------------------------------------------------------------------- */

/**
 * Why a base URL can't be used: the URL itself (`invalid` … `path`, the Vault's URL rules: http or https, a host, an
 * optional port and a path, no credentials, query or fragment); `address` — the host is this Whombat itself or an
 * address no model is reached at (loopback, link-local, a cloud metadata endpoint, multicast, reserved or documentation
 * space, `localhost`); `http_public` — plain http to an address on the internet (the key would cross it in the clear).
 * A private address (RFC 1918), Tailscale's (100.64.0.0/10, fd7a:115c:a1e0::/48) and any host name are fine: the
 * model is on the owner's network.
 */
export const LOCAL_MODEL_URL_PROBLEMS = [
  'invalid',
  'scheme',
  'credentials',
  'query',
  'host',
  'port',
  'path',
  'address',
  'http_public',
] as const;
export const LocalModelUrlProblem = z.enum(LOCAL_MODEL_URL_PROBLEMS);
export type LocalModelUrlProblem = z.infer<typeof LocalModelUrlProblem>;

export const LOCAL_MODEL_URL_PROBLEM_TEXT: Readonly<Record<LocalModelUrlProblem, string>> = {
  invalid:
    'That isn’t a web address. Write it like https://api.example.com/v1 or http://192.168.1.20:11434/v1.',
  scheme: 'Use an address that starts with http:// or https://.',
  credentials: 'Leave the username and password out of the address. Put a key under API key instead.',
  query: 'Leave ?… and #… out of the address.',
  host: 'That address has no valid host name.',
  port: 'That address has no valid port.',
  path: 'That address has a path Whombat can’t use (no “..”, “//” or encoded slashes).',
  address: 'Use an internet https:// address or a server on your own network, like 192.168.1.20.',
  http_public: 'Use https:// for a model on the internet.',
};

/** Address classes a model may be reached at: the owner's network, or the internet over https. */
const USABLE: readonly AddressClass[] = ['private', 'public'];

/**
 * Why the addresses a base URL's host has can't be used, or null (`address`, `http_public`). The server calls it with
 * the addresses a name resolved to, before every test and turn; `localModelUrlProblem` calls it for an IP literal.
 */
export function localModelAddressProblem(
  scheme: 'http' | 'https',
  addresses: readonly string[],
): 'address' | 'http_public' | null {
  if (addresses.length === 0) return 'address';
  for (const text of addresses) {
    const address = parseIp(text);
    if (!address) return 'address';
    const cls = classifyAddress(address);
    if (!USABLE.includes(cls)) return 'address';
    if (cls === 'public' && scheme === 'http') return 'http_public';
  }
  return null;
}

/**
 * Why a base URL can't be used, or null (`LOCAL_MODEL_URL_PROBLEMS`). An IP literal is checked here; a host name is
 * checked again by the server once resolved (`localModelAddressProblem`).
 */
export function localModelUrlProblem(raw: string): LocalModelUrlProblem | null {
  const parsed = parseVaultUrl(raw);
  if (!parsed.ok) return parsed.code;
  const { scheme, host, hostKind } = parsed.url;
  if (hostKind === 'name') return host === 'localhost' || host.endsWith('.localhost') ? 'address' : null;
  return localModelAddressProblem(scheme, [host]);
}

/**
 * An OpenAI-compatible API's base, as owners type it (`http://192.168.1.20:11434/v1`, `https://llm.tailnet.ts.net/v1`):
 * trimmed, and usable (`localModelUrlProblem`; the message is `LOCAL_MODEL_URL_PROBLEM_TEXT`'s).
 */
export const LocalModelBaseUrl = z
  .string()
  .trim()
  .min(1)
  .max(LOCAL_MODEL_URL_MAX)
  .superRefine((raw, ctx) => {
    const problem = localModelUrlProblem(raw);
    if (problem) ctx.addIssue({ code: 'custom', message: LOCAL_MODEL_URL_PROBLEM_TEXT[problem] });
  });

/** The name people read for it (“Llama on the NAS”); absent: the model's own name. */
export const LocalModelLabel = z.string().trim().min(1).max(LOCAL_MODEL_LABEL_MAX);

/** The API key the server asks for, if it asks for one (sent as `Authorization: Bearer …`). */
export const LocalModelApiKey = z.string().trim().min(1).max(LOCAL_MODEL_KEY_MAX);

/* Checking it ----------------------------------------------------------------------------------------------------- */

/**
 * How the last test went (`burrows.testLocalModel`, and the check `burrows.setLocalModel` runs): `ok` — it answered and
 * serves the model; `unreachable` — no answer (refused, timed out, the name didn't resolve, TLS failed); `refused` — it
 * turned Whombat away (401, 403: the key); `no_model` — it answered but doesn't serve that model; `not_compatible` — it
 * answered, but not as an OpenAI-compatible API does; `blocked` — the name resolved to an address Whombat doesn't send a
 * model's traffic to (`localModelAddressProblem`).
 */
export const LOCAL_MODEL_CHECK_STATES = [
  'ok',
  'unreachable',
  'refused',
  'no_model',
  'not_compatible',
  'blocked',
] as const;
export const LocalModelCheckState = z.enum(LOCAL_MODEL_CHECK_STATES);
export type LocalModelCheckState = z.infer<typeof LocalModelCheckState>;

/** A test's result. */
export const LocalModelCheck = z.object({
  state: LocalModelCheckState,
  at: Timestamp,
  /** The models the server listed (`GET <base>/models`), as it named them; empty when it listed none. */
  models: z.array(ModelId).max(PROVIDER_MODELS_MAX),
  /** What the server or the network said, for owners (an HTTP status, a refused connection); null when `ok`. */
  detail: z.string().max(500).nullable(),
});
export type LocalModelCheck = z.infer<typeof LocalModelCheck>;

/* What people read ------------------------------------------------------------------------------------------------ */

/**
 * `Burrow.localModel`: the burrow's model on its network as everyone in the burrow reads it (Settings → AI, the agent's
 * model, the Chat picker), never its key: only whether there is one.
 */
export const LocalModelView = z.object({
  baseUrl: z.string().min(1).max(LOCAL_MODEL_URL_MAX),
  /** The model a turn asks for when the agent or the thread names none. */
  model: ModelId,
  label: z.string().max(LOCAL_MODEL_LABEL_MAX).nullable(),
  hasApiKey: z.boolean(),
  /** The last test; null: not tested since it was set. */
  check: LocalModelCheck.nullable(),
  updatedAt: Timestamp,
});
export type LocalModelView = z.infer<typeof LocalModelView>;

/** Its name as people read it: the label, else the model. */
export function localModelName(view: Pick<LocalModelView, 'model' | 'label'>): string {
  return view.label ?? view.model;
}

/**
 * The models an agent or a thread can pick for `local` (CT-1173): the burrow's own model first (the default, its name
 * the label), then the others its last test listed. They take no effort and have no fast replies: none is sent. Any
 * other name may still be typed (a model id is free text); empty without a local model.
 */
export function localProviderModels(
  view: Pick<LocalModelView, 'model' | 'label' | 'check'> | null | undefined,
): ProviderModel[] {
  if (!view) return [];
  const ids = [view.model, ...(view.check?.models ?? []).filter((m) => m !== view.model)];
  // A model's label is at most 60 characters (`ProviderModel.label`); its id may be longer.
  const label = (name: string) => (name.length > 60 ? `${name.slice(0, 59)}…` : name);
  return ids.slice(0, PROVIDER_MODELS_MAX).map((id) => ({
    id,
    label: label(id === view.model ? localModelName(view) : id),
    description: null,
    efforts: [],
    isDefault: id === view.model,
    fast: null,
  }));
}
