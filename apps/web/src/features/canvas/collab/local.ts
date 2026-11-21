/**
 * A local stand-in for `/collab`: several peers, each with its own Y.Doc and awareness, kept in sync in memory
 * the way the Hocuspocus server relays them. Fixture mode opens canvases on it (with simulated collaborators),
 * and component tests put two editors on one hub to see each other's text and carets.
 */
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type CanvasCollabSession, type CollabScope, SnapshotStore } from './types';

/** Origin of changes the hub relays (so they are not relayed back). */
const RELAYED = Symbol('whombat-local-hub');

interface Peer {
  ydoc: Y.Doc;
  awareness: Awareness;
  scope: CollabScope;
  off: () => void;
}

export interface JoinOptions {
  /** Yjs client id (random by default). */
  clientId?: number;
  /** A read-only peer's document changes are not relayed (as the server drops them). */
  scope?: CollabScope;
}

export class LocalCollabHub {
  private readonly peers = new Set<Peer>();
  private readonly seed: Uint8Array | null;

  /** `initial`: the document every peer starts from (a Y.Doc's state). */
  constructor(initial?: Y.Doc | Uint8Array) {
    this.seed = initial ? (initial instanceof Y.Doc ? Y.encodeStateAsUpdate(initial) : initial) : null;
  }

  /** A new peer on the hub, synced with the others. */
  join(options: JoinOptions = {}): CanvasCollabSession {
    const ydoc = new Y.Doc();
    if (options.clientId !== undefined) ydoc.clientID = options.clientId;
    const others = [...this.peers];
    const source = others[0];
    if (source) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source.ydoc), RELAYED);
    else if (this.seed) Y.applyUpdate(ydoc, this.seed, RELAYED);
    const awareness = new Awareness(ydoc);
    const scope = options.scope ?? 'read-write';

    // What the others already show.
    for (const other of others) {
      const ids = [...other.awareness.getStates().keys()].filter((id) => id === other.awareness.clientID);
      if (ids.length) applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other.awareness, ids), RELAYED);
    }

    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === RELAYED || scope === 'readonly') return;
      for (const other of this.peers) if (other.ydoc !== ydoc) Y.applyUpdate(other.ydoc, update, RELAYED);
    };
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === RELAYED) return;
      const changed = [...added, ...updated, ...removed].filter((id) => id === awareness.clientID);
      if (!changed.length) return;
      const update = encodeAwarenessUpdate(awareness, changed);
      for (const other of this.peers)
        if (other.awareness !== awareness) applyAwarenessUpdate(other.awareness, update, RELAYED);
    };
    ydoc.on('update', onUpdate);
    awareness.on('update', onAwareness);

    const peer: Peer = {
      ydoc,
      awareness,
      scope,
      off: () => {
        ydoc.off('update', onUpdate);
        awareness.off('update', onAwareness);
      },
    };
    this.peers.add(peer);

    const store = new SnapshotStore({ status: 'connected', synced: true, scope });
    let destroyed = false;
    return {
      ydoc,
      awareness,
      snapshot: () => store.get(),
      subscribe: (listener) => store.subscribe(listener),
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        this.leave(peer);
        store.clear();
      },
    };
  }

  private leave(peer: Peer): void {
    peer.off();
    this.peers.delete(peer);
    for (const other of this.peers)
      removeAwarenessStates(other.awareness, [peer.awareness.clientID], RELAYED);
    peer.awareness.destroy();
    peer.ydoc.destroy();
  }

  /** Disconnects every peer. */
  destroy(): void {
    for (const peer of [...this.peers]) this.leave(peer);
  }
}
