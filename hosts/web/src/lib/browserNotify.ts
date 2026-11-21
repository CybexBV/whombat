// Opt-in browser notifications for new alerts that need attention (per
// browser: the choice is stored in localStorage). Shown only while the tab
// is hidden or unfocused, one per alert.

import { useEffect } from 'react';
import { onServerEvent } from '../api/events';
import { t } from './i18n';

const KEY = 'rackoon.notify';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationsEnabled(): boolean {
  return notificationsSupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted';
}

/** Asks for permission and stores the choice; resolves to the new state. */
export async function enableNotifications(on: boolean): Promise<boolean> {
  if (!on) {
    localStorage.removeItem(KEY);
    return false;
  }
  if (!notificationsSupported()) return false;
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (p !== 'granted') return false;
  localStorage.setItem(KEY, '1');
  return true;
}

export function useAlertNotifications(): void {
  useEffect(
    () =>
      onServerEvent('alert.opened', (d) => {
        if (!notificationsEnabled() || (document.visibilityState === 'visible' && document.hasFocus())) return;
        if (d.attention === false) return;
        const title = String(d.title ?? t('New alert'));
        const server = String(d.server ?? '');
        const n = new Notification(`${server ? `${server}: ` : ''}${title}`, {
          body: String(d.detail ?? ''),
          tag: String(d.id ?? title),
          icon: '/favicon.svg',
        });
        n.onclick = () => {
          window.focus();
          window.location.assign('/alerts');
          n.close();
        };
      }),
    [],
  );
}
