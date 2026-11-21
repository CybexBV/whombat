/**
 * A canvas collaboration session: the canvas's Y.Doc, the awareness shared with everyone on it, and the
 * connection state. The web editor binds Tiptap to `ydoc` / `awareness`; where they come from is the
 * session's business — the session's collaboration stream in the app, a local hub in fixture mode and tests.
 */
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

/**
 * `connecting` until the document has synced, `connected` while live, `offline` when the connection dropped
 * (the provider reconnects on its own), `denied` when the server refused us (signed out).
 */
export type CollabStatus = 'connecting' | 'connected' | 'offline' | 'denied';

/** What the box lets this connection do. */
export type CollabScope = 'read-write' | 'readonly';

export interface CollabSnapshot {
  status: CollabStatus;
  /** The document has been loaded at least once (it stays usable offline afterwards). */
  synced: boolean;
  /** Null until the server has authenticated the connection. */
  scope: CollabScope | null;
}

export interface CanvasCollabSession {
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  snapshot(): CollabSnapshot;
  /** Called whenever the snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/** Which canvas to open. */
export interface CanvasCollabTarget {
  burrow: string;
  slug: string;
  canvasId: string;
  documentName: string;
}

export type CanvasCollabFactory = (target: CanvasCollabTarget) => CanvasCollabSession;

/** A tiny observable for session snapshots. */
export class SnapshotStore {
  private current: CollabSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initial: CollabSnapshot) {
    this.current = initial;
  }

  get(): CollabSnapshot {
    return this.current;
  }

  set(patch: Partial<CollabSnapshot>): void {
    const next = { ...this.current, ...patch };
    if (
      next.status === this.current.status &&
      next.synced === this.current.synced &&
      next.scope === this.current.scope
    )
      return;
    this.current = next;
    for (const l of [...this.listeners]) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }
}
