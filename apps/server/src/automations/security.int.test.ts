/**
 * Regression tests for the security review of supervised automations (docs/decisions/bp-automations.md BP-C19…C25).
 * Each `describe` inverts a proof of concept from the review (branch review/security): it failed before the fix.
 *
 * SEC-AUTO-TRIGGER  the trigger room and every room whose content flows into a step are re-checked (still the
 *                   burrow's) at trigger scan, before every step and in the approval guard; every room is the person's,
 *                   so content flows between them (docs/decisions/membership.md MB-10).
 * SEC-AUTO-RUNNOW   Run now needs a “started by hand” trigger.
 * SEC-AUTO-DRAFT    publishing is bound to the reviewed draft's hash; an agent's drafting right ends at publish.
 * SEC-ATT-META      a message shows only its own attachments; `attachFrom` copies files.
 * Room names        trigger summaries name their rooms, in reads and frames alike (one-person.md OP-S69).
 */
import { type AutomationDefinitionInput, newId, type RealtimeEvent, topics } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { attachments, automationRuns, automationVersions, dispatches, messages } from '../db/schema/index';
import { loadMessage } from '../read/messages';
import type { BusFrame } from '../realtime/bus';
import { fillFrame } from '../realtime/fill';
import { personalize } from '../realtime/hub';
import { dispatchScopeOf, runInDispatchScope } from '../runtime/dispatch-scope';
import { inProcessApi } from '../test/api';
import { IDS, useAutomationWorld } from '../test/automations';
import { sessionFor } from '../test/tokens';
import { publishAutomationDraft, runAutomationNow, saveAutomationDraft } from './commands';
import { acceptAutomationPlan, proposeAutomationPlan } from './plans';
import { loadAutomationRow, loadRunRow, toAutomation } from './store';

const w = useAutomationWorld();
const srv = inProcessApi(() => w.services);
/** Every frame the bus published (the session event log's source, `managed/events.ts`). */
const published: BusFrame[] = [];
beforeAll(() => {
  w.services.bus.onFrame((f) => published.push(f));
});

/** The burrow's frames as the session event log delivers them to `viewerId`. */
async function framesFor(viewerId: string): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  for (const f of published) {
    if (f.topic !== topics.burrow(w.burrowId)) continue;
    out.push(personalize(await fillFrame(w.services.db, f.event, viewerId), viewerId));
  }
  return out;
}

const def = (d: Omit<AutomationDefinitionInput, 'version'>) =>
  ({ version: 1, ...d }) as AutomationDefinitionInput;

async function dispatchOf(runId: string, stepId: string) {
  const run = await w.run(runId);
  const id = run.steps.find((s) => s.stepId === stepId)?.dispatchId;
  const [d] = await w.services.db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, id ?? ''));
  if (!d) throw new Error(`no dispatch for ${stepId}`);
  return d;
}

/** An agent's ready upload for a room (no bytes are read in these tests). */
async function upload(agentId: string, conversationId: string, name = 'evidence.txt') {
  const id = newId('attachment');
  const sha = 'a'.repeat(64);
  await w.services.db.insert(attachments).values({
    id,
    burrowId: w.burrowId,
    conversationId,
    name,
    contentType: 'text/plain',
    kind: 'file',
    size: 12,
    sha256: sha,
    blobKey: `sha256/aa/aa/${sha}`,
    state: 'ready',
    url: `/api/v1/burrows/burrow-hq/attachments/${id}`,
    uploadedById: agentId,
    createdAt: w.now(),
    uploadedAt: w.now(),
  });
  return id;
}

/** FAKE AGENT: answers a dispatch with a file attached, then completes it. */
async function replyWithFile(dispatchId: string, text: string) {
  const s = w.services;
  const [d] = await s.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!d) throw new Error('no dispatch');
  const file = await upload(d.agentId, d.conversationId);
  await runInDispatchScope(dispatchScopeOf(d), () =>
    w.ok(d.agentId, sendMessage, {
      conversationId: d.conversationId,
      text,
      attachmentIds: [file],
      ...(d.threadRootId ? { threadRootId: d.threadRootId } : {}),
    }),
  );
  await s.runtime.finalize(dispatchId, { outcome: 'done' });
  return file;
}

