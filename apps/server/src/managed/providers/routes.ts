/**
 * The runner's sign-in executor routes (`bridge.ts`; contracts 0.5.1 `runnerApi.signinPoll|signinAnswer|signinEvent`,
 * CT-39; 0.9.0 `signinConsole`, CT-71): runner token, bounded bodies; on the sign-in socket when one is configured (`signin-socket.ts`, MR-34), else
 * loopback only in managed mode (MR-04 `isApplianceLocalPath`). Nothing here is logged: a `submitSecret` request
 * carries a secret.
 */
import { runnerApi } from '@whombat/core';
import { ApiError } from '../../lib/errors';
import { type RouteDef, runnerRoute as route } from '../../routes/define';
import { disconnectSignal, requireRunner } from '../../runtime/routes';
import type { Services } from '../../services';
import { providerLogins } from './service';

const bridge = (services: Services) => {
  const b = providerLogins(services).bridge;
  if (!b) throw new ApiError('not_found', 'This server runs sign-ins itself.');
  return b;
};
const opts = { bodyLimit: 64 * 1024, logLevel: 'warn' as const };

/**
 * The routes for one listener: `tcp` (the loopback HTTP port) refuses them when a sign-in socket is configured
 * (MR-34), `socket` (that socket's own listener) serves them.
 */
export function signInRouteDefs(via: 'tcp' | 'socket'): RouteDef[] {
  const allowed = (services: Services) => {
    if (via === 'tcp' && services.config.WHOMBAT_SIGNIN_SOCKET)
      throw new ApiError('not_found', 'Sign-ins are served on the sign-in socket.');
  };
  return [
    route(
      runnerApi.signinPoll,
      async ({ body, req, reply, services }) => {
        allowed(services);
        requireRunner(services, req);
        return { requests: await bridge(services).poll(body.waitMs ?? 25_000, disconnectSignal(reply)) };
      },
      opts,
    ),
    route(
      runnerApi.signinAnswer,
      async ({ body, req, services }) => {
        allowed(services);
        requireRunner(services, req);
        return {
          ok: bridge(services).answer(
            body.id,
            body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error },
          ),
        };
      },
      opts,
    ),
    route(
      runnerApi.signinConsole,
      async ({ body, req, services }) => {
        allowed(services);
        requireRunner(services, req);
        // Output may echo what a person typed: nothing of the body is logged (`opts.logLevel`).
        return { ok: true as const, unknown: (await bridge(services).console(body.events)).slice(0, 64) };
      },
      opts,
    ),
    route(
      runnerApi.signinEvent,
      async ({ body, req, services }) => {
        allowed(services);
        requireRunner(services, req);
        bridge(services).event(body.done);
        return { ok: true as const };
      },
      opts,
    ),
  ];
}

export const signInRoutes: RouteDef[] = signInRouteDefs('tcp');
