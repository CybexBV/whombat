/**
 * Tracker reports through automations (docs/decisions/report-trackers.md TA-01…TA-21) on a real database, with the
 * FakeTracker behind a home-network address (the Vault's network seam, as the connection path reaches it) and FAKE
 * AGENTS (test/automations.ts): the poller's baseline, then a new report starting one run with its thread and scope
 * (never the reporter), the kinds filter; a recipe end to end — the assessment written back as the tracker's assessment and
 * priority, Asks waiting for a person, No skipping, nothing to write —; the run's tools (`tracker_item` only in a
 * tracker run's turns and never naming the reporter, `tracker_read` only with the organization access, which is revoked
 * when the step settles); the write's request id; people reading the report and replying through the tracker once per
 * request id; moving an old tracker integration; and refusing a new one.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type AutomationDefinition,
  type AutomationRecipeInput,
  type AutomationRun,
  newId,
  type ReportAssessmentInput,
  recipeDefinition,
  recipeInstructions,
  recipeIsCurrent,
} from '@whombat/core';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BurrowAccess } from '../auth/request';
import {
  createAutomation,
  deleteAutomation,
  publishAutomationDraft,
  runAutomationNow,
  saveAutomationDraft,
  setAutomationKeys,
} from '../automations/commands';
import { automationSamples, sampleReport } from '../automations/routes';
import { updateAutomationsWords } from '../automations/words';
import { decideApproval } from '../commands/approvals';
import { reactToMessage, sendMessage } from '../commands/messages';
import { loadBurrowRow } from '../commit/pipeline';
import { visibleConnections } from '../connections/context';
import { connectionViews } from '../connections/views';
import {
  approvals,
  attachments,
  automationRunSteps,
  automationRuns,
  automations,
  automationVersions,
  catalogConnections,
  dispatches,
  events,
  messages,
  notifications,
  searchDocuments,
  t3Watches,
  trackerCursors,
  trackerItems,
  vaultNetworks,
} from '../db/schema/index';
import { indexMessage } from '../domain/search-index';
import { thePersonAccountId } from '../domain/the-person';
import { dispatchReadableAttachment } from '../files/access';
import { blobKey } from '../files/store';
import { checkConnectionHealth } from '../home/health';
import { OUTSIDERS_TOOLS } from '../mcp/served';
import { callTool, mcpToolList } from '../mcp/server';
import { loadPrincipalRow } from '../read/principals';
import { buildDispatchContext, WINDOW_SIZE } from '../runtime/context';
import { followT3Thread } from '../t3code/follow';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection, setConnectionKeys } from '../test/connections';
import { FakeTracker, type FakeTrackerItem } from '../test/tracker';
import { useFakeTrackerDriver } from '../test/tracker-driver';
import { useVaultNetForTests } from '../vault/net';
import { NOT_A_TRACKER_TURN } from './access';
import { trackerItemOp, trackerUpdateOp } from './people';
import { LIMITED_WORDS } from './stuck';

const w = useAutomationWorld();
const tracker = new FakeTracker();
const HOST = 'tracker.home.test';
const ADDRESS = '192.168.91.10';
let connectionId = '';
let address = '';

beforeAll(async () => {
  await tracker.start();
  useFakeTrackerDriver(w.services, tracker);
  const port = Number(new URL(tracker.url).port);
  address = `http://${HOST}:${port}`;
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
    id: 'vnw_tracker_test',
    cidr: '192.168.91.0/24',
    ports: [port],
    note: 'Fake tracker',
    addedAt: w.now(),
  });
  connectionId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme dev',
    fields: { url: address },
    secret: tracker.token,
  });
});

afterAll(async () => {
  await tracker.stop();
});

/** A report filed in the tracker now (the world's clock). */
function file(over: Partial<FakeTrackerItem> = {}): FakeTrackerItem {
  const at = w.now().toISOString();
  return tracker.add({ created_at: at, updated_at: at, ...over });
}

/** One poll of the connection, then the engine until nothing moves. */
async function poll(id = connectionId) {
  const result = await w.services.tracker.pollNow(id);
  await w.settle();
  return result;
}

type Recipe = Partial<AutomationRecipeInput>;

/** A recipe that assesses new tracker reports in #billing-v2 (writing back and looking inside by default). */
async function recipe(over: Recipe = {}, when: Record<string, unknown> = {}): Promise<string> {
  const w0 = {
    kind: 'tracker' as const,
    connectionId,
    itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
    ...when,
  };
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    source: {
      kind: 'recipe',
      recipe: {
        when: w0,
        job: 'assess',
        instructions: recipeInstructions('assess', w0),
        conversationId: IDS.billing,
        ...over,
      },
    },
    publish: true,
  });
  return automationId;
}

async function done(automationId: string) {
  await w.ok(IDS.mara, deleteAutomation, { automationId });
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const bug = (over: Partial<ReportAssessmentInput> = {}): ReportAssessmentInput => ({
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Saving a blueprint fails.',
  fixPlan: 'Handle the 500 in the save route.',
  recommends: 'change',
  ...over,
});

/**
 * A tracker run's turn is an outsiders' turn (outsiders-turns.md OT-01): what it is served is within the allowlist, with
 * the step's own tools where it has them.
 */
async function servedWithin(dispatchId: string, own: readonly string[]) {
  const names = (await mcpToolList(w.services, IDS.dusty, dispatchId)).map((t) => t.name);
  for (const name of names) expect(OUTSIDERS_TOOLS as readonly string[], name).toContain(name);
  expect(names).toEqual(expect.arrayContaining(['read_conversation', 'reply_in_thread', ...own]));
  return names;
}

async function tool(
  dispatchId: string,
  name: string,
  args: Record<string, unknown>,
  agentId: string = IDS.dusty,
) {
  const res = await callTool(w.services, { dispatchId, agentId, burrowId: w.burrowId }, name, args);
  return { isError: res.isError === true, body: (res.structuredContent ?? {}) as Record<string, unknown> };
}

/** The runner claims a turn: its context is built (the organization access is asked for then). */
async function claim(dispatchId: string) {
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
  const [row] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  return buildDispatchContext(w.services, row);
}

/** The FAKE AGENT's assessment turn: claimed, it reports (unless null), answers, and the engine moves on. */
async function assess(runId: string, a: ReportAssessmentInput | null, answer = 'A real bug in saving.') {
  const dispatchId = step(await w.run(runId), 'ask').dispatchId as string;
  await claim(dispatchId);
  if (a) expect(await tool(dispatchId, 'report_assessment', a)).toMatchObject({ isError: false });
  await w.fakeAgentReply(dispatchId, answer);
  await w.settle();
  await w.services.tracker.settled();
  return w.run(runId);
}

/** A new report, polled: the automation's run about it. */
async function reportRun(automationId: string, over: Partial<FakeTrackerItem> = {}) {
  const report = file(over);
  await poll();
  const run = (await w.runs(automationId)).at(-1);
  expect(run?.trigger.kind).toBe('tracker');
  expect((run as AutomationRun & { scope?: unknown }) && run).toBeTruthy();
  return { report, run: run as AutomationRun };
}

/** The definition an automation runs (its published version). */
async function liveDefinition(automationId: string) {
  const [v] = await w.services.db
    .select()
    .from(automationVersions)
    .where(eq(automationVersions.automationId, automationId))
    .orderBy(desc(automationVersions.n))
    .limit(1);
  expect(v).toBeTruthy();
  return v?.definition;
}

async function access(principalId: string): Promise<BurrowAccess> {
  const burrow = await loadBurrowRow(w.services.db, w.burrowId);
  const principal = await loadPrincipalRow(w.services.db, principalId);
  if (!burrow || !principal) throw new Error('no access');
  return { burrow, principal };
}

describe('the tracker connection (TA-01…TA-03)', () => {
  it('is never one an agent sees or calls', async () => {
    await setConnectionKeys(w.services, IDS.dusty, { read: 'can', write: 'can' });
    const seen = await visibleConnections(w.services.db, IDS.dusty, {
      id: 'dsp_x',
      burrowId: w.burrowId,
      agentId: IDS.dusty,
      trigger: 'mention',
      mode: 'reply',
      search: null,
      onBehalfOfAccountId: null,
    });
    expect(seen.map((c) => c.row.catalogId)).not.toContain('tracker');
  });

  it('says whether it answers through its driver, and when its driver isn’t there', async () => {
    const rowOf = async (id: string) =>
      (await w.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id)))[0] as
        | typeof catalogConnections.$inferSelect
        | undefined;
    const ok = await checkConnectionHealth(w.services, (await rowOf(connectionId)) as never);
    expect(ok?.status).toBe('ok');
    const missing = await insertConnection(w.services, {
      catalogId: 'tracker',
      burrowId: w.burrowId,
      label: 'Old tracker',
      handle: 'old-tracker',
      fields: { url: address, driver: 'not-installed' },
      secret: tracker.token,
    });
    const gone = await checkConnectionHealth(w.services, (await rowOf(missing)) as never);
    // “Whether it answers” says it doesn't (the person hears once a second look confirms it).
    expect(gone?.outcome).toBe('offline');
    expect((gone as { lines?: { check: string }[] } | null)?.lines?.map((l) => l.check)).toContain(
      'conn.answers',
    );
    await w.services.db.delete(catalogConnections).where(eq(catalogConnections.id, missing));
  });
});

