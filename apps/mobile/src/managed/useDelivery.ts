/**
 * What Android holds back of Whombat's notifications although they are allowed (`WhombatLive.deliveryStatus`): read
 * when the Notifications row shows and again whenever the app comes back to the foreground, which is when the person
 * returns from Android's settings. Android only, and read only: it changes nothing about the push registration.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { type DeliveryPage, type DeliveryStatus, WhombatLive } from '../../modules/whombat-live';

const read = (): DeliveryStatus | null => (Platform.OS === 'android' ? WhombatLive.deliveryStatus() : null);

export function useDeliveryStatus(): { status: DeliveryStatus | null; open(page: DeliveryPage): void } {
  const [status, setStatus] = useState<DeliveryStatus | null>(read);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const next = read();
      setStatus((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    });
    return () => sub.remove();
  }, []);
  // The page that turns it back on, else the app's own settings page.
  const open = useCallback((page: DeliveryPage) => {
    if (!WhombatLive.openDeliverySettings(page)) void Linking.openSettings();
  }, []);
  return { status, open };
}
