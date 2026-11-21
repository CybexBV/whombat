/**
 * The essentials' reads and writes on the phone (Whombat essentials; contracts 0.26; AP-516): editing, deleting and
 * pinning a message and the pinned list, a conversation's notification level and your Do not disturb / quiet hours —
 * each through the typed client, with the cache updated at once where the answer says what changed.
 *
 * Editing, deleting and pinning a message, the pinned list, Try again and a conversation's level are the shared hooks in
 * `@whombat/client/react` (`useEditMessage`, `useDeleteMessage`, `usePinMessage`, `usePins`, `useRetryTurn`,
 * `useSetNotify`); what's left here is the phone's own (AP-516).
 */
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { useSetNotify, useWhombat } from '@whombat/client/react';
import {
  type Bootstrap,
  type NotificationPreferences,
  notificationPreferencesOf,
  type Preferences,
} from '@whombat/core';
import { useCallback } from 'react';
import { useBurrow } from './BurrowProvider';

/* Conversations ---------------------------------------------------------------------------------------------------- */

/** A conversation's notification level: the shared hook (W2), re-exported for the screens. */
export { useSetNotify };

/* Your notification settings --------------------------------------------------------------------------------------- */

/** Your Do not disturb and quiet hours as the bootstrap has them (the defaults when none are stored). */
export function useNotificationPreferences(): NotificationPreferences {
  const { bootstrap } = useBurrow();
  return notificationPreferencesOf(bootstrap.preferences);
}

/**
 * Saves a change to them (AP-513): `me.updatePreferences` replaces `notifications` whole, so the change is applied to
 * what the server has now (read just before) and only `notifications` is sent. The bootstrap shows it at once; a
 * failure puts the old value back and throws.
 */
export function useSaveNotificationPreferences() {
  const { slug, bootstrap } = useBurrow();
  const { client } = useWhombat();
  const qc = useQueryClient();
  const before = bootstrap.preferences.notifications;
  return useCallback(
    async (change: (current: NotificationPreferences) => NotificationPreferences) => {
      const bootKey = queryKeys.conversations.bootstrap({ params: { burrow: slug } });
      const put = (value: NotificationPreferences | undefined) =>
        qc.setQueryData(
          bootKey,
          (old: Bootstrap | undefined) =>
            old && { ...old, preferences: { ...old.preferences, notifications: value } },
        );
      put(change(notificationPreferencesOf({ notifications: before })));
      try {
        const current: Preferences = await client.me.getPreferences();
        const result = await client.me.updatePreferences({
          body: { notifications: change(notificationPreferencesOf(current)) },
        });
        if (result.status !== 'ok') throw new Error('not saved');
        qc.setQueryData(bootKey, (old: Bootstrap | undefined) => old && { ...old, preferences: result.data });
      } catch (error) {
        put(before);
        throw error;
      }
    },
    [client, qc, slug, before],
  );
}
