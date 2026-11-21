/**
 * Client tests on the session fake (hermes-engine-app.md AP-5303): a typed client whose session is an in-memory box
 * answering with a REST-shaped mock (`fetch`-like), and a `Realtime` the test drives by hand.
 */
import type { RealtimeEvent, RealtimeEventType } from '@whombat/core';
import { type ClientOptions, createClient, type WhombatClient } from '../http/client';
import type { EventFrame, Realtime, RealtimeError, RealtimeStatus, ResyncSignal } from '../realtime/realtime';
import {
  createFakeSession,
  type FakeSessionOptions,
  type RestFetch,
  restHandler,
} from '../session/fake-session';
import type { ApplianceSession } from '../session/types';

/** Mara, an owner (the fixtures' account). */
export const FAKE_ACCOUNT = { id: 'acc_mara', name: 'Mara' };

/** A session on a box that answers with `fetch` (paths relative, `/api/v1/…`, unless `origin` says otherwise). */
export function fakeSession(
  fetch: RestFetch,
  options: Partial<FakeSessionOptions> & { origin?: string } = {},
): ApplianceSession {
  const { origin = '', ...rest } = options;
  return createFakeSession({ handle: restHandler(fetch, { origin }), account: FAKE_ACCOUNT, ...rest })
    .session;
}

/** The typed client over `fakeSession(fetch)`; `fake` adds to the box (uploads, downloads, faults' options). */
export function fakeClient(
  fetch: RestFetch,
  options: Omit<ClientOptions, 'session'> & { origin?: string; fake?: Partial<FakeSessionOptions> } = {},
): WhombatClient {
  const { origin, fake, ...clientOptions } = options;
  return createClient({
    session: fakeSession(fetch, { ...fake, ...(origin === undefined ? {} : { origin }) }),
    ...clientOptions,
  });
}

export interface DrivenRealtime extends Realtime {
  /** The box sends an event on `topic` (delivered when a screen holds the topic, as the session's are). */
  event(topic: string, event: RealtimeEvent, at?: string): void;
  /** Events may have been missed on these topics. */
  resync(signal: ResyncSignal): void;
  /** The connection's status changes. */
  setStatus(status: RealtimeStatus): void;
  /** The connection opens (after `connect()`). */
  open(): void;
}

/** A `Realtime` the test drives: subscriptions are counted, events and resyncs go out when the test says. */
export function drivenRealtime(): DrivenRealtime {
  const refs = new Map<string, number>();
  let status: RealtimeStatus = 'idle';
  let seq = 0;
  const events = new Set<(event: RealtimeEvent, frame: EventFrame) => void>();
  const typed = new Map<RealtimeEventType, Set<(event: never, frame: EventFrame) => void>>();
  const statuses = new Set<(status: RealtimeStatus) => void>();
  const resyncs = new Set<(signal: ResyncSignal) => void>();
  const errors = new Set<(error: RealtimeError) => void>();
  const add = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => void set.delete(l);
  };
  const setStatus = (next: RealtimeStatus) => {
    if (next === status) return;
    status = next;
    for (const l of [...statuses]) l(next);
  };
  return {
    connect: () => {
      if (status !== 'open' && status !== 'connecting') setStatus('connecting');
    },
    disconnect: () => setStatus('closed'),
    reconnectNow: () => {},
    status: () => status,
    session: () => null,
    subscribe(topics) {
      const list = typeof topics === 'string' ? [topics] : [...topics];
      for (const t of list) refs.set(t, (refs.get(t) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const t of list) {
          const n = (refs.get(t) ?? 1) - 1;
          if (n <= 0) refs.delete(t);
          else refs.set(t, n);
        }
      };
    },
    topics: () => [...refs.keys()],
    lastSeq: () => (seq ? seq : undefined),
    on: (type, listener) => {
      let set = typed.get(type);
      if (!set) {
        set = new Set();
        typed.set(type, set);
      }
      return add(set, listener as (event: never, frame: EventFrame) => void);
    },
    onEvent: (l) => add(events, l),
    onStatus: (l) => add(statuses, l),
    onResync: (l) => add(resyncs, l),
    onError: (l) => add(errors, l),
    event(topic, event, at = '2026-09-23T09:22:00.000Z') {
      if (!refs.has(topic)) return;
      seq += 1;
      const frame = { op: 'event', topic, event, seq, eventId: `live-${seq}`, at } as EventFrame;
      for (const l of [...events]) l(event, frame);
      for (const l of [...(typed.get(event.type) ?? [])]) l(event as never, frame);
    },
    resync(signal) {
      for (const l of [...resyncs]) l(signal);
    },
    setStatus,
    open: () => setStatus('open'),
  };
}