describe('SEC-AUTO-TRIGGER: the trigger room and every room a step reads', () => {
  it('a step reading an earlier step from another room goes on: every room of the burrow is the person’s', async () => {
    const id = await w.publish(
      def({
        conversationId: IDS.general,
        triggers: [{ kind: 'manual' }],
        steps: [
          {
            id: 'ask',
            kind: 'dispatch_agent',
            conversation: IDS.incidents,
            prompt: 'Status?',
          },
          { id: 'tell', kind: 'post_message', text: 'Dusty says: {{steps.ask.text}}' },
        ],
      }),
      { by: IDS.mara, name: 'Ask and tell' },
    );
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false });
    await w.settle();
    await w.fakeAgentReply((await dispatchOf(runId as string, 'ask')).id, 'INCIDENT-STATUS-GREEN');
    await w.settle();
    const run = await w.run(runId as string);
    expect(run.steps[1]?.state).toBe('succeeded');
    const told = await loadMessage(w.services.db, run.steps[1]?.messageIds[0] ?? '', IDS.mara);
    expect(told?.text).toContain('INCIDENT-STATUS-GREEN');
  });
});

describe('SEC-AUTO-RUNNOW: who may start a run', () => {
  it('Run now needs a “started by hand” trigger; a test run acts with the tester’s own authority', async () => {
    const id = await w.publish(
      def({
        conversationId: IDS.billing,
        triggers: [{ kind: 'message_posted', conversationId: IDS.billing, contains: ['never-typed'] }],
        steps: [{ id: 'note', kind: 'post_message', text: 'Note: {{trigger.text}}' }],
      }),
      { by: IDS.mara, name: 'Starts on its own' },
    );
    await expect(
      w.commit(IDS.mara, runAutomationNow, { automationId: id, test: false, text: 'forged' }),
    ).rejects.toThrow(/starts on its own/);
    const { runId } = await w.ok(IDS.mara, runAutomationNow, {
      automationId: id,
      test: true,
      text: 'tried',
    });
    const row = await loadRunRow(w.services.db, runId as string);
    expect(row.test).toBe(true);
    expect(row.publishedById).toBe(IDS.mara);
  });
});

describe('SEC-AUTO-DRAFT: publishing is bound to the reviewed draft', () => {
  const GOOD = def({
    conversationId: IDS.billing,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'x', kind: 'post_message', text: 'hello' }],
  });
  const EVIL = def({
    conversationId: IDS.billing,
    triggers: [{ kind: 'message_posted', conversationId: IDS.billing }],
    steps: [{ id: 'x', kind: 'post_message', conversation: IDS.general, text: 'Leak: {{trigger.text}}' }],
  });

  /** The agent proposes in a turn of its own in the person's Chat (automation-chat.md). */
  async function propose(input: { automationId?: string; name: string; definition: unknown }) {
    const dispatchId = await w.turn(IDS.dusty, IDS.billing);
    return w.ok(IDS.dusty, proposeAutomationPlan, {
      ...input,
      description: '',
      definition: input.definition as never,
      dispatchId,
    });
  }

  it('the agent may propose a change to a live automation; it runs only once the person turns that plan on', async () => {
    const id = await w.publish(GOOD, { name: 'Agent idea' });
    const plan = await propose({ automationId: id, name: 'Agent idea', definition: EVIL });
    expect(plan.planId).not.toBeNull();
    const before = await w.services.db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, id));
    expect(before).toHaveLength(1);
    expect(JSON.stringify(before[0]?.definition)).not.toContain('Leak');
    await w.ok(IDS.mara, acceptAutomationPlan, { planId: plan.planId as string });
    const after = await w.services.db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, id));
    expect(after).toHaveLength(2);
  });

  it('a plan another one replaced can’t be turned on, and neither can a draft changed after the person looked', async () => {
    const first = await propose({ name: 'Agent idea 2', definition: GOOD });
    const automationId = first.automationId as string;
    const reviewed = await w.draftHash(automationId);
    // Meanwhile the agent (e.g. prompt-injected) proposes something else.
    await propose({ automationId, name: 'Agent idea 2', definition: EVIL });
    await expect(
      w.commit(IDS.mara, acceptAutomationPlan, { planId: first.planId as string }),
    ).rejects.toThrow(/newer plan/);
    await expect(
      w.commit(IDS.mara, publishAutomationDraft, { automationId, enable: true, definitionHash: reviewed }),
    ).rejects.toThrow(/draft changed since you looked at it/);
    const versions = await w.services.db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, automationId));
    expect(versions).toHaveLength(0);
  });

  it('only the person saves drafts; the detail says who may', async () => {
    const drafted = (await propose({ name: 'Agent idea 3', definition: GOOD })) as { automationId: string };
    await expect(
      w.commit(IDS.dusty, saveAutomationDraft, {
        automationId: drafted.automationId,
        definition: EVIL as never,
      }),
    ).rejects.toThrow(/Only you/);
    const mara = await sessionFor(w.services, IDS.mara);
    const detail = await srv.inject({
      method: 'GET',
      url: `/api/v1/burrows/burrow-hq/automations/${drafted.automationId}`,
      headers: { cookie: mara.cookie },
    });
    expect(detail.json().automation.draftHash).toBe(await w.draftHash(drafted.automationId));
  });
});

