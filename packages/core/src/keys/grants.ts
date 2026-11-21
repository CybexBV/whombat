/**
 * Grant helpers: the agent's default keys, the Keys rows, display rows and summary counts, and describing grant
 * changes as `Keys` audit events.
 */
import { z } from 'zod';
import type { Grant, GrantInput } from '../domain/grant.js';
import {
  agentMaxTier,
  canonicalKey,
  impliedWithNote,
  isRetiredKey,
  KEY_CATALOG,
  KEY_IDS,
  type KeyId,
  type KeyScope,
  keyChain,
  keyLabel,
  keyOrder,
  keysImpliedBy,
  Tier,
} from './catalog.js';
import { clampTier, effectiveGrants, globMatch } from './engine.js';

export interface KeySet {
  can: readonly KeyId[];
  ask: readonly KeyId[];
  cannot: readonly KeyId[];
}

/**
 * Keys with an Off · Ask · On row of their own (not an always-on switch) that the agent starts with at `can` (0.57,
 * Whombat connections-catalog.md CX-20a, CT-310): changing things in connected services. A person connected the
 * service for the agent to use; the catalog's sensitive rules (CX-31) still ask.
 */
export const CAN_BY_DEFAULT_KEYS: readonly KeyId[] = ['connections.write'];

/**
 * Keys with Off · Ask · On that start at Ask, outside the risk rows and the accounts (Whombat assistant-settings.md):
 * changing the person's settings. The person may let the assistant go ahead; destructive changes ask anyway.
 */
export const ASK_BY_DEFAULT_KEYS: readonly KeyId[] = ['settings.change'];

/**
 * The keys to a person's own accounts the agent starts with (group `personal`, used only in a turn for that person,
 * OA-10): every one, sending / invites / sharing / trashing at `ask`, and `messages.search` so it can search what it can
 * read. Trashing mail and files is the person's choice after that (`ACCOUNT_TIER_KEYS`).
 */
const ACCOUNT_GRANTS: readonly GrantInput[] = [
  { keyId: 'messages.search', tier: 'can' },
  { keyId: 'mail.read', tier: 'can' },
  { keyId: 'mail.organize', tier: 'can' },
  { keyId: 'mail.draft', tier: 'can' },
  { keyId: 'mail.send', tier: 'ask' },
  { keyId: 'mail.delete', tier: 'ask' },
  { keyId: 'calendar.read', tier: 'can' },
  { keyId: 'calendar.write', tier: 'can' },
  { keyId: 'calendar.invite', tier: 'ask' },
  { keyId: 'files.read', tier: 'can' },
  { keyId: 'files.write', tier: 'can' },
  { keyId: 'files.share', tier: 'ask' },
  { keyId: 'files.delete', tier: 'ask' },
  { keyId: 'contacts.read', tier: 'can' },
];

/* The six risk rows (Whombat resourceful-agents.md RA-01; MDS-02, CT-212, CT-222, CT-246) -------------------------- */

/**
 * The consequential rows of Settings → Agent → Keys, each Off · Ask · On (`KEY_TIER_CHOICES`), in display order (RA-01):
 * Deploy, Merge into main, Push to main, Destructive commands on other machines, Message people outside your Whombat,
 * Money. A row is named by its first key (`KEY_TIER_ROW_KEYS`), so the helpers that take a row (`isKeyTierRow`,
 * `withKeyRowTier`, `configure*`) take that key; its label is `keyTierRowLabel` (“Merge into main”, “Money”), not the
 * key's catalog label. Everything else the agent may hold is on (`ALWAYS_ON_KEYS`, RA-02).
 */
export const KEY_TIER_ROWS = [
  'deploy',
  'merge',
  'branch.main.push',
  'commands.destructive',
  'messages.external',
  'refunds.issue',
] as const;
export type KeyTierRow = (typeof KEY_TIER_ROWS)[number];

export function isKeyTierRow(keyId: KeyId): keyId is KeyTierRow {
  return (KEY_TIER_ROWS as readonly KeyId[]).includes(keyId);
}