describe('new reports start automations (TA-04…TA-08)', () => {
  it('reads after a baseline, starts one run per new report with its thread and scope, never the reporter', async () => {
    const before = file({ title: 'Filed before anyone listened' });
    const id = await recipe();
    const features = await recipe({}, { itemKinds: ['feature'] });
    // Nothing listens before: the first read is the baseline, and nothing it lists fires.
    expect(await poll()).toMatchObject({ baseline: true, mirrored: 0 });
    expect(await w.runs(id)).toHaveLength(0);
    const [cursor] = await w.services.db
      .select()
      .from(trackerCursors)
      .where(eq(trackerCursors.connectionId, connectionId));
    expect(cursor?.after).toBe(before.number);

    const { report, run } = await reportRun(id, {
      title: 'The rollout never finishes',
      organization_name: 'HollowMere College',
      context: {
        page: 'Devices',
        browser: 'Chrome 141',
        breadcrumbs: [{ category: 'api', action: 'GET /v1/rollouts', status: 504 }],
        diagnostics: { origin: 'https://desk.acme.example', devices: [] },
      },
      app_version: '0.1.131',
    });
    expect(run.trigger.summary).toBe(
      `New bug report #${report.number} in Acme dev from HollowMere College: “The rollout never finishes”`,
    );
    const [row] = await w.services.db
      .select({ scope: messages.id })
      .from(messages)
      .where(eq(messages.id, run.threadRootId as string));
    expect(row).toBeTruthy();
    const [stored] = await w.services.db.select().from(automationRuns).where(eq(automationRuns.id, run.id));
    expect(stored?.itemKey).toBe(`tracker:${connectionId}#${report.number}`);
    expect(stored?.scope).toMatchObject({
      kind: 'tracker',
      event: 'item_opened',
      item: 'report',
      connection: 'Acme dev',
      connectionId,
      reportId: report.id,
      number: report.number,
      ref: `tracker-${report.number}`,
      type: 'bug',
      organization: 'HollowMere College',
      environment: 'production',
      version: '0.1.131',
      trusted: false,
      assigned: false,
      linkedPr: false,
    });
    const text = String((stored?.scope as { text?: string } | undefined)?.text ?? '');
    expect(text.split('\n')[0]).toBe(run.trigger.summary);
    expect(text).toContain('Expected: It saves.');
    expect(text).toContain('Seen on: Devices · Chrome 141 · Acme Desk 0.1.131 (production)');
    expect(text).toContain('It came with diagnostics: tracker_item reads the whole report.');
    const all = JSON.stringify(stored);
    expect(all).not.toContain('Rita');
    expect(all).not.toContain('rita@acme.example');
    // The signed event names no customer words, only ids, the number, the type and the connection.
    const [event] = await w.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'tracker.item_opened'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event?.text).toBe(`New bug report #${report.number} in Acme dev`);
    expect(JSON.stringify(event?.payload)).not.toContain('rollout');
    // The feature-only automation didn't fire on a bug report; polling again starts nothing new.
    expect(await w.runs(features)).toHaveLength(0);
    expect(await poll()).toMatchObject({ mirrored: 0 });
    expect(await w.runs(id)).toHaveLength(1);
    // A report the tracker says was filed long before the baseline is history.
    file({ created_at: new Date(w.now().getTime() - 3 * 3_600_000).toISOString() });
    expect(await poll()).toMatchObject({ mirrored: 0 });
    // A feature request starts the feature automation only… and both of the default one.
    const feature = file({ kind: 'feature', title: 'Export blueprints' });
    await poll();
    expect((await w.runs(features)).map((r) => r.trigger.summary)).toEqual([
      `New feature request #${feature.number} in Acme dev from Acme Fleet: “Export blueprints”`,
    ]);
    expect(await w.runs(id)).toHaveLength(2);
    // The connection page shows how the poller does while an automation listens.
    const [conn] = await w.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    const [view] = await connectionViews(w.services.db, conn ? [conn] : []);
    expect(view?.poller).toMatchObject({ problem: null });
    expect(view?.poller?.succeededAt).toBeTruthy();
    await done(id);
    await done(features);
  });
});

