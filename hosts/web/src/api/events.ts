// Server-Sent Events (`GET /api/v1/events`, API.md 5 + CONTRACT 5). Events
// invalidate the affected queries; the refetched data drives the UI and the
// polite status announcements (see useStatusAnnouncements). Components that
// need the payload itself (the console waits for `action.finished`) subscribe
// through `onServerEvent`.

import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import type { Fleet, ServerListItem, ServerStatus } from './types';
import { useEffect, useRef } from 'react';
import { setStreamLive } from '../lib/liveStatus';
import { applyAssistantEvent } from './assist';
import { API_BASE } from './client';

interface ServerEvent {
  id?: string;
  server?: string;
}

function parse(e: MessageEvent<string>): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(e.data);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Listener = (data: Record<string, unknown>) => void;
const listeners = new Map<string, Set<Listener>>();

/** Subscribe to one event name of the hub stream. Returns the unsubscribe function. */
export function onServerEvent(name: string, fn: Listener): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

/** Dispatch to the subscribers (also used by tests and the fixture-mode fallbacks). */
export function emitServerEvent(name: string, data: Record<string, unknown>): void {
  for (const fn of listeners.get(name) ?? []) fn(data);
}

/** React wrapper of onServerEvent; the latest callback is used without resubscribing. */
export function useServerEvent(name: string, fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onServerEvent(name, (d) => ref.current(d)), [name]);
}

/** Body of `server.updated` (CONTRACT 5). */
interface ServerUpdate {
  id?: string;
  status?: ServerStatus;
  status_note?: string | null;
  current?: Fleet['servers'][number]['current'];
  last_seen?: string | null;
  agent_connected?: boolean;
}

/** Applies a `server.updated` payload to the cached fleet and host lists. */
function patchServer(qc: QueryClient, ev: ServerUpdate): void {
  const id = ev.id;
  if (!id) return;
  const pick = <T extends object>(s: T): T => ({
    ...s,
    ...(ev.status !== undefined ? { status: ev.status } : {}),
    ...(ev.status_note !== undefined ? { status_note: ev.status_note } : {}),
    ...(ev.last_seen !== undefined ? { last_seen: ev.last_seen } : {}),
    ...(ev.agent_connected !== undefined ? { agent_connected: ev.agent_connected } : {}),
  });
  qc.setQueriesData<Fleet>({ queryKey: ['fleet'] }, (f) => {
    if (!f?.servers?.some((s) => s.id === id)) return f;
    return {
      ...f,
      servers: f.servers.map((s) => (s.id === id ? { ...pick(s), ...(ev.current !== undefined && ev.current !== null ? { current: ev.current } : {}) } : s)),
    };
  });
  qc.setQueriesData<ServerListItem[]>({ queryKey: ['servers'] }, (list) => {
    if (!Array.isArray(list) || !list.some((s) => s.id === id)) return list;
    return list.map((s) => (s.id === id ? pick(s) : s));
  });
}

const EVENT_NAMES = [
  'server.updated',
  'server.offline',
  'server.online',
  'server.settings_changed',
  'server.deleted',
  'alert.opened',
  'alert.resolved',
  'alert.updated',
  'maintenance.changed',
  'guest.state_changed',
  'action.finished',
  'task.finished',
  'enrollment.pending',
  'console.closed',
  'checks.changed',
  'agent.update',
  'assistant.state',
  'assistant.investigation',
  'assistant.event',
  'assistant.deleted',
  'resync',
] as const;

/** Subscribe to the hub's event stream while `enabled`. EventSource reconnects by itself (retry: 5000). */
export function useEventStream(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${API_BASE}/events`, { withCredentials: true });
    es.onopen = () => setStreamLive(true);
    es.onerror = () => setStreamLive(false);
    const invalidate = (...keys: QueryKey[]) => {
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    };
    const onEvent = (name: string, ev: ServerEvent) => {
      switch (name) {
        case 'server.updated':
          // Every agent report sends one (every 10 s per host). Refetching on
          // each made N hosts × 5 requests per 10 s on top of the polling:
          // patch the cached host rows instead; the pages poll the rest.
          patchServer(qc, ev as ServerUpdate);
          break;
        case 'server.offline':
        case 'server.online': {
          const id = ev.id ?? ev.server;
          invalidate(['fleet'], ['servers'], ['agents'], id ? ['server', id] : ['server']);
          break;
        }
        case 'server.settings_changed':
        case 'server.deleted': {
          const id = ev.id ?? ev.server;
          invalidate(['fleet'], ['fleetSeries'], ['servers'], ['agents'], ['groups'], id ? ['server', id] : ['server'], id ? ['settings', id] : ['settings']);
          break;
        }
        case 'alert.opened':
        case 'alert.resolved':
        case 'alert.updated':
          invalidate(['alerts'], ['fleet'], ...(ev.server ? [['server', ev.server] as QueryKey] : []));
          break;
        case 'maintenance.changed':
          invalidate(['maintenance'], ['alerts'], ['fleet'], ['server'], ['servers']);
          break;
        case 'guest.state_changed':
        case 'action.finished': {
          const id = ev.server;
          invalidate(['fleet'], ['guestList'], ...(id ? [['server', id] as QueryKey, ['guests', id] as QueryKey] : [['server'] as QueryKey, ['guests'] as QueryKey]));
          break;
        }
        case 'task.finished': {
          // A manage task (create, clone, backup, ...): guest lists, the guest and its manage views.
          const id = ev.server;
          invalidate(['fleet'], ['guestList'], ...(id ? [['server', id], ['guests', id], ['guest', id], ['manage', id]] : [['server'], ['guests'], ['guest'], ['manage']]));
          break;
        }
        case 'checks.changed':
          invalidate(['checks']);
          break;
        case 'agent.update':
          invalidate(['agents']);
          break;
        case 'enrollment.pending':
          invalidate(['fleet'], ['enrollments']);
          break;
        case 'assistant.state':
        case 'assistant.investigation':
        case 'assistant.event':
        case 'assistant.deleted':
          // Payloads carry the new state: patch the caches (api/assist.ts).
          applyAssistantEvent(qc, name, ev as Record<string, unknown>);
          break;
        case 'resync':
          void qc.invalidateQueries();
          break;
      }
    };
    const handlers = EVENT_NAMES.map((name) => {
      const fn = (e: MessageEvent<string>) => {
        const data = parse(e);
        onEvent(name, data as ServerEvent);
        emitServerEvent(name, data);
      };
      es.addEventListener(name, fn as EventListener);
      return [name, fn] as const;
    });
    return () => {
      for (const [name, fn] of handlers) es.removeEventListener(name, fn as EventListener);
      es.close();
      setStreamLive(true); // signed out or disabled: nothing to warn about
    };
  }, [enabled, qc]);
}
