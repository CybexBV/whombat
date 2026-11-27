/**
 * WHAT {ASSISTANT} MAY DO on a Google or Microsoft 365 account's page (Whombat accounts.md): the keys to the person's
 * own accounts, by service, each Allowed · Asks · Off (the words of a connection's tools) where the person may choose all
 * three, Asks · Off where it always asks (sending, invites, sharing: what reaches other people). A change is saved at once through `agent.setKeys` with every
 * other grant as it is (`withAccountTier`). Pure, shared by the web and the phone.
 */
import { type ConnectorService, connectionToolTierLabels } from '@whombat/core';
import type { Grant, GrantInput } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { agentMaxTier, type KeyId, keyLabel, type Tier } from '@whombat/core/keys';
import { agentWords } from '../agentName';
import { clientTree } from '../i18n/catalog';
import { CONN_ACCOUNT_KEYS_WORDS } from '../i18n/messages/connectionsHosts/connections';

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

const GROUPS: readonly {
  title: 'mail' | 'calendar' | 'files' | 'contacts';
  services: readonly ConnectorService[];
  keys: readonly KeyId[];
}[] = [
  {
    title: 'mail',
    services: ['mail'],
    keys: ['mail.read', 'mail.organize', 'mail.draft', 'mail.delete', 'mail.send'],
  },
  { title: 'calendar', services: ['calendar'], keys: ['calendar.read', 'calendar.write', 'calendar.invite'] },
  {
    title: 'files',
    services: ['files', 'docs', 'sheets'],
    keys: ['files.read', 'files.write', 'files.delete', 'files.share'],
  },
  { title: 'contacts', services: ['contacts'], keys: ['contacts.read'] },
];

const ALL: readonly Tier[] = ['can', 'ask', 'cannot'];
const ASKS: readonly Tier[] = ['ask', 'cannot'];

/** A tier in a connection's words: Allowed, Asks, Off. */
export function accountTierLabels(locale?: string | null): Readonly<Record<Tier, string>> {
  const labels = connectionToolTierLabels(locale);
  return { can: labels.can, ask: labels.ask, cannot: labels.off };
}

export const ACCOUNT_TIER_LABELS: Readonly<Record<Tier, string>> = accountTierLabels('en');

/** The section's words, the assistant by its name. */
export function accountKeysText(agent: string, locale?: string | null) {
  const { Name: N } = agentWords(agent, locale);
  const w = clientTree(locale, CONN_ACCOUNT_KEYS_WORDS);
  return {
    title: interpolate(w.title, { NAME: N.toUpperCase() }),
    line: (account: string) => interpolate(w.line, { Name: N, account }),
    tiersLabel: (key: string) => interpolate(w.tiersLabel, { key, Name: N }),
    alwaysAsks: w.alwaysAsks,
    saved: w.saved,
    failed: w.failed,
    groups: w.groups,
  };
}

/** The rows of the services the account brings, in the order above. */
export function accountKeyGroups(
  grants: readonly Pick<Grant, 'keyId' | 'tier'>[],
  services: readonly ConnectorService[],
  agent: string,
  locale?: string | null,
): AccountKeyGroup[] {
  const t = accountKeysText(agent, locale);
  return GROUPS.filter((g) => g.services.some((s) => services.includes(s))).map((g) => ({
    title: t.groups[g.title],
    rows: g.keys.map((keyId) => {
      const capped = agentMaxTier(keyId) === 'ask';
      const held = grants.find((x) => x.keyId === keyId)?.tier ?? 'cannot';
      return {
        keyId,
        label: keyLabel(keyId, locale),
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
