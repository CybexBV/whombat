/**
 * WHAT {ASSISTANT} MAY DO on a Google or Microsoft 365 account's page (Whombat accounts.md): the keys to the person's
 * own accounts, by service, each Allowed · Asks · Off (the words of a connection's tools) where the person may choose all
 * three, Asks · Off where it always asks (sending, invites, sharing: what reaches other people). A change is saved at once through `agent.setKeys` with every
 * other grant as it is (`withAccountTier`). Pure, shared by the web and the phone.
 */
import { CONNECTION_TOOL_TIER_LABELS, type ConnectorService } from '@whombat/core';
import type { Grant, GrantInput } from '@whombat/core/domain';
import { agentMaxTier, KEY_CATALOG, type KeyId, type Tier } from '@whombat/core/keys';
import { agentWords } from '../agentName';

export interface AccountKeyRow {
  keyId: KeyId;
  /** The key's own words: “Move mail to the trash”. */
  label: string;
  /** What it holds now; no grant reads Off. */
  tier: Tier;
  /** Allowed · Asks · Off, or Asks · Off for a key that always asks. */
  choices: readonly Tier[];
  /** “Always asks you first.” under a key that can't go ahead alone; else null. */
  note: string | null;
}

export interface AccountKeyGroup {
  /** “Mail”, “Calendar”, “Files”, “Contacts”. */
  title: string;
  rows: AccountKeyRow[];
}

const GROUPS: readonly { title: string; services: readonly ConnectorService[]; keys: readonly KeyId[] }[] = [
  {
    title: 'Mail',
    services: ['mail'],
    keys: ['mail.read', 'mail.organize', 'mail.draft', 'mail.delete', 'mail.send'],
  },
  { title: 'Calendar', services: ['calendar'], keys: ['calendar.read', 'calendar.write', 'calendar.invite'] },
  {
    title: 'Files',
    services: ['files', 'docs', 'sheets'],
    keys: ['files.read', 'files.write', 'files.delete', 'files.share'],
  },
  { title: 'Contacts', services: ['contacts'], keys: ['contacts.read'] },
];

const ALL: readonly Tier[] = ['can', 'ask', 'cannot'];
const ASKS: readonly Tier[] = ['ask', 'cannot'];

/** A tier in a connection's words: Allowed, Asks, Off. */
export const ACCOUNT_TIER_LABELS: Readonly<Record<Tier, string>> = {
  can: CONNECTION_TOOL_TIER_LABELS.can,
  ask: CONNECTION_TOOL_TIER_LABELS.ask,
  cannot: CONNECTION_TOOL_TIER_LABELS.off,
};

/** The section's words, the assistant by its name. */
export function accountKeysText(agent: string) {
  const { Name: N } = agentWords(agent);
  return {
    title: `WHAT ${N.toUpperCase()} MAY DO`,
    line: (account: string) =>
      `What ${N} may do with your ${account} account: Allowed runs at once, Asks waits for you, Off never runs.`,
    tiersLabel: (key: string) => `${key}: what ${N} may do`,
    alwaysAsks: 'Always asks you first.',
    saved: 'Saved.',
    failed: 'That didn’t save. Try again in a moment.',
  };
}

/** The rows of the services the account brings, in the order above. */
export function accountKeyGroups(
  grants: readonly Pick<Grant, 'keyId' | 'tier'>[],
  services: readonly ConnectorService[],
  agent: string,
): AccountKeyGroup[] {
  const t = accountKeysText(agent);
  return GROUPS.filter((g) => g.services.some((s) => services.includes(s))).map((g) => ({
    title: g.title,
    rows: g.keys.map((keyId) => {
      const capped = agentMaxTier(keyId) === 'ask';
      const held = grants.find((x) => x.keyId === keyId)?.tier ?? 'cannot';
      return {
        keyId,
        label: KEY_CATALOG[keyId].label,
        // A key held above its cap reads at the cap, as the engine decides it.
        tier: capped && held === 'can' ? 'ask' : held,
        choices: capped ? ASKS : ALL,
        note: capped ? t.alwaysAsks : null,
      };
    }),
  }));
}

/** What `agent.setKeys` gets: every grant as held, `keyId` at `tier` (added when it wasn't held). */
export function withAccountTier(
  grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[],
  keyId: KeyId,
  tier: Tier,
): GrantInput[] {
  const out: GrantInput[] = grants.map((g) =>
    g.scope ? { keyId: g.keyId, tier: g.tier, scope: g.scope } : { keyId: g.keyId, tier: g.tier },
  );
  const at = out.findIndex((g) => g.keyId === keyId);
  if (at >= 0) out[at] = { ...out[at], keyId, tier } as GrantInput;
  else out.push({ keyId, tier });
  return out;
}
