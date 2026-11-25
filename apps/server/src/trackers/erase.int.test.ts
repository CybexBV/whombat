/**
 * A report its tracker erased is forgotten (docs/decisions/report-trackers.md TA-161) on a real database — the mirrored
 * report, its customer's answers, the run about it and its card all live in Postgres, and the erasure must go through
 * the commit pipeline in one transaction —, with the FakeTracker behind a home-network address and FAKE AGENTS: a driver
 * without `erasures` keeps its reports as before; one with it has an erased report forgotten (its row and answers gone,
 * its run stopped with its waiting approval withdrawn, the run's words blanked) while an erasure of a report never
 * mirrored here touches nothing, the cursor moves on, and a connection nothing listens to any more still forgets.
 */
import type { AutomationRecipeInput, AutomationRun, ReportAssessmentInput } from '@whombat/core';
import { recipeInstructions } from '@whombat/core';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAutomation, deleteAutomation, setAutomationKeys } from '../automations/commands';
import {
  approvals,
  automationRuns,
  dispatches,
  events,
  messages,
  trackerCursors,
  trackerItems,
  trackerReplies,
  vaultNetworks,
} from '../db/schema/index';
import { callTool } from '../mcp/server';
import { buildDispatchContext } from '../runtime/context';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { FakeTracker, type FakeTrackerItem } from '../test/tracker';
import { fakeTrackerDriver } from '../test/tracker-driver';
import { useVaultNetForTests } from '../vault/net';
import type { TrackerDriver } from './driver';
import { REPORT_ERASED } from './erase';

const w = useAutomationWorld();
const tracker = new FakeTracker();
const HOST = 'erase.tracker.test';
const ADDRESS = '192.168.97.10';
let connectionId = '';

/** The tracker's list of erased reports, oldest first; its cursor is the count read so far. */
const erased: string[] = [];
/** The cursors the driver was asked from. */
const asked: (string | null)[] = [];
/** The driver as a tracker that says what it erased, two a page. */
let plain: TrackerDriver;
let withErasures: TrackerDriver;

beforeAll(async () => {
  await tracker.start();
  plain = fakeTrackerDriver([tracker]);
  withErasures = {
    ...plain,
    async erasures(_conn, { after }) {
      asked.push(after);
      const from = after === null ? 0 : Number(after);
      const ids = erased.slice(from, from + 2);
      return {
        ids,
        next: ids.length ? String(from + ids.length) : null,
        more: from + ids.length < erased.length,
      };
    },
  };
  w.services.tracker.drivers.register(plain);
  const port = Number(new URL(tracker.url).port);
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host !== HOST)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: ADDRESS, family: 4 }];
    },
    dialAddress: (a) => (a === ADDRESS ? '127.0.0.1' : a),
    deadlineMs: 3000,
  });
  await w.services.db.insert(vaultNetworks).values({
    id: 'vnw_tracker_erase',
    cidr: '192.168.97.0/24',
    ports: [port],
    note: 'Fake tracker',
    addedAt: w.now(),
  });
  connectionId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme dev',
    fields: { url: `http://${HOST}:${port}` },
    secret: tracker.token,
  });
});

afterAll(async () => {
  await tracker.stop();
});

function file(over: Partial<FakeTrackerItem> = {}): FakeTrackerItem {
  const at = w.now().toISOString();
  return tracker.add({ created_at: at, updated_at: at, ...over });
}

async function poll() {
  const result = await w.services.tracker.pollNow(connectionId);
  await w.settle();
  await w.services.tracker.settled();
  return result;
}

async function recipe(over: Partial<AutomationRecipeInput> = {}): Promise<string> {
  const when = {
    kind: 'tracker' as const,
    connectionId,
    itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
  };
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    source: {
      kind: 'recipe',
      recipe: {
        when,
        job: 'assess',
        instructions: recipeInstructions('assess', when),
        conversationId: IDS.billing,
        ...over,
      },
    },
    publish: true,
  });
  return automationId;
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const bug: ReportAssessmentInput = {
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Saving a blueprint fails.',
  fixPlan: 'Handle the 500 in the save route.',
  recommends: 'change',
};

/** The FAKE AGENT assesses: its turn is claimed, it reports, answers, and the engine moves on to the write's card. */
async function assess(runId: string): Promise<AutomationRun> {
  const dispatchId = step(await w.run(runId), 'ask').dispatchId as string;
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
  const [row] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  await buildDispatchContext(w.services, row);
  const res = await callTool(
    w.services,
    { dispatchId, agentId: IDS.dusty, burrowId: w.burrowId },
    'report_assessment',
    { ...bug },
  );
  expect(res.isError).not.toBe(true);
  await w.fakeAgentReply(dispatchId, 'A real bug in saving.');
  await w.settle();
  await w.services.tracker.settled();
  return w.run(runId);
}

async function mirrored(reportId: string) {
  const [row] = await w.services.db
    .select()
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, reportId)));
  return row ?? null;
}

async function cursor() {
  const [row] = await w.services.db
    .select()
    .from(trackerCursors)
    .where(eq(trackerCursors.connectionId, connectionId));
  return row;
}

