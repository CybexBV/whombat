/**
 * Handlers of the contract's endpoints. The session dispatcher runs the client ones in-process as the session's
 * account (`managed/dispatcher.ts`, MR-05); the runner's endpoints become Fastify routes on the loopback listener
 * (`registerRoute`): params, query and body validated with the endpoint's Zod schemas, the handler run and — outside
 * production — the response validated against the contract. Endpoints without a handler answer 501
 * `not_implemented` with the phase that owns them.
 */
import {
  type AnyEndpoint,
  type ApprovalRequiredBody,
  type BlockedBody,
  NoBody,
  pathParamNames,
} from '@whombat/core';
import type { FastifyInstance, FastifyReply, FastifyRequest, LogLevel } from 'fastify';
import type { z } from 'zod';
import type { BurrowAccess, RequestAuth } from '../auth/request';
import type { CommitResult } from '../commit/types';
import { ApiError, validationError } from '../lib/errors';
import type { Services } from '../services';

export interface SessionHandlerContext<E extends AnyEndpoint> {
  params: z.output<E['params']>;
  query: z.output<E['query']>;
  body: z.output<E['body']>;
  auth: RequestAuth;
  /** Present on burrow routes (`/burrows/:burrow/…`): the caller's principal there. */
  access: BurrowAccess;
  services: Services;
  /**
   * The session protocol minor of the app that asked, for an answer or a change an older app reads differently;
   * undefined for the assistant, tests and anything else outside an app's session, which get today's.
   */
  protocolMinor?: number | undefined;
}

export interface RunnerHandlerContext<E extends AnyEndpoint> extends SessionHandlerContext<E> {
  req: FastifyRequest;
  reply: FastifyReply;
}

export type HandlerContext<E extends AnyEndpoint> = SessionHandlerContext<E>;

export type Handler<E extends AnyEndpoint> = (
  ctx: HandlerContext<E>,
) => Promise<z.input<E['response']> | Raw>;

/** A handler result sent as is (CSV, custom status). */
export class Raw {
  constructor(
    readonly body: unknown,
    readonly status = 200,
    readonly headers: Record<string, string> = {},
  ) {}
}

/** Thrown to answer a keys-engine outcome: 403 Blocked or 202 approval required. */
export class OutcomeReply extends Error {
  constructor(
    readonly status: 202 | 403,
    readonly body: BlockedBody | ApprovalRequiredBody,
  ) {
    super('commit outcome');
  }
}

/** Unwraps an ok commit result, or throws the 403 / 202 reply for blocked / pending outcomes. */
export function ok<R>(result: CommitResult<R>): R {
  if (result.status === 'ok') return result.result;
  if (result.status === 'blocked') {
    throw new OutcomeReply(403, {
      error: { code: 'blocked', message: result.message },
      blocked: true,
      keyNeeded: result.keyNeeded,
      eventId: result.eventId,
    });
  }
  throw new OutcomeReply(202, {
    approvalRequired: true,
    approvalId: result.approvalId,
    approvalNumber: result.approvalNumber,
    eventId: result.eventId,
  });
}

export interface RouteDef {
  endpoint: AnyEndpoint;
  handler: Handler<AnyEndpoint>;
  /** Registered for a later phase: answers 501 before parsing anything. */
  stub?: string;
  /**
   * Fastify's per-route log level. Chatty machine routes (the runner's long-poll claim, heartbeats,
   * progress) use `warn`, so their request lines stay out of the log while errors still show.
   */
  logLevel?: LogLevel;
  /** A larger body than the app's 1 MiB for this route only (a pack archive upload). */
  bodyLimit?: number;
}

export interface RouteOptions {
  logLevel?: LogLevel;
  bodyLimit?: number;
}

export function route<E extends AnyEndpoint>(
  endpoint: E,
  handler: Handler<E>,
  options: RouteOptions = {},
): RouteDef {
  return { endpoint, handler: handler as unknown as Handler<AnyEndpoint>, ...options };
}

/** HTTP context exists only at the runner listener; it is never constructed by the session dispatcher. */
export function runnerRoute<E extends AnyEndpoint>(
  endpoint: E,
  handler: (ctx: RunnerHandlerContext<E>) => ReturnType<Handler<E>>,
  options: RouteOptions = {},
): RouteDef {
  if (endpoint.auth !== 'runner') throw new Error(`${endpoint.id} runs over sessions`);
  // The registry erases endpoint generics. registerRoute checks the transport before restoring this context.
  return { endpoint, handler: handler as unknown as Handler<AnyEndpoint>, ...options };
}

/** Endpoints owned by later phases: registered, answering 501 with the reason. */
export function notImplemented(endpoint: AnyEndpoint, reason: string): RouteDef {
  return {
    endpoint,
    stub: reason,
    handler: async () => {
      throw new ApiError('not_implemented', `Not implemented yet: ${reason}`, {
        details: { endpoint: endpoint.id },
      });
    },
  };
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(r.error, `The request ${what} is not valid.`);
  return r.data;
}

/** A runner endpoint as a Fastify route (its handler checks the runner token). */
export function registerRoute(app: FastifyInstance, services: Services, def: RouteDef): void {
  const ep = def.endpoint;
  if (ep.auth !== 'runner' || pathParamNames(ep.path).includes('burrow'))
    throw new Error(`${ep.id} runs only over sessions`);
  app.route({
    method: ep.method,
    url: `${ep.base}${ep.path}`,
    ...(def.logLevel ? { logLevel: def.logLevel } : {}),
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    handler: async (req, reply) => {
      if (def.stub !== undefined) {
        throw new ApiError('not_implemented', `Not implemented yet: ${def.stub}`, {
          details: { endpoint: ep.id },
        });
      }
      try {
        const params = parseOrThrow(ep.params, req.params, 'path');
        const query = parseOrThrow(ep.query, req.query ?? {}, 'query');
        const body = ep.body === NoBody ? undefined : parseOrThrow(ep.body, req.body, 'body');
        const auth: RequestAuth = { account: null };
        const access = undefined as unknown as BurrowAccess;
        const handler = def.handler as (
          ctx: RunnerHandlerContext<AnyEndpoint>,
        ) => ReturnType<Handler<AnyEndpoint>>;
        const result = await handler({ params, query, body, auth, access, services, req, reply });
        if (result instanceof Raw) {
          for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
          return reply.code(result.status).send(result.body);
        }
        if (services.config.NODE_ENV !== 'production') {
          const check = ep.response.safeParse(result);
          if (!check.success) {
            req.log.error(
              { endpoint: ep.id, issues: check.error.issues.slice(0, 5) },
              'response does not match contract',
            );
            throw new ApiError('internal', `Response for ${ep.id} does not match the contract.`, {
              details: {
                issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
              },
            });
          }
        }
        return reply.code(ep.status).send(result);
      } catch (err) {
        if (err instanceof OutcomeReply) return reply.code(err.status).send(err.body);
        throw err;
      }
    },
  });
}
