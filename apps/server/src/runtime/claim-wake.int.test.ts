/**
 * A waiting claim needs no 500 ms re-check (docs/decisions/server-efficiency.md SV-03): with the default 5 s safety
 * re-check, a new turn and a turn that frees its (agent, conversation) slot both reach a waiting runner at once,
 * because every dispatch change wakes the long-poll.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { DEFAULT_RUNTIME_OPTIONS } from './service';

const t = useTestServer({ seed: true });
const RUNNER = 'rnr_wake';

const claim = () => t.services.runtime.claim({ runnerId: RUNNER, providers: ['claude'], waitMs: 4_000 });

async function mention(text: string): Promise<string> {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.incidents, text });
  if (res.status !== 'ok') throw new Error('send failed');
  const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.messageId, res.result.id));
  if (!d) throw new Error('no dispatch');
  return d.id;
}

describe('the claim long-poll is woken, not polled (SV-03)', () => {
  it('re-checks only every 5 seconds on its own', () => {
    expect(t.services.runtime.options.pollMs).toBe(DEFAULT_RUNTIME_OPTIONS.pollMs);
    expect(DEFAULT_RUNTIME_OPTIONS.pollMs).toBe(5_000);
  });

  it('hands a waiting runner a new turn at once', async () => {
    const waiting = claim();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = performance.now();
    const id = await mention('@Dusty is 8812 settled?');
    const ctx = await waiting;
    expect(ctx?.dispatch.id).toBe(id);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('hands it the next turn of the same agent and room as soon as the one before ends', async () => {
    const [first] = await t.services.db.select().from(dispatches).where(eq(dispatches.state, 'claimed'));
    if (!first) throw new Error('nothing claimed');
    const second = await mention('@Dusty and 8813?');
    // Held back while Dusty's turn here runs.
    expect(await t.services.runtime.claimOne(RUNNER, ['claude'])).toBeNull();
    const waiting = claim();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ended = performance.now();
    await t.services.runtime.complete(first.id, {
      outcome: 'done',
      runnerId: RUNNER,
      attempt: first.attempts,
    });
    const ctx = await waiting;
    expect(ctx?.dispatch.id).toBe(second);
    expect(performance.now() - ended).toBeLessThan(1_500);
  }, 15_000);
});
