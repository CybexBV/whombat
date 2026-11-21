/**
 * `/internal/demo/play` and `/internal/demo/reset` (runner token): play or rewind the demo storyline in a
 * running server (`pnpm demo:play`, `pnpm demo:reset`). Not part of the public contract; answers 404 in
 * production unless `WHOMBAT_DEMO` is on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { requireRunner } from '../runtime/routes';
import type { Services } from '../services';

export const DEMO_PREFIX = '/internal/demo';

const Body = z.object({ burrow: z.string().min(1).max(63).optional() }).default({});

export function registerDemo(app: FastifyInstance, services: Services): void {
  const guard = (req: FastifyRequest) => {
    if (services.config.NODE_ENV === 'production' && !services.config.WHOMBAT_DEMO)
      throw new ApiError('not_found', 'No such endpoint.');
    requireRunner(services, req);
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError('bad_request', 'Send {"burrow": "<slug>"} or nothing.');
    return parsed.data.burrow;
  };
  app.post(`${DEMO_PREFIX}/play`, async (req: FastifyRequest, reply: FastifyReply) => {
    const burrow = guard(req);
    return reply.send(await services.demo.play(burrow));
  });
  app.post(`${DEMO_PREFIX}/reset`, async (req: FastifyRequest, reply: FastifyReply) => {
    const burrow = guard(req);
    await services.demo.rewind(burrow);
    return reply.send({ ok: true });
  });
}
