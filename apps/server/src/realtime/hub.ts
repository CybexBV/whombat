/**
 * Realtime topics for the session event log (`managed/events.ts`, ARCHITECTURE "Realtime"): who may subscribe to a
 * topic, and the viewer-relative fields of an event.
 *
 * The subscriber is an account's person principal in the topic's burrow (`SessionEventLog.principalFor`), so only the
 * person's devices get this far. `burrow:` and `me:` topics are the caller's own; a `conv:`, `run:` or `canvas:` topic
 * needs its conversation, run or canvas to be one of the caller's burrow, re-checked on every subscribe: every
 * conversation is the person's.
 */
import { parseTopic, type RealtimeEvent } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { canvases, runs } from '../db/schema/index';
import { inBurrow } from '../read/conversations';
import { personalizeMessage } from '../read/messages';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';

export type Authz = { ok: true } | { ok: false; reason: string };

/** Viewer-relative fields (`reactions[].mine`) for one recipient. */
export function personalize(event: RealtimeEvent, viewerId: string): RealtimeEvent {
  if (event.type === 'message.created' || event.type === 'message.updated') {
    return { ...event, message: personalizeMessage(event.message, viewerId) };
  }
  return event;
}

/** Checks a topic against the caller's burrow (the session event log's subscriptions). */
export async function authorizeTopic(
  services: Services,
  conn: { principal: PrincipalRow; burrowId: string },
  topic: string,
): Promise<Authz> {
  const parsed = parseTopic(topic);
  if (!parsed) return { ok: false, reason: 'bad_topic' };
  const db = services.db;
  const who = conn.principal;
  switch (parsed.kind) {
    case 'burrow':
      return parsed.id === conn.burrowId ? { ok: true } : { ok: false, reason: 'other_burrow' };
    // A burrow's server events (contracts 0.80, CT-339), like `burrow`.
    case 'hosts':
      return parsed.id === conn.burrowId ? { ok: true } : { ok: false, reason: 'other_burrow' };
    case 'me':
      return parsed.id === who.id ? { ok: true } : { ok: false, reason: 'not_you' };
    case 'conv':
      return (await inBurrow(db, conn.burrowId, parsed.id))
        ? { ok: true }
        : { ok: false, reason: 'other_burrow' };
    case 'run': {
      const [run] = await db.select({ burrowId: runs.burrowId }).from(runs).where(eq(runs.id, parsed.id));
      return run && run.burrowId === conn.burrowId ? { ok: true } : { ok: false, reason: 'unknown_run' };
    }
    case 'canvas': {
      const [canvas] = await db
        .select({ burrowId: canvases.burrowId })
        .from(canvases)
        .where(eq(canvases.id, parsed.id));
      return canvas && canvas.burrowId === conn.burrowId
        ? { ok: true }
        : { ok: false, reason: 'unknown_canvas' };
    }
  }
}
