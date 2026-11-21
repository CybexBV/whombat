/**
 * The agent holds Mara's Vault entries in the demo world (Whombat vault-self-serve.md VS-01, VS-02; one-agent.md OA-09,
 * hermes-engine.md HE-43; app AP-4035, AP-4992, AP-5280): every entry but an old `secret` entry is on for Neo until
 * switched off in the app; “Neo can use this” goes through `vault.giveKey` and `vault.takeKey` (the entry's one key, no
 * agent in the address), an API's variable name through `vault.setKeyEnvName`, and both are kept here. Pure,
 * unit-tested.
 */
import type { VaultEntry, VaultEntryDetail } from '@whombat/core/vault';

type Key = NonNullable<VaultEntryDetail['key']>;

export interface OwnVaultKeys {
  /** An entry as this world has it: on for Neo (unless switched off). */
  entry(entry: VaultEntryDetail): VaultEntryDetail;
  /** YOUR ENTRIES' row: whether it is on for Neo. */
  summary(entry: VaultEntry): VaultEntry;
  /** `vault.giveKey` (on, with its servers and variable name) or `vault.takeKey` (null). */
  set(entryId: string, given: { servers?: string[] | null; envName?: string } | null): void;
  /** `vault.setKeyEnvName`: an API's variable name, on a key it holds. */
  setEnvName(entry: Pick<VaultEntry, 'id' | 'kind' | 'createdAt'>, envName: string): void;
}

/**
 * `agentName`: the demo world's agent; the shared fixtures' recent uses name theirs (Dusty).
 */
export function createOwnVaultKeys(now: () => Date, agentName = 'Neo'): OwnVaultKeys {
  /** What was switched in the app: a key, or null for off. Untouched entries hold the key from the start. */
  const changed = new Map<string, Key | null>();
  const keyOf = (entry: Pick<VaultEntry, 'id' | 'kind' | 'createdAt'>): Key | null => {
    if (entry.kind === 'secret') return null;
    const kept = changed.get(entry.id);
    if (kept !== undefined) return kept;
    return { givenAt: entry.createdAt, servers: null, envName: null };
  };
  return {
    entry(entry) {
      const key = keyOf(entry);
      const recentUses = entry.recentUses.map((u) => ({ ...u, what: u.what.replaceAll('Dusty', agentName) }));
      return { ...entry, key, agentOn: key !== null, recentUses };
    },
    summary(entry) {
      return { ...entry, agentOn: keyOf(entry) !== null };
    },
    set(entryId, given) {
      if (!given) return void changed.set(entryId, null);
      const before = changed.get(entryId);
      changed.set(entryId, {
        givenAt: before?.givenAt ?? now().toISOString(),
        servers: given.servers ?? null,
        envName: given.envName ?? before?.envName ?? null,
      });
    },
    setEnvName(entry, envName) {
      const key = keyOf(entry);
      if (key) changed.set(entry.id, { ...key, envName });
    },
  };
}
