/**
 * Testing the model on the person's network (docs/decisions/hermes-engine.md HE-S55, HE-S90…; contracts CT-1171): its
 * model list (`checkLocalModel`, `GET <base>/models`) and one short completion, at most 20 s together. Every request
 * goes through `lib/outbound.ts` with a destination rule: the host is resolved once, every address it has is checked
 * with core's `localModelAddressProblem` (never loopback, link-local, metadata or special space; plain http only on the
 * person's network) and the socket dials one of exactly those addresses, so a rebinding answer can't slip through. No
 * redirect is followed.
 *
 * The same address rule runs when a turn on `local` starts (`localModelDispatch`): its context carries the model and
 * key only while the host still resolves somewhere Whombat sends a model's traffic.
 *
 * Tests reach a fake model on 127.0.0.1 only through `useLocalModelNetForTests` (refused outside `NODE_ENV=test`): a
 * resolver and a dial map, so the fake stands behind a home-network address the real checks accept.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { checkLocalModel, LOCAL_MODEL_CHECK_MS } from '@whombat/agent-runtime';
import {
  type LocalModelCheck,
  type LocalModelCheckState,
  type LocalModelDispatchContext,
  localModelAddressProblem,
  ModelId,
  PROVIDER_MODELS_MAX,
  parseVaultUrl,
} from '@whombat/core';
import { OutboundError, type OutboundPolicy, outboundErrorOf, outboundRequest } from '../lib/outbound';
import type { Services } from '../services';

/** The longest a test takes, the model list and the completion together (`burrows.testLocalModel`). */
export const LOCAL_MODEL_TEST_MS = 20_000;
/** The longest a turn's start waits for the host's addresses. */
const TURN_RESOLVE_MS = 2_000;
/** The most bytes read of an answer (a long model list). */
const ANSWER_MAX_BYTES = 2 * 1024 * 1024;
/** `LocalModelCheck.detail`'s bound. */
const DETAIL_MAX = 500;

/** DNS for the local model, and (tests only) where a checked address is really dialled. */
export interface LocalModelNet {
  resolve(hostname: string): Promise<{ address: string; family: number }[]>;
  dialAddress?: (address: string) => string;
  /** Tests only: a shorter whole test than `LOCAL_MODEL_TEST_MS`. */
  testMs?: number;
}

const systemNet: LocalModelNet = {
  resolve: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
};

const overrides = new WeakMap<Services, LocalModelNet>();

/** Tests only: a fake model on 127.0.0.1 behind a home-network address. Refused outside `NODE_ENV=test`. */
export function useLocalModelNetForTests(services: Services, net: LocalModelNet): void {
  if (services.config.NODE_ENV !== 'test')
    throw new Error('The local model’s network seam is for tests only.');
  overrides.set(services, net);
}

function netOf(services: Services): LocalModelNet {
  return overrides.get(services) ?? systemNet;
}