describe('telling a duplicate (TA-60)', () => {
  it('lists the organization’s other open reports with the report, never another organization’s', async () => {
    // Bug reports are mirrored without a run of their own (this automation takes feature requests).
    const id = await recipe({}, { itemKinds: ['feature'] });
    await poll();
    const hollowmere = {
      organization_id: '00000000-0000-4000-8000-0000000000a1',
      organization_name: 'HollowMere College',
    };
    const earlier = file({ kind: 'bug', title: 'Rollout stuck at 40%', ...hollowmere });
    // Another organization, even one with the same name, never shows: told by the tracker's id.
    file({
      kind: 'bug',
      title: 'Another school’s problem',
      organization_id: '00000000-0000-4000-8000-0000000000b2',
      organization_name: 'HollowMere College',
    });
    await poll();
    const { run } = await reportRun(id, {
      kind: 'feature',
      title: 'Show the rollout’s progress',
      ...hollowmere,
    });
    const dispatchId = step(run, 'ask').dispatchId as string;
    await claim(dispatchId);
    const text = (await tool(dispatchId, 'tracker_item', {})).body.text as string;
    expect(text).toContain(`#${earlier.number} “Rollout stuck at 40%”`);
    expect(text).not.toContain('Another school’s problem');
    await done(id);
  });

  it('fills in the organization of a report mirrored before Whombat kept it, then lists it', async () => {
    const id = await recipe({}, { itemKinds: ['feature'] });
    await poll();
    const hillside = {
      organization_id: '00000000-0000-4000-8000-0000000000c3',
      organization_name: 'Hillside School',
    };
    const earlier = file({ kind: 'bug', title: 'Wi-Fi profile missing', ...hillside });
    const kept = file({ kind: 'bug', title: 'Printer offline', ...hillside });
    await poll();
    const organizationOf = async (reportId: string) =>
      (
        await w.services.db
          .select({ id: trackerItems.organizationId })
          .from(trackerItems)
          .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, reportId)))
      )[0]?.id;
    // As a report mirrored before migration 0064 has it: no organization id. Another's set id is never overwritten.
    await w.services.db
      .update(trackerItems)
      .set({ organizationId: null })
      .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, earlier.id)));
    await w.services.db
      .update(trackerItems)
      .set({ organizationId: 'org-set-before' })
      .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, kept.id)));
    expect(await poll()).toMatchObject({ organizations: 1 });
    expect(await organizationOf(earlier.id)).toBe(hillside.organization_id);
    expect(await organizationOf(kept.id)).toBe('org-set-before');
    // Once filled in, a poll has nothing to do.
    expect((await poll()).organizations ?? 0).toBe(0);

    const { run } = await reportRun(id, {
      kind: 'feature',
      title: 'Push the Wi-Fi profile again',
      ...hillside,
    });
    const dispatchId = step(run, 'ask').dispatchId as string;
    await claim(dispatchId);
    const text = (await tool(dispatchId, 'tracker_item', {})).body.text as string;
    expect(text).toContain(`#${earlier.number} “Wi-Fi profile missing”`);
    await done(id);
  });
});

