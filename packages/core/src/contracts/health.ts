import { z } from 'zod';
import { endpoint } from './endpoint.js';

/**
 * GET /api/v1/health. Anyone gets `ok`, `db` and `service` (the marker clients use to recognize a Whombat
 * server). What is running — `version`, the git commit it was built from, the newest migration it has
 * (docs/decisions/bp-distribution.md BP-F03, BP-F19) — and the server's `time` only go to a caller on this
 * machine (loopback, not through a proxy) or a signed-in admin; they are optional so the public answer and
 * servers from before them parse too.
 */
export const HealthResponse = z.object({
  ok: z.boolean(),
  service: z.literal('whombat-server'),
  db: z.enum(['up', 'down']),
  time: z.string().optional(),
  version: z.string().optional(),
  gitSha: z.string().nullable().optional(),
  schema: z.string().nullable().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const healthEndpoints = {
  get: endpoint({
    id: 'health.get',
    method: 'GET',
    path: '/health',
    auth: 'none',
    summary: 'Liveness and database status; the running version for local callers and admins.',
    response: HealthResponse,
  }),
};