/**
 * The keys a three-state row decides, its own key first. Setting the row sets every one of them to the row's tier
 * (`withKeyRowTier`: a key under the row's key — `deploy.staging`, `merge.main` — only when the agent holds it, the
 * row's key covers it otherwise), so no stale narrower grant (`merge.main: cannot`) overrides the row.
 * Money's `billing.write` isn't under `refunds.issue` in the catalog, so the row always writes it.
 */
export const KEY_TIER_ROW_KEYS: Readonly<Record<KeyTierRow, readonly KeyId[]>> = {
  deploy: ['deploy', 'deploy.staging', 'deploy.production'],
  merge: ['merge', 'merge.main'],
  'branch.main.push': ['branch.main.push'],
  'commands.destructive': ['commands.destructive'],
  'messages.external': ['messages.external'],
  'refunds.issue': ['refunds.issue', 'billing.write'],
};

/**
 * What a three-state row shows (`keyRowTier`): the tier that decides a deploy to staging and to production, a merge
 * into main, a push to main, a destructive command, an outside message, a refund and a billing change — the most
 * restrictive when a row reads several. The bare `deploy` is left out so an agent holding the two environments at ask
 * and no umbrella reads Ask.
 */
export const KEY_TIER_ROW_READS: Readonly<Record<KeyTierRow, readonly KeyId[]>> = {
  deploy: ['deploy.staging', 'deploy.production'],
  merge: ['merge.main'],
  'branch.main.push': ['branch.main.push'],
  'commands.destructive': ['commands.destructive'],
  'messages.external': ['messages.external'],
  'refunds.issue': ['refunds.issue', 'billing.write'],
};

/** Every key of a risk row (`KEY_TIER_ROW_KEYS`), in row order: what never belongs to `ALWAYS_ON_KEYS`. */
export const RISK_ROW_KEYS: readonly KeyId[] = KEY_TIER_ROWS.flatMap((row) => KEY_TIER_ROW_KEYS[row]);

/** A risk row as people see it (RA-01, RA-06). */
export interface KeyRiskRow {
  row: KeyTierRow;
  /** The row's label: “Deploy”, “Merge into main”, “Push to main”, …, “Money”. */
  label: string;
  /** One line under the label. */
  description: string;
  /** The keys it decides (`KEY_TIER_ROW_KEYS`). */
  keys: readonly KeyId[];
  /** What “Always allow {Agent} to {verb}” ends with (RA-06): “deploy”, “merge into main”, … */
  verb: string;
}

/** The six rows with their labels, lines and verbs, in display order. */
export const KEY_RISK_ROWS: readonly KeyRiskRow[] = [
  {
    row: 'deploy',
    label: 'Deploy',
    description: 'Deploy to staging and production.',
    keys: KEY_TIER_ROW_KEYS.deploy,
    verb: 'deploy',
  },
  {
    row: 'merge',
    label: 'Merge into main',
    description: 'Merge pull requests, into the default branch too.',
    keys: KEY_TIER_ROW_KEYS.merge,
    verb: 'merge into main',
  },
  {
    row: 'branch.main.push',
    label: 'Push to main',
    description: 'Push commits straight to the default branch, without a pull request.',
    keys: KEY_TIER_ROW_KEYS['branch.main.push'],
    verb: 'push to main',
  },
  {
    row: 'commands.destructive',
    label: 'Destructive commands on other machines',
    description:
      'Delete files, drop databases or stop services on other machines. Commands on your Whombat never need this.',
    keys: KEY_TIER_ROW_KEYS['commands.destructive'],
    verb: 'run destructive commands on other machines',
  },
  {
    row: 'messages.external',
    label: 'Message people outside your Whombat',
    description: 'Send email or messages to anyone outside this Whombat.',
    keys: KEY_TIER_ROW_KEYS['messages.external'],
    verb: 'message people outside your Whombat',
  },
  {
    row: 'refunds.issue',
    label: 'Money',
    description: 'Refunds, payments and billing data.',
    keys: KEY_TIER_ROW_KEYS['refunds.issue'],
    verb: 'handle money',
  },
];

/** A row's entry in `KEY_RISK_ROWS`. */
export function keyRiskRow(row: KeyTierRow): KeyRiskRow {
  return KEY_RISK_ROWS.find((r) => r.row === row) as KeyRiskRow;
}