describe('a recipe writes the assessment back (TA-09…TA-13, TA-17)', () => {
  it('assesses with the report and the organization, writes assessment and priority, and revokes the access', async () => {
    const id = await recipe();
    await poll();
    const { report, run } = await reportRun(id, { title: 'Blueprint won’t save' });
    const dispatchId = step(run, 'ask').dispatchId as string;
    const context = await claim(dispatchId);
    expect(context.tracker).toMatchObject({
      connection: 'Acme dev',
      number: report.number,
      access: { state: 'granted' },
    });
    const names = (await mcpToolList(w.services, IDS.dusty, dispatchId)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['tracker_item', 'tracker_read', 'report_assessment']));

    // The whole report, never the reporter's name or email.
    const read = await tool(dispatchId, 'tracker_item', {});
    expect(read.isError).toBe(false);
    const text = read.body.text as string;
    expect(text).toContain('Blueprint won’t save');
    expect(text).toContain('POST /v1/blueprints');
    expect(text).not.toContain('Rita');
    expect(text).not.toContain('rita@acme.example');
    tracker.packages.set(`${report.id}:diag-1`, { events: ['agent restarted'] });
    expect((await tool(dispatchId, 'tracker_item', { diagnostics: 'diag-1' })).body).toMatchObject({
      status: 'ok',
      cut: false,
    });
    expect((await tool(dispatchId, 'tracker_item', { diagnostics: 'nope' })).isError).toBe(true);

    // The organization, read-only, with the step's grant; the tracker's own routes are refused before sending.
    const devices = await tool(dispatchId, 'tracker_read', { path: '/v1/devices' });
    expect(devices.body).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(JSON.stringify(devices.body.body)).toContain('Lab PC 1');
    expect(tracker.orgGets.at(-1)?.token).not.toBe(tracker.token);
    expect((await tool(dispatchId, 'tracker_read', { path: '/v1/integrations/reports' })).isError).toBe(true);
    const leaky = await tool(dispatchId, 'tracker_read', { path: '/v1/leaky' });
    expect(JSON.stringify(leaky.body)).not.toContain(tracker.token);

    const after = await assess(run.id, bug());
    expect(step(after, 'ask').state).toBe('succeeded');
    const back = step(after, 'write_back');
    expect(back.state).toBe('succeeded');
    expect(back.output).toMatchObject({
      wrote: true,
      connectionId,
      connection: 'Acme dev',
      reportId: report.id,
      number: report.number,
      assessment: 'likely_bug',
      priority: 'high',
    });
    const post = tracker.posts.at(-1);
    expect(post?.body).toMatchObject({ assessment: 'likely_bug', priority: 'high' });
    expect(post?.body).not.toHaveProperty('status');
    expect(post?.body).not.toHaveProperty('message');
    expect(typeof post?.body.request_id).toBe('string');
    expect(tracker.reports.get(report.id)).toMatchObject({ assessment: 'likely_bug', priority: 'high' });
    // The step settled: its organization access is revoked in the tracker.
    expect(tracker.revocations).toContain(report.id);
    expect(after.status).toBe('succeeded');
    await done(id);
  });

  it('asks a person when its key asks, skips when it says no or there is nothing to write', async () => {
    // Its step has no `trackerAccess`: the agent's key decides.
    const id = await recipe({});
    expect(JSON.stringify(await liveDefinition(id))).not.toContain('trackerAccess');
    await poll();
    // Asks: a person says yes to exactly the line.
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [{ keyId: 'report.update', tier: 'ask', connections: [connectionId] }],
    });
    const asked = await reportRun(id, { title: 'Asks first' });
    const ctx = await claim(step(asked.run, 'ask').dispatchId as string);
    // Looking inside follows the token (TA-23): the assessing step asks without a switch.
    expect(ctx.tracker?.access).toMatchObject({ state: 'granted' });
    const waiting = await assess(asked.run.id, bug({ importance: 'critical' }));
    const back = step(waiting, 'write_back');
    expect(back.state).toBe('waiting');
    const [approval] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, back.approvalId as string));
    expect(approval?.title).toBe(`Acme dev #${asked.report.number}: Likely bug · urgent priority`);
    const posts = tracker.posts.length;
    await w.ok(IDS.mara, decideApproval, { number: approval?.number as number, decision: 'approve' });
    await w.settle();
    expect(step(await w.run(asked.run.id), 'write_back')).toMatchObject({
      state: 'succeeded',
      output: { wrote: true, assessment: 'likely_bug', priority: 'urgent' },
    });
    expect(tracker.posts.length).toBe(posts + 1);

    // No: skipped with why, and nothing is sent.
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [{ keyId: 'report.update', tier: 'cannot', connections: [connectionId] }],
    });
    const refused = await reportRun(id, { title: 'Not allowed' });
    const no = step(await assess(refused.run.id, bug()), 'write_back');
    expect(no.state).toBe('skipped');
    expect(no.output).toMatchObject({ wrote: false });
    expect(String(no.output.reason)).toContain('Update reports');
    expect(tracker.posts.length).toBe(posts + 1);

    // Not a bug: nothing to write.
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [{ keyId: 'report.update', tier: 'can', connections: [connectionId] }],
    });
    const fine = await reportRun(id, { title: 'Works as intended' });
    const nothing = step(await assess(fine.run.id, bug({ kind: 'not_a_bug' })), 'write_back');
    expect(nothing).toMatchObject({
      state: 'skipped',
      output: { wrote: false, reason: 'Nothing to write: Dusty says it’s not a bug.' },
    });
    // Unassessed: nothing to write either.
    const quiet = await reportRun(id, { title: 'Nobody says' });
    expect(step(await assess(quiet.run.id, null), 'write_back').output).toMatchObject({
      wrote: false,
      reason: 'Nothing to write: Dusty didn’t assess it.',
    });
    expect(tracker.posts.length).toBe(posts + 1);
    await done(id);
  });

  it('refuses the run’s tools outside a tracker run, and the organization without a grant', async () => {
    // An ordinary turn: neither tool is listed, and calling them is refused.
    const res = await w.services.pipeline.commit(
      sendMessage,
      { conversationId: IDS.billing, text: '@Dusty how is it going?', mentions: [IDS.dusty] },
      { burrowId: w.burrowId, actorId: IDS.mara },
    );
    expect(res.status).toBe('ok');
    const [mention] = await w.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.agentId, IDS.dusty), eq(dispatches.trigger, 'mention')))
      .orderBy(desc(dispatches.createdAt))
      .limit(1);
    const turn = mention?.id as string;
    const names = (await mcpToolList(w.services, IDS.dusty, turn)).map((t) => t.name);
    expect(names).not.toContain('tracker_item');
    expect(names).not.toContain('tracker_read');
    expect((await tool(turn, 'tracker_item', {})).body).toMatchObject({
      error: { code: 'forbidden', message: NOT_A_TRACKER_TURN },
    });

    // A tracker run whose token lacks reports:assess: the report, but not the organization, and the turn says why.
    tracker.assess = false;
    const id = await recipe();
    await poll();
    const { run } = await reportRun(id, { title: 'No organization this time' });
    const dispatchId = step(run, 'ask').dispatchId as string;
    const context = await claim(dispatchId);
    expect(context.tracker?.access).toMatchObject({ state: 'unavailable' });
    expect(context.tracker?.access?.reason).toContain('reports:assess');
    const listed = (await mcpToolList(w.services, IDS.dusty, dispatchId)).map((t) => t.name);
    expect(listed).toContain('tracker_item');
    expect(listed).not.toContain('tracker_read');
    expect((await tool(dispatchId, 'tracker_read', { path: '/v1/devices' })).isError).toBe(true);
    tracker.assess = true;
    await assess(run.id, null);
    await done(id);
  });

  it('offers what the agent suggests with the card, and only steps that don’t write code or judge it look inside (AR-52, TA-23)', async () => {
    const id = await recipe({ repo: 'whombat/billing', fix: { mode: 'ask' } });
    await poll();
    const { report, run } = await reportRun(id, { kind: 'feature', title: 'Diagnostics are hard to read' });
    expect((await claim(step(run, 'ask').dispatchId as string)).tracker?.access).toMatchObject({
      state: 'granted',
    });
    // The assessment step: its assessment and the report, the organization it was granted, nothing of the person's.
    expect(
      await servedWithin(step(run, 'ask').dispatchId as string, [
        'report_assessment',
        'tracker_item',
        'tracker_read',
      ]),
    ).not.toContain('open_pull_request');
    let after = await assess(
      run.id,
      bug({
        kind: 'feature',
        importance: 'medium',
        summary: 'A compact list with the newest diagnostics first would be easier to read.',
        fixPlan: 'Sort the diagnostics by date, newest first.',
      }),
      'A good idea: the newest first would make the page much easier to read.',
    );
    // A feature it recommends: the same card as a fix, in its own words, in the report's thread.
    expect(step(after, 'worth_fixing').output).toEqual({
      result: true,
      story: 'Yes: Dusty suggests a change.',
    });
    const [card] = await w.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, step(after, 'approve').approvalId as string));
    expect(card).toMatchObject({
      title: `Suggested change for Acme dev #${report.number}: Diagnostics are hard to read`,
      question: 'Make this change?',
    });
    expect(card?.whatHappens[0]).toBe(
      'A compact list with the newest diagnostics first would be easier to read.',
    );
    expect(card?.whatHappens.join(' ')).toContain('Nothing is merged and nothing is sent to the customer');
    await w.ok(IDS.mara, decideApproval, { number: card?.number as number, decision: 'approve' });
    await w.settle();
    after = await w.run(run.id);

    // The developer writes code and the reviewer gives a verdict: neither asks the tracker for the organization.
    const fix = step(after, 'fix');
    const branch = String((fix.output.workspace as { branch?: string }).branch);
    expect(branch).toBe(`feat/tracker-${report.number}`);
    const developer = await claim(fix.dispatchId as string);
    expect(developer.tracker).toMatchObject({ number: report.number, access: null });
    expect((await mcpToolList(w.services, IDS.dusty, fix.dispatchId as string)).map((t) => t.name)).toEqual(
      expect.arrayContaining(['tracker_item']),
    );
    // The developer's checkout is its own: a pull request from any other branch is refused (OT-06); from its own, the
    // automation opens it after the review.
    await servedWithin(fix.dispatchId as string, ['tracker_item', 'open_pull_request']);
    const pr = (over: Record<string, unknown>) =>
      tool(fix.dispatchId as string, 'open_pull_request', {
        repo: 'whombat/billing',
        branch,
        base: 'main',
        title: 'Newest diagnostics first',
        body: '',
        ...over,
      });
    const elsewhere = await pr({ branch: 'feat/invoice-pdf' });
    expect(elsewhere.body.error).toMatchObject({ code: 'forbidden' });
    expect(String((elsewhere.body.error as { message?: string }).message)).toContain(branch);
    // A repository that isn't the burrow's is refused before it gets that far.
    expect((await pr({ repo: 'whombat/web' })).isError).toBe(true);
    expect(((await pr({})).body.error as { message?: string }).message).not.toContain(branch);
    await w.fakePush('whombat/billing', branch, 'Show the newest diagnostics first');
    await w.fakeAgentReply(fix.dispatchId as string, 'The diagnostics list shows the newest first now.');
    await w.settle();
    const review = step(await w.run(run.id), 'review');
    const reviewer = await claim(review.dispatchId as string);
    expect(reviewer.tracker).toMatchObject({ number: report.number, access: null });
    expect(await servedWithin(review.dispatchId as string, ['tracker_item'])).not.toContain(
      'review_pull_request',
    );
    const grants = tracker.grants.size;
    await w.fakeAgentReply(review.dispatchId as string, 'Approve: it does what was suggested.');
    await w.settle();
    after = await w.run(run.id);
    expect(after.status).toBe('succeeded');
    expect(step(after, 'pr').output).toMatchObject({ opened: true });
    expect(tracker.grants.size).toBe(grants);
    await done(id);
  });

  it('hands its code work to a T3 Code connection that manages, and merges when asked (TA-37, TA-39)', async () => {
    const count = async () =>
      (await w.services.db.select().from(automations).where(eq(automations.burrowId, w.burrowId))).length;
    const before = await count();
    const over: Recipe = {
      repo: 'whombat/billing',
      t3: 't3',
      fix: { mode: 'auto', minImportance: 'low', merge: 'checks' },
      replyToCustomer: true,
    };
    const refusal = async () => {
      try {
        await recipe(over);
        return '';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    expect(await refusal()).toContain('no T3 Code connection t3');
    const t3 = await insertConnection(w.services, {
      catalogId: 't3code',
      burrowId: w.burrowId,
      label: 'T3 Code',
      handle: 't3',
      signIn: 'password',
      fields: { url: 'http://t3.home.test:3773' },
    });
    try {
      await w.services.db
        .update(catalogConnections)
        .set({ access: 'read' })
        .where(eq(catalogConnections.id, t3));
      expect(await refusal()).toContain('only looks');
      // Nothing was made.
      expect(await count()).toBe(before);
      await w.services.db
        .update(catalogConnections)
        .set({ access: 'manage' })
        .where(eq(catalogConnections.id, t3));
      const id = await recipe(over);
      const definition = (await liveDefinition(id)) as AutomationDefinition;
      const fix = definition.steps.find((s) => s.id === 'fix');
      expect(fix?.kind === 'dispatch_agent' && fix.prompt).toContain('t3_thread_launch');
      expect(definition.steps.at(-1)).toMatchObject({ kind: 'merge_pull_request', repo: 'whombat/billing' });

      // An automation that still has an earlier version's own words (the fix in a new thread) takes today's by
      // itself when Whombat starts after an update: a new version, published by whoever published it before.
      const fixOf = (d: AutomationDefinition) => {
        const step = d.steps.find((s) => s.id === 'fix');
        return step?.kind === 'dispatch_agent' ? step.prompt : '';
      };
      const publish = async (d: object) => {
        await w.ok(IDS.mara, saveAutomationDraft, {
          automationId: id,
          definition: d as Record<string, unknown>,
        });
        await w.ok(IDS.mara, publishAutomationDraft, {
          automationId: id,
          definitionHash: await w.draftHash(id),
        });
      };
      const earlier = recipeDefinition(definition.recipe as AutomationRecipeInput, 'fix-in-a-new-thread');
      await publish(earlier);
      const old = (await liveDefinition(id)) as AutomationDefinition;
      expect(recipeIsCurrent(old)).toBe(false);
      expect(fixOf(old)).not.toContain('look thread');
      const version = async () =>
        (await w.services.db.select().from(automations).where(eq(automations.id, id)))[0]?.currentVersion ??
        0;
      const was = await version();
      expect(await updateAutomationsWords(w.services)).toBe(1);
      expect(await version()).toBe(was + 1);
      const now = (await liveDefinition(id)) as AutomationDefinition;
      expect(recipeIsCurrent(now)).toBe(true);
      expect(fixOf(now)).toContain('look thread');
      const [latest] = await w.services.db
        .select()
        .from(automationVersions)
        .where(and(eq(automationVersions.automationId, id), eq(automationVersions.n, was + 1)));
      expect(latest?.publishedById).toBe(IDS.mara);
      // Once: nothing more to do the next time.
      expect(await updateAutomationsWords(w.services)).toBe(0);
      // Words someone changed are theirs: they stay.
      const own = JSON.parse(JSON.stringify(earlier)) as { steps: { id: string; prompt?: string }[] };
      for (const s of own.steps)
        if (s.id === 'fix') s.prompt = `${s.prompt} Keep the change under fifty lines.`;
      await publish(own);
      expect(await updateAutomationsWords(w.services)).toBe(0);
      expect(fixOf((await liveDefinition(id)) as AutomationDefinition)).toContain('under fifty lines');
      await done(id);
    } finally {
      await w.services.db.delete(catalogConnections).where(eq(catalogConnections.id, t3));
    }
  });
});

