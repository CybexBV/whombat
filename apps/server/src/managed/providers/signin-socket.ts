/**
 * The runner's sign-in routes on a unix socket (review I-1; docs/decisions/managed-runtime.md MR-34). Over loopback
 * TCP the runner can't tell the server from any local process that binds the port while the server is down, and would
 * hand it the runner token and answer its `submitSecret`/`githubToken` requests. A socket in a directory only the
 * server's user can write (`/run/whombat`, the unit's `RuntimeDirectory`) can only be the server's: the runner checks
 * exactly that before each request (`apps/runner/src/signin-socket.ts`). The socket itself is 0666: the runner runs as
 * another user, and the runner token still authenticates every request.
 */
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { hermesHomeRouteDefs } from '../../hermes-home/routes';
import { ApiError } from '../../lib/errors';
import { registerRoute } from '../../routes/define';
import type { Services } from '../../services';
import { signInRouteDefs } from './routes';

export async function listenSignInSocket(services: Services, path: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(err.toBody());
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: { code: 'bad_request', message: 'Not a valid sign-in request.' } });
    services.log.error({ err: String(err) }, 'sign-in socket request failed');
    return reply.code(500).send({ error: { code: 'internal', message: 'The sign-in request failed.' } });
  });
  for (const def of signInRouteDefs('socket')) registerRoute(app, services, def);
  // The Hermes homes' steps (hermes-engine.md HE-38): as private as sign-ins, so on the same socket.
  for (const def of hermesHomeRouteDefs('socket')) registerRoute(app, services, def);
  if (existsSync(path)) unlinkSync(path);
  await app.listen({ path });
  chmodSync(path, 0o666);
  return app;
}