/** A row's label (“Merge into main”, “Money”): what Keys shows, never the key's label. */
export function keyTierRowLabel(row: KeyTierRow): string {
  return keyRiskRow(row).label;
}

/** “Always allow Dusty to merge into main” (RA-06): the risk-row card's second choice. */
export function alwaysAllowLabel(agentName: string, row: KeyTierRow): string {
  return `Always allow ${agentName} to ${keyRiskRow(row).verb}`;
}

/**
 * The three states in display order, in the words of everything the assistant may do
 * (docs/decisions/settings-groups.md): Just watch · Ask me first · Go ahead (`KEY_TIER_LABELS`).
 */
export const KEY_TIER_CHOICES: readonly Tier[] = ['cannot', 'ask', 'can'];

/** A three-state row's segment labels. */
export const KEY_TIER_LABELS: Readonly<Record<Tier, string>> = {
  cannot: 'Just watch',
  ask: 'Ask me first',
  can: 'Go ahead',
};

/** The Deploy row's hint while the Whombat has no deploy workflow (MDS-05). */
export const DEPLOY_NO_WORKFLOW_HINT = 'No deploy workflow is set up on this Whombat yet.';

/** The three-state row a key belongs to (`merge.main` → `merge`, `billing.write` → `refunds.issue`), or null. */
export function keyTierRowOf(keyId: KeyId): KeyTierRow | null {
  for (const row of KEY_TIER_ROWS) if (KEY_TIER_ROW_KEYS[row].includes(keyId)) return row;
  return null;
}

/** The tiers of the three-state rows: what Keys edits. */
export const KeyRowTiers = z.object({
  merge: Tier.optional(),
  deploy: Tier.optional(),
  /** Push to main (0.36, AC-41). */
  'branch.main.push': Tier.optional(),
  /** Destructive commands on other machines (0.44, RA-01). */
  'commands.destructive': Tier.optional(),
  /** Message people outside your Whombat (0.44, RA-01). */
  'messages.external': Tier.optional(),
  /** Money: refunds and billing data (0.44, RA-01). */
  'refunds.issue': Tier.optional(),
});
export type KeyRowTiers = z.infer<typeof KeyRowTiers>;

/**
 * Tiers by key, for the three-state controls: the risk rows (by their key) and a single key shown in three
 * states under All keys (`connections.write`, CT-246). `KeyRowTiers` fits in it.
 */
export type KeyTiers = Partial<Record<KeyId, Tier>>;

const RANK: Record<Tier, number> = { cannot: 0, ask: 1, can: 2 };

/**
 * The tier a key is held at, scopes aside: the most specific level of its umbrella chain with a grant decides (direct
 * grants before bundle-derived ones, the strictest of several), clamped to the key's agent cap; none → `cannot`. Pass
 * one agent's grants.
 */
export function keyHeldTier(grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[], keyId: KeyId): Tier {
  const own = effectiveGrants(grants);
  for (const level of keyChain(keyId)) {
    const candidates = own.filter((g) => g.key === level);
    if (candidates.length === 0) continue;
    const direct = candidates.filter((g) => !g.derived);
    const pool = direct.length > 0 ? direct : candidates;
    let tier: Tier = 'can';
    for (const g of pool) if (RANK[g.tier] < RANK[tier]) tier = g.tier;
    return clampTier(keyId, tier);
  }
  return 'cannot';
}

/**
 * The tier a three-state row shows for an agent's grants (pass one agent's grants): the tier that decides each key the
 * row reads (`KEY_TIER_ROW_READS`), the most restrictive of them (an agent holding both deploy environments at ask
 * reads Ask). Scopes are not looked at; no grant reads Off.
 */
export function keyRowTier(
  grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
  row: KeyTierRow,
): Tier {
  let result: Tier = 'can';
  for (const keyId of KEY_TIER_ROW_READS[row]) {
    const tier = keyHeldTier(grants, keyId);
    if (RANK[tier] < RANK[result]) result = tier;
  }
  return result;
}

