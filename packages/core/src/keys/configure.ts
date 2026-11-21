/**
 * Settings → Agent → Keys: a save changes only what the person changed. The agent holds whatever its defaults or
 * earlier edits gave it, so a save is its current grants with the person's edits applied — never the rows rebuilt from
 * the toggles.
 */
import type { Grant, GrantInput } from '../domain/grant.js';
import type { KeyId, Tier } from './catalog.js';
import { clampTier } from './engine.js';
import {
  diffGrants,
  isKeyTierRow,
  type KeyOption,
  type KeyTiers,
  keyHeldTier,
  keyRowTier,
  RISK_KEY_OPTIONS,
  withKeyRowTier,
} from './grants.js';

export type ConfigureKeyState = Partial<Record<KeyId, boolean>>;

/** Whether an option is shown in three states (Off · Ask · On): a risk row, or a single key with `defaultTier`. */
export function isThreeStateOption(option: KeyOption): boolean {
  return option.defaultTier !== undefined;
}

/** The tier a three-state option reads: a risk row's `keyRowTier`, a single key's `keyHeldTier`. */
function optionTier(grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[], option: KeyOption): Tier {
  return isKeyTierRow(option.keyId) ? keyRowTier(grants, option.keyId) : keyHeldTier(grants, option.keyId);
}

/**
 * The Keys toggles for held grants: a row is on when the key is held at its cap (`can`, or `ask` for a key that always
 * asks); locked rows are off. `options` is the
 * row list shown (the six risk rows, `RISK_KEY_OPTIONS`, or All keys, `ALL_KEY_OPTIONS`); default the risk rows. A three-state row is on when it reads `can`, for a client that shows it as a switch; its
 * tiers are `configureKeyTiers`.
 */
export function configureKeyState(
  grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
  options: readonly KeyOption[] = RISK_KEY_OPTIONS,
): ConfigureKeyState {
  const state: ConfigureKeyState = {};
  for (const option of options) {
    state[option.keyId] = isThreeStateOption(option)
      ? optionTier(grants, option) === 'can'
      : !option.locked &&
        grants.some((g) => g.keyId === option.keyId && g.tier === clampTier(option.keyId, 'can'));
  }
  return state;
}

/**
 * The three-state options' tiers for held grants, for the options `options` shows (CT-212): a risk row by its key
 * (`keyRowTier`), a single key with `defaultTier` (`connections.write` under All keys) by `keyHeldTier`.
 */
export function configureKeyTiers(
  grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
  options: readonly KeyOption[] = RISK_KEY_OPTIONS,
): KeyTiers {
  const tiers: KeyTiers = {};
  for (const option of options)
    if (isThreeStateOption(option)) tiers[option.keyId] = optionTier(grants, option);
  return tiers;
}

export interface ConfigureEdit {
  /** The toggles as the page opened (or as last saved) and as they are now. */
  baseKeys: ConfigureKeyState;
  keys: ConfigureKeyState;
  /**
   * The three-state options (the risk rows, a single key with `defaultTier`) as the page opened (`configureKeyTiers`)
   * and as they are now (CT-212). Absent: they are read from `keys` as switches (on `can`, off `cannot`).
   */
  baseTiers?: KeyTiers;
  tiers?: KeyTiers;
}

/** The tier a three-state option was changed to in this edit, or null when it wasn't. */
function rowEdit(edit: ConfigureEdit, keyId: KeyId): Tier | null {
  const tier = edit.tiers?.[keyId];
  if (tier !== undefined && tier !== edit.baseTiers?.[keyId]) return tier;
  const on = !!edit.keys[keyId];
  if (on !== !!edit.baseKeys[keyId]) return on ? 'can' : 'cannot';
  return null;
}

/**
 * The grants a Keys save sends to `agent.setKeys` (which replaces the agent's grants), or null when the save changes
 * no key. Starts from the grants the agent holds now and applies only the edits:
 * - a row switched on is held at its cap (`can`, or `ask` for a key that always asks);
 * - a row switched off is no longer held;
 * - a three-state row set to Off, Ask or On (`edit.tiers`) writes its keys at `cannot`, `ask` or `can`
 *   (`withKeyRowTier`, CT-212); a single key in three states (0.44) gets that tier, its scope kept.
 * Every other grant — keys outside the list shown, locked rows, `ask` tiers, scopes — is kept.
 */
export function configureGrants(
  held: readonly Grant[],
  edit: ConfigureEdit,
  options: readonly KeyOption[] = RISK_KEY_OPTIONS,
): GrantInput[] | null {
  let next = new Map<KeyId, GrantInput>();
  for (const { agentId: _agentId, ...grant } of held) next.set(grant.keyId, grant);
  for (const option of options) {
    if (option.locked) continue;
    const keyId = option.keyId;
    if (isKeyTierRow(keyId)) {
      const tier = rowEdit(edit, keyId);
      if (tier) next = new Map(withKeyRowTier([...next.values()], keyId, tier).map((g) => [g.keyId, g]));
      continue;
    }
    if (isThreeStateOption(option)) {
      const tier = rowEdit(edit, keyId);
      if (tier) next.set(keyId, { ...next.get(keyId), keyId, tier });
      continue;
    }
    const on = !!edit.keys[keyId];
    if (on === !!edit.baseKeys[keyId]) continue;
    if (!on) {
      next.delete(keyId);
      continue;
    }
    next.set(keyId, { ...next.get(keyId), keyId, tier: clampTier(keyId, 'can') });
  }
  const grants = [...next.values()];
  return diffGrants(held, grants).length > 0 ? grants : null;
}
