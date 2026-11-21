/** Query hooks and small shared helpers of the automations screens. */
import { CHAT_WORDS } from '@whombat/client';
import { queryHook, useCatalogConnections, useChatRooms, useTheAgent } from '@whombat/client/react';
import type { ChatRoom, PlanNames } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useMemo } from 'react';

export { useAutomation, useAutomationRun, useAutomationRuns, useAutomations } from '@whombat/client/react';

/** Recent issues, pull requests and reports to try an automation on (`automations.samples`). */
export const useAutomationSamples = queryHook(api.automations.samples);

/** The tracker report a run started from, read live (0.69, `tracker.item`; AP-1024). */
export const useTrackerItem = queryHook(api.tracker.item);

/** A room an automation answers in: Chat, or the Feedback room. */
export interface AutomationRoom {
  id: string;
  title: string;
  room: ChatRoom;
}

/** A tracker connection by its label. */
export interface AutomationTrackerConnection {
  id: string;
  label: string;
}

/**
 * The burrow's shared tracker connections (Settings → Connections; AP-1017), by label; empty when the list is refused.
 * `ready` once it is known.
 */
export function useTrackerConnections(
  burrow: string,
  enabled = true,
): { connections: readonly AutomationTrackerConnection[]; ready: boolean } {
  const { data, isPending, isError } = useCatalogConnections(enabled ? { params: { burrow } } : null, {
    retry: false,
  });
  const connections = useMemo(
    () =>
      (data?.connections ?? [])
        .filter((c) => c.catalogId === 'tracker')
        .map((c) => ({ id: c.id, label: c.label })),
    [data],
  );
  return { connections, ready: !enabled || !isPending || isError };
}

/** Paths of the automations screens (burrow-less, AP-360). */
export const automationPaths = {
  list: () => '/automations',
  one: (id: string) => `/automations/${encodeURIComponent(id)}`,
  run: (number: number) => `/automation-runs/${number}`,
};

/**
 * The rooms an automation answers in (Whombat one-agent.md OA-04; app one-agent.md AP-4931): the person's Chat and,
 * once it exists, their Feedback room — there are no channels. `known` once `chats.list` has answered.
 */
export function useAutomationRooms(
  burrow: string,
  enabled = true,
): { rooms: AutomationRoom[]; known: boolean } {
  const { chat, feedback, known } = useChatRooms(burrow, enabled);
  const rooms = useMemo(
    () => [chat, feedback].flatMap((r) => (r ? [{ id: r.id, title: CHAT_WORDS[r.room], room: r.room }] : [])),
    [chat, feedback],
  );
  return { rooms, known };
}

/**
 * The names an automation's words need (core `PlanNames`, automation-page.md): the agent's, the rooms' and the tracker
 * connections' labels, from what this app already reads. Unknown ones read as core's stand-ins.
 */
export function useAutomationNames(burrow: string): PlanNames {
  const { words } = useTheAgent(burrow);
  const { rooms } = useAutomationRooms(burrow);
  const { connections } = useTrackerConnections(burrow);
  return useMemo(
    () => ({
      agent: words.name,
      conversationTitle: (id: string) => rooms.find((r) => r.id === id)?.title,
      connectionLabel: (id: string) => connections.find((c) => c.id === id)?.label,
    }),
    [words.name, rooms, connections],
  );
}