describe('a tracker that erases reports (TA-161)', () => {
  it('keeps everything as before when its driver doesn’t say what it erased', async () => {
    const id = await recipe();
    expect(await poll()).toMatchObject({ baseline: true });
    const report = file({ title: 'Kept without erasures' });
    expect(await poll()).toMatchObject({ mirrored: 1 });
    expect((await poll()).erased).toBeUndefined();
    // Gone from the tracker, but its driver doesn't say so: Whombat keeps it, as before.
    tracker.reports.delete(report.id);
    expect((await poll()).erased).toBeUndefined();
    expect(await mirrored(report.id)).toBeTruthy();
    expect((await cursor())?.erasedAfter).toBeNull();
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('forgets an erased report it mirrored: its row, answers and run’s words go, its run and card stop', async () => {
    w.services.tracker.drivers.register(withErasures);
    const id = await recipe();
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [{ keyId: 'report.update', tier: 'ask', connections: [connectionId] }],
    });
    await poll();
    const gone = file({ title: 'The rollout never finishes', description: 'Stuck at 40% since Monday.' });
    const stays = file({ title: 'Export is slow' });
    await poll();
    const runs = await w.runs(id);
    const run = runs.find((r) => r.trigger.summary.includes('rollout')) as AutomationRun;
    expect(run).toBeTruthy();
    const waiting = step(await assess(run.id), 'write_back');
    expect(waiting.state).toBe('waiting');
    // The customer writes back: Whombat keeps their words for the run.
    tracker.reporterWrites(gone.id, 'Still stuck at 40% here.');
    await poll();
    const row = await mirrored(gone.id);
    expect(row).toBeTruthy();
    expect(
      await w.services.db
        .select()
        .from(trackerReplies)
        .where(eq(trackerReplies.reportRowId, row?.id as string)),
    ).toHaveLength(1);

    // The customer withdraws it: the tracker deletes it and lists the erasure, after one of a report never here.
    tracker.reports.delete(gone.id);
    erased.push('never-mirrored-report', gone.id);
    const result = await poll();
    expect(result.erased).toBe(1);
    expect(asked.at(-1)).toBeNull();
    expect(await mirrored(gone.id)).toBeNull();
    expect(await mirrored(stays.id)).toBeTruthy();
    expect(
      await w.services.db
        .select()
        .from(trackerReplies)
        .where(eq(trackerReplies.reportRowId, row?.id as string)),
    ).toHaveLength(0);
    // Its run stopped, the write's card withdrawn, and the run keeps none of the customer's words.
    const stopped = await w.run(run.id);
    expect(stopped.status).toBe('cancelled');
    const [approval] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, waiting.approvalId as string));
    expect(approval?.state).toBe('declined');
    const [stored] = await w.services.db.select().from(automationRuns).where(eq(automationRuns.id, run.id));
    expect(stored?.error).toBe(REPORT_ERASED);
    expect(stored?.trigger.summary).toBe(`Deleted report #${gone.number} in Acme dev`);
    expect(stored?.scope).toMatchObject({
      reportId: gone.id,
      number: gone.number,
      title: '',
      description: '',
    });
    expect(JSON.stringify([stored?.scope, stored?.trigger])).not.toMatch(/rollout|40%|HollowMere|Acme Fleet/);
    // Its thread says it stopped, in the automation's words.
    const notice = await w.services.db
      .select({ text: messages.text })
      .from(messages)
      .where(
        and(eq(messages.threadRootId, run.threadRootId as string), like(messages.text, '%was stopped%')),
      );
    expect(notice).toHaveLength(1);
    // Signed with ids only.
    const [event] = await w.services.db.select().from(events).where(eq(events.type, 'tracker.items_erased'));
    expect(event?.payload).toMatchObject({ connectionId, numbers: [gone.number], stopped: 1 });
    expect(JSON.stringify(event)).not.toContain('rollout');
    // The report kept is untouched, and the cursor moved past what was read.
    const other = (await w.runs(id)).find((r) => r.trigger.summary.includes('Export'));
    expect(other?.status).not.toBe('cancelled');
    expect((await cursor())?.erasedAfter).toBe('2');
    expect((await poll()).erased).toBeUndefined();
    expect(asked.at(-1)).toBe('2');
    // Read again from the start (a restored backup): nothing more happens.
    await w.services.db
      .update(trackerCursors)
      .set({ erasedAfter: null })
      .where(eq(trackerCursors.connectionId, connectionId));
    expect((await poll()).erased).toBeUndefined();
    expect(
      await w.services.db.select().from(events).where(eq(events.type, 'tracker.items_erased')),
    ).toHaveLength(1);

    // Nothing listens any more, but what it mirrored still follows the tracker's erasures.
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
    tracker.reports.delete(stays.id);
    erased.push(stays.id);
    expect(await poll()).toMatchObject({ skipped: 'not_listened', erased: 1 });
    expect(await mirrored(stays.id)).toBeNull();
    expect((await cursor())?.erasedAfter).toBe('3');
  });
});
