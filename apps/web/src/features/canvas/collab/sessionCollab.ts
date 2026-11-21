/**
 * A canvas over the appliance session's collaboration stream (managed mode, AP-11): the standard y-protocols
 * messages (sync step 1/2 and updates, awareness) on one `CollabChannel` per canvas, instead of Hocuspocus on
 * `/collab`. The session re-attaches the channel after reconnects; every (re)attach starts a fresh sync
 * (step 1 with our state vector), so nothing typed offline is lost and nothing is applied twice (Yjs updates
 * are idempotent).
 */
import type { ApplianceSession, CollabChannel } from '@whombat/client/session';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type CanvasCollabSession, type CanvasCollabTarget, SnapshotStore } from './types';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Changes that came from the appliance (not sent back). */
const REMOTE = Symbol('whombat-session-collab');

export function syncStep1(ydoc: Y.Doc): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(e, ydoc);
  return encoding.toUint8Array(e);
}

export function updateMessage(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_SYNC);
  syncProtocol.writeUpdate(e, update);
  return encoding.toUint8Array(e);
}

export function awarenessMessage(awareness: Awareness, clients: number[]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(e);
}

/**
 * Applies one inbound message; returns the reply to send (sync step 2 for a step 1), if any, and whether it
 * completed the initial sync.
 */
export function handleMessage(
  ydoc: Y.Doc,
  awareness: Awareness,
  message: Uint8Array,
  origin: unknown,
): { reply: Uint8Array | null; synced: boolean } {
  const d = decoding.createDecoder(message);
  const type = decoding.readVarUint(d);
  if (type === MESSAGE_SYNC) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    const kind = syncProtocol.readSyncMessage(d, e, ydoc, origin);
    return {
      reply: encoding.length(e) > 1 ? encoding.toUint8Array(e) : null,
      synced: kind === syncProtocol.messageYjsSyncStep2,
    };
  }
  if (type === MESSAGE_AWARENESS) {
    applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), origin);
    return { reply: null, synced: false };
  }
  return { reply: null, synced: false };
}

export function createSessionCollab(
  target: CanvasCollabTarget,
  session: ApplianceSession,
): CanvasCollabSession {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const store = new SnapshotStore({ status: 'connecting', synced: false, scope: null });
  const channel: CollabChannel | null = session.openCollab({
    burrow: target.burrow,
    canvasId: target.canvasId,
  });
  let tooLarge = false;
  let open = false;
  let destroyed = false;

  if (!channel) store.set({ status: 'denied' });

  const send = (m: Uint8Array) => {
    if (!open || !channel) return;
    // Session protocol v1 carries one message per frame (≤ 64 KiB, AP-19): a bigger one can't go; the next sync
    // after a reconnect sends the state again in smaller pieces only if edits split it, so say it's not live.
    if (!channel.send(m) && !tooLarge) {
      tooLarge = true;
      store.set({ status: 'offline' });
    }
  };
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) send(updateMessage(update));
  };
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE) return;
    send(awarenessMessage(awareness, [...added, ...updated, ...removed]));
  };
  ydoc.on('update', onUpdate);
  awareness.on('update', onAwareness);

  const offMessage = channel?.onMessage((m) => {
    if (destroyed) return;
    const { reply, synced } = handleMessage(ydoc, awareness, m, REMOTE);
    if (reply) send(reply);
    if (synced && store.get().status !== 'denied') store.set({ synced: true, status: 'connected' });
  });
  const offStatus = channel?.onStatus((s) => {
    if (destroyed) return;
    if (s === 'open') {
      open = true;
      store.set({
        status: store.get().synced ? 'connected' : 'connecting',
        scope: channel?.readOnly() ? 'readonly' : 'read-write',
      });
      send(syncStep1(ydoc));
      send(awarenessMessage(awareness, [ydoc.clientID]));
    } else if (s === 'closed') {
      open = false;
      store.set({ status: store.get().synced ? 'offline' : 'connecting' });
      // Others' carets are stale until we're back.
      removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter((id) => id !== ydoc.clientID),
        REMOTE,
      );
    } else {
      open = false;
      store.set({ status: 'denied' });
    }
  });

  return {
    ydoc,
    awareness,
    snapshot: () => store.get(),
    subscribe: (l) => store.subscribe(l),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offMessage?.();
      offStatus?.();
      ydoc.off('update', onUpdate);
      awareness.off('update', onAwareness);
      channel?.close();
      store.clear();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}