/** Whether a key of a row is under another key of the same row (`deploy.staging` under `deploy`). */
function coveredInRow(row: KeyTierRow, keyId: KeyId): boolean {
  return keyChain(keyId).some((k) => k !== canonicalKey(keyId) && KEY_TIER_ROW_KEYS[row].includes(k));
}

/**
 * The grants with a three-state row set to `tier`: every key of the row (`KEY_TIER_ROW_KEYS`) at `tier`, without a
 * scope (the row is the whole truth) — a key under the row's own key (`merge.main`, `deploy.staging`) only when the
 * grants hold it (the umbrella covers it otherwise), every other key always (Money's `billing.write`). Order: the other
 * grants as they were, each row grant where it was, new row grants at the end in row order.
 */
export function withKeyRowTier(grants: readonly GrantInput[], row: KeyTierRow, tier: Tier): GrantInput[] {
  const covered = KEY_TIER_ROW_KEYS[row];
  const written = new Set<KeyId>();
  const out = grants.map((g): GrantInput => {
    if (!covered.includes(g.keyId)) return g;
    written.add(g.keyId);
    return { keyId: g.keyId, tier };
  });
  for (const keyId of covered) {
    if (written.has(keyId) || coveredInRow(row, keyId)) continue;
    out.push({ keyId, tier });
  }
  return out;
}

/* Everything else is on (RA-02) ---------------------------------------------------------------------------------- */

/**
 * Keys an agent may hold that are not always on although no risk row holds them (RA-02): approving pull requests
 * (reviews stay a person's thing, MOA-01) and changing connected services (a row of its own, CT-310).
 */
export const ALWAYS_ON_EXCEPTIONS: readonly KeyId[] = ['pr.approve', 'connections.write', 'settings.change'];

/**
 * The keys the agent holds at `can` (Whombat resourceful-agents.md RA-02): every key an agent may hold at `can`
 * (`agentMaxTier`) that is neither a person's account key (group `personal`, `ACCOUNT_GRANTS`) nor in a risk row,
 * except `ALWAYS_ON_EXCEPTIONS`. One id per permission, in catalog order: other wordings (`sameAs`: `repos.read_all`,
 * `branch.feature.write`, `code.change`) and the bundle `tests_ci.run` (it only brings in `tests.run` and `ci.run`, both
 * listed) are left out.
 */
export const ALWAYS_ON_KEYS: readonly KeyId[] = KEY_IDS.filter(
  (id) =>
    agentMaxTier(id) === 'can' &&
    KEY_CATALOG[id].group !== 'personal' &&
    keyTierRowOf(id) === null &&
    !ALWAYS_ON_EXCEPTIONS.includes(id) &&
    !KEY_CATALOG[id].sameAs &&
    // Keys only automations hold (0.69, CT-325: `report.update`) are no agent's.
    !KEY_CATALOG[id].automationsOnly &&
    // Keys nothing uses any more (0.113, CT-824) are given to nobody.
    !KEY_CATALOG[id].retired &&
    id !== 'tests_ci.run',
);

/** Whether a key is always on (`ALWAYS_ON_KEYS`; other wordings of one count too). */
export function isAlwaysOnKey(keyId: KeyId): boolean {
  return ALWAYS_ON_KEYS.includes(canonicalKey(keyId));
}

const tierKeys = (grants: readonly GrantInput[], tier: Tier) =>
  grants.filter((g) => g.tier === tier).map((g) => g.keyId);

/**
 * The agent's keys when the Whombat is created (Whombat one-agent.md OA-05): a person's accounts (`ACCOUNT_GRANTS`:
 * sending, invites, sharing and trashing ask), everything else an agent may hold on (`ALWAYS_ON_KEYS` and
 * `CAN_BY_DEFAULT_KEYS`), and every key of the six risk rows at `ask`. Owners change them in Settings → Agent → Keys.
 */
export const AGENT_DEFAULT_KEYS: KeySet = {
  can: [
    ...tierKeys(ACCOUNT_GRANTS, 'can'),
    ...ALWAYS_ON_KEYS.filter((k) => !ACCOUNT_GRANTS.some((g) => g.keyId === k)),
    ...CAN_BY_DEFAULT_KEYS,
  ],
  // Sharing a thread by link always asks (its cap is Ask; Whombat share-links.md).
  ask: [...tierKeys(ACCOUNT_GRANTS, 'ask'), ...ASK_BY_DEFAULT_KEYS, 'share.link', ...RISK_ROW_KEYS],
  cannot: [],
};

