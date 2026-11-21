/**
 * The session's name for each `api.<area>.<action>` endpoint: its key path, which is how the protocol's allowlist
 * (`API_OPERATIONS`) and the runtime name operations. An endpoint's `id` is usually the same, but not always
 * (`api.packs.agentPacks` had the id `packs.agent` until contracts 0.113, parity G-02), so the session never sends
 * `ep.id` as the op.
 */
import { type AnyEndpoint, api } from '@whombat/core/contracts';

const OP_BY_ID = new Map<string, string>();
/** Key path → endpoint. */
export const API_ENDPOINT_BY_OP = new Map<string, AnyEndpoint>();
for (const [area, group] of Object.entries(api as unknown as Record<string, Record<string, AnyEndpoint>>))
  for (const [action, ep] of Object.entries(group)) {
    OP_BY_ID.set(ep.id, `${area}.${action}`);
    API_ENDPOINT_BY_OP.set(`${area}.${action}`, ep);
  }

/** The operation name the session sends for an endpoint (its key path; `ep.id` for endpoints outside `api`). */
export function apiOpName(ep: AnyEndpoint): string {
  return OP_BY_ID.get(ep.id) ?? ep.id;
}
