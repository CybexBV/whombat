/**
 * The AI gateway relay (docs/decisions/ai-gateway.md AIG-08, AIG-09): `ALL /ai-gateway/:provider/*`. A gateway turn's
 * CLI (through the sandbox's loopback bridge and the runner's forwarder on an appliance, directly when self-hosted)
 * sends its Anthropic Messages or OpenAI Responses requests here with the turn's agent token as its key; the relay
 * checks that turn and streams the request to the burrow's gateway with Whombat's key, and the answer back, unbuffered.
 *
 * - `api/hello` (Claude Code's reachability ping) answers 200 here, without a key and without reaching the gateway.
 * - The key (`Authorization: Bearer` or `x-api-key`) is the dispatch's agent token: 401 when it isn't one (unknown or
 *   expired), 409 when its turn isn't running any more, 403 when the turn doesn't go through the gateway or for another
 *   provider (`dispatches.gateway_provider`, set at claim), 404 for any path outside the provider's allow list.
 * - Upstream: the connection's base URL with the path below `/ai-gateway/<provider>` and the query as sent, under the
 *   connection's destination policy (home networks or the LAN switch, a pinned certificate) with no total deadline, a
 *   10-minute idle timeout and a 64 MiB request body (413 beyond). The caller's credential, hop-by-hop headers and any
 *   `x-fusebox-*` are dropped; `Authorization: Bearer <client key>` is set (none for an open Fusebox).
 * - The account that answered (`x-fusebox-account`) is recorded on the dispatch (`gateway_account`).
 * - A failure before the gateway answered is a 502 in the provider's error shape naming the gateway; after, the stream
 *   is cut (the CLI fails the turn as any provider error). One that couldn't get to the gateway at all, while the CLI
 *   still waited, makes it count as unreachable at once (`noteRelayFailure`): the turn's retry and the next turns run
 *   on the person's own sign-in.
 *
 * Every refusal is in the provider's error shape too (Anthropic's for Claude Code, OpenAI's for Codex), so the CLI says
 * what happened. Not under `/internal/`, served on the appliance's loopback listener (`isApplianceLocalPath`), no body
 * parser (the body streams).
 */
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { AI_GATEWAY_RELAY_PREFIX, aiGatewayRelayRoute, type GatewayProvider } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { agentTokenDispatch, slideAgentToken } from '../auth/agent-tokens';
import { bearerOf } from '../auth/request';
import { connectionPolicy } from '../connections/destination';
import { outboundText, pinOf } from '../connections/http';
import { dispatches } from '../db/schema/index';
import { OutboundError, type OutboundPolicy, outboundConnectOptions } from '../lib/outbound';
import type { Services } from '../services';
import {
  answeringAccount,
  RELAY_BODY_MAX,
  RELAY_IDLE_MS,
  relayErrorBody,
  relayRequestHeaders,
  relayResponseHeaders,
  upstreamUrl,
} from './relay-logic';
import { noteRelayFailure } from './service';
import { gatewayConnectionOf, gatewayKeyOf, gatewayName, isGatewayCatalogId } from './store';

/** The relay's route (AIG-08). */
export const AI_GATEWAY_RELAY_ROUTE = `${AI_GATEWAY_RELAY_PREFIX}/:provider/*`;

const LIVE = new Set(['claimed', 'running']);

