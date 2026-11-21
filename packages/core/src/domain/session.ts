/**
 * Which conversation a turn continues (contracts 0.125, CT-1207; Whombat hermes-engine.md HE-18, HE-40): one Chat thread
 * is one Hermes session. Pure: the keys Whombat files a turn's session under.
 */
import { z } from 'zod';

/**
 * What a turn continues: `thread:<root>` / `conv:<conversation>` (chat), `run:<run id>` (a run),
 * `automation:<automation>:<step>` (automation steps).
 */
export const TaskKey = z
  .string()
  .regex(/^(conv|thread|run|automation):[A-Za-z0-9_-]{1,80}(:[A-Za-z0-9_-]{1,80})?$/, {
    message: 'Expected conv:, thread:, run: or automation: followed by an id',
  });
export type TaskKey = z.infer<typeof TaskKey>;

interface DispatchLike {
  conversationId: string;
  threadRootId: string | null;
  runId: string | null;
}

/** The task a dispatch works on: its run, else its thread, else its conversation. */
export function taskKeyFor(d: DispatchLike): TaskKey {
  if (d.runId) return `run:${d.runId}`;
  if (d.threadRootId) return `thread:${d.threadRootId}`;
  return `conv:${d.conversationId}`;
}

/** Sessions are per thread, else per conversation (runs keep their own). */
export function conversationKeyFor(d: Pick<DispatchLike, 'conversationId' | 'threadRootId'>): TaskKey {
  return d.threadRootId ? `thread:${d.threadRootId}` : `conv:${d.conversationId}`;
}
