/** Plain-data control API endpoints (method, path, auth, schemas), like core's REST contracts. */
import { z } from 'zod';

export const CONTROL_PREFIX = '/v1';

/**
 * - `none`: public (JWKS, health, magic-link request).
 * - `session`: a signed-in cloud account (bearer session token).
 * - `device`: a device-signed request envelope (`@whombat/control-contracts/device`).
 * - `provisioning`: the factory provisioning credential.
 * - `operator`: Whombat staff (separate IAM; rollout controls).
 */
export type ControlAuth = 'none' | 'session' | 'device' | 'provisioning' | 'operator';

export interface ControlEndpoint<
  Body extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
  Query extends z.ZodType = z.ZodType,
> {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Relative to `CONTROL_PREFIX`; `:param` segments. */
  path: string;
  auth: ControlAuth;
  summary: string;
  query: Query;
  body: Body;
  response: Res;
  /**
   * Success status (CT-38): `201` when the call created something (a registration, a release), with `200` for an
   * idempotent repeat of the same creation; `202` when it was accepted for later delivery (a feedback drop, with `200`
   * for the same bytes again); `204` when it answers without a body (a reporter signing out, CT-164); otherwise `200`.
   * Errors are `ControlErrorBody` with 4xx/5xx.
   */
  status: 200 | 201 | 202 | 204;
}

export function controlEndpoint<
  Res extends z.ZodType,
  Body extends z.ZodType = z.ZodUndefined,
  Query extends z.ZodType = z.ZodObject<Record<string, never>>,
>(def: {
  id: string;
  method: ControlEndpoint['method'];
  path: string;
  auth: ControlAuth;
  summary: string;
  response: Res;
  body?: Body;
  query?: Query;
  status?: 200 | 201 | 202 | 204;
}): ControlEndpoint<Body, Res, Query> {
  return {
    ...def,
    status: def.status ?? 200,
    body: (def.body ?? z.undefined()) as Body,
    query: (def.query ?? z.object({})) as Query,
  };
}
