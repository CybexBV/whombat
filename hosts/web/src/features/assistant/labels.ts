// Words and colors of the assistant UI: investigation states, access
// levels, providers, and the label an alert row shows for its investigation.

import type { Access, Investigation, InvestigationState, ProviderId } from '../../api/assist';
import { t } from '../../lib/i18n';

export const STATE_LABEL: Record<InvestigationState, string> = {
  starting: t('Starting'),
  running: t('Investigating'),
  waiting: t('Waiting for you'),
  idle: t('Answered'),
  done: t('Done'),
  failed: t('Failed'),
  stopped: t('Stopped'),
};

/** "Done · needs attention" for a finished investigation that did not resolve its problem. */
export function stateText(i: Pick<Investigation, 'state' | 'resolved'>): string {
  return i.state === 'done' && i.resolved === false ? `${STATE_LABEL.done} · ${t('needs attention')}` : STATE_LABEL[i.state];
}

/** The assistant is working (a spinner instead of a dot; Stop is offered). */
export function isActive(state: InvestigationState): boolean {
  return state === 'starting' || state === 'running' || state === 'waiting';
}

/** Status color of an investigation: a finished one that needs attention is a warning. */
export function stateColor(i: Pick<Investigation, 'state' | 'resolved'>): string {
  switch (i.state) {
    case 'waiting':
      return 'var(--warning)';
    case 'done':
      return i.resolved === false ? 'var(--warning)' : 'var(--good)';
    case 'failed':
      return 'var(--critical)';
    case 'stopped':
      return 'var(--muted)';
    default:
      return 'var(--info)';
  }
}

/** The state an alert row shows for its investigation (docs/ASSIST.md 7). */
export function alertInvestigationLabel(state: InvestigationState): string {
  if (state === 'starting' || state === 'running') return t('Investigating…');
  if (state === 'waiting') return t('Waiting for you');
  return t('Investigated');
}

export const PROVIDER_NAME: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };

export const ACCESS: { value: Access; label: string; text: string }[] = [
  { value: 'read', label: t('Read only'), text: t('Looks, never changes anything') },
  { value: 'ask', label: t('Ask before changes'), text: t('Commands and guest actions wait for your approval') },
  { value: 'full', label: t('Full access'), text: t('Runs commands and actions without asking, where the host allows them') },
];

export const ACCESS_LABEL: Record<Access, string> = { read: t('Read only'), ask: t('Ask before changes'), full: t('Full access') };

/** "Claude Code · opus" (no model: the CLI's default). */
export function providerLine(i: Pick<Investigation, 'provider' | 'model'>): string {
  return i.model ? `${PROVIDER_NAME[i.provider]} · ${i.model}` : PROVIDER_NAME[i.provider];
}

/** "≈ $0.42", or null without an estimate. */
export function costText(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  return `≈ $${usd < 0.01 && usd > 0 ? '0.01' : usd.toFixed(2)}`;
}

/** The newest investigation of an alert (lists are newest first). */
export function investigationOfAlert(list: Investigation[] | undefined, alertId: string): Investigation | undefined {
  return list?.find((i) => i.alert_id === alertId);
}
