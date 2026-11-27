/**
 * Pure view model of the automations screens (Whombat docs/decisions/automation-chat.md; app automation-chat.md): labels
 * and tones for statuses and step states, and the overview's words. The list's rows and an automation's page are the
 * phone's too (`@whombat/client` automationView). Automations are made and changed by talking to the agent, so nothing
 * here edits a definition.
 */
import {
  type AgentScheduleView,
  type AutomationRunStatus,
  type AutomationStepState,
  daysAgo,
  formatClock,
  formatDate,
  formatShortWeekday,
  scheduleActions,
} from '@whombat/core';
import type { DotTone } from '../../components/StatusDot';
import { liveT } from '../../i18n/live';
import { currentLocale, type WebMessageKey, webTranslator } from '../../i18n/provider';

/**
 * A run's status and its colour. Red says something doesn't work now, so a failed run, or one that needs a look, is
 * `warn`: it happened, and the automation isn't broken for it. A finished run's page says how it went
 * (`automationRunLabel`: “Finished · worked”).
 */
/** A label read in the page's language when it is shown, beside its fixed colour. */
function liveLabel(key: WebMessageKey, tone: DotTone): { readonly label: string; tone: DotTone } {
  return {
    get label() {
      return liveT(key);
    },
    tone,
  };
}

export const RUN_STATUS: Record<AutomationRunStatus, { readonly label: string; tone: DotTone }> = {
  queued: liveLabel('automations.status.queued', 'mut'),
  running: liveLabel('automations.status.running', 'brand'),
  waiting: liveLabel('automations.status.waiting', 'warn'),
  paused: liveLabel('automations.status.paused', 'warn'),
  succeeded: liveLabel('automations.status.done', 'ok'),
  failed: liveLabel('automations.status.failed', 'warn'),
  cancelled: liveLabel('automations.status.stopped', 'mut'),
  skipped: liveLabel('automations.status.skipped', 'mut'),
  needs_review: liveLabel('automations.status.needsYou', 'warn'),
};

export const STEP_STATE: Record<AutomationStepState, { readonly label: string; tone: DotTone }> = {
  pending: liveLabel('automations.status.notYet', 'mut'),
  running: liveLabel('automations.status.running', 'brand'),
  waiting: liveLabel('automations.status.waiting', 'warn'),
  succeeded: liveLabel('automations.status.done', 'ok'),
  failed: liveLabel('automations.status.failed', 'bad'),
  skipped: liveLabel('automations.status.skipped', 'mut'),
  cancelled: liveLabel('automations.status.stopped', 'mut'),
  blocked: liveLabel('automations.status.blocked', 'bad'),
  uncertain: liveLabel('automations.status.uncertain', 'bad'),
};

export function runActive(status: AutomationRunStatus): boolean {
  return ['queued', 'running', 'waiting', 'paused', 'needs_review'].includes(status);
}

/* The list (docs/app/decisions/automation-page.md) ----------------------------------------------------------------- */

/** “Next run 09:00” today, “Next run Mon 09:00” this week, “Next run 3 Nov” later (AP-1084). */
export function nextRunWords(nextRunAt: string, now: Date, timeZone: string): string {
  const { t } = webTranslator(currentLocale());
  const days = -daysAgo(nextRunAt, now, timeZone);
  const clock = formatClock(nextRunAt, timeZone);
  if (days <= 0) return t('automations.nextRun', { when: clock });
  if (days < 7) {
    return t('automations.nextRun', {
      when: `${formatShortWeekday(nextRunAt, timeZone, currentLocale())} ${clock}`,
    });
  }
  return t('automations.nextRun', { when: formatDate(nextRunAt, timeZone, { now }, currentLocale()) });
}

/* The overview (docs/app/decisions/automation-chat.md) --------------------------------------------------------------- */

/** The page's words, with the agent's name. */
export function overviewWords(agentName: string) {
  return {
    title: 'Automations',
    subtitle: `What ${agentName} does on its own.`,
    /** Over the field. */
    intro: `To make one or change one, tell ${agentName}.`,
    placeholder: `Tell ${agentName} what should happen on its own…`,
    /** The field's words on a phone, where the whole sentence doesn't fit beside its buttons. */
    placeholderShort: `Tell ${agentName}…`,
    automations: 'Automations',
    onlyTellsYou: 'Only tells you',
    loading: 'Loading automations…',
    emptyTitle: 'No automations yet',
    empty: `Repeated jobs and their results will appear here. Tell ${agentName} what should happen on its own.`,
    emptyButton: `Tell ${agentName}…`,
    readFailed: 'Couldn’t read your automations.',
    readFailedText: 'There’s no saved copy to show on this device yet.',
    refreshFailed: 'Couldn’t refresh your automations.',
    savedAt: (when: string) => `Showing the list saved at ${when}.`,
    tryAgain: 'Try again',
    ask: `Ask ${agentName}`,
    /** What “Ask Neo” puts in the field, unsent. */
    askText: 'My automations list didn’t load. Can you check what’s wrong?',
    moreDetail: 'More detail',
  };
}

/** The agent's schedules the overview lists: running, paused, or ended after 90 days (Resume renews it). */
export function listedSchedules(schedules: readonly AgentScheduleView[] | undefined): AgentScheduleView[] {
  return (schedules ?? []).filter((s) => s.status !== 'ended' || scheduleActions(s).resume);
}
