/**
 * The automations engine without a 1-second loop (docs/decisions/server-efficiency.md SV-03): a burrow is scanned only
 * while a live automation reads events (no cursor, no lock otherwise), publishing one starts at the latest event (no
 * history replays), and a started engine passes when something may have brought work — a nudge, a commit while it
 * has work — and otherwise on its safety tick.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../commands/messages';
import { runInCommandScope } from '../commit/scope';
import { automationCursors, events } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { setAutomationEnabled } from './commands';
import { AutomationEngine } from './engine';

const w = useAutomationWorld();

const def = (extra: Partial<AutomationDefinitionInput>) =>
  ({
    version: 1,
    conversationId: IDS.incidents,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'note', kind: 'post_message', text: 'Tick.' }],
    ...extra,
  }) as AutomationDefinitionInput;

const cursor = async () =>
  (await w.services.db.select().from(automationCursors).where(eq(automationCursors.burrowId, w.burrowId)))[0]
    ?.seq ?? null;
const head = async () =>
  Math.max(
    0,
    ...(
      await w.services.db.select({ seq: events.seq }).from(events).where(eq(events.burrowId, w.burrowId))
    ).map((e) => e.seq),
  );

describe('scanning only what reads events (SV-03)', () => {
  it('leaves a burrow alone while its automations don’t read events, and never replays history after', async () => {
    await w.publish(def({}), { name: 'By hand' });
    const started = await cursor();
    expect(started).not.toBeNull();
    await w.ok(IDS.mara, sendMessage, {
      conversationId: IDS.incidents,
      text: 'watch-word before anyone listens',
    });
    await w.settle();
    // Nothing reads events: the cursor waited.
    expect(await cursor()).toBe(started);

    const watcher = await w.publish(
      def({
        triggers: [{ kind: 'message_posted', conversationId: IDS.incidents, contains: ['watch-word'] }],
      }),
      { name: 'Watcher' },
    );
    // Published: the cursor is at the latest event before the publish's own, so the message before it starts nothing.
    expect(await cursor()).toBe((await head()) - 1);
    await w.settle();
    expect(await w.runs(watcher)).toEqual([]);
    await w.ok(IDS.mara, sendMessage, { conversationId: IDS.incidents, text: 'watch-word now' });
    await w.settle();
    expect(await w.runs(watcher)).toHaveLength(1);

    // Switched off and on again with nobody else listening: what was said meanwhile starts nothing either.
    await w.ok(IDS.mara, setAutomationEnabled, { automationId: watcher, enabled: false });
    await w.ok(IDS.mara, sendMessage, { conversationId: IDS.incidents, text: 'watch-word while off' });
    await w.settle();
    await w.ok(IDS.mara, setAutomationEnabled, { automationId: watcher, enabled: true });
    expect(await cursor()).toBe((await head()) - 1);
    await w.settle();
    expect(await w.runs(watcher)).toHaveLength(1);
  });
});

describe('a started engine passes when work may have come (SV-03)', () => {
  it('kicked by commits while it has work, idle otherwise', async () => {
    const engine = new AutomationEngine(w.services, {
      tickMs: 60_000,
      idleTickMs: 60_000,
      kickMs: 20,
      lockCheckMs: 20,
      lockRetryMs: 30,
    });
    // The world's own engine was never started: this one takes the lock.
    const passes = vi.spyOn(engine, 'scanSchedules');
    try {
      engine.start();
      await expect.poll(() => engine.isActive, { timeout: 5_000 }).toBe(true);
      await expect.poll(() => passes.mock.calls.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(1);
      // A watcher from the test above reads events: a message (a signed event) kicks a pass at once.
      const before = passes.mock.calls.length;
      await w.ok(IDS.mara, sendMessage, { conversationId: IDS.incidents, text: 'anything at all' });
      await expect.poll(() => passes.mock.calls.length, { timeout: 2_000 }).toBeGreaterThan(before);
      // Nothing more happens: no pass on its own until the safety tick.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const quiet = passes.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(passes.mock.calls.length).toBe(quiet);
      // A nudge (a publish, a decision) is a pass.
      engine.nudge();
      await expect.poll(() => passes.mock.calls.length, { timeout: 2_000 }).toBeGreaterThan(quiet);
    } finally {
      await engine.close();
    }
  });
});

describe('a nudge from inside a command (RN-S1)', () => {
  it('runs the pass outside the command’s scope, so a receipt settled meanwhile doesn’t roll its scan back', async () => {
    const watcher = await w.publish(
      def({
        triggers: [{ kind: 'message_posted', conversationId: IDS.incidents, contains: ['scoped-word'] }],
      }),
      { name: 'Scoped watcher' },
    );
    const engine = new AutomationEngine(w.services, {
      // Only the nudge passes: no safety tick and no kick from the message's own frame within the test.
      tickMs: 60_000,
      idleTickMs: 60_000,
      kickMs: 60_000,
      lockCheckMs: 20,
      lockRetryMs: 30,
    });
    try {
      engine.start();
      await expect.poll(() => engine.isActive, { timeout: 5_000 }).toBe(true);
      await engine.tick();
      await w.ok(IDS.mara, sendMessage, { conversationId: IDS.incidents, text: 'scoped-word, please' });
      // A command that is still running (its receipt was settled elsewhere: every commit in its scope rolls back)
      // nudges the engine from its `after` hook, as `runNow` and `approvals.decide` do.
      let finish = () => {};
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const command = runInCommandScope(
        {
          active: true,
          accepted: true,
          beforeCommit: async () => {
            throw new Error('the command receipt was settled elsewhere');
          },
          afterCommit: () => {},
        },
        async () => {
          engine.nudge();
          await held;
        },
      );
      // The pass its nudge started commits as the engine's own: the message starts its run.
      await expect.poll(async () => (await w.runs(watcher)).length, { timeout: 5_000 }).toBe(1);
      finish();
      await command;
    } finally {
      await engine.close();
    }
  });
});
