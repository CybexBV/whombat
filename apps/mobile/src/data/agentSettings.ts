/**
 * Settings → Agent → Keys on the phone (Whombat one-agent.md OA-05, OA-09; app one-agent.md AP-4926, AP-4969): the same
 * rows (`@whombat/client`'s `agentKeys`), drafts and requests as the web — the six rows by risk, Off · Ask · On, then All
 * keys (core's `configureGrants`, `agent.setKeys` with what the agent holds now and only the edits). No channels, no keys
 * of someone's own accounts beside the rows: a person's own mail, calendar and files serve only the turns for them
 * (OA-10). Owners change them (`canManageAgent`). Pure.
 */
import {
  allKeyOptions,
  keyPlace,
  keyRowOptions,
  liveKeyRows,
  ownKeyOptions,
  type TierKeyRow,
  tierKeyRows,
} from '@whombat/client';
import type { Grant, GrantInput } from '@whombat/core/domain';
import {
  type ConfigureKeyState,
  configureGrants,
  configureKeyState,
  configureKeyTiers,
  isThreeStateOption,
  type KeyId,
  type KeyOption,
  type KeyTiers,
  keyLabel,
  RISK_KEY_OPTIONS,
  type Tier,
} from '@whombat/core/keys';
import { mobileTranslator } from '../i18n/translate';

/* Keys -------------------------------------------------------------------------------------------------------- */

/** The rows the agent gets (the web's AccessTab). */
export interface AccessOptions {
  /** The rows by risk (Off · Ask · On). */
  rowOptions: KeyOption[];
  /** All keys: switches, and `connections.write` as Off · Ask · On. */
  allOptions: KeyOption[];
}

export function accessOptions(): AccessOptions {
  return {
    rowOptions: keyRowOptions(RISK_KEY_OPTIONS),
    allOptions: ownKeyOptions(allKeyOptions()),
  };
}

export interface AccessDraft {
  /** The switches of All keys. */
  keys: ConfigureKeyState;
  /** The rows (Off · Ask · On by row key) and All keys' three-state key. */
  tiers: KeyTiers;
}

/** The draft as the agent holds it now. */
export function accessDraft(grants: readonly Grant[], opts: AccessOptions): AccessDraft {
  return {
    keys: configureKeyState(grants, opts.allOptions),
    tiers: configureKeyTiers(grants, [...opts.rowOptions, ...opts.allOptions]),
  };
}

/** What a Save sends to `agent.setKeys`: the grants it holds now with the edits, or null when nothing changed. */
export function accessChanges(
  grants: readonly Grant[],
  base: AccessDraft,
  draft: AccessDraft,
  opts: AccessOptions,
): GrantInput[] | null {
  return configureGrants(
    grants,
    { baseKeys: base.keys, keys: draft.keys, baseTiers: base.tiers, tiers: draft.tiers },
    [...opts.rowOptions, ...opts.allOptions],
  );
}

/** Whether two drafts say the same (key order doesn't count). */
export function sameAccess(a: AccessDraft, b: AccessDraft): boolean {
  const on = (s: ConfigureKeyState) =>
    Object.entries(s)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
      .join(',');
  const tiers = (t: KeyTiers) =>
    Object.entries(t)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(',');
  return on(a.keys) === on(b.keys) && tiers(a.tiers) === tiers(b.tiers);
}

/** One switch under All keys: its label, whether it's on, and why it's locked. */
export interface KeySwitchRow {
  keyId: KeyId;
  label: string;
  on: boolean;
  /** “people only”, “included with the browser”: shown under it, and the switch doesn't move. */
  note: string | null;
  locked: boolean;
}

/** One Off · Ask · On row under All keys (`connections.write`). */
export interface KeyTierSwitchRow {
  keyId: KeyId;
  label: string;
  tier: Tier;
}

export interface AccessView {
  /** The rows by risk, Off · Ask · On. */
  rows: TierKeyRow[];
  /** All keys, in catalog order. */
  all: (KeySwitchRow | KeyTierSwitchRow)[];
  /** “12 of 14 on” for All keys. */
  allCount: string;
}

export function isTierSwitch(row: KeySwitchRow | KeyTierSwitchRow): row is KeyTierSwitchRow {
  return 'tier' in row;
}

/** What KEYS shows for a draft (the web's AccessTab, AP-679). */
export function accessView(
  draft: AccessDraft,
  opts: AccessOptions,
  ctx: { deployWorkflow?: boolean | undefined; locale?: string | undefined } = {},
): AccessView {
  const { locale } = ctx;
  const rows = tierKeyRows(
    opts.rowOptions,
    (row) => draft.tiers[row] ?? 'cannot',
    ctx.deployWorkflow,
    locale,
  );
  const switches = liveKeyRows(opts.allOptions, (keyId) => !!draft.keys[keyId], locale);
  const all = opts.allOptions.flatMap((option): (KeySwitchRow | KeyTierSwitchRow)[] => {
    if (isThreeStateOption(option))
      return [
        {
          keyId: option.keyId,
          label: keyLabel(option.keyId, locale),
          tier: draft.tiers[option.keyId] ?? option.defaultTier ?? 'ask',
        },
      ];
    const row = switches.find((r) => r.option.keyId === option.keyId);
    if (!row) return [];
    return [
      {
        keyId: option.keyId,
        label: keyLabel(option.keyId, locale),
        on: row.checked,
        note: row.note,
        locked: !!row.includedWith,
      },
    ];
  });
  const on =
    switches.filter((r) => r.checked).length +
    opts.allOptions.filter((o) => isThreeStateOption(o) && draft.tiers[o.keyId] === 'can').length;
  return {
    rows,
    all,
    allCount: mobileTranslator(locale).t('data.agentSettings.allCount', {
      on,
      total: opts.allOptions.length,
    }),
  };
}

/**
 * Where `?key=` points (a skill's “Turn on …” link): the row it is in, or All keys (which opens), or nowhere here. The
 * screen scrolls to it and marks it.
 */
export function keyTarget(
  key: string | undefined,
  opts: AccessOptions,
): { place: 'row' | 'all'; keyId: KeyId } | null {
  if (!key) return null;
  return keyPlace(key as KeyId, opts.rowOptions, opts.allOptions);
}

/** All keys' line (the web's, AP-679). */
export function allKeysLabel(locale?: string): string {
  return mobileTranslator(locale).t('data.agentSettings.allKeys');
}
export const ALL_KEYS_LABEL = allKeysLabel();
export const allKeysHint = (agent: string, locale?: string) =>
  mobileTranslator(locale).t('data.agentSettings.allKeysHint', { agent });

/* Saving --------------------------------------------------------------------------------------------------------- */

/** “Updated Neo’s keys.” (the web's `savedText`, AP-385). */
export function settingsSavedText(name: string, what: string, locale?: string): string {
  return mobileTranslator(locale).t('data.agentSettings.saved', { name, what });
}

/** A save step's answer when it didn't happen (the web's `outcomeNotice`): the notice, or null when it went through. */
export function settingsRefusal(
  result:
    | { status: 'ok' }
    | { status: 'blocked'; message: string }
    | { status: 'pending_approval'; approvalNumber: number },
  locale?: string,
): string | null {
  if (result.status === 'blocked') return result.message;
  if (result.status === 'pending_approval')
    return mobileTranslator(locale).t('data.agentSettings.waitingApproval', {
      number: result.approvalNumber,
    });
  return null;
}
