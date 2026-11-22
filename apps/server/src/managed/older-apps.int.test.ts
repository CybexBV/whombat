/**
 * Older apps and automations started by mail (docs/decisions/automation-recipes.md): a session below protocol minor 3
 * gets mail runs and their automations in a form its contracts read — in answers and in live updates — and a newer one
 * gets them as they are. Needs Postgres: the session, the automation and its run go through the commit pipeline.
 */
import { definitionHash, validateDefinition } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAutomation, publishAutomationDraft } from '../automations/commands';
import { MAIL_AUTOMATIONS_MINOR } from '../automations/older-apps';
import { createRun } from '../automations/runs';
import { loadAutomationRow } from '../automations/store';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
const B = { burrow: 'burrow-hq' };

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

type Out = { t: string; output?: Record<string, unknown> };
type RunOut = { trigger: { kind: string }; steps: { kind: string }[] };
type AutomationOut = { id: string; definition: unknown; draft: unknown };

describe('automations for older apps', () => {
  it('sends a session below minor 3 mail runs and their automations in a form it reads, a newer one as they are', async () => {
    const older = await m.client(mara, { minor: MAIL_AUTOMATIONS_MINOR - 1 });
    const newer = await m.client(mara);
    for (const c of [older, newer]) {
      c.send({ t: 'subscribe', sub: 'burrow', topics: [`burrow:${TEST_BURROW_ID}`] });
      await c.waitFor((x) => x.t === 'subscribed');
    }

    const services = m.t.services;
    const definition = {
      version: 1,
      conversationId: IDS.billing,
      triggers: [{ kind: 'manual' }],
      steps: [
        { id: 'ask', kind: 'dispatch_agent', prompt: 'Propose a change.', proposeActions: true },
        { id: 'act', kind: 'connection_actions', from: 'ask' },
      ],
      limits: { runTimeoutMinutes: 30, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
    };
    const made = await m.t.commit(IDS.mara, createAutomation, {
      name: 'Proposes changes',
      source: {
        kind: 'import',
        file: { whombat: 'automation', name: 'Proposes changes', description: '', definition },
      },
    });
    if (made.status !== 'ok') throw new Error('create');
    const { automationId } = made.result as { automationId: string };
    const check = validateDefinition(definition);
    if (!check.ok) throw new Error(check.problems.join(' '));
    const published = await m.t.commit(IDS.mara, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: definitionHash(check.definition),
    });
    if (published.status !== 'ok') throw new Error('publish');

    // A run as incoming mail starts one: the live update reaches both sessions, each in its own form.
    const automation = await loadAutomationRow(services.db, TEST_BURROW_ID, automationId);
    await services.pipeline.transact(TEST_BURROW_ID, async (session) => {
      await createRun(session, {
        automation,
        definition: check.definition,
        version: automation.currentVersion as number,
        publishedById: IDS.mara,
        trigger: {
          kind: 'mail',
          summary: 'Mail from billing@example.com: “Invoice”',
          actorId: null,
          eventId: null,
          messageId: null,
          scheduledFor: null,
        },
        triggerKey: 'mail:older-apps',
        scope: { kind: 'mail', text: '' },
        conversationId: IDS.billing,
        threadRootId: null,
        causalDepth: 0,
        causalChain: [],
        startedById: null,
        test: false,
      });
    });
    const update = (x: { t: string }) =>
      x.t === 'event' &&
      (x as unknown as { event: { type: string } }).event.type === 'automation.run.updated';
    const runOf = (x: unknown) => (x as { event: { run: RunOut } }).event.run;
    expect(runOf(await older.waitFor(update)).trigger.kind).toBe('message_posted');
    expect(runOf(await older.waitFor(update)).steps.map((s) => s.kind)).toEqual([
      'dispatch_agent',
      'unknown',
    ]);
    expect(runOf(await newer.waitFor(update)).trigger.kind).toBe('mail');

    // Its answers too: the run history and the automation, whose definition an older app can't read.
    const runs = async (c: typeof older) =>
      ((await c.request('automations.runs', { params: B, query: { automation: automationId } })) as Out)
        .output as {
        runs: RunOut[];
      };
    expect((await runs(older)).runs.map((r) => r.trigger.kind)).toEqual(['message_posted']);
    expect((await runs(newer)).runs.map((r) => r.trigger.kind)).toEqual(['mail']);
    const listed = async (c: typeof older) =>
      (
        ((await c.request('automations.list', { params: B })) as Out).output as {
          automations: AutomationOut[];
        }
      ).automations.find((a) => a.id === automationId);
    expect(await listed(older)).toMatchObject({ definition: null, draft: null });
    expect((await listed(newer))?.definition).not.toBeNull();
  });
});