describe('SEC-ATT-META: a message shows only its own files', () => {
  it('an attachment id on another message’s list is not shown there', async () => {
    const file = await upload(IDS.dusty, IDS.incidents, 'incident-secrets.txt');
    const own = await w.ok(IDS.dusty, sendMessage, {
      conversationId: IDS.incidents,
      text: 'Here it is',
      attachmentIds: [file],
    });
    const other = await w.ok(IDS.mara, sendMessage, {
      conversationId: IDS.general,
      text: 'Nothing attached',
    });
    await w.services.db
      .update(messages)
      .set({ attachmentIds: [file] })
      .where(eq(messages.id, other.id));
    expect((await loadMessage(w.services.db, own.id, IDS.mara))?.attachments.map((a) => a.id)).toEqual([
      file,
    ]);
    expect((await loadMessage(w.services.db, other.id, IDS.mara))?.attachments).toEqual([]);
  });

  it('attachFrom copies a file within the room', async () => {
    const steps = (to: string): AutomationDefinitionInput['steps'] => [
      {
        id: 'ask',
        kind: 'dispatch_agent',
        conversation: IDS.incidents,
        prompt: 'Evidence?',
      },
      {
        id: 'share',
        kind: 'post_message',
        conversation: to,
        text: 'Evidence attached.',
        attachFrom: ['ask'],
      },
    ];
    const same = await w.publish(
      def({ conversationId: IDS.incidents, triggers: [{ kind: 'manual' }], steps: steps(IDS.incidents) }),
      { by: IDS.mara, name: 'Share in the room' },
    );

    const { runId: sameRun } = await w.ok(IDS.mara, runAutomationNow, { automationId: same, test: false });
    await w.settle();
    const original = await replyWithFile((await dispatchOf(sameRun as string, 'ask')).id, 'Found it.');
    await w.settle();
    const shared = await w.run(sameRun as string);
    expect(shared.steps[1]?.state).toBe('succeeded');
    const posted = await loadMessage(w.services.db, shared.steps[1]?.messageIds[0] ?? '', IDS.mara);
    expect(posted?.attachments).toHaveLength(1);
    const copy = posted?.attachments[0];
    expect(copy?.id).not.toBe(original);
    expect(copy?.name).toBe('evidence.txt');
    const [copyRow] = await w.services.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, copy?.id ?? ''));
    const [originalRow] = await w.services.db.select().from(attachments).where(eq(attachments.id, original));
    expect(copyRow?.messageId).toBe(posted?.id);
    expect(copyRow?.blobKey).toBe(originalRow?.blobKey);
    expect(originalRow?.messageId).not.toBe(posted?.id);
  });
});

describe('room names in trigger summaries', () => {
  it('names its room in reads and frames alike', async () => {
    const id = await w.publish(
      def({
        conversationId: IDS.incidents,
        triggers: [{ kind: 'message_posted', conversationId: IDS.incidents, contains: ['page-me'] }],
        steps: [{ id: 'note', kind: 'post_message', text: 'Paged.' }],
      }),
      { by: IDS.mara, name: 'Pager' },
    );
    const row = await loadAutomationRow(w.services.db, w.burrowId, id);
    expect((await toAutomation(w.services.db, row)).triggerSummary).toBe(
      'Message with “page-me” in incidents',
    );

    // Realtime: a change to it reaches Mara with the room's name.
    await w.ok(IDS.mara, saveAutomationDraft, {
      automationId: id,
      definition: row.draftJson ?? { version: 1 },
    });
    const summaries = async (who: string) =>
      (await framesFor(who)).flatMap((e) =>
        e.type === 'automation.updated' && e.automation.id === id ? [e.automation.triggerSummary] : [],
      );
    expect(await summaries(IDS.mara)).toContain('Message with “page-me” in incidents');
    // Nobody's run rows were touched by reading.
    expect(
      await w.services.db.select().from(automationRuns).where(eq(automationRuns.automationId, id)),
    ).toEqual([]);
  });
});
