/**
 * Agents asking for a key (docs/decisions/key-requests.md): which keys an agent may ask for, and the grant set
 * an approved request leaves. The server checks the same rules when the agent asks and when the key is given.
 */
import type { Grant } from '../domain/grant.js';
import { agentMaxTier, KEY_CATALOG, type KeyId, type Tier } from './catalog.js';
import { clampTier, decide } from './engine.js';
import { KEY_TIER_ROW_KEYS, keyTierRowOf, withKeyRowTier } from './grants.js';

const RANK: Record<Tier, number> = { cannot: 0, ask: 1, can: 2 };

/** The tier the agent holds a key at today: its own grant for the key, or what an umbrella or bundle gives it. */
export function heldTier(agentId: string, grants: readonly Grant[], keyId: KeyId): Tier {
  const own = grants.filter((g) => g.agentId === agentId);
  const direct = own.find((g) => g.keyId === keyId)?.tier ?? 'cannot';
  const decided = decide({ id: agentId, kind: 'agent' }, own, keyId).tier;
  return RANK[direct] >= RANK[decided] ? direct : decided;
}

export interface KeyRequestAgent {
  id: string;
  name: string;
}

/**
 * Why the agent can't ask for `keyId`, or null when it may: the key is for people only, the agent already holds
 * it as far as a request gives it (`requestedTier`). Merge into main is no longer for people only (CT-211); a Merge or
 * Deploy key held at ask is held as far as a request gives it (CT-213).
 */
export function keyRequestProblem(
  agent: KeyRequestAgent,
  grants: readonly Grant[],
  keyId: KeyId,
): string | null {
  const label = KEY_CATALOG[keyId].label;
  if (agentMaxTier(keyId) === 'never') return `“${label}” is for people. ${agent.name} never holds this key.`;
  const held = heldTier(agent.id, grants, keyId);
  if (RANK[held] >= RANK[requestedTier(keyId)]) {
    if (held === 'can') return `${agent.name} already holds “${label}”.`;
    return clampTier(keyId, 'can') === 'ask'
      ? `${agent.name} already holds “${label}”, and it always asks a person first.`
      : `${agent.name} already holds “${label}” and asks a person each time. A person can switch it to On in Settings → Agent.`;
  }
  return null;
}

/**
 * The tier an approved request gives: `can`, clamped to the key's cap (an ask-capped key asks). A key of a risk row
 * (`RISK_ROW_KEYS`: deploys, merges, Push to main, and since 0.44 destructive commands, outside messages, refunds and
 * billing data, RA-01) is given at `ask`: a person switches the row to On in Settings → Agent, or says “Always allow” on a
 * card, if they want (Whombat MDS-04, amending KR-04; CT-213; RA-06).
 */
export function requestedTier(keyId: KeyId): Tier {
  return keyTierRowOf(keyId) ? 'ask' : clampTier(keyId, 'can');
}

/**
 * The agent's grants once a request for `keyId` is approved: every other grant as it was, the key's own grant
 * (`ask` or `cannot`, or none) replaced by `requestedTier` at the end of the list.
 *
 * A key of the Merge or Deploy row sets the whole row to `ask` (`withKeyRowTier`: the umbrella key at ask, the
 * narrower keys held aligned), so a request for “Deploy to staging” leaves a Deploy row that reads Ask rather than a
 * production deploy still blocked by `deploy: cannot` (CT-213). Unless a key of the row is held at `can` already: then
 * only the key's own grant becomes `ask`, so the approval never lowers anything.
 */
export function grantsWithRequestedKey(agentId: string, grants: readonly Grant[], keyId: KeyId): Grant[] {
  const own = grants.filter((g) => g.agentId === agentId);
  const row = keyTierRowOf(keyId);
  if (row && !KEY_TIER_ROW_KEYS[row].some((k) => heldTier(agentId, own, k) === 'can')) {
    const inputs = withKeyRowTier(
      own.map(({ agentId: _agentId, ...g }) => g),
      row,
      'ask',
    );
    return inputs.map((g) => ({ agentId, ...g }));
  }
  const kept = own.filter((g) => g.keyId !== keyId);
  return [...kept, { agentId, keyId, tier: requestedTier(keyId) }];
}
