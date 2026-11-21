import { z } from 'zod';
import { PrincipalId } from '../ids.js';
import { KeyId, KeyScope, Tier } from '../keys/catalog.js';

/**
 * A permission key held by an agent. People do not have grants: they act under role rules
 * (see `decide()` in `@whombat/core/keys`).
 */
export const Grant = z.object({
  agentId: PrincipalId,
  keyId: KeyId,
  tier: Tier,
  scope: KeyScope.optional(),
});
export type Grant = z.infer<typeof Grant>;

/** A grant as submitted by a client (the agent is implied by the route). */
export const GrantInput = Grant.omit({ agentId: true });
export type GrantInput = z.infer<typeof GrantInput>;