describe('try it on a recent report (TA-19)', () => {
  it('lists the connection’s open reports of its kinds and test-runs one as the tracker has it now', async () => {
    const id = await recipe({}, { itemKinds: ['bug'] });
    const mara = await access(IDS.mara);
    const closed = file({ title: 'Closed already', status: 'closed' });
    const feature = file({ title: 'A feature', kind: 'feature' });
    const open = file({ title: 'Open bug' });
    const { samples } = await automationSamples(w.services, mara, id);
    const numbers = samples.map((s) => s.number);
    expect(numbers).toContain(open.number);
    expect(numbers).not.toContain(closed.number);
    expect(numbers).not.toContain(feature.number);
    expect(samples.find((s) => s.number === open.number)).toEqual({
      kind: 'report',
      connectionId,
      reportId: open.id,
      number: open.number,
      title: 'Open bug',
      type: 'bug',
      organization: 'Acme Fleet',
      openedAt: open.created_at.replace(/Z$/, '.000Z').replace('.000.000Z', '.000Z'),
    });
    expect(JSON.stringify(samples)).not.toContain('Rita');

    const report = await sampleReport(w.services, mara, id, open.id);
    const { runId } = await w.ok(IDS.mara, runAutomationNow, {
      automationId: id,
      test: true,
      sample: { reportId: open.id },
      sampleReport: report,
    });
    await w.settle();
    const run = await w.run(runId as string);
    expect(run.test).toBe(true);
    expect(run.trigger).toMatchObject({ kind: 'tracker', summary: `Tried on Acme dev #${open.number}` });
    await expect(sampleReport(w.services, mara, id, feature.id)).rejects.toThrow(/feature request/);
    // It writes back like a real run.
    expect(step(await assess(run.id, bug({ importance: 'low' })), 'write_back').output).toMatchObject({
      wrote: true,
      assessment: 'likely_bug',
      priority: 'low',
    });
    // The reports filed here are read before the automation goes, so later tests start after them.
    await poll();
    await done(id);
  });
});

describe('people act on the report (TA-14…TA-16)', () => {
  it('reads it live with the reporter for people, and sends a reply once per request id', async () => {
    const id = await recipe({ writeBack: false });
    await poll();
    const { report, run } = await reportRun(id, { title: 'Please answer me' });
    const mara = await access(IDS.mara);
    const view = await trackerItemOp(w.services, mara, run.id);
    expect(view.can.update).toBe(true);
    expect(view.report).toMatchObject({
      connection: 'Acme dev',
      number: report.number,
      reporter: { name: 'Rita Reporter', email: 'rita@acme.example' },
      status: 'new',
    });

    const body = {
      requestId: '6b8f0a4e-1f2c-4d3e-8a9b-0c1d2e3f4a5b',
      message: 'We are on it.',
      status: 'in_progress' as const,
    };
    const first = await trackerUpdateOp(w.services, mara, run.id, body);
    const again = await trackerUpdateOp(w.services, mara, run.id, body);
    expect(again.messageId).toBe(first.messageId);
    const sent = tracker.reports.get(report.id);
    expect(sent?.status).toBe('in_progress');
    expect(sent?.messages.filter((m) => m.body === 'We are on it.')).toHaveLength(1);
    const lines = await w.services.db.select().from(messages).where(eq(messages.id, first.messageId));
    expect(lines[0]?.text).toBe(
      `Reply to the reporter, sent through Acme Desk:\n\nWe are on it.\n\nSet Acme dev #${report.number} to In progress.`,
    );
    expect(lines[0]?.authorId).toBe(IDS.mara);
    expect(lines[0]?.threadRootId).toBe(run.threadRootId);
    expect(first.report.messages.at(-1)).toMatchObject({ author: 'team', body: 'We are on it.' });

    // Never an agent.
    await expect(trackerUpdateOp(w.services, await access(IDS.dusty), run.id, body)).rejects.toThrow();
    await assess(run.id, null);
    await done(id);
  });
});

describe('a refused token (TA-03)', () => {
  it('marks the connection “Needs a new token” and the poller waits for a new one', async () => {
    const id = await recipe({ writeBack: false });
    await poll();
    const good = tracker.token;
    tracker.token = 'another-token-entirely';
    expect(await poll()).toMatchObject({ problem: 'refused' });
    const [conn] = await w.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(conn?.status).toBe('needs_reauth');
    expect(await poll()).toMatchObject({ skipped: 'needs_token' });
    tracker.token = good;
    await done(id);
  });
});

