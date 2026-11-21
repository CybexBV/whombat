import { useTheAgent } from '@whombat/client/react';
import { type VaultWords, vaultWords } from './copy';

/**
 * The Vault's words (less-is-more.md AP-1800; one-agent.md AP-4941): the agent by its name, and what saving from chat
 * does (VS-08; AP-4009).
 */
export function useVaultWords(burrow: string): VaultWords {
  const { words } = useTheAgent(burrow);
  return vaultWords(words.name);
}
