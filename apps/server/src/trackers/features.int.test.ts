/**
 * Tracker feature requests put to the person (docs/decisions/report-trackers.md TA-41…TA-48) on a real database, with
 * a FakeTracker behind a home-network address, the in-memory FakeGitHub and FAKE AGENTS: the card with the agent's value,
 * the person's answers (approve, decline with the agent's or their own reason, ask the customer, approve and build), what
 * the customer reads and the status it sets, a newer assessment replacing a waiting card, a decided report not asked
 * about again, what skips the card (a bug, a reply that asks first), and a report closed in the tracker ending a waiting card.
 */
import {
  type AutomationRecipeInput,
  type AutomationRun,
  customerSignature,
  featureRequestOutcome,
  type ReportAssessmentInput,
  recipeInstructions,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BurrowAccess } from '../auth/request';
import { createAutomation, deleteAutomation } from '../automations/commands';
import { activeRunCount, loadRunRow } from '../automations/store';
import { loadBurrowRow } from '../commit/pipeline';
import { dispatches, events, featureRequests, messages, vaultNetworks } from '../db/schema/index';
import { callTool } from '../mcp/server';
import { loadMessages } from '../read/messages';
import { loadPrincipalRow } from '../read/principals';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { FakeTracker, type FakeTrackerItem } from '../test/tracker';
import { useFakeTrackerDriver } from '../test/tracker-driver';
import { useVaultNetForTests } from '../vault/net';
import { featureRequestItems, trackerDecideOp } from './features';

const w = useAutomationWorld();
const dev = new FakeTracker();
const HOST = 'dev.tracker.test';
const ADDRESS = '192.168.94.10';
const REPO = 'whombat/billing';
let devId = '';
let signature = '';

beforeAll(async () => {
  await dev.start();
  useFakeTrackerDriver(w.services, dev);
  const port = Number(new URL(dev.url).port);
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host === HOST) return [{ address: ADDRESS, family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (a) => (a === ADDRESS ? '127.0.0.1' : a),
    deadlineMs: 3000,
  });
  await w.services.db.insert(vaultNetworks).values({
    id: 'vnw_tracker_features',
    cidr: '192.168.94.0/24',
    ports: [port],
    note: 'Fake tracker installation',
    addedAt: w.now(),
  });
  devId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme dev',
    handle: 'tracker-dev',
    fields: { url: `http://${HOST}:${port}` },
    secret: dev.token,
  });
  const agent = await loadPrincipalRow(w.services.db, IDS.dusty);
  signature = customerSignature(agent?.name ?? 'Dusty');
});

afterAll(async () => {
  await dev.stop();
});

async function poll() {
  await w.services.tracker.pollNow(devId);
  await w.settle();
  await w.services.tracker.settled();
}

/** “Assess and answer Acme Desk reports”, putting feature requests to the person. */
async function recipe(over: Partial<AutomationRecipeInput> = {}): Promise<string> {
  const when = {
    kind: 'tracker' as const,
    connectionId: devId,
    itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
  };
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    name: 'Assess and answer Acme Desk reports',
    source: {
      kind: 'recipe',
      recipe: {
        when,
        job: 'assess',
        instructions: recipeInstructions('assess', when),
        conversationId: IDS.billing,
        replyToCustomer: true,
        decideFeatures: true,
        ...over,
      },
    },
    publish: true,
  });
  await poll();
  return automationId;
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const feature = (over: Partial<ReportAssessmentInput> = {}): ReportAssessmentInput => ({
  kind: 'feature',
  importance: 'medium',
  confidence: 'high',
  size: 'small',
  summary: 'Export the device list to a spreadsheet.',
  recommends: 'change',
  reply: 'Thanks for the idea. We will look at it and let you know once we have decided.',
  replyAsks: false,
  language: 'en',
  value: 7,
  valueWhy: 'Several schools keep their device lists in spreadsheets, and the work is small.',
  approvedReply:
    'Good news: we will add an export of the device list. We will let you know when it is ready.',
  declineReason: 'Only a few customers would use it.',
  declinedReply:
    'Thanks for the idea. We have decided not to add this, because only a few customers would use it.',
  ...over,
});

/** The agent of step `stepId` reports `a` and answers in the thread. */
async function assess(
  runId: string,
  a: ReportAssessmentInput,
  stepId = 'ask',
  answer = 'A feature request.',
) {
  const dispatchId = step(await w.run(runId), stepId).dispatchId as string;
  expect(dispatchId).toBeTruthy();
  await w.services.db.update(dispatches).set({ state: 'running' }).where(eq(dispatches.id, dispatchId));
  const res = await callTool(
    w.services,
    { dispatchId, agentId: IDS.dusty, burrowId: w.burrowId },
    'report_assessment',
    a,
  );
  expect(res.isError).not.toBe(true);
  await w.fakeAgentReply(dispatchId, answer);
  await w.settle();
  await w.services.tracker.settled();
  return w.run(runId);
}

