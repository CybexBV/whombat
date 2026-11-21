/**
 * The viewer's Vault entries the assistant may use (docs/decisions/vault.md VT-72): What it may do counts them under
 * WHAT IT CAN SIGN IN TO. Nobody sees anyone else's entries (`vault.list` answers only the caller's).
 */
import type { VaultEntry } from '@whombat/core/vault';

/** The viewer's entries the agent may use: switched on for it. */
export function agentVaultEntries(entries: readonly VaultEntry[] | undefined): VaultEntry[] {
  return (entries ?? []).filter((e) => e.agentOn);
}
