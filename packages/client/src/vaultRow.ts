/**
 * A Vault entry's one line in the list, the same on the web and the phone
 * (docs/decisions/final-settings-vault-files-usage.md): only an entry whose check is failing gets the loud mark —
 * “Not working · The password stopped working” — every other one says how its check went and when it was last used
 * (“Sign-in reached · Last used 09:12”, “Not checked · Neo is off”). A secret's value is never part of it. Pure.
 */
import { formatRecent } from '@whombat/core/text';
import { VAULT_COPY, type VaultEntry, vaultEntryProblem } from '@whombat/core/vault';
import { agentWords } from './agentName';

export const VAULT_ROW_TEXT = {
  intro: (agent: string) => `Sign-ins and secrets ${agentWords(agent).Name} can use when it works for you.`,
  /** Under the list: what the Vault never shows. */
  closed: 'Secrets stay closed. Replace one here when it changes.',
  notWorking: 'Not working',
  reached: 'Sign-in reached',
  secret: 'Secret',
  notUsed: 'Not used yet',
  lastUsed: (when: string) => `Last used ${when}`,
  off: (agent: string) => `${agentWords(agent).Name} is off`,
  loading: 'Loading your Vault…',
  emptyTitle: 'Nothing in your Vault yet',
  failedTitle: 'Couldn’t read your Vault',
  failedLine: 'This doesn’t mean a sign-in stopped working. Try again in a moment.',
  retry: 'Try again',
} as const;

export interface VaultRowLine {
  text: string;
  /** The entry's check is failing: the only line drawn in the “Not working” colour. */
  failing: boolean;
}

/** The entry's line under its name. */
export function vaultRowLine(
  entry: Pick<VaultEntry, 'kind' | 'auth' | 'check' | 'agentOn' | 'lastUsedAt'>,
  ctx: { now: Date | number | string; timeZone: string; agent: string },
): VaultRowLine {
  const problem = entry.kind === 'secret' ? null : vaultEntryProblem(entry);
  if (problem) return { text: `${VAULT_ROW_TEXT.notWorking} · ${problem.replace(/\.$/, '')}`, failing: true };
  const status =
    entry.kind === 'secret'
      ? VAULT_ROW_TEXT.secret
      : entry.check.status === 'reached'
        ? VAULT_ROW_TEXT.reached
        : VAULT_COPY.notChecked;
  const use = !entry.agentOn
    ? VAULT_ROW_TEXT.off(ctx.agent)
    : entry.lastUsedAt
      ? VAULT_ROW_TEXT.lastUsed(formatRecent(entry.lastUsedAt, ctx.now, ctx.timeZone))
      : VAULT_ROW_TEXT.notUsed;
  return { text: `${status} · ${use}`, failing: false };
}
