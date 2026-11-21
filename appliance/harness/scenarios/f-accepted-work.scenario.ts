/**
 * (f) Disconnects never cancel accepted work (assignment §14.7, MA-09): the browser closes, or the relay restarts,
 * while the agent works on an accepted task; the work completes and the result is there exactly once.
 */

import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { restartService } from '../src/dev/restart.ts';
import { sleep } from '../src/lib/proc.ts';
import { type ApplianceSession, whenOpen, whenState } from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import {
  api,
  collect,
  ensureWorkspace,
  eventType,
  repliesTo,
  type Workspace,
} from '../src/scenario-kit/work.ts';
import { runtimeHealth } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let w: Workspace;

/** The agent's replies to `sinceId` (in its thread: the owner's Chat is threaded). */
async function agentReplies(s: ApplianceSession, sinceId: string): Promise<{ id: string; text: string }[]> {
  return repliesTo(s, w.slug, sinceId, w.agent.id);
}

beforeAll(async () => {
  slice = await ensureSlice();
  const { session } = await ownerSession(slice);
  w = await ensureWorkspace(session, `Accepted ${randomBytes(3).toString('hex')}`);
  session.close('closed');
});

describe('f accepted work survives disconnects', () => {
  it('browser closes right after the task was accepted: the agent still answers, once', async (ctx) => {
    const { session } = await ownerSession(slice);
    const accepted: string[] = [];
    const sent = await api<{ message: { id: string }; dispatches: unknown[] }>(
      session,
      'messages.send',
      'POST',
      {
        params: { burrow: w.slug, conversationId: w.conversationId },
        body: { text: `@${w.agent.name} are you there?` },
      },
      { onProgress: (p) => accepted.push(p) },
    );
    expect(sent.dispatches.length).toBe(1);
    session.close('closed'); // the tab is gone
    await sleep(2000); // the scripted agent thinks ~1.5 s, with nobody connected
    const { session: later } = await ownerSession(slice);
    // Another scenario's turn may still hold the runner: wait for the answer, then make sure it came once.
    let replies = await agentReplies(later, sent.message.id);
    for (const until = Date.now() + 60_000; replies.length === 0 && Date.now() < until; ) {
      await sleep(500);
      replies = await agentReplies(later, sent.message.id);
    }
    await sleep(1000);
    replies = await agentReplies(later, sent.message.id);
    note(ctx, 'after the browser came back', { accepted, replies: replies.map((r) => r.text) });
    expect(replies.length).toBe(1);
    later.close('closed');
  });

  it('the relay restarts while the agent works: the reply arrives once, via cursor resume', async (ctx) => {
    const { session } = await ownerSession(slice, { backoff: { baseMs: 200, maxMs: 1500 } });
    const events = collect(session, [`conv:${w.conversationId}`]);
    const sent = await api<{ message: { id: string } }>(session, 'messages.send', 'POST', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      body: { text: `@${w.agent.name} one more thing` },
    });
    const t0 = Date.now();
    await restartService('relay');
    const restartMs = Date.now() - t0;
    await whenOpen(session, 60_000);
    const reply = await events.waitFor(
      (e) => {
        const m = (
          e.event as {
            message?: {
              id: string;
              author?: { id: string };
              authorId?: string;
              threadRootId?: string | null;
            };
          }
        ).message;
        // The answer to this message (in its thread), not another turn's.
        return eventType(e) === 'message.created' &&
          (m?.author?.id ?? m?.authorId) === w.agent.id &&
          m?.threadRootId === sent.message.id
          ? m
          : null;
      },
      60_000,
      'agent reply after relay restart',
    );
    let health = await runtimeHealth();
    for (let i = 0; i < 20 && !health.ok; i++) {
      await sleep(500);
      health = await runtimeHealth();
    }
    note(ctx, 'relay restart', {
      restartMs,
      recoveredMs: Date.now() - t0,
      readies: events.readies,
      snapshots: events.snapshots,
      runtimeRelay: (health.body as { checks?: { sessionEndpoint?: unknown } }).checks?.sessionEndpoint,
    });
    expect(reply).toBeTruthy();
    expect(events.duplicateMessages()).toEqual([]);
    expect(events.duplicateCursors()).toEqual([]);
    expect((await agentReplies(session, sent.message.id)).length).toBe(1);
    expect(health.ok).toBe(true);
    events.close();
    session.close('closed');
  });
});

void whenState;
