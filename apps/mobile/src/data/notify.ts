/**
 * Notifications people control, on the phone (Whombat essentials item 12; contracts CT-175; AP-511, AP-512, AP-513):
 * a conversation's level in its header menu (All / Mentions / Nothing), and Do not disturb and quiet hours in the
 * Settings tab's Notifications. The words follow the web's Settings → Notifications. Pure; every change replaces
 * `Preferences.notifications` whole (`me.updatePreferences`), built from what the server has now.
 */
import { endsText } from '@whombat/client';
import {
  type ConversationKind,
  type DateInput,
  type DndPreset,
  defaultNotifyLevel,
  dndPresetLabels,
  formatClock,
  isDndActive,
  type NotificationPreferences,
  type NotifyLevel,
  notifyLevelLabels,
  notifyLevelOf,
  toDate,
  zonedInstant,
  zonedParts,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

/* A conversation's level --------------------------------------------------------------------------------------------- */

function levelDetails(locale?: string): Record<NotifyLevel, string> {
  const { t } = mobileTranslator(locale);
  return {
    all: t('data.notify.level.all'),
    mentions: t('data.notify.level.mentions'),
    none: t('data.notify.level.none'),
  };
}

export interface NotifyOption {
  level: NotifyLevel;
  label: string;
  /** What it lets through, and “· default” on the kind's default. */
  detail: string;
  selected: boolean;
}

export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['all', 'mentions', 'none'];

/** The header menu's three choices for a conversation, the one in effect selected. */
export function notifyOptions(
  c: { kind: ConversationKind; notify?: NotifyLevel | null },
  locale?: string,
): NotifyOption[] {
  const current = notifyLevelOf(c);
  const fallback = defaultNotifyLevel(c.kind);
  const labels = notifyLevelLabels(locale);
  const details = levelDetails(locale);
  const { t } = mobileTranslator(locale);
  return NOTIFY_LEVELS.map((level) => ({
    level,
    label: labels[level],
    detail: level === fallback ? t('data.notify.isDefault', { detail: details[level] }) : details[level],
    selected: level === current,
  }));
}

/**
 * What `conversations.setNotify` gets for a pick: null for the kind's default (the conversation follows the default
 * again), else the level (AP-511).
 */
export function notifyBody(kind: ConversationKind, level: NotifyLevel): NotifyLevel | null {
  return level === defaultNotifyLevel(kind) ? null : level;
}

/* Do not disturb ------------------------------------------------------------------------------------------------------ */

/** “On until 14:52” while Do not disturb is on, “Off” otherwise. */
export function dndStateText(
  prefs: Pick<NotificationPreferences, 'dndUntil'>,
  now: DateInput,
  timeZone: string,
  locale?: string,
): string {
  const { t } = mobileTranslator(locale);
  if (!isDndActive(prefs, now) || !prefs.dndUntil) return t('data.notify.off');
  return t('data.notify.onUntil', { when: endsText(prefs.dndUntil, now, timeZone, locale) });
}

export function dndPresets(locale?: string): readonly { preset: DndPreset; label: string }[] {
  const labels = dndPresetLabels(locale);
  return (['30m', '1h', 'tomorrow'] as const).map((preset) => ({ preset, label: labels[preset] }));
}
export const DND_PRESETS = dndPresets();

export function dndHint(locale?: string): string {
  return mobileTranslator(locale).t('data.notify.dndHint');
}
export const DND_HINT = dndHint();

/** `7:30`, `0730`, `07:30` → `07:30`; null for anything that isn't a time of day. */
export function parseClock(value: string): string | null {
  const m = /^\s*(\d{1,2})[:.h]?(\d{2})\s*$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * “Until 18:30” typed in the sheet: the next time the clock shows it in the person's zone (today when it's still to
 * come, else tomorrow), or why it can't be used.
 */
export function dndUntilClock(
  value: string,
  now: DateInput,
  timeZone: string,
  locale?: string,
): { ok: true; until: string } | { ok: false; error: string } {
  const clock = parseClock(value);
  if (!clock) return { ok: false, error: mobileTranslator(locale).t('data.notify.typeTime') };
  const n = toDate(now);
  const today = zonedParts(n, timeZone);
  let at = zonedInstant(today, clock, timeZone);
  if (at.getTime() <= n.getTime())
    at = zonedInstant(zonedParts(n.getTime() + 86_400_000, timeZone), clock, timeZone);
  return { ok: true, until: at.toISOString() };
}

/** Where the iPhone's time picker for “Until” starts: the next whole hour on the person's clock (18:00 at 17:22). */
export function nextWholeHour(now: DateInput, timeZone: string): string {
  return `${formatClock(toDate(now).getTime() + 3_600_000, timeZone).slice(0, 2)}:00`;
}

/* Quiet hours --------------------------------------------------------------------------------------------------------- */

export function quietHoursHint(locale?: string): string {
  return mobileTranslator(locale).t('data.notify.quietHoursHint');
}
export const QUIET_HOURS_HINT = quietHoursHint();

/* Previews ------------------------------------------------------------------------------------------------------------ */

/** Settings → Notifications' message-text switch (CT-286, AP-809), the web's words. */
export function previewsTitle(locale?: string): string {
  return mobileTranslator(locale).t('data.notify.previewsTitle');
}
export function previewsHint(locale?: string): string {
  return mobileTranslator(locale).t('data.notify.previewsHint');
}
export const PREVIEWS_TITLE = previewsTitle();
export const PREVIEWS_HINT = previewsHint();