describe('a report’s turn looks into the code through T3 Code (outsiders-turns.md OT-11)', () => {
  it('sees T3 Code alone, with the connection tools, and any other outsiders’ turn sees none', async () => {
    // Working again after the token tests above.
    await w.services.db
      .update(catalogConnections)
      .set({ status: 'active' })
      .where(eq(catalogConnections.id, connectionId));
    await setConnectionKeys(w.services, IDS.dusty, { read: 'can', write: 'can' });
    const t3 = await insertConnection(w.services, {
      catalogId: 't3code',
      burrowId: w.burrowId,
      label: 'T3 Code',
      signIn: 'password',
      fields: { url: 'http://t3.home.test:3773' },
    });
    const other = await insertConnection(w.services, {
      catalogId: 'hetzner',
      burrowId: w.burrowId,
      secret: 'hetzner-token',
    });
    try {
      const id = await recipe();
      await poll();
      const { run } = await reportRun(id, { title: 'Exports lose a row' });
      const dispatchId = step(run, 'ask').dispatchId as string;
      const context = await claim(dispatchId);
      expect(context.connections?.map((c) => c.catalogId)).toEqual(['t3code']);
      await servedWithin(dispatchId, ['tracker_item', 'connection_tools', 'connection_call']);
      // Only its own work there: nothing of the person's, refused before T3 Code is asked anything.
      const handle = context.connections?.[0]?.handle as string;
      const call = (name: string, args: Record<string, unknown>) =>
        tool(dispatchId, 'connection_call', { connection: handle, tool: name, arguments: args });
      expect((await call('schedule_task', { prompt: 'Run this every hour' })).body.status).toBe('blocked');
      expect((await call('t3_thread_send', { threadId: 'mcp:theirs', message: 'Hi' })).body.status).toBe(
        'blocked',
      );
      const [turn] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
      await w.services.db.insert(t3Watches).values({
        burrowId: w.burrowId,
        connectionId: t3,
        threadId: 'mcp:started-here',
        title: 'Look into exports',
        conversationId: turn?.conversationId as string,
        threadRootId: turn?.threadRootId ?? null,
        agentId: IDS.dusty,
        wakes: false,
        armedAt: w.now(),
      });
      // The person's own turn can hand over work in the same chat thread. It stays theirs.
      await w.services.db.insert(t3Watches).values({
        burrowId: w.burrowId,
        connectionId: t3,
        threadId: 'mcp:person-in-same-thread',
        title: 'Private follow-up',
        conversationId: turn?.conversationId as string,
        threadRootId: turn?.threadRootId ?? null,
        agentId: IDS.dusty,
        personId: IDS.mara,
        wakes: false,
        armedAt: w.now(),
      });
      expect(
        (await call('t3_thread_send', { threadId: 'mcp:person-in-same-thread', message: 'Hi' })).body.status,
      ).toBe('blocked');
      // A thread started from this report passes the check (this T3 Code is unreachable, so it then lists no tools).
      expect((await call('t3_thread_read', { threadId: 'mcp:started-here' })).body.status).not.toBe(
        'blocked',
      );
      // The fix continues that thread: a message to it passes too, and the turn's context names it for the step.
      expect(
        (await call('t3_thread_send', { threadId: 'mcp:started-here', message: 'Now fix it.' })).body.status,
      ).not.toBe('blocked');
      expect((await claim(dispatchId)).t3Handoffs).toEqual([
        { connection: handle, threadId: 'mcp:started-here', title: 'Look into exports', state: 'working' },
      ]);
      // The person's turn hands the report's own thread more work from this Chat thread (a follow-up after the run
      // stopped): it wakes them now, and stays the report's, so the run's review still reads it.
      const place = {
        conversationId: turn?.conversationId as string,
        threadRootId: turn?.threadRootId ?? null,
      };
      const asAgent = { burrowId: w.burrowId, actorId: IDS.dusty };
      const arm = (threadId: string, from: { threadRootId: string | null }, who: 'report' | 'person') =>
        w.services.pipeline.commit(
          followT3Thread,
          {
            how: 'arm',
            connectionId: t3,
            threadId,
            title: null,
            conversationId: place.conversationId,
            threadRootId: from.threadRootId,
            personId: who === 'person' ? IDS.mara : null,
            wakes: who === 'person',
            ...(who === 'report' ? { report: true } : {}),
          },
          asAgent,
        );
      const watch = async (threadId: string) =>
        (
          await w.services.db
            .select()
            .from(t3Watches)
            .where(and(eq(t3Watches.connectionId, t3), eq(t3Watches.threadId, threadId)))
        )[0];
      const own = async (threadId: string) =>
        (await call('t3_thread_send', { threadId, message: 'Go on.' })).body.status !== 'blocked';
      // One from before threads were marked, still as the report's turn left it.
      await arm('mcp:started-here', place, 'person');
      // One a report's turn started since.
      await arm('mcp:fix-here', place, 'report');
      await arm('mcp:fix-here', place, 'person');
      expect(await watch('mcp:fix-here')).toMatchObject({ personId: IDS.mara, wakes: true });
      expect(await own('mcp:started-here')).toBe(true);
      expect(await own('mcp:fix-here')).toBe(true);
      expect((await call('t3_thread_read', { threadId: 'mcp:started-here' })).body.status).not.toBe(
        'blocked',
      );
      expect(((await claim(dispatchId)).t3Handoffs ?? []).map((h) => h.threadId).sort()).toEqual([
        'mcp:fix-here',
        'mcp:started-here',
      ]);
      // While the person still waits for it, the report's turn working on it neither takes their wake nor uses it up.
      await arm('mcp:fix-here', place, 'report');
      await w.services.pipeline.commit(
        followT3Thread,
        { how: 'seen', connectionId: t3, threadId: 'mcp:fix-here', key: 'done:run-1', report: true },
        asAgent,
      );
      expect(await watch('mcp:fix-here')).toMatchObject({ personId: IDS.mara, wakes: true, seenKey: null });
      // Handed work from another thread, it is the person's from then on: what they said there isn't the report's.
      await arm('mcp:fix-here', { threadRootId: 'msg_another_thread' }, 'person');
      expect(await own('mcp:fix-here')).toBe(false);
      await arm('mcp:fix-here', place, 'person');
      expect(await own('mcp:fix-here')).toBe(false);
      // A thread the person's turn started in this Chat thread is still theirs, however often they hand it work.
      await arm('mcp:person-in-same-thread', place, 'person');
      expect(await own('mcp:person-in-same-thread')).toBe(false);
      expect(((await claim(dispatchId)).t3Handoffs ?? []).map((h) => h.threadId)).toEqual([
        'mcp:started-here',
      ]);
      // Another outsiders' turn (no report behind it) sees no connection at all.
      const seen = await visibleConnections(w.services.db, IDS.dusty, {
        id: 'dsp_not_a_report',
        burrowId: w.burrowId,
        agentId: IDS.dusty,
        trigger: 'automation',
        mode: 'reply',
        search: null,
        onBehalfOfAccountId: null,
      });
      expect(seen).toEqual([]);
      await done(id);
    } finally {
      await w.services.db.delete(catalogConnections).where(eq(catalogConnections.id, t3));
      await w.services.db.delete(catalogConnections).where(eq(catalogConnections.id, other));
    }
  });
});

