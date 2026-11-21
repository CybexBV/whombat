/**
 * The runner's Hermes-home routes (`bridge.ts`; contracts 0.125 `runnerApi.hermesPoll`, `hermesAnswer`): runner
 * token; on the sign-in socket when one is configured (MR-34: memory and sessions are as private as sign-ins), else
 * the loopback runner API. Nothing of a body is logged: answers carry people's memory and their homes' bytes.
 */
import { hermesHomeEndpoints } from '@whombat/core';
import { ApiError } from '../lib/errors';
import { type RouteDef, runnerRoute as route } from '../routes/define';
import { disconnectSignal, requireRunner } from '../runtime/routes';
import type { Services } from '../services';
import { hermesHomeBridge } from './service';

const bridge = (services: Services) => {
  const b = hermesHomeBridge(services);
  if (!b) throw new ApiError('not_found', 'This server runs the Hermes homes’ steps itself.');
  return b;
};

/** An archive chunk's answer is about 1.4 MB of base64. */
const opts = { bodyLimit: 2 * 1024 * 1024, logLevel: 'warn' as const };

/** The routes for one listener: `tcp` refuses them when a sign-in socket is configured, `socket` serves them. */
export function hermesHomeRouteDefs(via: 'tcp' | 'socket'): RouteDef[] {
  const allowed = (services: Services) => {
    if (via === 'tcp' && services.config.WHOMBAT_SIGNIN_SOCKET)
      throw new ApiError('not_found', 'The Hermes homes’ steps are served on the sign-in socket.');
  };
  return [
    route(
      hermesHomeEndpoints.poll,
      async ({ body, req, reply, services }) => {
        allowed(services);
        requireRunner(services, req);
        return { requests: await bridge(services).poll(body.waitMs ?? 25_000, disconnectSignal(reply)) };
      },
      opts,
    ),
    route(
      hermesHomeEndpoints.answer,
      async ({ body, req, services }) => {
        allowed(services);
        requireRunner(services, req);
        return { ok: bridge(services).answer(body) };
      },
      opts,
    ),
  ];
}

export const hermesHomeRoutes: RouteDef[] = hermesHomeRouteDefs('tcp');
