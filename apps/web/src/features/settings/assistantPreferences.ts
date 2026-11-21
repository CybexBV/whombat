import { queryKeys } from '@whombat/client/query';
import { useBootstrap, usePreferences } from '@whombat/client/react';
import {
  type AssistantPreferences,
  type Bootstrap,
  DEFAULT_ASSISTANT_PREFERENCES,
  type Preferences,
} from '@whombat/core';
import { useCallback } from 'react';
import { useAppServices } from '../../app/providers';

/**
 * Your assistant's suggestions and the topics it won't bring up again (AG-11, AG-12). “Don’t ask again” is answered
 * in the DM and changes them on the server with no event, so they are read fresh (`GET /me/preferences`) while
 * shown; the cached bootstrap stands in until that answers.
 */
export function useAssistantPreferences(burrow: string): AssistantPreferences {
  const { data } = useBootstrap({ params: { burrow } });
  const fresh = usePreferences({}, { staleTime: 0 });
  return fresh.data?.assistant ?? data?.preferences.assistant ?? DEFAULT_ASSISTANT_PREFERENCES;
}

/**
 * Saves a change to them. `PATCH /me/preferences` replaces `assistant` whole, so the change is applied to what the
 * server has now (read just before), never to a copy that may predate a “Don’t ask again” in the DM. The cached
 * preferences and bootstrap show the change at once; a failure puts the old value back.
 */
export function useSaveAssistantPreferences(burrow: string) {
  const { client, queryClient } = useAppServices();
  return useCallback(
    async (change: (current: AssistantPreferences) => AssistantPreferences) => {
      const bootKey = queryKeys.conversations.bootstrap({ params: { burrow } });
      const prefsKey = queryKeys.me.getPreferences({});
      const cachedPrefs = queryClient.getQueryData<Preferences>(prefsKey);
      const cachedBoot = queryClient.getQueryData<Bootstrap>(bootKey);
      const before = cachedPrefs?.assistant ?? cachedBoot?.preferences.assistant;
      const put = (value: AssistantPreferences | undefined) => {
        queryClient.setQueryData(
          bootKey,
          (old: Bootstrap | undefined) =>
            old && { ...old, preferences: { ...old.preferences, assistant: value } },
        );
        queryClient.setQueryData(
          prefsKey,
          (old: Preferences | undefined) => old && { ...old, assistant: value },
        );
      };
      const all = (preferences: Preferences) => {
        queryClient.setQueryData(bootKey, (old: Bootstrap | undefined) => old && { ...old, preferences });
        queryClient.setQueryData(prefsKey, preferences);
      };
      put(change(before ?? DEFAULT_ASSISTANT_PREFERENCES));
      try {
        const current = (await client.me.getPreferences()).assistant ?? DEFAULT_ASSISTANT_PREFERENCES;
        const result = await client.me.updatePreferences({ body: { assistant: change(current) } });
        if (result.status === 'ok') all(result.data);
        else put(before);
      } catch (err) {
        put(before);
        throw err;
      }
    },
    [client, queryClient, burrow],
  );
}