describe('a report’s turn uses no file someone adds to its thread', () => {
  it('neither names nor gives it the person’s file, by any way, also for a run started before the handover was kept', async () => {
    const id = await recipe();
    await poll();
    const { run } = await reportRun(id, { title: 'Charts are blank' });
    const dispatchId = step(run, 'ask').dispatchId as string;
    const [turn] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    if (!turn?.threadRootId) throw new Error('no thread');
    // The person adds a file of their own to the report's thread.
    const staged = await w.services.files.store.stage([Buffer.from('MARA_PRIVATE')], { maxBytes: 1024 });
    const key = blobKey(staged.sha256);
    await w.services.files.store.commit(staged, key);
    const fileId = newId('attachment');
    await w.services.db.insert(attachments).values({
      id: fileId,
      burrowId: w.burrowId,
      conversationId: turn.conversationId,
      name: 'notes.pdf',
      declaredType: 'application/pdf',
      contentType: 'application/pdf',
      kind: 'file',
      size: staged.size,
      sha256: staged.sha256,
      blobKey: key,
      state: 'ready',
      url: `/api/v1/burrows/burrow-hq/attachments/${fileId}`,
      uploadedById: IDS.mara,
      createdAt: w.now(),
      uploadedAt: w.now(),
    });
    const notes = await w.ok(IDS.mara, sendMessage, {
      conversationId: turn.conversationId,
      threadRootId: turn.threadRootId,
      text: 'My notes on it',
      attachmentIds: [fileId],
    });
    const reachesIt = async () => {
      const context = await claim(dispatchId);
      const shown = [
        ...(context.trigger ? [context.trigger] : []),
        ...context.window,
        ...(context.thread ? [context.thread.root, ...context.thread.replies] : []),
      ];
      expect(shown.some((m) => m.text === 'My notes on it')).toBe(true);
      const thread = await tool(dispatchId, 'read_conversation', {
        conversationId: turn.conversationId,
        threadRootId: turn.threadRootId,
      });
      expect(thread.isError).toBe(false);
      return {
        listed: context.attachments.map((a) => a.id),
        shown: shown.flatMap((m) => m.attachments.map((a) => a.id)),
        inThread: JSON.stringify(thread.body).includes(fileId),
        read: !(await tool(dispatchId, 'read_attachment', { attachmentId: fileId })).isError,
        fetched: !!(await dispatchReadableAttachment(w.services.db, turn, WINDOW_SIZE, fileId)),
      };
    };
    const none = { listed: [], shown: [], inThread: false, read: false, fetched: false };
    expect(await reachesIt()).toEqual(none);
    // A run started before the handed-over files were kept counts only what the server put on its first prompt.
    await w.services.db
      .update(automationRunSteps)
      .set({ output: {} })
      .where(eq(automationRunSteps.dispatchId, dispatchId));
    expect(await reachesIt()).toEqual(none);
    // The person's own turn there reads it as ever.
    const person = await thePersonAccountId(w.services.db, w.burrowId);
    const theirs = { ...turn, id: 'dsp_persons_own', trigger: 'mention' as const, messageId: notes.id };
    expect(
      (
        await dispatchReadableAttachment(
          w.services.db,
          { ...theirs, onBehalfOfAccountId: person },
          WINDOW_SIZE,
          fileId,
        )
      )?.id,
    ).toBe(fileId);
    await done(id);
  });
});

describe('the poller after a long gap (TA-59)', () => {
  it('after a long gap reads back to its cursor, never skipping a report more than a few pages back', async () => {
    const id = await recipe();
    await poll();
    // Twelve new reports, two to a page: more than the pages a cycle usually reads.
    tracker.pageSize = 2;
    try {
      const filed = Array.from({ length: 12 }, (_, i) => file({ title: `Report ${i + 1} after the outage` }));
      expect(await poll()).toMatchObject({ mirrored: 12 });
      // Far more than a cycle reads: the cursor never moves past a report not read, and the next cycles read on.
      tracker.pageSize = 1;
      const many = Array.from({ length: 60 }, (_, i) =>
        file({ title: `Report ${i + 1} after a long outage` }),
      );
      // Twenty a cycle, oldest first.
      expect(await poll()).toMatchObject({ mirrored: 20 });
      for (let i = 0; i < 2; i++) await poll();
      const after = await w.services.db
        .select({ number: trackerItems.number })
        .from(trackerItems)
        .where(eq(trackerItems.connectionId, connectionId));
      for (const r of many) expect(after.map((m) => m.number)).toContain(r.number);
      const mirrored = await w.services.db
        .select({ number: trackerItems.number })
        .from(trackerItems)
        .where(eq(trackerItems.connectionId, connectionId));
      for (const r of filed) expect(mirrored.map((m) => m.number)).toContain(r.number);
    } finally {
      tracker.pageSize = 50;
    }
    await done(id);
  });
});