async function access(principalId: string): Promise<BurrowAccess> {
  const burrow = await loadBurrowRow(w.services.db, w.burrowId);
  const principal = await loadPrincipalRow(w.services.db, principalId);
  if (!burrow || !principal) throw new Error('no access');
  return { burrow, principal };
}

async function decide(requestId: string, choice: 'approve' | 'build' | 'decline' | 'ask', note?: string) {
  const res = await trackerDecideOp(w.services, await access(IDS.mara), requestId, {
    choice,
    ...(note ? { note } : {}),
  });
  await w.settle();
  await w.services.tracker.settled();
  return res.request;
}

/** A new feature request polled into a run, assessed by the agent: its run waits for the person. */
async function asked(automationId: string, over: Partial<FakeTrackerItem> = {}, a = feature()) {
  const at = w.now().toISOString();
  const report = dev.add({
    kind: 'feature',
    title: 'Export devices to CSV',
    created_at: at,
    updated_at: at,
    ...over,
  });
  await poll();
  const run = (await w.runs(automationId)).at(-1) as AutomationRun;
  const after = await assess(run.id, a);
  const requestId = String((step(after, 'decide').output as { requestId?: unknown }).requestId ?? '');
  return { report, run: after, requestId };
}

async function requestRow(id: string) {
  const [row] = await w.services.db.select().from(featureRequests).where(eq(featureRequests.id, id));
  if (!row) throw new Error('no request');
  return row;
}

/** The request's card as people read it. */
async function cardOf(id: string) {
  const row = await requestRow(id);
  const [m] = await w.services.db
    .select()
    .from(messages)
    .where(eq(messages.id, row.messageId as string));
  if (!m) throw new Error('no card');
  const [loaded] = await loadMessages(w.services.db, [m], IDS.mara);
  if (loaded?.card?.kind !== 'feature_request') throw new Error('not a feature request card');
  return { message: loaded, request: loaded.card.request };
}

const sentTo = (reportId: string) =>
  (dev.reports.get(reportId)?.messages ?? []).filter((m) => m.author === 'Acme team').map((m) => m.body);

const lines = async (runId: string) => (await w.runThread(runId)).map((m) => m.text);

