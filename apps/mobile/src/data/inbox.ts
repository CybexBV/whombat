/**
 * The tab bar's badges (AP-708): what TalkBack hears for a tab with something new, and the number on it. The Inbox list
 * went with the crew's tabs (one-layout-android.md AP-2640). Pure.
 */

import { mobileTranslator } from '../i18n/translate';

/** “Inbox, 3 new”; the tab's own name when there's nothing new. */
export function tabBadgeLabel(label: string, count: number, dot = false, locale?: string): string {
  const { t } = mobileTranslator(locale);
  if (count > 0) return `${label}, ${t('navigation.new', { count })}`;
  return dot ? `${label}, ${t('navigation.unreadMessages')}` : label;
}

/** The badge's text: up to 99, then “99+”. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
