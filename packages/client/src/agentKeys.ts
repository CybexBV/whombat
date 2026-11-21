/**
 * The agent's KEYS in Settings → Agent, on the web and the phone (moved here from the web's `liveKeys.ts` so the phone's
 * agent settings use the same rows, AP-713; one agent, one page: one-agent.md AP-4903).
 *
 * Since contracts 0.44 (Whombat resourceful-agents.md RA-01, RA-02; AP-678, AP-679) the keys a person decides are six
 * rows, each Off · Ask · On (`KEY_TIER_ROWS`, `KEY_RISK_ROWS`): Deploy, Merge into main, Push to main, Destructive
 * commands on other machines, Message people outside your Whombat and Money. Everything else an agent may hold is on
 * (`ALWAYS_ON_KEYS`), and Settings → Agent lists them under **All keys**
 * (`ALL_KEY_OPTIONS`: switches, and Change things in connected services as Off · Ask · On of its own).
 *
 * The switches (AP-253, review S2): a row a bundle key brings in (“Browse the web” while “Use a web browser” is on) shows
 * on and locked, “included with the browser”, and grants nothing of its own; once the bundle is off it is an ordinary row.
 */

import {
  ALL_KEY_OPTIONS,
  DEPLOY_NO_WORKFLOW_HINT,
  impliedBy,
  includedNote,
  isKeyTierRow,
  isThreeStateOption,
  KEY_TIER_CHOICES,
  KEY_TIER_LABELS,
  type KeyId,
  type KeyOption,
  type KeyTierRow,
  keyRiskRow,
  keyTierRowLabel,
  keyTierRowOf,
  type Tier,
} from '@whombat/core/keys';
/* The six rows --------------------------------------------------------------------------------------------------- */

/** A three-state row (one of `KEY_TIER_ROWS`) rather than a switch. */
export function isTierOption(option: KeyOption): option is KeyOption & { keyId: KeyTierRow } {
  return option.defaultTier !== undefined && isKeyTierRow(option.keyId);
}

/** The six rows (`KEY_TIER_ROWS`), from the options: every Whombat has them all (hermes-engine-app.md AP-5301). */
export function keyRowOptions(options: readonly KeyOption[]): KeyOption[] {
  return options.filter(isTierOption);
}

/** Off · Ask · On, in order, for the segmented control. */
export const TIER_SEGMENTS: readonly { value: Tier; label: string }[] = KEY_TIER_CHOICES.map((value) => ({
  value,
  label: KEY_TIER_LABELS[value],
}));

export interface TierKeyRow {
  option: KeyOption & { keyId: KeyTierRow };
  row: KeyTierRow;
  tier: Tier;
  /** “Merge into main”, “Money” (`keyTierRowLabel`): never the key's catalog label. */
  label: string;
  /** The line under it (`KEY_RISK_ROWS`): “Deploy to staging and production.” */
  description: string;
  /** The Deploy row's “No deploy workflow is set up on this Whombat yet.” (MDS-05), or null. */
  hint: string | null;
}

/**
 * The three-state rows with their tiers (`tierOf`: the person's choice, else what the agent holds or the
 * default). `deployWorkflow` is `HostInfo.deployWorkflow`: only `false` gives the Deploy row its hint; `true` or unknown
 * (an older server) gives none. The row stays settable either way.
 */
export function tierKeyRows(
  options: readonly KeyOption[],
  tierOf: (row: KeyTierRow, option: KeyOption) => Tier,
  deployWorkflow?: boolean,
): TierKeyRow[] {
  return options.filter(isTierOption).map((option) => ({
    option,
    row: option.keyId,
    tier: tierOf(option.keyId, option),
    label: keyTierRowLabel(option.keyId),
    description: keyRiskRow(option.keyId).description,
    hint: option.keyId === 'deploy' && deployWorkflow === false ? DEPLOY_NO_WORKFLOW_HINT : null,
  }));
}

/* All keys -------------------------------------------------------------------------------------------------- */

/** All keys (`ALL_KEY_OPTIONS`, in catalog order). */
export function allKeyOptions(): KeyOption[] {
  return [...ALL_KEY_OPTIONS];
}

/**
 * Where a key is shown in Settings → Agent (a skill's “Turn on …” link, `?key=`): its row (`deploy.staging` → Deploy), All keys,
 * or nowhere on this screen.
 */
export function keyPlace(
  keyId: KeyId,
  rows: readonly KeyOption[],
  all: readonly KeyOption[],
): { place: 'row'; keyId: KeyTierRow } | { place: 'all'; keyId: KeyId } | null {
  const row = keyTierRowOf(keyId);
  if (row && rows.some((o) => o.keyId === row)) return { place: 'row', keyId: row };
  if (all.some((o) => o.keyId === keyId)) return { place: 'all', keyId };
  return null;
}

/* The switches (AP-253) ----------------------------------------------------------------------------------------- */

/** The rows with no included lock: an included row is an ordinary row, off by default (it grants nothing itself). */
export function ownKeyOptions(options: readonly KeyOption[]): KeyOption[] {
  return options.map((o) =>
    o.includedWith ? { ...o, locked: null, lockedTier: null, includedWith: undefined, defaultOn: false } : o,
  );
}

export interface LiveKeyRow {
  option: KeyOption;
  /** What the switch shows. */
  checked: boolean;
  /** The bundle key that brings this row in now; the row is locked with `includedNote`. */
  includedWith: KeyId | null;
  /** “people only”, “included with the browser”, …, or null. */
  note: string | null;
}

/**
 * Each switch row: a capped row (an older Whombat's Merge into main, Deploy) off with its note; a row an on bundle key
 * brings in on and locked with “included with …”; any other row as `isOn` says. Three-state options (the rows, the
 * three-state keys under All keys) aren't switches and are left out.
 */
export function liveKeyRows(options: readonly KeyOption[], isOn: (keyId: KeyId) => boolean): LiveKeyRow[] {
  const switches = options.filter((o) => !isThreeStateOption(o));
  const onKeys = switches.filter((o) => !o.locked && isOn(o.keyId)).map((o) => o.keyId);
  return switches.map((option) => {
    if (option.locked) return { option, checked: false, includedWith: null, note: option.locked };
    const via = impliedBy(
      option.keyId,
      onKeys.filter((k) => k !== option.keyId),
    );
    if (via) return { option, checked: true, includedWith: via, note: includedNote(via) };
    return { option, checked: isOn(option.keyId), includedWith: null, note: null };
  });
}

/** The keys switched on in their own right (an included row grants nothing of its own). */
export function selectedKeys(rows: readonly LiveKeyRow[]): KeyId[] {
  return rows.filter((r) => r.checked && !r.includedWith && !r.option.locked).map((r) => r.option.keyId);
}
