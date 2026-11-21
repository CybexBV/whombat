/**
 * Fixture mode (`VITE_FIXTURES=1`, Storybook, tests): canvases open on a local hub holding the document the
 * seed builds from `@whombat/fixtures`' Markdown (same client id, so the fixtures' comment anchors resolve),
 * with the collaborator the mock shows: on the plan canvas the agent is writing the third rule, its caret after
 * "locale".
 */
import { buildCanvasYDoc, caretJSON, findText, readCanvas } from '@whombat/canvas-schema';
import type { CollabAwarenessState } from '@whombat/core';
import { CANVAS_COMMENTS, CANVAS_MARKDOWN, CANVASES, plan, canvas as planCanvas } from '@whombat/fixtures';
import { ASSISTANT_FACE, ASSISTANT_NAME, WHOMBAT_ID } from '../../../app/oneFixtures';
import { LocalCollabHub } from './local';
import type { CanvasCollabSession, CanvasCollabTarget } from './types';
import { collabUserOf } from './users';

/** Someone the fixture world shows writing on a canvas: their caret rests just after `after`. */
interface FixtureWriter {
  principalId: string;
  after: string;
}

export const FIXTURE_WRITERS: Record<string, FixtureWriter[]> = {
  [planCanvas.id]: [{ principalId: WHOMBAT_ID, after: 'keyed by invoice number and locale' }],
};

/** A canvas of the fixture world on a fresh local hub; destroying the session tears the hub down. */
export function createFixtureSession(target: CanvasCollabTarget): CanvasCollabSession {
  const found = CANVASES.find((c) => c.id === target.canvasId || c.slug === target.slug);
  const { ydoc: built } = buildCanvasYDoc(CANVAS_MARKDOWN[found?.id ?? ''] ?? '', {
    title: found?.title ?? target.slug,
    plan: found?.planId === plan.id ? plan : null,
    comments: CANVAS_COMMENTS.filter((c) => c.canvasId === found?.id),
  });
  const hub = new LocalCollabHub(built);
  built.destroy();

  for (const writer of FIXTURE_WRITERS[found?.id ?? ''] ?? []) {
    // The one agent, as the fixture world names it (`oneFixtures.ts`).
    const agent = {
      id: writer.principalId,
      name: ASSISTANT_NAME,
      kind: 'agent' as const,
      face: ASSISTANT_FACE,
    };
    const peer = hub.join();
    const { doc, meta } = readCanvas(peer.ydoc);
    const hit = findText(doc, writer.after);
    const caret = hit ? caretJSON(peer.ydoc, meta, hit.to) : null;
    const state: CollabAwarenessState = {
      user: collabUserOf(agent),
      writing: true,
      cursor: caret === null ? null : { anchor: caret, head: caret },
    };
    peer.awareness.setLocalState(state);
  }

  const session = hub.join();
  return { ...session, destroy: () => hub.destroy() };
}