/** The CLI's key: `Authorization: Bearer …` (Codex, Claude Code's `apiKeyHelper`) or `x-api-key` (Claude Code). */
function presentedKey(req: FastifyRequest): string | null {
  const bearer = bearerOf(req.headers);
  if (bearer) return bearer;
  const raw = req.headers['x-api-key'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value || null;
}

/** An answer in the provider's error shape (the connection closes: the body may not have been read). */
function refuse(reply: FastifyReply, provider: GatewayProvider, status: number, message: string) {
  return reply
    .code(status)
    .header('connection', 'close')
    .header('cache-control', 'no-store')
    .send(relayErrorBody(provider, status, message));
}

/** The same, once the reply is hijacked (raw response). */
function refuseRaw(reply: FastifyReply, provider: GatewayProvider, status: number, message: string): void {
  const res = reply.raw;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(relayErrorBody(provider, status, message));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(body);
}

/** The connection policy for a stream: no total deadline, the idle timeout, the body cap (AIG-09). */
function streamingPolicy(policy: OutboundPolicy): OutboundPolicy {
  const out: OutboundPolicy = { ...policy, timeoutMs: RELAY_IDLE_MS, maxRequestBytes: RELAY_BODY_MAX };
  delete out.deadlineMs;
  delete out.maxBytes;
  delete out.truncateAt;
  return out;
}

async function relay(services: Services, req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as { provider?: string; '*'?: string };
  const provider = params.provider;
  if (provider !== 'claude' && provider !== 'codex')
    return reply
      .code(404)
      .header('connection', 'close')
      .send({ error: { code: 'not_found', message: 'No such endpoint.' } });
  const rest = params['*'] ?? '';
  const route = aiGatewayRelayRoute(provider, rest);
  // Claude Code's reachability ping: answered here, never relayed (AIG-09).
  if (route === 'hello') return reply.code(200).header('cache-control', 'no-store').send({ ok: true });

  const key = presentedKey(req);
  const dispatch = key ? await agentTokenDispatch(services, key) : null;
  if (!dispatch)
    return refuse(reply, provider, 401, 'Whombat didn’t accept this key: it isn’t a running turn’s.');
  if (!LIVE.has(dispatch.state)) return refuse(reply, provider, 409, 'This turn isn’t running any more.');
  if (dispatch.gatewayProvider !== provider)
    return refuse(
      reply,
      provider,
      403,
      dispatch.gatewayProvider
        ? 'This turn goes through the AI gateway for another tool.'
        : 'This turn doesn’t go through the AI gateway.',
    );
  if (route !== 'forward') return refuse(reply, provider, 404, 'Whombat doesn’t relay this path.');

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > RELAY_BODY_MAX)
    return refuse(reply, provider, 413, 'The request is larger than the AI gateway takes (64 MiB).');

  const connection = await gatewayConnectionOf(services.db, dispatch.burrowId);
  const name = connection ? gatewayName(connection) : 'The AI gateway';
  if (!connection || !isGatewayCatalogId(connection.catalogId))
    return refuse(reply, provider, 502, `${name} isn’t set up any more.`);
  const { usable, key: clientKey } = gatewayKeyOf(services, connection);
  if (!usable) return refuse(reply, provider, 502, `${name} has no key Whombat can send.`);

  // The relay's calls keep a long turn's token alive, as its MCP calls do (essentials-agents.md EA-04).
  await slideAgentToken(services, dispatch.id).catch((err: unknown) =>
    services.log.warn({ err: String(err), dispatchId: dispatch.id }, 'could not slide an agent token'),
  );

  const raw = req.raw.url ?? '';
  const search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
  // The path exactly as the allow list knows it (no `..`, no doubled or trailing slashes reach the gateway).
  const path = (rest.split('?')[0] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  const target = upstreamUrl(connection.baseUrl, path, search);
  // The gateway couldn't be reached at all: it counts as unreachable now (never fails the answer itself).
  const unreachableNow = () =>
    void noteRelayFailure(services, connection.id, dispatch.burrowId).catch((err: unknown) =>
      services.log.warn({ err: String(err) }, 'ai gateway: couldn’t note that it is unreachable'),
    );
  let options: ReturnType<typeof outboundConnectOptions>;
  try {
    const policy = await connectionPolicy(services, connection.baseUrl, pinOf(connection));
    options = outboundConnectOptions(target, streamingPolicy(policy));
  } catch (err) {
    unreachableNow();
    return refuse(reply, provider, 502, `Whombat couldn’t reach ${name}: ${outboundText(err)}`);
  }

  reply.hijack();
  const transport = options.url.protocol === 'https:' ? https : http;
  let upstream: ClientRequest;
  try {
    upstream = transport.request(options.url, {
      method: req.method,
      headers: relayRequestHeaders(req.headers, clientKey),
      lookup: options.lookup,
      agent: options.agent ?? false,
    });
  } catch (err) {
    unreachableNow();
    refuseRaw(reply, provider, 502, `Whombat couldn’t reach ${name}: ${outboundText(err)}`);
    return;
  }
  let answered = false;
  let done = false;
  // The CLI hung up first: what the request to the gateway then says (aborted) is not about the gateway.
  let callerGone = false;
  const fail = (status: number, message: string) => {
    if (done) return;
    done = true;
    upstream.destroy();
    refuseRaw(reply, provider, status, message);
    req.raw.resume();
  };
  upstream.setTimeout(RELAY_IDLE_MS, () =>
    upstream.destroy(new OutboundError('timeout', `Nothing for ${RELAY_IDLE_MS} ms.`)),
  );
  upstream.on('error', (err) => {
    if (answered) {
      done = true;
      reply.raw.destroy();
      return;
    }
    if (!done && !callerGone) unreachableNow();
    fail(502, `Whombat couldn’t reach ${name}: ${outboundText(err)}`);
  });
  upstream.on('response', (res: IncomingMessage) => {
    if (done) {
      res.resume();
      return;
    }
    answered = true;
    const account = answeringAccount(res.headers);
    if (account && account !== dispatch.gatewayAccount)
      void services.pipeline
        .transactAccount((tx) =>
          tx.update(dispatches).set({ gatewayAccount: account }).where(eq(dispatches.id, dispatch.id)),
        )
        .catch((err: unknown) =>
          services.log.warn(
            { err: String(err), dispatchId: dispatch.id },
            'could not record the gateway account',
          ),
        );
    reply.raw.writeHead(res.statusCode ?? 502, relayResponseHeaders(res.headers));
    // Streamed as it comes (SSE included): no buffering either way.
    reply.raw.flushHeaders();
    res.on('data', (chunk: Buffer) => {
      if (!reply.raw.write(chunk)) res.pause();
    });
    reply.raw.on('drain', () => res.resume());
    res.on('end', () => {
      done = true;
      reply.raw.end();
    });
    res.on('error', () => {
      done = true;
      reply.raw.destroy();
    });
  });
  // The CLI went away: so does the request to the gateway.
  reply.raw.on('close', () => {
    if (reply.raw.writableFinished) return;
    callerGone = true;
    upstream.destroy();
  });

  // The body, streamed and counted (64 MiB).
  let size = 0;
  req.raw.on('data', (chunk: Buffer) => {
    if (done) return;
    size += chunk.length;
    if (size > RELAY_BODY_MAX) {
      fail(413, 'The request is larger than the AI gateway takes (64 MiB).');
      return;
    }
    if (!upstream.write(chunk)) req.raw.pause();
  });
  upstream.on('drain', () => req.raw.resume());
  req.raw.on('error', () => upstream.destroy());
  // A body read to its end already (none was sent) ends the request at once; else at its end.
  if (req.raw.readableEnded) upstream.end();
  else
    req.raw.on('end', () => {
      if (!done) upstream.end();
    });
}

/** Registers the relay (AIG-08): every method, no body parser (the body streams), quiet logs. */
export function registerGatewayRelay(app: FastifyInstance, services: Services): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    scope.all(AI_GATEWAY_RELAY_ROUTE, { logLevel: 'warn' }, (req, reply) => relay(services, req, reply));
  });
}
