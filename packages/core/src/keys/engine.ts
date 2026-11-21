/**
 * The keys engine. Pure: given an actor, the agent's grants and the key a command needs, decide whether
 * the command runs (`allow`), needs a person first (`ask` → Approval) or is blocked (`deny` → Blocked event).
 *
 * Resolution for agents:
 * 1. People-only keys (`agentMaxTier: 'never'`, e.g. Push to main, Approve requests) are denied outright. Merge into
 *    main and the deploy keys are ordinary keys since 0.34 (CT-211): `can` merges or deploys, `ask` asks a person.
 * 2. Grants are normalised: other wordings (`sameAs`) map to their canonical key, bundles (`implies`) expand.
 * 3. Walk from the required key up its umbrella chain (Deploy to staging → Deploy). The first level with an
 *    in-scope grant decides; explicit grants beat bundle-derived ones at the same level, and when several
 *    grants apply at one level the most restrictive wins.
 * 4. No grant anywhere → deny ("not one of Banjo’s keys"). `cannot` → deny. `ask` → ask.
 *    `can` is clamped to the key's `agentMaxTier` (sending mail, calendar invites, sharing and trashing files ask).
 *
 * The person may use every key (`can`): a Whombat is one person's (Whombat one-person.md OP-01, contracts 3.0, CT-1507).
 */
import type { Grant } from '../domain/grant.js';
import {
  agentMaxTier,
  canonicalKey,
  isKeyId,
  KEY_CATALOG,
  type KeyId,
  type KeyScope,
  keyChain,
  type MaxTier,
  type Tier,
} from './catalog.js';

export type DecisionOutcome = 'allow' | 'ask' | 'deny';

export type DecisionReason =
  /** Agent holds the key at `can`. */
  | 'granted'
  /** The person may use every key. */
  | 'person'
  /** Agent holds the key at `ask`. */
  | 'asks_first'
  /** Agent holds `can`, but the key is capped at `ask` for agents (sending mail, invites, sharing, trashing). */
  | 'always_asks'
  /** People-only key (Push to main, Approve requests, …). */
  | 'people_only'
  /** Agent does not hold the key or any umbrella of it. */
  | 'no_key'
  /** Agent holds the key at `cannot`. */
  | 'denied'
  /** Agent holds the key, but not for this branch / repo / environment / connection. */
  | 'out_of_scope'
  /** Unknown key id. */
  | 'unknown_key';

export interface Actor {
  id: string;
  kind: 'person' | 'agent';
}

/** What the command touches. Compared against grant scopes. */
export interface RequestScope {
  branch?: string;
  /** Repo id or full name (`whombat/billing`). */
  repo?: string;
  environment?: string;
  /** Connection id (`con_…`; 0.69, CT-325). */
  connection?: string;
}

export interface Decision {
  outcome: DecisionOutcome;
  /** Effective tier after clamping. */
  tier: Tier;
  keyId: KeyId;
  reason: DecisionReason;
  /** The (canonical) key whose grant decided, when a grant decided. */
  grantKeyId?: KeyId;
  /** True when a `can` grant was lowered to `ask` by the key's agent cap. */
  clamped: boolean;
}

const TIER_RANK: Record<Tier, number> = { cannot: 0, ask: 1, can: 2 };

function strictest(tiers: readonly Tier[]): Tier {
  let result: Tier = 'can';
  for (const t of tiers) if (TIER_RANK[t] < TIER_RANK[result]) result = t;
  return result;
}

