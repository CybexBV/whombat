/** Realtime hooks: topic subscriptions, connection status, the agent's thinking line, raw events. */
import { hashKey, type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { type RealtimeEventOf, type RealtimeEventType, TYPING_TTL_MS } from '@whombat/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cachedMe } from '../query/cache';
import { type AgentNowEntry, queryKeys, type TypingEntry } from '../query/keys';
import type { EventFrame, RealtimeStatus } from '../realtime/realtime';
import { useWhombat } from './context';

/**
 * Subscribe to realtime topics while mounted (`conv:<id>`, `run:<id>`…). Ref-counted: two screens on
 * the same topic share one server subscription. Pass null/undefined to subscribe to nothing.
 */
export function useSubscription(topics: string | readonly string[] | null | undefined): void {
  const { realtime } = useWhombat();
  const list = topics == null ? [] : typeof topics === 'string' ? [topics] : topics;
  const key = [...new Set(list)].sort().join('|');
  useEffect(() => {
    if (!realtime || !key) return;
    return realtime.subscribe(key.split('|'));
  }, [realtime, key]);
}

const noop = () => () => {};

/** `idle | connecting | open | reconnecting | closed` (idle when there is no realtime client). */
export function useRealtimeStatus(): RealtimeStatus {
  const { realtime } = useWhombat();
  return useSyncExternalStore(
    realtime ? (cb) => realtime.onStatus(cb) : noop,
    () => realtime?.status() ?? 'idle',
    () => 'idle',
  );
}

/** Run a callback for each realtime event of a type (toasts, sounds, live activities). */
export function useRealtimeEvent<T extends RealtimeEventType>(
  type: T,
  listener: (event: RealtimeEventOf<T>, frame: EventFrame) => void,
): void {
  const { realtime } = useWhombat();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    if (!realtime) return;
    return realtime.on(type, (event, frame) => ref.current(event, frame));
  }, [realtime, type]);
}

/**
 * One query-cache subscription per QueryClient for every realtime-state reader, dispatching cache events by key hash
 * (docs/decisions/web-efficiency.md WE-08). Each typing line, presence dot and agent-now reader used to subscribe to the
 * whole cache itself, so every cache change ran every reader's filter.
 */
interface CacheHub {
  listeners: Map<string, Set<() => void>>;
  off: (() => void) | null;
}
const hubs = new WeakMap<QueryClient, CacheHub>();

export function subscribeCacheEntry(qc: QueryClient, hash: string, listener: () => void): () => void {
  let hub = hubs.get(qc);
  if (!hub) {
    hub = { listeners: new Map(), off: null };
    hubs.set(qc, hub);
  }
  const h = hub;
  let set = h.listeners.get(hash);
  if (!set) {
    set = new Set();
    h.listeners.set(hash, set);
  }
  const own = set;
  own.add(listener);
  h.off ??= qc.getQueryCache().subscribe((event) => {
    const forKey = h.listeners.get(event.query.queryHash);
    if (forKey) for (const l of [...forKey]) l();
  });
  return () => {
    own.delete(listener);
    if (!own.size && h.listeners.get(hash) === own) h.listeners.delete(hash);
    if (!h.listeners.size && h.off) {
      h.off();
      h.off = null;
    }
  };
}

/**
 * Data of one cache entry (or the part `select` picks), re-rendering when it changes (for realtime-only state without
 * a queryFn). `select` must return the same value for unchanged data (a field of it), so a reader re-renders only when
 * its part changed.
 */
function useCacheEntry<T, R = T>(qc: QueryClient, key: QueryKey, fallback: T, select?: (data: T) => R): R {
  const hash = hashKey(key);
  const subscribe = useCallback((cb: () => void) => subscribeCacheEntry(qc, hash, cb), [qc, hash]);
  const read = () => {
    const data = (qc.getQueryData(key) as T | undefined) ?? fallback;
    return select ? select(data) : (data as unknown as R);
  };
  return useSyncExternalStore(subscribe, read, () =>
    select ? select(fallback) : (fallback as unknown as R),
  );
}

const NO_TYPING: TypingEntry[] = [];
const NO_AGENT_NOW: AgentNowEntry[] = [];

/**
 * What agents are doing in a conversation (AP-734): every agent's latest action per thread, from `activity.updated`.
 * Pair it with `useTyping` and `workingLabel`: the action shows only while its agent is thinking there.
 */
export function useAgentNow(conversationId: string | null | undefined): AgentNowEntry[] {
  const qc = useQueryClient();
  return useCacheEntry(qc, queryKeys.agentNow(conversationId ?? '-'), NO_AGENT_NOW);
}

export interface TypingState {
  /** The agent thinking here right now, in arrival order (the `typing` event is its thinking line only, CT-1515). */
  typing: TypingEntry[];
}

/**
 * "{name} is thinking" for a conversation (top level, or one thread). Entries expire `TYPING_TTL_MS` (6 s) after their
 * last refresh, as the contract says.
 */
export function useTyping(
  conversationId: string | null | undefined,
  threadRootId: string | null = null,
): TypingState {
  const qc = useQueryClient();
  const entries = useCacheEntry(qc, queryKeys.typing(conversationId ?? '-'), NO_TYPING);
  const [now, setNow] = useState(() => Date.now());

  const me = cachedMe(qc);
  const here = entries.filter((e) => e.threadRootId === threadRootId && e.principalId !== me);
  // Checked against the clock as it renders, so new entries show without a second render to read the time; `now` only
  // moves when the next one expires.
  const at = Math.max(now, Date.now());
  const visible = here.filter((e) => e.expiresAt > at);
  const nextExpiry = Math.min(...visible.map((e) => e.expiresAt));

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, Math.min(nextExpiry - Date.now(), TYPING_TTL_MS));
    const timer = setTimeout(() => setNow(Date.now()), delay + 1);
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  return { typing: conversationId ? visible : NO_TYPING };
}