describe('a feature request put to the person (TA-44, TA-45)', () => {
  it('waits on a card with the value and both drafts, and tells the customer it is planned', async () => {
    const id = await recipe();
    const { report, run, requestId } = await asked(id);
    expect(run.status).toBe('waiting');
    // The customer heard only that it is being considered.
    expect(step(run, 'reply').output).toMatchObject({ sent: true, status: 'investigating' });
    expect(sentTo(report.id)).toEqual([`${feature().reply}\n\n${signature}`]);
    expect(step(run, 'decide').state).toBe('waiting');

    const { message, request } = await cardOf(requestId);
    expect(message.threadRootId).toBe((await loadRunRow(w.services.db, run.id)).threadRootId);
    expect(request).toMatchObject({
      state: 'waiting',
      value: 7,
      connection: 'Acme dev',
      number: report.number,
      title: 'Export devices to CSV',
      organization: 'Acme Fleet',
      canBuild: false,
      approvedMessage: `${feature().approvedReply}\n\n${signature}`,
      declinedMessage: `${feature().declinedReply}\n\n${signature}`,
      declineReason: feature().declineReason,
    });
    // In Needs you, opening its thread; it doesn't hold a place among the runs going at once.
    const items = await featureRequestItems(w.services.db, w.burrowId);
    expect(items.map((i) => i.item.title)).toContain('Feature request: Export devices to CSV · 7 of 10');
    expect(items[0]?.item.actions[0]?.href).toContain(message.threadRootId as string);
    expect(await activeRunCount(w.services.db, id)).toBe(0);
    // No customer words in the signed event.
    const [signed] = await w.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'tracker.feature_requested'));
    expect(JSON.stringify(signed?.payload)).not.toContain('CSV');

    const decided = await decide(requestId, 'approve');
    expect(decided).toMatchObject({ state: 'decided', choice: 'approve' });
    const done = await w.run(run.id);
    expect(done.status).toBe('succeeded');
    expect(step(done, 'words').state).toBe('skipped');
    expect(step(done, 'tell').output).toMatchObject({ sent: true, status: 'planned' });
    expect(dev.reports.get(report.id)?.status).toBe('planned');
    expect(sentTo(report.id).at(-1)).toBe(`${feature().approvedReply}\n\n${signature}`);
    expect(
      (await lines(run.id)).some((l) =>
        l.startsWith(`Replied to the customer and set #${report.number} to “Planned”`),
      ),
    ).toBe(true);
    expect((await cardOf(requestId)).request?.state).toBe('decided');
    expect(await featureRequestItems(w.services.db, w.burrowId)).toEqual([]);
    // Answered once only.
    await expect(decide(requestId, 'decline')).rejects.toThrow(/isn’t waiting/);

    // The customer thanks them: answered as any reply, with the decision in what the agent reads, and no new card.
    dev.reporterWrites(report.id, 'Great, thanks!');
    await poll();
    const later = (await w.runs(id)).at(-1) as AutomationRun;
    expect(String((await loadRunRow(w.services.db, later.id)).scope.text)).toMatch(
      /The team decided on \d+ \w+ to build it\./,
    );
    const after = await assess(later.id, feature({ reply: 'You are welcome!' }));
    expect(step(after, 'decide')).toMatchObject({ state: 'skipped' });
    expect(step(after, 'decide').inputSummary).toMatch(/^Already decided: approved by \w+ on /);
    expect(after.status).toBe('succeeded');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('declines with the agent’s reason as drafted, or has the agent word the person’s own', async () => {
    const id = await recipe();
    const first = await asked(id, { title: 'Dark mode for the console' });
    await decide(first.requestId, 'decline', feature().declineReason);
    const done = await w.run(first.run.id);
    expect(done.status).toBe('succeeded');
    expect(step(done, 'words').state).toBe('skipped');
    expect(dev.reports.get(first.report.id)?.status).toBe('not_planned');
    expect(sentTo(first.report.id).at(-1)).toBe(`${feature().declinedReply}\n\n${signature}`);
    expect((await requestRow(first.requestId)).note).toBeNull();

    const second = await asked(id, { title: 'Print labels for every device' });
    await decide(second.requestId, 'decline', 'Printing belongs in the label printer’s own software.');
    let now = await w.run(second.run.id);
    expect(step(now, 'decide').output).toMatchObject({
      choice: 'decline',
      needsWords: true,
      status: 'not_planned',
    });
    expect(step(now, 'words').state).toBe('waiting');
    // The agent is told the person's reason.
    const [turn] = await w.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, step(now, 'words').dispatchId as string));
    expect(turn).toBeTruthy();
    const words = 'We won’t add label printing to Acme Desk: your label printer’s own software does it best.';
    now = await assess(second.run.id, feature({ reply: words }), 'words', 'The message is ready.');
    expect(now.status).toBe('succeeded');
    expect(step(now, 'tell').output).toMatchObject({ sent: true, status: 'not_planned' });
    expect(sentTo(second.report.id).at(-1)).toBe(`${words}\n\n${signature}`);
    expect((await cardOf(second.requestId)).request).toMatchObject({
      choice: 'decline',
      note: 'Printing belongs in the label printer’s own software.',
    });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('asks the customer in the agent’s words, and their answer brings a new card', async () => {
    const id = await recipe();
    const { report, run, requestId } = await asked(id, { title: 'Export to Excel' });
    await expect(
      trackerDecideOp(w.services, await access(IDS.mara), requestId, { choice: 'ask' }),
    ).rejects.toThrow(/ask the customer/);
    await decide(requestId, 'ask', 'Which columns do they need?');
    const words = 'Which details of each device would you like in the export: name, serial number, room?';
    const done = await assess(run.id, feature({ reply: words }), 'words', 'Ready.');
    expect(done.status).toBe('succeeded');
    expect(dev.reports.get(report.id)?.status).toBe('needs_information');
    expect(sentTo(report.id).at(-1)).toBe(`${words}\n\n${signature}`);

    dev.reporterWrites(report.id, 'Name and serial number, please.');
    await poll();
    const answer = (await w.runs(id)).at(-1) as AutomationRun;
    // Asking isn't a decision: nothing about one in what the agent reads.
    expect(String((await loadRunRow(w.services.db, answer.id)).scope.text)).not.toContain('The team decided');
    const again = await assess(answer.id, feature({ value: 8, reply: '' }));
    const next = String((step(again, 'decide').output as { requestId?: unknown }).requestId);
    expect(next).not.toBe(requestId);
    expect((await cardOf(next)).request).toMatchObject({ state: 'waiting', value: 8 });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('replaces a waiting card with a newer assessment, and stops the card of a run that stops', async () => {
    const id = await recipe();
    const { report, run, requestId } = await asked(id, { title: 'Bulk rename devices' });
    dev.reporterWrites(report.id, 'Also for rooms, please.');
    await poll();
    const answer = (await w.runs(id)).at(-1) as AutomationRun;
    const after = await assess(answer.id, feature({ reply: 'Noted, thanks.' }));
    expect((await cardOf(requestId)).request?.state).toBe('replaced');
    await w.settle();
    const old = await w.run(run.id);
    expect(old.status).toBe('succeeded');
    expect(step(old, 'decide').state).toBe('skipped');
    const newer = String((step(after, 'decide').output as { requestId?: unknown }).requestId);
    await expect(decide(requestId, 'approve')).rejects.toThrow(/isn’t waiting/);
    // The automation goes: its waiting card no longer waits.
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
    expect((await cardOf(newer)).request?.state).toBe('stopped');
  });

  it('ends a card still waiting once its report is closed in the tracker, and its run goes on', async () => {
    const id = await recipe();
    const { report, run, requestId } = await asked(id, { title: 'Group devices by school' });
    expect(step(run, 'decide').state).toBe('waiting');
    const told = sentTo(report.id).length;
    // Someone closes it in the tracker: a change of status only, nothing the customer wrote.
    dev.change(report.id, (r) => {
      r.status = 'closed';
    });
    await poll();
    const { request } = await cardOf(requestId);
    expect(request).toMatchObject({ state: 'stopped', note: 'The report was closed.' });
    expect(request && featureRequestOutcome(request, null)).toMatchObject({
      lead: 'No longer waiting',
      detail: 'The report was closed.',
    });
    const done = await w.run(run.id);
    expect(step(done, 'decide')).toMatchObject({ state: 'skipped', inputSummary: 'The report was closed.' });
    expect(done.status).toBe('succeeded');
    // Out of the person's Needs you, nothing more for the customer, and an answer now is refused.
    expect((await featureRequestItems(w.services.db, w.burrowId)).map((i) => i.item.id)).not.toContain(
      `feature_request:${requestId}`,
    );
    expect(sentTo(report.id)).toHaveLength(told);
    await expect(decide(requestId, 'approve')).rejects.toThrow(/isn’t waiting/);
    // Polling again changes nothing.
    await poll();
    expect((await requestRow(requestId)).state).toBe('stopped');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('builds what the person approves to build, without a second card', async () => {
    const id = await recipe({ repo: REPO, fix: { mode: 'ask', minImportance: 'high', maxPerDay: 5 } });
    const { report, run, requestId } = await asked(id, { title: 'Sort devices by room' });
    expect((await cardOf(requestId)).request?.canBuild).toBe(true);
    await decide(requestId, 'build');
    const now = await w.run(run.id);
    expect(dev.reports.get(report.id)?.status).toBe('in_progress');
    expect(step(now, 'worth_fixing').output).toMatchObject({ result: true });
    expect(step(now, 'needs_yes').output).toMatchObject({ result: false });
    expect(step(now, 'approve').state).toBe('skipped');
    expect(step(now, 'fix').dispatchId).toBeTruthy();

    // A card that can't build refuses it.
    const plain = await recipe();
    const other = await asked(plain, { title: 'Show battery levels' });
    await expect(decide(other.requestId, 'build')).rejects.toThrow(/approve it instead/);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
    await w.ok(IDS.mara, deleteAutomation, { automationId: plain });
  });

  it('puts nothing to the person for a bug, or before the customer answered', async () => {
    const id = await recipe();
    const at = w.now().toISOString();
    const bug = dev.add({ kind: 'bug', title: 'Rollout stuck', created_at: at, updated_at: at });
    await poll();
    const run = (await w.runs(id)).at(-1) as AutomationRun;
    const done = await assess(run.id, feature({ kind: 'bug', importance: 'high', value: null }));
    expect(step(done, 'decide')).toMatchObject({ state: 'skipped', inputSummary: 'Not a feature request.' });
    expect(done.status).toBe('succeeded');
    expect(dev.reports.get(bug.id)?.status).toBe('investigating');

    const waiting = await asked(
      id,
      { title: 'Something with exports' },
      feature({ reply: 'What would you like to export?', replyAsks: true, value: null }),
    );
    expect(step(waiting.run, 'decide')).toMatchObject({
      state: 'skipped',
      inputSummary: 'Waiting for the customer’s answer first.',
    });
    expect(waiting.run.status).toBe('succeeded');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});
