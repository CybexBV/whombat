/**
 * The run screen's ACTIVITY section (work-supervision WS-13…WS-17): one row per observed action, routine reads and
 * searches collapsed into a group (`collapseActivity`, shared with the web) and evidence behind a tap. Pure, so it is
 * unit-tested.
 */
import { type Activity, type ActivityStatus, collapseActivity, formatAgo } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

/** The status dot: running in the developer green, waiting warn, failed bad, interrupted mut, done ok. */
export type ActivityDot = 'live' | 'ok' | 'warn' | 'bad' | 'mut';

export const ACTIVITY_DOTS: Record<ActivityStatus, ActivityDot> = {
  running: 'live',
  waiting: 'warn',
  failed: 'bad',
  interrupted: 'mut',
  done: 'ok',
};

/** Screen-reader words for the dot. */
export function activityStatusLabels(locale?: string): Record<ActivityStatus, string> {
  const { t } = mobileTranslator(locale);
  return {
    running: t('data.activity.running'),
    waiting: t('data.activity.waiting'),
    failed: t('data.run.step.failed'),
    interrupted: t('data.activity.interrupted'),
    done: t('data.run.step.done'),
  };
}
export const ACTIVITY_STATUS_LABELS = activityStatusLabels();

/** Under evidence that was shortened (input over 1 KB, output over 4 KB). */
export function activityTruncatedText(locale?: string): string {
  return mobileTranslator(locale).t('data.activity.truncated');
}
export const ACTIVITY_TRUNCATED_TEXT = activityTruncatedText();

export interface ActivityRowView {
  id: string;
  dot: ActivityDot;
  statusLabel: string;
  /** As the server wrote it: “Command failed”, “Interrupted · the turn stopped”. */
  title: string;
  detail: string | null;
  /** Mono: the path, command or query. */
  object: string | null;
  /** `just now`, `3 min ago`. */
  time: string;
  evidence: { input: string | null; output: string | null; truncated: boolean } | null;
  accessibilityLabel: string;
}

export type ActivityEntryView =
  | { type: 'row'; key: string; row: ActivityRowView }
  | { type: 'group'; key: string; title: string; time: string; rows: ActivityRowView[] };

export interface ActivitySectionModel {
  entries: ActivityEntryView[];
}

export function activityRow(a: Activity, now: Date, timeZone: string, locale?: string): ActivityRowView {
  const time = formatAgo(a.updatedAt, now, timeZone, locale);
  const statusLabel = activityStatusLabels(locale)[a.status];
  const evidence =
    a.evidence && (a.evidence.input || a.evidence.output)
      ? { input: a.evidence.input, output: a.evidence.output, truncated: a.evidence.truncated }
      : null;
  return {
    id: a.id,
    dot: ACTIVITY_DOTS[a.status],
    statusLabel,
    title: a.title,
    detail: a.detail,
    object: a.object,
    time,
    evidence,
    accessibilityLabel: [a.title, a.detail, a.object, statusLabel, time].filter(Boolean).join(', '),
  };
}

/**
 * Rows oldest first, as the feed reads (the live log's order). A turn with no rows yet shows nothing (the section stays
 * out of the way); every turn reports its steps since Hermes runs them all (hermes-engine-app.md AP-5009).
 */
export function activitySection(
  res: { activities: readonly Activity[] } | undefined,
  now: Date,
  timeZone: string,
  locale?: string,
): ActivitySectionModel {
  if (!res) return { entries: [] };
  const entries = collapseActivity(res.activities).map((e): ActivityEntryView => {
    if (e.type === 'row')
      return { type: 'row', key: e.activity.id, row: activityRow(e.activity, now, timeZone, locale) };
    const rows = e.items.map((a) => activityRow(a, now, timeZone, locale));
    return {
      type: 'group',
      key: `group-${e.items[0]?.id ?? e.title}`,
      title: e.title,
      time: rows.at(-1)?.time ?? '',
      rows,
    };
  });
  return { entries };
}