describe('a stuck intake tells the person', () => {
  const told = (prefix: string) =>
    w.services.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `${prefix}:${connectionId}:%`));
  const cursorOf = async () =>
    (
      await w.services.db.select().from(trackerCursors).where(eq(trackerCursors.connectionId, connectionId))
    )[0];

  it('says once in the person’s Chat and Inbox that more new reports wait than a cycle reads', async () => {
    const id = await recipe();
    await poll();
    const service = w.services.tracker;
    const real = service.driverFor;
    // An installation with far more new reports than a cycle reads: its driver says so (a backlog).
    service.driverFor = (row) => ({
      ...real.call(service, row),
      poll: async () => ({ items: [], unreadable: [], backlog: true }),
    });
    const after = (await cursorOf())?.after;
    try {
      expect(await poll()).toMatchObject({ mirrored: 0 });
      expect(await poll()).toMatchObject({ mirrored: 0 });
    } finally {
      service.driverFor = real;
    }
    // The cursor stays where it was, and the connection says why.
    expect(await cursorOf()).toMatchObject({ after, problemCode: 'backlog' });
    const rows = await told('tracker_backlog');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'needs_you', where: 'Acme dev', link: { type: 'message' } });
    // The person's assistant said it in their Chat, which the notification opens.
    const [said] = await w.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, rows[0]?.messageId as string));
    expect(said?.text).toContain('Acme dev');
    // Reading to its cursor again ends it.
    expect((await poll()).problem).toBeUndefined();
    expect((await cursorOf())?.problemCode).toBeNull();
    expect(await told('tracker_backlog')).toHaveLength(1);
    await done(id);
  });

  it('says once that a report came after its automation reached today’s runs', async () => {
    const id = await recipe();
    await poll();
    // One run a day: the first report takes it.
    const [v] = await w.services.db
      .select()
      .from(automationVersions)
      .where(eq(automationVersions.automationId, id))
      .orderBy(desc(automationVersions.n))
      .limit(1);
    const definition = v?.definition as { limits: { maxRunsPerDay: number } };
    await w.services.db
      .update(automationVersions)
      .set({ definition: { ...definition, limits: { ...definition.limits, maxRunsPerDay: 1 } } as never })
      .where(and(eq(automationVersions.automationId, id), eq(automationVersions.n, v?.n as number)));
    file({ title: 'Screens stay black after sleep' });
    await poll();
    const started = async () => (await w.runs(id)).filter((r) => r.status !== 'skipped').length;
    const before = await started();
    expect(before).toBe(1);
    // The next one: no run starts; a skipped one keeps it, with why, and the person hears once.
    const report = file({ title: 'Login screen shows the wrong school' });
    await poll();
    await w.services.background.settle();
    expect(await started()).toBe(before);
    expect((await w.runs(id)).filter((r) => r.status === 'skipped').map((r) => r.error)).toContain(
      LIMITED_WORDS.day,
    );
    const rows = await told('tracker_limited');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'needs_you', where: 'Acme dev' });
    // It names the first one skipped today (an earlier test's report may come first).
    expect(rows[0]?.text).toMatch(/#\d+/);
    expect(report.number).toBeGreaterThan(0);
    await poll();
    await w.services.background.settle();
    expect(await told('tracker_limited')).toHaveLength(1);
    // A notice lost (a restart right after the commit) is sent by the poll's sweep.
    await w.services.db
      .delete(notifications)
      .where(like(notifications.dedupKey, `tracker_limited:${connectionId}:%`));
    const { resendLimited } = await import('./stuck');
    // One run a page: it still pages through to every window.
    await resendLimited(w.services, 1);
    expect(await told('tracker_limited')).toHaveLength(1);
    await done(id);
  });

  it('says once that a new report came in a form it can’t read', async () => {
    const id = await recipe();
    await poll();
    const service = w.services.tracker;
    const real = service.driverFor;
    const after = (await cursorOf())?.after ?? 0;
    // A new report whose fields this Whombat doesn't understand (no title, no status): unreadable, its driver says.
    service.driverFor = (row) => ({
      ...real.call(service, row),
      poll: async () => ({
        items: [],
        unreadable: [{ id: randomUUID(), number: after + 1 }],
        backlog: false,
      }),
    });
    try {
      expect(await poll()).toMatchObject({ mirrored: 0, invalid: 1 });
      expect(await poll()).toMatchObject({ invalid: 1 });
    } finally {
      service.driverFor = real;
    }
    const rows = await told('tracker_unreadable');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'needs_you', where: 'Acme dev' });
    expect(rows[0]?.text).toContain(`#${after + 1}`);
    await done(id);
  });

  it('says once that a connection’s polls have failed for an hour', async () => {
    const id = await recipe();
    await poll();
    tracker.down = 503;
    try {
      expect(await poll()).toMatchObject({ problem: 'unreachable' });
      w.advance(40 * 60_000);
      expect(await poll()).toMatchObject({ problem: 'unreachable' });
      // Not an hour yet: nothing said.
      expect(await told('tracker_failing')).toHaveLength(0);
      w.advance(25 * 60_000);
      await poll();
      w.advance(15 * 60_000);
      await poll();
    } finally {
      tracker.down = null;
    }
    const rows = await told('tracker_failing');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'needs_you', where: 'Acme dev' });
    expect(rows[0]?.text).toContain('Acme dev');
    expect((await poll()).problem).toBeUndefined();
    await done(id);
  });

  it('marks tracker run messages as an outsiders’ run’s so message and reaction automations skip them', async () => {
    const trackerAutoId = await recipe({ writeBack: false });
    await poll();

    const msgWatcherId = await w.publish(
      {
        version: 1,
        conversationId: IDS.billing,
        triggers: [
          {
            kind: 'message_posted',
            conversationId: IDS.billing,
            contains: ['TRACKER_TRIGGER_PHRASE'],
            includeAgents: true,
            includeReplies: true,
          },
        ],
        steps: [{ id: 'note', kind: 'post_message', text: 'Triggered' }],
        limits: { runTimeoutMinutes: 30, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
      },
      { name: 'Tracker message watcher' },
    );
    const reactWatcherId = await w.publish(
      {
        version: 1,
        conversationId: IDS.billing,
        triggers: [{ kind: 'reaction_added', conversationId: IDS.billing, value: '👍' }],
        steps: [{ id: 'note', kind: 'post_message', text: 'Triggered reaction' }],
        limits: { runTimeoutMinutes: 30, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
      },
      { name: 'Tracker reaction watcher' },
    );
    try {
      w.advance(10_000);
      file({
        title: 'Bug with TRACKER_TRIGGER_PHRASE',
        description: 'Echo TRACKER_TRIGGER_PHRASE',
      });
      await poll();
      const [run] = await w.runs(trackerAutoId);
      expect(run).toBeDefined();
      const dispatchId = run?.steps[0]?.dispatchId as string;
      expect(dispatchId).toBeTruthy();

      await w.fakeAgentReply(dispatchId, 'Assessment mentions TRACKER_TRIGGER_PHRASE.');
      await w.settle();

      const threadMsgs = await w.runThread(run?.id as string);
      expect(threadMsgs.length).toBeGreaterThanOrEqual(2);
      for (const m of threadMsgs) {
        expect(m.outsidersRun, m.text).toBe(true);
        expect(m.provenance, m.text).toBeNull();
        await w.ok(IDS.mara, reactToMessage, { messageId: m.id, value: '👍', on: true });
      }
      await w.settle();

      expect(await w.runs(msgWatcherId)).toHaveLength(0);
      expect(await w.runs(reactWatcherId)).toHaveLength(0);

      // The migration that brought the column marks what tracker runs posted before it (what the run's own steps and
      // turns posted in its thread while they ran), and moves a mark a newer build kept in `provenance` to the column.
      const ids = threadMsgs.map((m) => m.id);
      const root = threadMsgs.find((m) => !m.threadRootId) ?? threadMsgs[0];
      if (!root) throw new Error('no thread root');
      // The run is still open at the upgrade, and the person asks their agent in its thread: their own turn's answer
      // there is theirs, not the run's.
      await w.services.db
        .update(automationRuns)
        .set({ status: 'running', finishedAt: null })
        .where(eq(automationRuns.id, run?.id as string));
      w.advance(60_000);
      const own = await w.ok(IDS.mara, sendMessage, {
        conversationId: root.conversationId,
        text: 'Thanks',
        threadRootId: root.id,
      });
      const [runTurn] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
      const personTurn = await w.turn(runTurn?.agentId as string, root.conversationId, {
        trigger: 'mention',
        threadRootId: root.id,
      });
      await w.fakeAgentReply(personTurn, 'Your own answer about it.');
      const [agentAnswer] = await w.services.db
        .select()
        .from(messages)
        .where(and(eq(messages.threadRootId, root.id), eq(messages.text, 'Your own answer about it.')));
      expect(agentAnswer?.outsidersRun).toBe(false);
      await w.services.db.update(messages).set({ outsidersRun: false }).where(inArray(messages.id, ids));
      await w.services.db.execute(
        sql`update messages set provenance = 'outsiders_run' where id = ${root.id}`,
      );
      // Indexed while it wasn't marked: the migration takes it out of Search.
      for (const id of ids) await indexMessage(w.services.db, id);
      expect(
        await w.services.db.select().from(searchDocuments).where(inArray(searchDocuments.id, ids)),
      ).not.toEqual([]);
      const migration = readFileSync(
        new URL('../db/migrations/0014_outsiders_run_mark.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint').map((x) => x.trim()))
        if (statement && !statement.startsWith('ALTER')) await w.services.db.execute(sql.raw(statement));
      const theirs = [own.id, agentAnswer?.id as string];
      const after = await w.services.db
        .select()
        .from(messages)
        .where(inArray(messages.id, [...ids, ...theirs]));
      expect(after).toHaveLength(ids.length + 2);
      for (const m of after) {
        expect(m.outsidersRun, m.text).toBe(!theirs.includes(m.id));
        expect(m.provenance, m.text).toBeNull();
      }
      expect(
        await w.services.db.select().from(searchDocuments).where(inArray(searchDocuments.id, ids)),
      ).toEqual([]);
    } finally {
      await done(trackerAutoId);
      await done(msgWatcherId);
      await done(reactWatcherId);
    }
  });
});