/** Grants for a key set (clamped). */
export function grantsFromKeySet(agentId: string, set: KeySet): Grant[] {
  const out: Grant[] = [];
  for (const tier of ['can', 'ask', 'cannot'] as const) {
    for (const keyId of set[tier]) out.push({ agentId, keyId, tier: clampTier(keyId, tier) });
  }
  return out;
}

/** The agent's default grants (`AGENT_DEFAULT_KEYS`). */
export function agentDefaultGrants(agentId: string): Grant[] {
  return grantsFromKeySet(agentId, AGENT_DEFAULT_KEYS);
}

/* The Keys rows (RA-01, RA-02) ------------------------------------------------------------------------------------ */

export interface KeyOption {
  keyId: KeyId;
  /** On when the page opens. Locked rows are never toggleable. A three-state row: its `defaultTier` is `can`. */
  defaultOn: boolean;
  /** "people only" / "always asks a person" / "included with the browser", or null when the row toggles. */
  locked: string | null;
  /** The tier a locked row holds: its cap (cannot / ask). */
  lockedTier: Tier | null;
  /**
   * Set on the three-state rows: the six risk rows (`KEY_TIER_ROWS`, RA-01) and, under All keys, a single key with a
   * tier of its own (`connections.write`, `ALL_KEY_OPTIONS`). The row is Off · Ask · On (`KEY_TIER_CHOICES`) instead
   * of a switch, and this is the tier it opens at. Such a row is never locked.
   */
  defaultTier?: Tier;
  /**
   * When set, this row is on and locked because another on key brings it in through a bundle (`browser.use` →
   * `web.browse`, S2). It grants nothing of its own — the bundle key does — so `configureGrants` skips it.
   */
  includedWith?: KeyId;
}

function tierRow(keyId: KeyId, defaultTier: Tier): KeyOption {
  return { keyId, defaultOn: defaultTier === 'can', locked: null, lockedTier: null, defaultTier };
}

/** The first rows of Keys (RA-01): the six risk rows, Off · Ask · On, at Ask. */
export const RISK_KEY_OPTIONS: readonly KeyOption[] = KEY_TIER_ROWS.map((row) => tierRow(row, 'ask'));

/** The keys to a person's own accounts (group `personal`, `ACCOUNT_GRANTS`), in catalog order. */
export const ACCOUNT_KEYS: readonly KeyId[] = KEY_IDS.filter((id) => KEY_CATALOG[id].group === 'personal');

/**
 * The account keys with Off · Ask · On instead of a switch: trashing mail and files starts at Ask and the person may let
 * the agent go ahead without asking. What reaches other people (sending, invites, sharing) always asks.
 */
export const ACCOUNT_TIER_KEYS: readonly KeyId[] = ['mail.delete', 'files.delete'];

/**
 * Keys' collapsed All keys (RA-02, OA-05): every key the agent may hold outside the six risk rows, one id per
 * permission, in catalog order — `ALWAYS_ON_KEYS` (switches, on), `pr.approve` (a switch, off), `connections.write`
 * (Off · Ask · On at On, CT-310) and a person's account keys (`ACCOUNT_KEYS`, switches, on; sending, invites and sharing
 * are held at `ask`, their cap; trashing is Off · Ask · On at Ask, `ACCOUNT_TIER_KEYS`). The switches work as `configureKeyState` and `configureGrants` say: on = the
 * key's cap (`can`, or `ask` for a capped key), off = no grant.
 */
export const ALL_KEY_OPTIONS: readonly KeyOption[] = KEY_IDS.filter(
  (id) => isAlwaysOnKey(id) || ALWAYS_ON_EXCEPTIONS.includes(id) || ACCOUNT_KEYS.includes(id),
)
  .filter((id) => !KEY_CATALOG[id].sameAs)
  .map((keyId) =>
    CAN_BY_DEFAULT_KEYS.includes(keyId)
      ? tierRow(keyId, 'can')
      : ACCOUNT_TIER_KEYS.includes(keyId) || ASK_BY_DEFAULT_KEYS.includes(keyId)
        ? tierRow(keyId, 'ask')
        : {
            keyId,
            defaultOn: isAlwaysOnKey(keyId) || ACCOUNT_KEYS.includes(keyId),
            locked: null,
            lockedTier: null,
          },
  );