/** Converts a glob (`feat/*`, `release/**`) to a matcher. `*` stays within a path segment. */
export function globMatch(pattern: string, value: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

function dimensionMatches(allowed: readonly string[] | undefined, value: string | undefined, glob: boolean) {
  if (!allowed) return true;
  if (value === undefined) return false;
  return allowed.some((a) => (glob ? globMatch(a, value) : a === value));
}

/** Whether a (combined) grant scope covers the request. Unrestricted dimensions always match. */
export function scopeMatches(scope: KeyScope | undefined, request: RequestScope | undefined): boolean {
  if (!scope) return true;
  const r = request ?? {};
  return (
    dimensionMatches(scope.branches, r.branch, true) &&
    dimensionMatches(scope.repos, r.repo, false) &&
    dimensionMatches(scope.environments, r.environment, false) &&
    dimensionMatches(scope.connections, r.connection, false)
  );
}

export interface EffectiveGrant {
  key: KeyId;
  tier: Tier;
  /** Every scope must match: the key's inherent scope and the grant's own scope. */
  scopes: KeyScope[];
  source: KeyId;
  derived: boolean;
}

function scopesOf(...scopes: (KeyScope | undefined)[]): KeyScope[] {
  return scopes.filter((s): s is KeyScope => !!s);
}

/** Normalises grants (wordings → canonical key, bundles expanded). */
export function effectiveGrants(
  grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
): EffectiveGrant[] {
  const out: EffectiveGrant[] = [];
  for (const g of grants) {
    const def = KEY_CATALOG[g.keyId];
    if (!def) continue;
    const scopes = scopesOf(def.scope, g.scope);
    out.push({ key: canonicalKey(g.keyId), tier: g.tier, scopes, source: g.keyId, derived: false });
    for (const implied of def.implies ?? []) {
      const impliedScopes = scopesOf(KEY_CATALOG[implied].scope, g.scope);
      out.push({
        key: canonicalKey(implied),
        tier: g.tier,
        scopes: impliedScopes,
        source: g.keyId,
        derived: true,
      });
    }
  }
  return out;
}

/** Highest tier an agent may hold for a key, as a `Tier`. */
export function maxTierAsTier(max: MaxTier): Tier {
  return max === 'never' ? 'cannot' : max;
}

/** Clamps a tier to what an agent may hold for the key: never → cannot, ask-capped → ask. */
export function clampTier(keyId: KeyId, tier: Tier): Tier {
  const cap = maxTierAsTier(agentMaxTier(keyId));
  return TIER_RANK[tier] > TIER_RANK[cap] ? cap : tier;
}

export interface ClampResult<G> {
  grants: G[];
  /** Grants whose tier was lowered. */
  clamped: { keyId: KeyId; from: Tier; to: Tier }[];
}

/** Clamps every grant to its key's agent cap (run when saving grants; the engine clamps again anyway). */
export function clampGrants<G extends Pick<Grant, 'keyId' | 'tier'>>(grants: readonly G[]): ClampResult<G> {
  const clamped: ClampResult<G>['clamped'] = [];
  const out = grants.map((g) => {
    const tier = clampTier(g.keyId, g.tier);
    if (tier !== g.tier) {
      clamped.push({ keyId: g.keyId, from: g.tier, to: tier });
      return { ...g, tier };
    }
    return g;
  });
  return { grants: out, clamped };
}

function result(
  keyId: KeyId,
  outcome: DecisionOutcome,
  tier: Tier,
  reason: DecisionReason,
  extra: Partial<Pick<Decision, 'grantKeyId' | 'clamped'>> = {},
): Decision {
  return { outcome, tier, keyId, reason, clamped: false, ...extra };
}

/**
 * Decide whether `actor` may use `keyId` (optionally within `scope`).
 * `grants` may contain grants of other principals (an automation's); only the actor's are considered.
 */
export function decide(actor: Actor, grants: readonly Grant[], keyId: KeyId, scope?: RequestScope): Decision {
  // Defensive: ids read from storage may not be in this build's catalog. Unknown keys never allow.
  if (typeof keyId !== 'string' || !isKeyId(keyId)) return result(keyId, 'deny', 'cannot', 'unknown_key');

  if (actor.kind === 'person') return result(keyId, 'allow', 'can', 'person');

  const cap = agentMaxTier(keyId);
  if (cap === 'never') return result(keyId, 'deny', 'cannot', 'people_only');

  const own = effectiveGrants(grants.filter((g) => g.agentId === actor.id));
  let sawOutOfScope = false;

  for (const level of keyChain(keyId)) {
    const candidates = own.filter((g) => g.key === level);
    if (candidates.length === 0) continue;
    const direct = candidates.filter((g) => !g.derived);
    const pool = direct.length > 0 ? direct : candidates;
    const inScope = pool.filter((g) => g.scopes.every((s) => scopeMatches(s, scope)));
    if (inScope.length === 0) {
      sawOutOfScope = true;
      continue;
    }
    const tier = strictest(inScope.map((g) => g.tier));
    if (tier === 'cannot') return result(keyId, 'deny', 'cannot', 'denied', { grantKeyId: level });
    if (tier === 'ask') return result(keyId, 'ask', 'ask', 'asks_first', { grantKeyId: level });
    if (cap === 'ask')
      return result(keyId, 'ask', 'ask', 'always_asks', { grantKeyId: level, clamped: true });
    return result(keyId, 'allow', 'can', 'granted', { grantKeyId: level });
  }

  return result(keyId, 'deny', 'cannot', sawOutOfScope ? 'out_of_scope' : 'no_key');
}

/** Human explanation of a decision, for logs, tool results and error bodies. */
export function describeDecision(decision: Decision, actorName: string): string {
  const label = KEY_CATALOG[decision.keyId]?.label ?? decision.keyId;
  switch (decision.reason) {
    case 'granted':
      return `${actorName} holds “${label}”.`;
    case 'person':
      return `${actorName} can do this: it’s their Whombat.`;
    case 'asks_first':
      return `${actorName} holds “${label}”, but asks a person first.`;
    case 'always_asks':
      return `“${label}” always asks a person when the agent uses it.`;
    case 'people_only':
      return `“${label}” is for people. The agent never holds this key.`;
    case 'no_key':
      return `“${label}” is not one of ${actorName}’s keys.`;
    case 'denied':
      return `${actorName} can’t use “${label}”.`;
    case 'out_of_scope':
      return `${actorName} holds “${label}”, but not for this one.`;
    case 'unknown_key':
      return 'Unknown key.';
  }
}

/**
 * Note stored with an audit event about the key (`KEY USED · asks a person first`,
 * `KEY IT NEEDED · not one of Banjo’s keys`). Null when there is nothing to add.
 */
export function keyNoteFor(decision: Decision, actorName: string): string | null {
  switch (decision.outcome) {
    case 'allow':
      return null;
    case 'ask':
      return 'asks a person first';
    case 'deny':
      return `not one of ${actorName}’s keys`;
  }
}
