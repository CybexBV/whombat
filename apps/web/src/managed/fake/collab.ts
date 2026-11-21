/**
 * The fake appliance's side of canvas collaboration (AP-15): one Y.Doc per canvas, seeded like fixture mode
 * (`@whombat/canvas-schema` from the fixtures' Markdown), answering y-protocols sync and relaying updates and
 * awareness between the sessions attached to it — what the real appliance does behind `collab` streams.
 */

import { buildCanvasYDoc } from '@whombat/canvas-schema';
import type { FakeCollabPeer } from '@whombat/client/fake';
import { CANVAS_COMMENTS, CANVAS_MARKDOWN, CANVASES, plan } from '@whombat/fixtures';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import {
  awarenessMessage,
  handleMessage,
  syncStep1,
  updateMessage,
} from '../../features/canvas/collab/sessionCollab';

const RELAYED = Symbol('fake-appliance');

interface Doc {
  ydoc: Y.Doc;
  awareness: Awareness;
  peers: Set<(m: Uint8Array) => void>;
}

export function createFakeCollabHub() {
  const docs = new Map<string, Doc>();

  function docFor(canvasId: string): Doc {
    let d = docs.get(canvasId);
    if (d) return d;
    const found = CANVASES.find((c) => c.id === canvasId);
    const { ydoc } = buildCanvasYDoc(CANVAS_MARKDOWN[found?.id ?? ''] ?? '', {
      title: found?.title ?? canvasId,
      plan: found?.planId === plan.id ? plan : null,
      comments: CANVAS_COMMENTS.filter((c) => c.canvasId === found?.id),
    });
    const awareness = new Awareness(ydoc);
    awareness.setLocalState(null);
    const doc: Doc = { ydoc, awareness, peers: new Set() };
    ydoc.on('update', (update: Uint8Array) => {
      for (const p of doc.peers) p(updateMessage(update));
    });
    awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...added, ...updated, ...removed];
        for (const p of doc.peers) p(awarenessMessage(awareness, changed));
      },
    );
    docs.set(canvasId, doc);
    d = doc;
    return d;
  }

  return {
    /** Everything the appliance's copy of a canvas holds, as JSON text (tests). */
    snapshot(canvasId: string): string {
      const d = docs.get(canvasId);
      return d ? JSON.stringify(d.ydoc.toJSON()) : '';
    },
    open(document: { canvasId: string }, send: (m: Uint8Array) => void): FakeCollabPeer | null {
      if (!CANVASES.some((c) => c.id === document.canvasId)) return null;
      const doc = docFor(document.canvasId);
      doc.peers.add(send);
      const clients = new Set<number>();
      // Start the peer's sync: our state vector, and everyone's awareness.
      send(syncStep1(doc.ydoc));
      const states = [...doc.awareness.getStates().keys()];
      if (states.length) send(awarenessMessage(doc.awareness, states));
      return {
        receive(message) {
          // Awareness from this peer: remember its client ids so a close removes them.
          if (message[0] === 1) {
            const before = new Set(doc.awareness.getStates().keys());
            const { reply } = handleMessage(doc.ydoc, doc.awareness, message, RELAYED);
            for (const id of doc.awareness.getStates().keys()) if (!before.has(id)) clients.add(id);
            if (reply) send(reply);
            return;
          }
          const { reply } = handleMessage(doc.ydoc, doc.awareness, message, RELAYED);
          if (reply) send(reply);
        },
        close() {
          doc.peers.delete(send);
          if (clients.size) removeAwarenessStates(doc.awareness, [...clients], RELAYED);
        },
      };
    },
  };
}