export interface KeyRow {
  keyId: KeyId;
  label: string;
  tier: Tier;
  /** ✓ can · ? asks a person · × no key */
  mark: '✓' | '?' | '×';
  /** '' · 'asks a person' · 'no key' */
  note: '' | 'asks a person' | 'no key';
  scope?: KeyScope;
}

const TIER_ROW: Record<Tier, Pick<KeyRow, 'mark' | 'note'>> = {
  can: { mark: '✓', note: '' },
  ask: { mark: '?', note: 'asks a person' },
  cannot: { mark: '×', note: 'no key' },
};

/** Label of a grant. */
export function grantLabel(grant: Pick<Grant, 'keyId'>): string {
  return keyLabel(grant.keyId);
}

/**
 * Key rows as the agent page and run page show them: can (✓), then ask (?), then cannot (×), each in catalog order.
 * Tiers are clamped first; retired keys are left out (CT-824).
 */
export function keyRows(grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[]) {
  const rows: KeyRow[] = grants
    .filter((g) => !isRetiredKey(g.keyId))
    .map((g) => {
      const tier = clampTier(g.keyId, g.tier);
      const row: KeyRow = { keyId: g.keyId, label: grantLabel(g), tier, ...TIER_ROW[tier] };
      if (g.scope) row.scope = g.scope;
      return row;
    });
  const rank: Record<Tier, number> = { can: 0, ask: 1, cannot: 2 };
  return rows.sort((a, b) => rank[a.tier] - rank[b.tier] || keyOrder(a.keyId) - keyOrder(b.keyId));
}

/** A key a held key brings in through its bundle, for the agent page: “Browse the web · with the browser” (S2). */
export interface ImpliedKeyRow {
  keyId: KeyId;
  label: string;
  /** The held key that brings it in. */
  impliedBy: KeyId;
  /** “with the browser”. */
  note: string;
}

/**
 * Keys an agent holds only through a bundle, not in its own right (so `keyRows` doesn't list them): `browser.use`
 * held → “Browse the web · with the browser”. A companion to `keyRows`, which is unchanged. In catalog order, once
 * each, skipping any key the agent also holds directly.
 */
export function impliedKeyRows(grants: readonly Pick<Grant, 'keyId' | 'tier'>[]): ImpliedKeyRow[] {
  const held = new Set(
    grants.filter((g) => clampTier(g.keyId, g.tier) !== 'cannot').map((g) => canonicalKey(g.keyId)),
  );
  const rows: ImpliedKeyRow[] = [];
  const seen = new Set<KeyId>();
  for (const g of grants) {
    if (clampTier(g.keyId, g.tier) === 'cannot') continue;
    for (const implied of keysImpliedBy(g.keyId)) {
      if (held.has(implied) || seen.has(implied)) continue;
      seen.add(implied);
      rows.push({
        keyId: implied,
        label: keyLabel(implied),
        impliedBy: g.keyId,
        note: impliedWithNote(g.keyId),
      });
    }
  }
  return rows.sort((a, b) => keyOrder(a.keyId) - keyOrder(b.keyId));
}

export interface KeysSummary {
  /** Keys held at `can`. */
  keys: number;
  /** Keys held at `ask`. */
  askFirst: number;
}

/** Inputs for "3 keys · 1 ask first" (retired keys not counted, CT-824). */
export function keysSummary(grants: readonly Pick<Grant, 'keyId' | 'tier'>[]): KeysSummary {
  let keys = 0;
  let askFirst = 0;
  for (const g of grants) {
    if (isRetiredKey(g.keyId)) continue;
    const tier = clampTier(g.keyId, g.tier);
    if (tier === 'can') keys++;
    else if (tier === 'ask') askFirst++;
  }
  return { keys, askFirst };
}

