import Fastify, { type FastifyError, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { smartHomeTriggersFor } from './automations/home-triggers';
import { closeConnections } from './connections/pool';
import { registerDemo } from './demo/routes';
import { registerFileRoutes } from './files/routes';
import { registerGatewayRelay } from './gateway/relay';
import { homeJobsFor } from './home/jobs';
import { stopHosts } from './hosts/index';
import { ApiError } from './lib/errors';
import { isApplianceLocalPath } from './lib/local-paths';
import { requestSerializer } from './lib/redact';
import { providerLogins } from './managed/providers/service';
import { registerMcp } from './mcp/server';
import { registerPagesRoutes } from './pages/routes';
import { registerApiRoutes } from './routes/index';
import { closeSchedules } from './schedules/ticker';
import type { Services } from './services';
import { protectEventsFor } from './things/kinds/home/protect-events';
import { onePasswordSyncFor } from './vault/onepassword/sync';
import { registerOnePasswordStandIn } from './vault/onepassword/testing/routes';
import { closeVoiceTyping } from './voice/service';

export interface AppDeps {
  services: Services;
  logger?: FastifyServerOptions['logger'];
}

/**
 * The path a request is routed by. The router decodes percent-escapes (`/%69nternal/…` reaches
 * `/internal/…`), so a prefix test on the raw URL can be walked around: use the route it matched, else the
 * decoded path (docs/decisions/auth-selfhost.md AH-09).
 */
export function routedPath(req: Pick<FastifyRequest, 'url' | 'routeOptions'>): string {
  const matched = req.routeOptions?.url;
  if (matched) return matched;
  const raw = req.url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Methods that change nothing; everything else is a write for the read-only start. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A request a read-only server refuses (docs/decisions/managed-db.md MD-07): any unsafe method, and the runner's
 * claims and agents' MCP calls, which only exist to change things.
 */
export function isWriteRequest(method: string, path: string): boolean {
  if (!SAFE_METHODS.has(method.toUpperCase())) return true;
  return path.startsWith('/internal/') || path === '/mcp';
}

/** Postgres refused a write: `read_only_sql_transaction` (the read-only pool). */
export function isReadOnlyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++)
    if ((e as { code?: unknown }).code === '25006') return true;
  return false;
}

export function readOnlyBody() {
  return {
    error: {
      code: 'read_only' as const,
      message:
        'This Whombat is read-only for now: a newer version migrated its database and this one may not write to it. Reading works; writing needs the newer version running again.',
    },
  };
}

/** The logger options with the request serializer that keeps credentials out of logged URLs. */
function loggerOptions(logger: AppDeps['logger'], level: string): FastifyServerOptions['logger'] {
  if (logger === false) return false;
  const base = logger && typeof logger === 'object' ? logger : { level };
  return { ...base, serializers: { ...base.serializers, req: requestSerializer } };
}

export async function buildApp({ services, logger }: AppDeps) {
  const config = services.config;
  const app = Fastify({
    logger: loggerOptions(logger, config.LOG_LEVEL),
    bodyLimit: 1024 * 1024,
  });
  if (logger !== false) services.log = app.log;

  app.addHook('onRequest', async (req, reply) => {
    const path = routedPath(req);
    // This listener is loopback-only and serves the runner protocol and agents' MCP tools, nothing else (MA-10,
    // MR-04). People and their devices reach Whombat only through encrypted sessions.
    if (!isApplianceLocalPath(path)) {
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'Whombat’s app reaches it through an encrypted session.',
        },
      });
    }
    // Read-only start (docs/decisions/managed-db.md MD-07): every write is refused up front with the reason;
    // anything that slips through (a read that writes) is refused by Postgres and answered the same way below.
    if (services.schemaAccess === 'read-only' && isWriteRequest(req.method, path)) {
      return reply.code(503).send(readOnlyBody());
    }
  });

  // JSON bodies; an empty body with a JSON content type counts as no body (POST /logout, /pause …).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError('bad_request', 'The request body is not valid JSON.'), undefined);
    }
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      if (err.status >= 500 && err.code !== 'not_implemented') req.log.error({ err }, err.message);
      return reply.code(err.status).send(err.toBody());
    }
    if (isReadOnlyViolation(err)) return reply.code(503).send(readOnlyBody());
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      // Fastify's own words (“Body cannot be empty when content-type is set to 'application/json'”) are for developers:
      // people read a plain sentence, the raw words stay in the details.
      const message = status === 413 ? 'That’s too big to send.' : 'That didn’t work. Try again.';
      return reply.code(status).send({
        error: {
          code: status === 404 ? 'not_found' : 'bad_request',
          message,
          details: { said: err.message },
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } }),
  );

  // The runner protocol's endpoints (`/internal/runner/…`) and its file fetch; agents' MCP tools; the AI gateway relay
  // (docs/decisions/ai-gateway.md AIG-08, AIG-09: agent tokens, streamed both ways); the demo's controls.
  registerApiRoutes(app, services);
  registerFileRoutes(app, services);
  registerPagesRoutes(app, services);
  registerMcp(app, services);
  registerGatewayRelay(app, services);
  registerDemo(app, services);
  registerOnePasswordStandIn(app, services);
  app.addHook('onClose', async () => {
    // Badges, notifications and pushes after the last commits finish while the database is still there (SV-02).
    await services.background.settle();
    // Open canvases are stored and their session streams closed (the collaboration service, collab/service.ts).
    await services.collab.close();
    services.runtime.close();
    closeSchedules(services);
    closeVoiceTyping(services);
    services.usage.close();
    services.linkPreviews.close();
    await services.housekeeping.close();
    services.files.close();
    await closeConnections(services);
    stopHosts(services);
    services.demo.close();
    await services.automations.close();
    await services.feedback.close();
    await services.tracker.close();
    await services.gateway.close();
    await protectEventsFor(services).close();
    await smartHomeTriggersFor(services).close();
    await onePasswordSyncFor(services).close();
    services.guides.close();
    await services.guides.settle();
    await homeJobsFor(services).close();
    await services.github.close().catch(() => {});
    providerLogins(services).close();
  });
  return app;
}
