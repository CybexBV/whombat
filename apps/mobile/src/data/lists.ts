/**
 * View models for a branch room's header and Settings → Agent's spend line (one-agent.md AP-4975). They reuse core's
 * copy helpers so wording matches the web. Pure.
 */
import { type SpendAgentWeek, spendLine } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

/**
 * A branch room's mono line: its number, and the repository's name when the rooms span several (CT-170, AP-514). The
 * room's own header uses it.
 */
export function branchRoomMeta(
  room: { prNumber: number; repo?: string | null },
  repos: ReadonlySet<string>,
): string {
  const name = room.repo?.split('/')[1];
  return repos.size > 1 && name ? `${name} #${room.prNumber}` : `#${room.prNumber}`;
}

/**
 * The agent's spend line (Whombat spend.md SP-02, AP-236; Settings → Agent → Spend, AP-4975): “This week: 1.2M tokens ·
 * about $3.40”, “This week: 1.2M tokens” when no turn reported a cost. Null while it loads or when the server won't say
 * (the line is hidden).
 */
export function agentSpendLine(spend: SpendAgentWeek | undefined, locale?: string): string | null {
  // “tasks”, not the contract's “turns”, like the web (web-efficiency.md WE-16).
  if (!spend) return null;
  return spend.week.turns === 0
    ? mobileTranslator(locale).t('data.lists.noTasks')
    : spendLine(spend.week, locale);
}
