/**
 * `createSessionRealtime(session)` — the `Realtime` interface (what every hook and cache reducer uses) over
 * appliance-session subscriptions instead of the `/ws` socket (AP-11). Differences to the socket:
 *
 * - One session subscription holds every topic (ref-counted exactly like the socket); the appliance resumes it
 *   from its own cursor after reconnects, so a reconnect is *not* a resync unless the appliance says so;
 * - `snapshot_required` (retention expired, restart, changed access) and a subscription that could not resume
 *   become `onResync({ reason: 'snapshot' })`, which invalidates what those topics feed;
 * - `session()` (burrow and principal for the cache reducers) comes from the held `burrow:` and `me:` topics.
 */
import { parseTopic, type RealtimeEvent, type RealtimeEventOf, type RealtimeEventType } from '@whombat/core';
import type { EventFrame, Realtime, RealtimeError, RealtimeStatus, ResyncSignal } from '../realtime/realtime';
import { decodeRealtimeEvent } from '../tolerant';
import { guardListeners, type ListenerErrorHook } from './listeners';
import type { ApplianceSession, ConnectionState, SessionSubscription } from './types';

export interface SessionRealtimeOptions {
  /** Decode events with the contract schema, tolerantly (default true). */
  validate?: boolean;
  /** What a listener threw (`listeners.ts`): the others still hear and the connection stays. Default: the console. */
  onListenerError?: ListenerErrorHook;
}

function statusOf(state: ConnectionState, everOpen: boolean): RealtimeStatus {
  switch (state.status) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return everOpen ? 'reconnecting' : 'connecting';
    case 'open':
      return 'open';
    case 'reconnecting':
      return 'reconnecting';
    case 'closed':
      return 'closed';
  }
}

export function createSessionRealtime(
  session: ApplianceSession,
  options: SessionRealtimeOptions = {},
): Realtime {
  const validate = options.validate ?? true;
  const refs = new Map<string, number>();
  let sub: SessionSubscription | null = null;
  let seq = 0;
  let everOpen = session.state().status === 'open';
  let ready = false;
  let offState: (() => void) | null = null;

  const listeners = {
    event: new Set<(event: RealtimeEvent, frame: EventFrame) => void>(),
    typed: new Map<RealtimeEventType, Set<(event: never, frame: EventFrame) => void>>(),
    status: new Set<(status: RealtimeStatus) => void>(),
    resync: new Set<(signal: ResyncSignal) => void>(),
    error: new Set<(error: RealtimeError) => void>(),
  };
  const call = guardListeners(options.onListenerError);
  const emit = <T>(set: Set<(v: T) => void>, v: T) => {
    for (const l of [...set]) call('realtime', l, v);
  };

  function resync(signal: ResyncSignal) {
    if (signal.topics.length) emit(listeners.resync, signal);
  }

  function ensureSub() {
    if (sub) {
      sub.setTopics([...refs.keys()]);
      return;
    }
    if (!refs.size) return;
    ready = false;
    sub = session.subscribe([...refs.keys()], {
      onEvent(e) {
        let event: RealtimeEvent;
        if (validate) {
          // Tolerantly (AP-255): an event type only a newer app knows is skipped quietly; an unknown card or list
          // item inside a known one is left out or replaced, not the event.
          const decoded = decodeRealtimeEvent(e.event);
          if (decoded.kind === 'unknown') return;
          if (decoded.kind === 'invalid') {
            emit(listeners.error, { kind: 'bad_frame', raw: JSON.stringify(e.event) });
            // Its change is lost (the cursor moved past it): what its topic feeds is read again, as after a gap.
            if (refs.has(e.topic)) resync({ reason: 'gap', topics: [e.topic] });
            return;
          }
          event = decoded.event;
        } else event = e.event as RealtimeEvent;
        if (!refs.has(e.topic)) return;
        seq += 1;
        const frame = {
          op: 'event',
          topic: e.topic,
          event,
          seq,
          eventId: e.cursor ?? `live-${seq}`,
          at: e.at,
        } as EventFrame;
        let heard = true;
        for (const l of [...listeners.event]) heard = call('event', l, event, frame) && heard;
        const typed = listeners.typed.get(event.type);
        if (typed) for (const l of [...typed]) heard = call('event', l, event as never, frame) && heard;
        // A listener that threw lost this change (the cursor is past it): its topic is read again, as after a gap.
        if (!heard && refs.has(e.topic)) resync({ reason: 'gap', topics: [e.topic] });
      },
      onSnapshotRequired({ topics }) {
        resync({ reason: 'snapshot', topics: topics.filter((t) => refs.has(t)) });
      },
      onReady({ resumed }) {
        // The first answer of a fresh subscription has nothing to resume; later ones might have lost events.
        if (ready && !resumed) resync({ reason: 'reconnect', topics: [...refs.keys()] });
        ready = true;
      },
    });
  }

  function watchState() {
    if (offState) return;
    let last = statusOf(session.state(), everOpen);
    offState = session.onState((s) => {
      if (s.status === 'open') everOpen = true;
      const next = statusOf(s, everOpen);
      if (next !== last) {
        last = next;
        emit(listeners.status, next);
      }
    });
  }

  function heldSession(): { burrowId: string; principalId: string } | null {
    let burrowId: string | null = null;
    let principalId: string | null = null;
    for (const topic of refs.keys()) {
      const t = parseTopic(topic);
      if (t?.kind === 'burrow') burrowId = t.id;
      else if (t?.kind === 'me') principalId = t.id;
    }
    return burrowId && principalId ? { burrowId, principalId } : null;
  }

  const add = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => {
      set.delete(l);
    };
  };

  return {
    connect() {
      watchState();
      session.connect();
      ensureSub();
    },
    disconnect() {
      sub?.close();
      sub = null;
      offState?.();
      offState = null;
    },
    reconnectNow: () => session.reconnectNow(),
    status: () => statusOf(session.state(), everOpen),
    session: heldSession,
    subscribe(input) {
      const list = [...new Set(typeof input === 'string' ? [input] : input)];
      for (const topic of list) if (!parseTopic(topic)) throw new Error(`Invalid realtime topic "${topic}"`);
      let changed = false;
      for (const topic of list) {
        const count = refs.get(topic) ?? 0;
        refs.set(topic, count + 1);
        if (count === 0) changed = true;
      }
      if (changed && offState) ensureSub();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        let removed = false;
        for (const topic of list) {
          const count = (refs.get(topic) ?? 1) - 1;
          if (count > 0) refs.set(topic, count);
          else {
            refs.delete(topic);
            removed = true;
          }
        }
        if (removed && sub) {
          if (refs.size) sub.setTopics([...refs.keys()]);
          else {
            sub.close();
            sub = null;
          }
        }
      };
    },
    topics: () => [...refs.keys()],
    lastSeq: () => (seq ? seq : undefined),
    on<T extends RealtimeEventType>(
      type: T,
      listener: (event: RealtimeEventOf<T>, frame: EventFrame) => void,
    ) {
      let set = listeners.typed.get(type);
      if (!set) {
        set = new Set();
        listeners.typed.set(type, set);
      }
      const l = listener as (event: never, frame: EventFrame) => void;
      set.add(l);
      return () => {
        set.delete(l);
      };
    },
    onEvent: (l) => add(listeners.event, l),
    onStatus: (l) => add(listeners.status, l),
    onResync: (l) => add(listeners.resync, l),
    onError: (l) => add(listeners.error, l),
  };
}