/** "3 keys · 1 ask first". */
export function formatKeysSummary(s: KeysSummary): string {
  return `${s.keys} ${s.keys === 1 ? 'key' : 'keys'} · ${s.askFirst} ask first`;
}

/**
 * Key needed to write to a branch: the default branch → Push to main (CT-211; agents may hold it since 0.36 — Off,
 * Ask or On, AC-41), feat/* → feature key, else shared.
 */
export function branchWriteKey(branch: string, defaultBranch = 'main'): KeyId {
  if (branch === defaultBranch) return 'branch.main.push';
  if (globMatch('feat/*', branch)) return 'branch.feature.readwrite';
  return 'branch.shared.push';
}

export type GrantChangeKind = 'added' | 'removed' | 'tier_changed' | 'scope_changed';

export interface GrantChange {
  keyId: KeyId;
  kind: GrantChangeKind;
  from: Tier | null;
  to: Tier | null;
  scope?: KeyScope;
}

function sameScope(a: KeyScope | undefined, b: KeyScope | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Changes between two grant sets of one agent, in catalog order. Each becomes one `Keys` event. */
export function diffGrants(
  before: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
  after: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
): GrantChange[] {
  const byKey = (list: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[]) =>
    new Map(list.map((g) => [g.keyId, g] as const));
  const a = byKey(before);
  const b = byKey(after);
  const keys = [...new Set<KeyId>([...a.keys(), ...b.keys()])].sort((x, y) => keyOrder(x) - keyOrder(y));
  const changes: GrantChange[] = [];
  for (const keyId of keys) {
    const prev = a.get(keyId);
    const next = b.get(keyId);
    if (!prev && next)
      changes.push(withScope({ keyId, kind: 'added', from: null, to: next.tier }, next.scope));
    else if (prev && !next) changes.push({ keyId, kind: 'removed', from: prev.tier, to: null });
    else if (prev && next && prev.tier !== next.tier)
      changes.push(withScope({ keyId, kind: 'tier_changed', from: prev.tier, to: next.tier }, next.scope));
    else if (prev && next && !sameScope(prev.scope, next.scope))
      changes.push(withScope({ keyId, kind: 'scope_changed', from: prev.tier, to: next.tier }, next.scope));
  }
  return changes;
}

function withScope(change: GrantChange, scope: KeyScope | undefined): GrantChange {
  if (scope) change.scope = scope;
  return change;
}

/** Possessive with the typographic apostrophe: Neo → Neo’s. */
export function possessive(name: string): string {
  return `${name}’s`;
}

/**
 * Audit text of a grant change, e.g. "Gave Banjo a new key: Run tests",
 * "Moved Neo’s “Deploy to production” key to ask first".
 */
export function describeGrantChange(agentName: string, change: GrantChange): string {
  const label = grantLabel({ keyId: change.keyId });
  const who = possessive(agentName);
  const { from, to } = change;
  if (change.kind === 'scope_changed') return `Changed where ${who} “${label}” key works`;
  if (to === null || to === 'cannot') {
    if (from === null) return `Marked “${label}” as a key ${agentName} doesn’t hold`;
    return `Took ${who} “${label}” key away`;
  }
  if (to === 'can') {
    if (from === 'ask') return `Let ${agentName} use “${label}” without asking`;
    return `Gave ${agentName} a new key: ${label}`;
  }
  // to === 'ask'
  if (from === 'can') return `Moved ${who} “${label}” key to ask first`;
  return `Gave ${agentName} a new key that asks first: ${label}`;
}

/** Validates a grant set before saving: known keys, no duplicates, tiers within caps. */
export function validateGrants(
  grants: readonly GrantInput[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const g of grants) {
    if (!KEY_CATALOG[g.keyId]) errors.push(`Unknown key ${g.keyId}`);
    if (seen.has(g.keyId)) errors.push(`Duplicate key ${g.keyId}`);
    seen.add(g.keyId);
    const cap = clampTier(g.keyId, g.tier);
    if (cap !== g.tier)
      errors.push(`${KEY_CATALOG[g.keyId]?.label ?? g.keyId} can be at most “${cap}” for the agent`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
