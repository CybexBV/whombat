import { queryKeys } from '@whombat/client/query';
import { useBootstrap, usePreferences } from '@whombat/client/react';
import {
  type Bootstrap,
  type NotificationPreferences,
  notificationPreferencesOf,
  type Preferences,
} from '@whombat/core';
import { useCallback } from 'react';
import { useAppServices } from '../../app/providers';

/**
 * Your notification settings (Do not disturb, quiet hours, email, thread replies; CT-175): read fresh while shown (the
 * phone and another tab change them too), the cached bootstrap standing in until that answers; the defaults when
 * none are stored.
 */
export function useNotificationPreferences(burrow: string): NotificationPreferences {
  const { data } = useBootstrap({ params: { burrow } });
  const fresh = usePreferences({}, { staleTime: 0 });
  return notificationPreferencesOf(fresh.data ?? data?.preferences ?? {});
}

/**
 * Saves a change to them (AP-491). `PATCH /me/preferences` replaces `notifications` whole and leaves every other field
 * alone, so the change is applied to what the server has now (read just before), never to a copy another device
 * changed since; only `notifications` is sent. The cached preferences and bootstrap show it at once; a failure puts
 * the old value back and throws.
 */
export function useSaveNotificationPreferences(burrow: string) {
  const { client, queryClient } = useAppServices();
  return useCallback(
    async (change: (current: NotificationPreferences) => NotificationPreferences) => {
      const bootKey = queryKeys.conversations.bootstrap({ params: { burrow } });
      const prefsKey = queryKeys.me.getPreferences({});
      const cachedPrefs = queryClient.getQueryData<Preferences>(prefsKey);
      const cachedBoot = queryClient.getQueryData<Bootstrap>(bootKey);
      const before = (cachedPrefs ?? cachedBoot?.preferences)?.notifications;
      const put = (value: NotificationPreferences | undefined) => {
        queryClient.setQueryData(
          bootKey,
          (old: Bootstrap | undefined) =>
            old && { ...old, preferences: { ...old.preferences, notifications: value } },
        );
        queryClient.setQueryData(
          prefsKey,
          (old: Preferences | undefined) => old && { ...old, notifications: value },
        );
      };
      const all = (preferences: Preferences) => {
        queryClient.setQueryData(bootKey, (old: Bootstrap | undefined) => old && { ...old, preferences });
        queryClient.setQueryData(prefsKey, preferences);
      };
      put(change(notificationPreferencesOf({ notifications: before })));
      try {
        const current = notificationPreferencesOf(await client.me.getPreferences());
        const result = await client.me.updatePreferences({ body: { notifications: change(current) } });
        if (result.status === 'ok') all(result.data);
        else {
          put(before);
          throw new Error('not saved');
        }
      } catch (err) {
        put(before);
        throw err;
      }
    },
    [client, queryClient, burrow],
  );
}
