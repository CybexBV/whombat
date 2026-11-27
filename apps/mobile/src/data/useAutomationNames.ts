/**
 * The names an automation's words need (core `PlanNames`, automation-page.md AP-6331): the agent's, Chat's and the
 * other rooms' titles, and tracker connections' labels, from what the phone already reads. Unknown ones read as
 * core's stand-ins (“a room”, “a tracker connection”).
 */
import { chatRoomsOf, chatWords, roomOfConversation } from '@whombat/client';
import { useCatalogConnections, useChats, useConnectors } from '@whombat/client/react';
import type { PlanNames } from '@whombat/core';
import { useMemo } from 'react';
import { useI18n } from '../i18n';
import { useBurrow } from './BurrowProvider';
import { useAgentWords } from './useAgent';

export function useAutomationNames(): PlanNames {
  const { slug } = useBurrow();
  const agent = useAgentWords();
  const chats = useChats({ params: { burrow: slug } }, { retry: false });
  const connections = useCatalogConnections({ params: { burrow: slug } }, { retry: false });
  const connectors = useConnectors({}, { retry: false });
  const { rawLocale } = useI18n();
  return useMemo(() => {
    const list = chats.data?.chats ?? [];
    const rooms = chatRoomsOf(list, rawLocale);
    const words = chatWords(rawLocale);
    return {
      agent: agent.Name,
      conversationTitle: (id: string) => {
        const room = roomOfConversation(rooms, id);
        if (room) return words[room];
        return list.find((c) => c.id === id)?.title;
      },
      connectionLabel: (id: string) =>
        connections.data?.connections.find((c) => c.id === id)?.label ||
        connectors.data?.connections.find((c) => c.id === id)?.email ||
        undefined,
    };
  }, [agent.Name, chats.data, connections.data, connectors.data, rawLocale]);
}
