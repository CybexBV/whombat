import { agentWords } from '@whombat/client';
import { formatRecent } from '@whombat/core/text';
import { type VaultEntry, vaultCopy, vaultEntryProblem } from '@whombat/core/vault';
import { mobileTranslator } from '../i18n/translate';

export function vaultRowText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    intro: (agent: string) => t('vault.row.intro', { agent: agentWords(agent, locale).Name }),
    closed: t('vault.row.closed'),
    notWorking: t('vault.row.notWorking'),
    reached: t('vault.row.reached'),
    secret: t('vaultForm.vaultFormText.secretLabel.secret'),
    notUsed: t('vault.row.notUsed'),
    lastUsed: (when: string) => t('vault.row.lastUsed', { when }),
    off: (agent: string) => t('vault.row.off', { agent: agentWords(agent, locale).Name }),
    loading: t('vault.row.loading'),
    emptyTitle: t('vault.row.emptyTitle'),
    failedTitle: t('vault.row.failedTitle'),
    failedLine: t('vault.row.failedLine'),
    retry: t('search.searchCopy.retry'),
  };
}

export function phoneVaultRowLine(
  entry: Pick<VaultEntry, 'kind' | 'auth' | 'check' | 'agentOn' | 'lastUsedAt'>,
  { now, timeZone, agent, locale }: { now: Date; timeZone: string; agent: string; locale: string },
) {
  const words = vaultRowText(locale);
  const problem = entry.kind === 'secret' ? null : vaultEntryProblem(entry, locale);
  if (problem) return { text: `${words.notWorking} · ${problem.replace(/\.$/, '')}`, failing: true };
  const status =
    entry.kind === 'secret'
      ? words.secret
      : entry.check.status === 'reached'
        ? words.reached
        : vaultCopy(locale).notChecked;
  const use = !entry.agentOn
    ? words.off(agent)
    : entry.lastUsedAt
      ? words.lastUsed(formatRecent(entry.lastUsedAt, now, timeZone, locale))
      : words.notUsed;
  return { text: `${status} · ${use}`, failing: false };
}