/** What a test asks: the base URL, the model and the key it sends. */
export interface LocalModelTarget {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

/** How the model list went (`checkLocalModel`), with what the network or the server said. */
export type LocalModelListing =
  | { ok: true; models: string[] }
  | {
      ok: false;
      reason: 'bad_url' | 'unreachable' | 'refused' | 'not_openai';
      blocked: boolean;
      detail: string | null;
    };

/** How the short completion went; null: not tried (no time left). */
export type LocalModelCompletion =
  | { kind: 'answered' }
  | { kind: 'status'; status: number; detail: string | null }
  | { kind: 'failed'; detail: string | null }
  | null;

/** A text for the person, one line, within `LocalModelCheck.detail`'s bound. */
function detailText(text: string | null | undefined): string | null {
  if (!text) return null;
  // Control characters (a server's own error text) become spaces.
  const flat = [...text].map((c) => (c < ' ' || c === '\u007f' ? ' ' : c)).join('');
  const line = flat
    .replace(/\s+/g, ' ')
    .replace(/^Error: /, '')
    .trim();
  return line ? line.slice(0, DETAIL_MAX) : null;
}

/**
 * The test's result (`LocalModelCheck`, CT-1171) from its two steps: the model list decides whether the server answers
 * as an OpenAI-compatible API (`unreachable`, `refused`, `not_compatible`, `blocked`); the completion then decides —
 * an answer is `ok`; a 401 or 403 `refused`; any other status `no_model` for a model the list doesn't name, else
 * `not_compatible` with what the server said; no answer in time is `ok` for a model the list names (a big model still
 * loading) and `no_model` otherwise.
 */
export function localModelCheckOf(
  model: string,
  listing: LocalModelListing,
  completion: LocalModelCompletion,
  at: string,
): LocalModelCheck {
  const result = (state: LocalModelCheckState, models: string[], detail: string | null): LocalModelCheck => ({
    state,
    at,
    models,
    detail: state === 'ok' ? null : detailText(detail),
  });
  if (!listing.ok) {
    if (listing.blocked) return result('blocked', [], listing.detail);
    switch (listing.reason) {
      case 'refused':
        return result('refused', [], listing.detail);
      case 'not_openai':
        return result('not_compatible', [], listing.detail);
      default:
        return result('unreachable', [], listing.detail);
    }
  }
  const models = listing.models
    .filter((m) => ModelId.safeParse(m).success && m.trim() === m)
    .slice(0, PROVIDER_MODELS_MAX);
  const listed = listing.models.includes(model);
  if (!completion) return result(listed ? 'ok' : 'no_model', models, null);
  switch (completion.kind) {
    case 'answered':
      return result('ok', models, null);
    case 'status':
      if (completion.status === 401 || completion.status === 403)
        return result('refused', models, completion.detail);
      return result(listed ? 'not_compatible' : 'no_model', models, completion.detail);
    case 'failed':
      return result(listed ? 'ok' : 'no_model', models, completion.detail);
  }
}

/** The destination rule of a model's requests: every address its host has must be one a model is reached at. */
function policyOf(net: LocalModelNet, baseUrl: string, deadlineMs: number): OutboundPolicy {
  const scheme = baseUrl.trim().toLowerCase().startsWith('https:') ? 'https' : 'http';
  return {
    destination: {
      schemes: ['http:', 'https:'],
      check(hostname, addresses) {
        const problem = localModelAddressProblem(scheme, addresses);
        if (problem)
          throw new OutboundError(
            'destination',
            problem === 'http_public'
              ? `${hostname} is on the internet: use https.`
              : `${hostname} isn’t an address Whombat can reach for a custom AI model.`,
          );
      },
    },
    resolve: net.resolve,
    ...(net.dialAddress ? { dialAddress: net.dialAddress } : {}),
    deadlineMs,
    timeoutMs: deadlineMs,
    maxBytes: ANSWER_MAX_BYTES,
  };
}

/** What an error answer says: an OpenAI-style `error.message`, else the start of the body. */
function answerDetail(status: number, body: Buffer): string {
  const text = body.toString('utf8');
  let said: string | null = null;
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    const error = json.error as { message?: unknown } | string | undefined;
    said =
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : typeof json.message === 'string'
            ? json.message
            : typeof json.detail === 'string'
              ? json.detail
              : null;
  } catch {
    said = text.slice(0, 200);
  }
  return said ? `HTTP ${status}: ${said}` : `HTTP ${status}`;
}

/** Tests a model: its list, then one short completion, within `LOCAL_MODEL_TEST_MS` (`testMs` in tests). */
export async function testLocalModel(services: Services, target: LocalModelTarget): Promise<LocalModelCheck> {
  const net = netOf(services);
  const total = net.testMs ?? LOCAL_MODEL_TEST_MS;
  const started = Date.now();
  const headers: Record<string, string> = target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {};
  const listMs = Math.min(LOCAL_MODEL_CHECK_MS, total);

  // The list, through `checkLocalModel`, with what went wrong kept for the person.
  let blocked = false;
  let failure: string | null = null;
  let status: number | null = null;
  const listed = await checkLocalModel(target.baseUrl, {
    timeoutMs: listMs,
    ...(target.apiKey ? { key: target.apiKey } : {}),
    fetch: async (url, init) => {
      try {
        const res = await outboundRequest(
          url,
          { method: init.method ?? 'GET', headers: { accept: 'application/json', ...headers } },
          policyOf(net, target.baseUrl, listMs),
        );
        status = res.status;
        return { status: res.status, json: async () => JSON.parse(res.body.toString('utf8')) as unknown };
      } catch (err) {
        const e = outboundErrorOf(err);
        blocked = e.reason === 'destination';
        failure = e.message;
        throw e;
      }
    },
  });
  const listing: LocalModelListing = listed.ok
    ? listed
    : {
        ok: false,
        reason: listed.reason,
        blocked,
        detail: failure ?? (status !== null ? `HTTP ${status}` : null),
      };

  // One short completion, in the time left.
  let completion: LocalModelCompletion = null;
  const left = total - (Date.now() - started);
  if (listing.ok && left >= 500) {
    const base = target.baseUrl.trim().replace(/\/+$/, '');
    try {
      const res = await outboundRequest(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify({
            model: target.model,
            messages: [{ role: 'user', content: 'Say OK.' }],
            max_tokens: 1,
            stream: false,
          }),
        },
        policyOf(net, target.baseUrl, left),
      );
      if (res.status >= 200 && res.status < 300) {
        let choices: unknown = null;
        try {
          choices = (JSON.parse(res.body.toString('utf8')) as { choices?: unknown }).choices;
        } catch {
          choices = null;
        }
        completion = Array.isArray(choices)
          ? { kind: 'answered' }
          : {
              kind: 'status',
              status: res.status,
              detail: 'The answer to a short question had no reply in it.',
            };
      } else completion = { kind: 'status', status: res.status, detail: answerDetail(res.status, res.body) };
    } catch (err) {
      completion = { kind: 'failed', detail: outboundErrorOf(err).message };
    }
  }
  return localModelCheckOf(target.model, listing, completion, services.clock().toISOString());
}

/**
 * `DispatchContext.localModel` of a turn on `local` (CT-1172): the burrow's base URL and key, and the model the turn asks
 * for (`turnModel`, the thread's or the agent's, else the burrow's own). Null without a model on the network, and when
 * its host now resolves somewhere Whombat doesn't send a model's traffic (`localModelAddressProblem`). A name that
 * doesn't resolve here is passed on: the turn's own egress resolves it again.
 */
export async function localModelDispatch(
  services: Services,
  stored: { baseUrl: string; model: string } | null,
  key: string | null,
  turnModel: string | null | undefined,
): Promise<LocalModelDispatchContext | null> {
  if (!stored) return null;
  const model = turnModel && ModelId.safeParse(turnModel).success ? turnModel.trim() : stored.model;
  const parsed = parseVaultUrl(stored.baseUrl);
  if (!parsed.ok) return null;
  const { scheme, host, hostKind } = parsed.url;
  let addresses: string[] | null = hostKind === 'name' ? null : [host];
  if (hostKind === 'name') {
    let timer: NodeJS.Timeout | undefined;
    const found = await Promise.race([
      netOf(services)
        .resolve(host)
        .then((all) => all.map((a) => a.address))
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TURN_RESOLVE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    addresses = found;
  }
  if (addresses && localModelAddressProblem(scheme, addresses)) {
    services.log.warn({ host }, 'the local model’s address is not one a turn may reach');
    return null;
  }
  return { v: 1, baseUrl: stored.baseUrl, model, defaultModel: stored.model, apiKey: key };
}
