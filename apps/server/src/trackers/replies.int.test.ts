/**
 * Replying to a tracker report's customer and telling them when the fix is live (docs/decisions/report-trackers.md
 * TA-25…TA-36) on a real database, with two FakeTracker installations — development (`dev.tracker.test`) and production
 * (`manage.tracker.test`) — behind home-network addresses, the in-memory FakeGitHub and FAKE AGENTS: the `tracker_reply`
 * step (Can sends it signed with the status, Asks waits on a card with exactly what is sent, a reply with something to
 * check and a test run's always ask, No and an empty reply skip), the fix followed from its pull request to live (a
 * development report told once development runs it; a production report told twice), a fix to the device agent
 * stopped at its merge, and the customer's answers (a reply starts a run in the report's thread, “It works” only says
 * so).
 */
import {
  type AutomationRecipeInput,
  type AutomationRun,
  CreateConnectionBody,
  customerSignature,
  type ReportAssessmentInput,
  recipeInstructions,
} from '@whombat/core';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BurrowAccess } from '../auth/request';
import {
  createAutomation,
  deleteAutomation,
  runAutomationNow,
  setAutomationKeys,
} from '../automations/commands';
import { sampleReport } from '../automations/routes';
import { loadRunRow } from '../automations/store';
import { decideApproval } from '../commands/approvals';
import { loadBurrowRow } from '../commit/pipeline';
import { createConnection, viewerFor } from '../connections/connect';
import { startT3Code, type T3CodeStub } from '../connections/testing/t3code-stub';
import { connectionViews } from '../connections/views';
import {
  approvals,
  automationRunSteps,
  catalogConnections,
  dispatches,
  messages,
  notifications,
  pullRequests,
  trackerFixes,
  trackerItems,
  vaultNetworks,
} from '../db/schema/index';
import type { FakeGitHub } from '../github/fake';
import { callTool } from '../mcp/server';
import { loadPrincipalRow } from '../read/principals';
import { T3_SETTLE_QUIET_MS } from '../t3code/settle';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { accountOf } from '../test/tokens';
import { FakeTracker, type FakeTrackerItem } from '../test/tracker';
import { useFakeTrackerDriver } from '../test/tracker-driver';
import { useVaultNetForTests } from '../vault/net';
import { trackerItemOp } from './people';
import {
  RELEASE_DEV_GRACE_MS,
  RELEASE_HOLD_MS,
  RELEASE_LAST_RETRY_MS,
  RELEASE_NUDGE_ANSWER_MS,
  RELEASE_QUIET_MS,
  RELEASE_SAME_RETRY_MS,
  RELEASE_SLOW_MS,
  RELEASE_START_RETRY_MS,
} from './release';

const w = useAutomationWorld();
const dev = new FakeTracker();
const prod = new FakeTracker();
const DEV_HOST = 'dev.tracker.test';
const PROD_HOST = 'manage.tracker.test';
const DEV_ADDRESS = '192.168.93.10';
const PROD_ADDRESS = '192.168.93.11';
const T3_HOST = 't3.tracker.test';
const T3_ADDRESS = '192.168.93.12';
const REPO = 'whombat/billing';
let devId = '';
let prodId = '';
let signature = '';

beforeAll(async () => {
  await dev.start();
  useFakeTrackerDriver(w.services, dev, prod);
  await prod.start();
  const devPort = Number(new URL(dev.url).port);
  const prodPort = Number(new URL(prod.url).port);
  useVaultNetForTests(w.services, {
    resolve: async (host) => {
      if (host === DEV_HOST) return [{ address: DEV_ADDRESS, family: 4 }];
      if (host === PROD_HOST) return [{ address: PROD_ADDRESS, family: 4 }];
      if (host === T3_HOST) return [{ address: T3_ADDRESS, family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    dialAddress: (a) => (a === DEV_ADDRESS || a === PROD_ADDRESS || a === T3_ADDRESS ? '127.0.0.1' : a),
    deadlineMs: 3000,
  });
  await w.services.db.insert(vaultNetworks).values({
    id: 'vnw_tracker_replies',
    cidr: '192.168.93.0/24',
    ports: [devPort, prodPort],
    note: 'Fake tracker installations',
    addedAt: w.now(),
  });
  devId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme dev',
    handle: 'tracker-dev',
    fields: { url: `http://${DEV_HOST}:${devPort}` },
    secret: dev.token,
  });
  prodId = await insertConnection(w.services, {
    catalogId: 'tracker',
    burrowId: w.burrowId,
    label: 'Acme Desk',
    fields: { url: `http://${PROD_HOST}:${prodPort}` },
    secret: prod.token,
  });
  const agent = await loadPrincipalRow(w.services.db, IDS.dusty);
  signature = customerSignature(agent?.name ?? 'Dusty');
});

afterAll(async () => {
  await dev.stop();
  await prod.stop();
});

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

function file(tracker: FakeTracker, over: Partial<FakeTrackerItem> = {}): FakeTrackerItem {
  const at = w.now().toISOString();
  return tracker.add({ created_at: at, updated_at: at, ...over });
}

async function poll(id: string) {
  const result = await w.services.tracker.pollNow(id);
  await w.settle();
  await w.services.tracker.settled();
  return result;
}

/** One pass over the fixes, a minute later (an installation's health is read at most once a minute). */
async function follow() {
  w.advance(61_000);
  await w.services.tracker.followFixesNow();
  await w.settle();
}

/** “Assess new reports in …” from billing-v2, writing back and replying to the customer. */
async function recipe(connectionId: string, over: Partial<AutomationRecipeInput> = {}): Promise<string> {
  const when = {
    kind: 'tracker' as const,
    connectionId,
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

const bug = (over: Partial<ReportAssessmentInput> = {}): ReportAssessmentInput => ({
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Saving a blueprint fails.',
  fixPlan: 'Handle the 500 in the save route.',
  recommends: 'change',
  reply:
    'Thanks for telling us. Saving a blueprint fails because of a problem on our side, and we are looking into it.',
  replyAsks: false,
  language: 'en',
  ...over,
});

async function assess(runId: string, a: ReportAssessmentInput, answer = 'A real bug in saving.') {
  const dispatchId = step(await w.run(runId), 'ask').dispatchId as string;
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

/** The run's own thread, in Mara's Feedback room (an assessing recipe's runs post there, automations/rooms.ts). */
async function thread(runId: string) {
  return (await w.runThread(runId)).map((m) => ({
    id: m.id,
    text: m.text,
    root: m.threadRootId,
    author: m.authorId,
  }));
}

async function card(approvalId: string) {
  const [a] = await w.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!a) throw new Error('no approval');
  const [m] = a.messageId
    ? await w.services.db.select().from(messages).where(eq(messages.id, a.messageId))
    : [];
  return { approval: a, text: m?.text ?? '' };
}

const quotedLines = (text: string) =>
  text
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');

/** A new report polled into a run. */
async function reportRun(automationId: string, tracker: FakeTracker, connectionId: string, over = {}) {
  const report = file(tracker, over);
  await poll(connectionId);
  const run = (await w.runs(automationId)).at(-1) as AutomationRun;
  expect(run.trigger.kind).toBe('tracker');
  return { report, run };
}

/** The recipe's fix chain after the assessment: yes, the developer's push and answer, the review; the pull request. */
async function fixIt(runId: string, number: number, reply = 'Saving works again.') {
  let now = await w.run(runId);
  const { approval } = await card(step(now, 'approve').approvalId as string);
  await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
  await w.settle();
  now = await w.run(runId);
  const branch = `feat/${(await loadRunRow(w.services.db, runId)).scope.ref as string}`;
  await w.fakePush(REPO, branch, `Fix report ${number}`);
  await w.fakeAgentReply(step(now, 'fix').dispatchId as string, reply);
  await w.settle();
  now = await w.run(runId);
  await w.fakeAgentReply(step(now, 'review').dispatchId as string, 'Approve: a test covers it.');
  await w.settle();
  now = await w.run(runId);
  expect(now.status).toBe('succeeded');
  const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
  if (!pr) throw new Error('no pull request');
  return { pr, link: `[PR #${pr.number}](${pr.url})` };
}

/** Merges the pull request on GitHub and mirrors it; answers the merge commit. */
async function merge(prNumber: number): Promise<string> {
  await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  await fake().simulateClose({ repo: REPO, number: prNumber, login: 'mara-gh', merged: true });
  await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  return (await fake().getPullRequest(REPO, prNumber)).mergeCommitSha as string;
}

/** An installation deploys a revision after the merge (a clean build). */
async function deploy(tracker: FakeTracker, version: string, environment?: 'development' | 'production') {
  const revision = await fake().simulateCommitOn({ repo: REPO, branch: 'main' });
  tracker.health = {
    ...tracker.health,
    version,
    release: version,
    source_revision: revision,
    source_dirty: false,
    ...(environment ? { environment } : {}),
  };
  return revision;
}

async function fixRow(reportId: string) {
  const [row] = await w.services.db.select().from(trackerFixes).where(eq(trackerFixes.reportId, reportId));
  return row;
}

describe('the reply step (TA-25…TA-28)', () => {
  it('sends the reply signed with the status at Can, and says so in the thread', async () => {
    const id = await recipe(devId);
    expect(await poll(devId)).toMatchObject({ baseline: true });
    const { report, run } = await reportRun(id, dev, devId, { title: 'Saving a blueprint fails' });
    const posts = dev.posts.length;
    const done = await assess(run.id, bug());
    expect(done.status).toBe('succeeded');
    const message = `${bug().reply}\n\n${signature}`;
    expect(signature).toBe('Dusty - AI Assistant');
    expect(step(done, 'reply')).toMatchObject({
      state: 'succeeded',
      output: {
        sent: true,
        connectionId: devId,
        connection: 'Acme dev',
        reportId: report.id,
        number: report.number,
        message,
        status: 'investigating',
      },
    });
    const sent = dev.posts.slice(posts).filter((p) => p.body.message !== undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ message, status: 'investigating' });
    expect(dev.reports.get(report.id)?.status).toBe('investigating');
    const lines = (await thread(run.id)).map((m) => m.text);
    expect(lines).toContain(
      `Replied to the customer and set #${report.number} to “Investigating”:\n\n${quotedLines(message)}`,
    );

    // Whombat's own reply and status aren't the customer's: polling again starts nothing.
    const runs = (await w.runs(id)).length;
    await poll(devId);
    expect((await w.runs(id)).length).toBe(runs);

    // A reply that asks something: “Needs information”.
    const asked = await reportRun(id, dev, devId, { title: 'Which blueprint?' });
    const after = await assess(
      asked.run.id,
      bug({ kind: 'question', reply: 'Which blueprint were you saving when it failed?', replyAsks: true }),
    );
    expect(step(after, 'reply').output).toMatchObject({ sent: true, status: 'needs_information' });
    expect(dev.reports.get(asked.report.id)?.status).toBe('needs_information');

    // A question the reply answers fully: nothing written back as “Needs information”, and the report closes (TA-54).
    const answered = await reportRun(id, dev, devId, { title: 'Where do Authentik users come from?' });
    const closed = await assess(
      answered.run.id,
      bug({
        kind: 'question',
        recommends: 'nothing',
        reply: 'They get an account when they first sign in through a mapped group.',
        closes: true,
      }),
    );
    expect(step(closed, 'reply').output).toMatchObject({ sent: true, status: 'closed' });
    expect(dev.reports.get(answered.report.id)?.status).toBe('closed');
    expect(step(closed, 'write_back')).toMatchObject({ state: 'skipped' });
    expect(dev.reports.get(answered.report.id)?.assessment ?? null).toBeNull();
    // The same without the agent's flag: an answered question asking nothing back is finished all the same.
    const plain = await reportRun(id, dev, devId, { title: 'Can I rename a blueprint?' });
    const renamed = await assess(
      plain.run.id,
      bug({ kind: 'question', recommends: 'nothing', reply: 'Yes: open it and change its name at the top.' }),
    );
    expect(step(renamed, 'reply').output).toMatchObject({ sent: true, status: 'closed' });
    // A report waiting for its fix's release closes only when the customer calls it solved (TA-157).
    const waiting = await reportRun(id, dev, devId, {
      title: 'Pairing code unreadable',
      status: 'awaiting_release',
    });
    const asked2 = await assess(
      waiting.run.id,
      bug({
        kind: 'question',
        recommends: 'nothing',
        reply: 'It comes with the next update of the software.',
      }),
    );
    expect(step(asked2, 'reply').output).toMatchObject({ sent: true, status: null });
    expect(dev.reports.get(waiting.report.id)?.status).toBe('awaiting_release');
    const solved = await reportRun(id, dev, devId, {
      title: 'Kiosk text cut off',
      status: 'awaiting_release',
    });
    const thanked = await assess(
      solved.run.id,
      bug({
        recommends: 'nothing',
        reply: 'Good to hear it works now. We’re closing this report.',
        closes: true,
      }),
    );
    expect(step(thanked, 'reply').output).toMatchObject({ sent: true, status: 'closed' });
    expect(dev.reports.get(solved.report.id)?.status).toBe('closed');

    // A repeat of the same organization's open report is linked to it, the tracker way (TA-54).
    const original = await reportRun(id, dev, devId, { title: 'Exports drop the last row' });
    await assess(original.run.id, bug());
    const repeat = await reportRun(id, dev, devId, { title: 'Last row missing from my export' });
    const linked = await assess(
      repeat.run.id,
      bug({
        kind: 'duplicate',
        recommends: 'nothing',
        duplicateOf: original.report.number,
        reply: 'Thanks! Someone else reported this too; we tell you here as soon as it is fixed.',
        closes: true,
      }),
    );
    expect(step(linked, 'reply').output).toMatchObject({ sent: true, status: 'duplicate' });
    expect(dev.reports.get(repeat.report.id)).toMatchObject({
      status: 'duplicate',
      duplicate_of: original.report.id,
    });

    // Nothing to say: skipped with why.
    const quiet = await reportRun(id, dev, devId, { title: 'Thank you!' });
    const skipped = step(await assess(quiet.run.id, bug({ kind: 'not_a_bug', reply: '' })), 'reply');
    expect(skipped).toMatchObject({
      state: 'skipped',
      output: { sent: false, reason: 'Nothing to send: Dusty had nothing to tell the customer.' },
    });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('asks a person with exactly what is sent when its key asks, when the reply needs a look, and in a test run', async () => {
    const id = await recipe(devId);
    await poll(devId);
    // The recipe got “Reply to customers” at Can for its connection (TA-27).
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [
        { keyId: 'report.update', tier: 'can', connections: [devId] },
        { keyId: 'report.reply', tier: 'ask', connections: [devId] },
      ],
    });
    const asks = await reportRun(id, dev, devId, { title: 'Asks first' });
    let now = await assess(asks.run.id, bug());
    const message = `${bug().reply}\n\n${signature}`;
    const waiting = step(now, 'reply');
    expect(waiting.state).toBe('waiting');
    const first = await card(waiting.approvalId as string);
    expect(first.approval.title).toBe(`Reply to the customer of Acme dev #${asks.report.number}`);
    expect(first.approval.whatHappens).toEqual([
      `Dusty’s reply goes to the customer through Acme dev, which emails it to them and sets #${asks.report.number} to “Investigating”:`,
      bug().reply,
      signature,
    ]);
    expect(first.text).toBe(
      `I need a person to say yes before I go on: Reply to the customer of Acme dev #${asks.report.number}\n\n${quotedLines(message)}`,
    );
    const posts = dev.posts.length;
    await w.ok(IDS.mara, decideApproval, { number: first.approval.number, decision: 'approve' });
    await w.settle();
    now = await w.run(asks.run.id);
    expect(step(now, 'reply')).toMatchObject({ state: 'succeeded', output: { sent: true, message } });
    expect(dev.posts.length).toBe(posts + 1);

    // A reply with something a customer mustn't read waits for a yes even at Can, and the card says why.
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [
        { keyId: 'report.update', tier: 'can', connections: [devId] },
        { keyId: 'report.reply', tier: 'can', connections: [devId] },
      ],
    });
    const risky = await reportRun(id, dev, devId, { title: 'Needs a look' });
    now = await assess(risky.run.id, bug({ reply: 'We fixed it in PR #52 and it ships soon.' }));
    const look = await card(step(now, 'reply').approvalId as string);
    expect(look.approval.whatHappens[0]).toBe('Check it first: It mentions a pull request.');
    await w.ok(IDS.mara, decideApproval, { number: look.approval.number, decision: 'decline' });
    await w.settle();
    expect(step(await w.run(risky.run.id), 'reply')).toMatchObject({
      state: 'skipped',
      output: {
        sent: false,
        reason: `Mara declined replying to the customer of Acme dev #${risky.report.number}.`,
      },
    });
    expect(dev.reports.get(risky.report.id)?.messages ?? []).toEqual([]);

    // No: skipped with why, nothing sent.
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [
        { keyId: 'report.update', tier: 'can', connections: [devId] },
        { keyId: 'report.reply', tier: 'cannot', connections: [devId] },
      ],
    });
    const no = await reportRun(id, dev, devId, { title: 'Not allowed' });
    const refused = step(await assess(no.run.id, bug()), 'reply');
    expect(refused.state).toBe('skipped');
    expect(String(refused.output.reason)).toContain('Reply to customers');
    expect(dev.reports.get(no.report.id)?.messages ?? []).toEqual([]);

    // A test run's reply always asks (TA-28).
    await w.ok(IDS.mara, setAutomationKeys, {
      automationId: id,
      grants: [
        { keyId: 'report.update', tier: 'can', connections: [devId] },
        { keyId: 'report.reply', tier: 'can', connections: [devId] },
      ],
    });
    const sample = file(dev, { title: 'Try me' });
    const { runId } = await w.ok(IDS.mara, runAutomationNow, {
      automationId: id,
      test: true,
      sample: { reportId: sample.id },
      sampleReport: await sampleReport(w.services, await access(IDS.mara), id, sample.id),
    });
    await w.settle();
    const tried = await assess(runId as string, bug());
    const test = await card(step(tried, 'reply').approvalId as string);
    expect(test.approval.whatHappens[0]).toBe(
      'This is a test run: the customer gets it only if you say yes.',
    );
    expect(dev.reports.get(sample.id)?.messages ?? []).toEqual([]);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('the fix of a development report (TA-29, TA-30, TA-36)', () => {
  it('says where it is, then that it was merged, and tells the customer once development runs it', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Exports lose the last row' });
    await assess(run.id, bug());
    const { pr, link } = await fixIt(
      run.id,
      report.number,
      'Exports keep their last row now.\n\nFor the customer (fixed): Exports include every row again.',
    );
    const texts = async () => (await thread(run.id)).map((m) => m.text);
    expect(await texts()).toContain(
      `Opened ${link}. The customer hears once the fix is live on ${DEV_HOST}.`,
    );
    expect(await fixRow(report.id)).toMatchObject({ state: 'open', prNumber: pr.number, repo: REPO });
    // Its description names the report the way the tracker's own deploy looks for (TA-35, `{{trigger.host}}`).
    expect(fake().repos.get(REPO)?.prs.get(pr.number)?.body).toContain(
      `Tracker report: ${DEV_HOST} #${report.number}`,
    );

    const mergeSha = await merge(pr.number);
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged', mergeSha });
    expect(await texts()).toContain(`${link} was merged. The customer hears once it’s live on ${DEV_HOST}.`);
    // The branch cleanup leaves the merged line to the fix (once).
    const { cleanUpMergedBranches } = await import('../automations/cleanup');
    await cleanUpMergedBranches(w.services, w.now(), new Map());
    expect((await texts()).filter((t) => t.includes('was merged'))).toHaveLength(1);

    // Development still runs an older revision: nothing yet.
    const posts = dev.posts.length;
    await follow();
    expect((await fixRow(report.id))?.state).toBe('merged');
    expect(dev.posts.length).toBe(posts);

    // A dirty build doesn't count.
    await deploy(dev, '0.1.175');
    dev.health.source_dirty = true;
    await follow();
    expect((await fixRow(report.id))?.state).toBe('merged');

    // Development runs a clean revision with the fix: the customer is told once, with the release record.
    await deploy(dev, '0.1.176');
    await follow();
    const live = await fixRow(report.id);
    expect(live).toMatchObject({ state: 'live', developmentHost: DEV_HOST, developmentVersion: '0.1.176' });
    const notices = dev.posts.slice(posts).filter((p) => p.body.status === 'available');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatchObject({
      message: `Good news: we’ve fixed this, and the fix is live now. Exports include every row again. Could you try again and let us know whether it works?\n\n${signature}`,
      release: {
        component: 'manage',
        version: '0.1.176',
        evidence: expect.stringMatching(/^Live on dev\.tracker\.test since \d+ \w+ 2026\.$/),
      },
    });
    expect(dev.reports.get(report.id)?.status).toBe('available');
    expect(await texts()).toContain(
      `The fix is live on ${DEV_HOST} (Acme Desk 0.1.176), so the customer was told and asked to try it.`,
    );
    await follow();
    expect(dev.posts.slice(posts).filter((p) => p.body.status === 'available')).toHaveLength(1);

    // The run page shows where the fix is.
    const view = await trackerItemOp(w.services, await access(IDS.mara), run.id);
    expect(view.report.fix).toMatchObject({
      state: 'live',
      repo: REPO,
      prNumber: pr.number,
      development: { host: DEV_HOST, version: '0.1.176' },
      production: null,
    });

    // “It works”: the thread says so and the fix is confirmed; no run starts.
    const runs = (await w.runs(id)).length;
    dev.reporterWrites(report.id, 'The fix works. Thank you.', 'confirmed');
    await poll(devId);
    expect((await w.runs(id)).length).toBe(runs);
    expect((await fixRow(report.id))?.state).toBe('confirmed');
    const said = (await thread(run.id)).filter((m) => m.text === 'The customer says the fix works.');
    expect(said).toHaveLength(1);
    expect(said[0]?.author).not.toBe(IDS.dusty);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('tells the customer at the merge of a fix to the device agent, then stops (TA-59)', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'The agent crashes' });
    await assess(run.id, bug());
    const { pr, link } = await fixIt(run.id, report.number);
    const fakePr = fake().repos.get(REPO)?.prs.get(pr.number);
    if (fakePr) fakePr.files = [{ path: 'agent/src/report.rs', add: 4, del: 1 }];
    const before = dev.posts.length;
    await merge(pr.number);
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'stopped' });
    expect((await thread(run.id)).map((m) => m.text)).toContain(
      `${link} changes what reaches customers with a release of its own, so the customer was told it’s fixed and comes with a coming update.`,
    );
    const told = dev.posts.slice(before).filter((p) => p.body.message !== undefined);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toMatchObject({ status: 'awaiting_release' });
    expect(told[0]?.body.message).toContain('coming update of the Acme Desk software');
    await deploy(dev, '0.1.177');
    const posts = dev.posts.length;
    await follow();
    expect(dev.posts.length).toBe(posts);

    // The tracker then says what it offers of its devices' software (TA-155): an older one changes nothing.
    const older = await fake().simulateCommitOn({ repo: REPO, branch: 'side' });
    dev.health = { ...dev.health, device_release_version: '2.0.1', device_source_revision: older };
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'stopped' });
    expect(dev.posts.length).toBe(posts);
    // One with the fix: the report is marked released without a message (they heard it at the merge).
    dev.health = {
      ...dev.health,
      device_release_version: '2.0.2',
      device_source_revision: dev.health.source_revision,
    };
    await follow();
    expect(await fixRow(report.id)).toMatchObject({
      state: 'live',
      separate: 'only',
      developmentHost: DEV_HOST,
      note: null,
    });
    const marked = dev.posts.slice(posts);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.body.message).toBeUndefined();
    expect(marked[0]?.body).toMatchObject({ status: 'available', release: { version: '0.1.177' } });
    expect((await thread(run.id)).some((m) => m.text.includes('marked as released'))).toBe(true);
    await follow();
    expect(dev.posts.length).toBe(posts + 1);
    delete dev.health.device_release_version;
    delete dev.health.device_source_revision;
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('follows a fix that changes the device agent and what the tracker runs: it goes live with the tracker', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Enrolment refused on a USB adapter' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    const fakePr = fake().repos.get(REPO)?.prs.get(pr.number);
    if (fakePr)
      fakePr.files = [
        { path: 'agent/src/enrol.rs', add: 4, del: 1 },
        { path: 'src/enrollment/submission.rs', add: 9, del: 2 },
        { path: 'docs/api.md', add: 1, del: 0 },
      ];
    const before = dev.posts.length;
    await merge(pr.number);
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged' });
    expect(dev.posts.slice(before).filter((p) => p.body.status === 'awaiting_release')).toHaveLength(0);
    await deploy(dev, '0.1.178');
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'live', developmentVersion: '0.1.178' });
    expect(dev.posts.slice(before).filter((p) => p.body.status === 'available')).toHaveLength(1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('other ways a fix goes (TA-29, TA-33, TA-36)', () => {
  it('follows a person’s merged fix that names the report, and ends a closed or a stale one', async () => {
    const id = await recipe(devId);
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Exports are slow' });
    await assess(run.id, bug({ recommends: 'nothing' }));
    const texts = async () => (await thread(run.id)).map((m) => m.text);

    // A person's own pull request with the report's line: followed once it is merged.
    const number = await fake().simulateOpenPullRequest({
      repo: REPO,
      head: 'anna/faster-exports',
      title: 'Faster exports',
      body: `Speeds up exports.\n\nTracker report: ${DEV_HOST} #${report.number}`,
      login: 'anna-gh',
    });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await fake().simulateClose({ repo: REPO, number, login: 'anna-gh', merged: true });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ prNumber: number, runId: run.id, stepIdx: null });
    await follow();
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
    const link = `[PR #${number}](${pr?.url})`;
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged' });
    expect(await texts()).toContain(`${link} was merged. The customer hears once it’s live on ${DEV_HOST}.`);

    // Not live within 90 days of its merge: no longer followed, and the thread says who tells the customer.
    await w.services.db
      .update(trackerFixes)
      .set({ mergedAt: new Date(w.now().getTime() - 91 * 86_400_000) })
      .where(eq(trackerFixes.reportId, report.id));
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'stopped' });
    expect(await texts()).toContain(
      `Stopped waiting for the fix of Acme dev #${report.number} to go live after 90 days: tell the customer on the run page once it is.`,
    );

    // Another of its pull requests is closed without merging.
    const other = await fake().simulateOpenPullRequest({
      repo: REPO,
      head: 'anna/other-try',
      title: 'Another try',
      body: `Tracker report: ${DEV_HOST} #${report.number}`,
      login: 'anna-gh',
    });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await fake().simulateClose({ repo: REPO, number: other, login: 'anna-gh', merged: false });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await follow();
    // Only merged pull requests of people are followed: a closed one never was.
    expect(
      (await w.services.db.select().from(trackerFixes).where(eq(trackerFixes.prNumber, other))).length,
    ).toBe(0);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('follows the run’s own pull request when someone finished it from the run’s branch after the step stopped', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Totals drift' });
    await assess(run.id, bug());
    // Its pull request step stopped before opening it (an update restarted Whombat), and someone opened and merged it
    // from the run's branch, without the line that names the report.
    const branch = `feat/acme-dev-${report.number}`;
    const stopped = await w.services.db
      .update(automationRunSteps)
      .set({ state: 'uncertain', output: { branch, title: 'Fix the drift' } })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.stepId, 'pr')))
      .returning({ idx: automationRunSteps.idx });
    expect(stopped).toHaveLength(1);
    const number = await fake().simulateOpenPullRequest({
      repo: REPO,
      head: branch,
      title: 'Fix the drift',
      body: 'Totals no longer drift.',
      login: 'anna-gh',
    });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await fake().simulateClose({ repo: REPO, number, login: 'anna-gh', merged: true });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ prNumber: number, runId: run.id, stepIdx: null });
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged' });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('follows a fix opened and merged between two reads of GitHub, which the mirror never saw', async () => {
    const id = await recipe(devId, { repo: REPO });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Totals are off by a cent' });
    await assess(run.id, bug({ recommends: 'nothing' }));
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    const number = await fake().simulateOpenPullRequest({
      repo: REPO,
      head: 'anna/cent',
      title: 'Round totals once',
      body: `Rounds once.\n\nTracker report: ${DEV_HOST} #${report.number}`,
      login: 'anna-gh',
    });
    await fake().simulateClose({ repo: REPO, number, login: 'anna-gh', merged: true });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    expect(
      (await w.services.db.select().from(pullRequests).where(eq(pullRequests.number, number))).length,
    ).toBe(0);
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ prNumber: number, runId: run.id, repo: REPO });
    // Then followed like any other: merged, and live once development runs it.
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged', mergeSha: expect.any(String) });
    await deploy(dev, '0.1.200');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('says a fix was closed without merging', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Totals are off' });
    await assess(run.id, bug());
    const { pr, link } = await fixIt(run.id, report.number);
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await fake().simulateClose({ repo: REPO, number: pr.number, login: 'mara-gh', merged: false });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'closed' });
    expect((await thread(run.id)).map((m) => m.text)).toContain(
      `${link} was closed without merging, so the customer isn’t told it’s fixed.`,
    );
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('the fix of a production report (TA-30, TA-32)', () => {
  it('tells the customer it’s fixed once development runs it, and that it’s live once production does', async () => {
    // Development says which installation it is; production is told apart by its address.
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title: 'Reports page is blank' });
    await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
    // The fix says what it did for the customer (TA-55): part of it is still open.
    const note = 'De pagina toont nu een duidelijke melding in plaats van leeg te blijven.';
    const { pr, link } = await fixIt(
      run.id,
      report.number,
      `The reports page shows a message now.\n\nFor the customer (partly fixed): ${note}`,
    );
    // The line is for the customer's notice, not the team's pull request.
    expect(fake().repos.get(REPO)?.prs.get(pr.number)?.body).not.toContain('For the customer');
    const texts = async () => (await thread(run.id)).map((m) => m.text);
    expect(await texts()).toContain(
      `Opened ${link}. The customer hears once the fix is live on ${DEV_HOST}.`,
    );
    await merge(pr.number);
    await follow();
    expect(await texts()).toContain(`${link} was merged. The customer hears once it’s live on ${DEV_HOST}.`);

    const posts = prod.posts.length;
    await deploy(dev, '0.1.178', 'development');
    await follow();
    expect(await fixRow(report.id)).toMatchObject({
      state: 'development',
      developmentHost: DEV_HOST,
      developmentVersion: '0.1.178',
    });
    const coming = prod.posts.slice(posts);
    expect(coming).toHaveLength(1);
    expect(coming[0]?.body).toMatchObject({ status: 'awaiting_release' });
    // A partial fix never says it's fixed, and says what changed.
    expect(coming[0]?.body.message).toContain(note);
    expect(coming[0]?.body.message).not.toContain('opgelost');
    expect(coming[0]?.body.message).toContain('volgende update van Acme Desk');
    expect(coming[0]?.body.release).toBeUndefined();
    expect(await texts()).toContain(
      `The fix is live on ${DEV_HOST} (Acme Desk 0.1.178), so the customer was told it’s fixed and comes with the next update.`,
    );

    // Production deploys it: told again, now with the release record.
    await deploy(prod, '0.1.180', 'production');
    await follow();
    expect(await fixRow(report.id)).toMatchObject({
      state: 'live',
      productionHost: PROD_HOST,
      productionVersion: '0.1.180',
    });
    const live = prod.posts.slice(posts + 1);
    expect(live).toHaveLength(1);
    expect(live[0]?.body).toMatchObject({
      status: 'available',
      message: `De aanpassing staat nu live. Wil je het proberen en laten weten hoe het gaat?\n\n${signature}`,
      release: {
        component: 'manage',
        version: '0.1.180',
        evidence: expect.stringMatching(/^Live op manage\.tracker\.test sinds /),
      },
    });
    expect(await texts()).toContain(
      `The fix is live on ${PROD_HOST} (Acme Desk 0.1.180), so the customer was told and asked to try it.`,
    );

    // The connection page says which installation each is and what it runs (TA-32).
    const [conn] = await w.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, prodId));
    const [prodView] = await connectionViews(w.services.db, conn ? [conn] : []);
    expect(prodView?.poller).toMatchObject({ environment: 'production', version: '0.1.180' });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('a fix to what reaches customers with a release of its own (TA-155)', () => {
  afterEach(() => {
    delete prod.health.device_release_version;
    delete prod.health.device_source_revision;
  });

  /** A production bug report's fix changing `files`, merged while production says what it offers of the devices' part. */
  async function separateFix(title: string, files: { path: string; add: number; del: number }[]) {
    dev.health = { ...dev.health, environment: 'development' };
    // What production offers now: built before the fix.
    const offered = await deploy(prod, '0.1.192', 'production');
    prod.health = { ...prod.health, device_release_version: '2.1.0', device_source_revision: offered };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title });
    await assess(run.id, bug());
    const { pr } = await fixIt(
      run.id,
      report.number,
      'The kiosk draws its code again.\n\nFor the customer (fixed): The pairing code shows on every screen.',
    );
    const fakePr = fake().repos.get(REPO)?.prs.get(pr.number);
    if (fakePr) fakePr.files = files;
    const posts = prod.posts.length;
    await merge(pr.number);
    await follow();
    return { id, report, run, offered, posts };
  }

  it('one that changes only that part is followed until production offers it, then the customer hears how to get it', async () => {
    const { id, report, run, offered, posts } = await separateFix('The pairing code is unreadable', [
      { path: 'agent/kiosk/src/main.rs', add: 9, del: 2 },
      // The repository's own checks reach no customer.
      { path: 'ops/checks/module-sizes.json', add: 1, del: 1 },
    ]);
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged', separate: 'only' });
    expect(prod.posts.slice(posts)).toHaveLength(0);
    // Development runs it: “fixed, it comes with the next update”, as for any fix.
    await deploy(dev, '0.1.193', 'development');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('development');
    expect(prod.posts.slice(posts).map((p) => p.body.status)).toEqual(['awaiting_release']);
    // Production runs a revision with it, but still offers the devices' part built before it: not there yet.
    await deploy(prod, '0.1.194', 'production');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('development');
    expect(prod.posts.slice(posts)).toHaveLength(1);
    // Production offers a release of it with the fix.
    prod.health = {
      ...prod.health,
      device_release_version: '2.1.1',
      device_source_revision: prod.health.source_revision,
    };
    expect(prod.health.device_source_revision).not.toBe(offered);
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'live', productionVersion: '0.1.194' });
    const live = prod.posts.slice(posts + 1);
    expect(live).toHaveLength(1);
    expect(live[0]?.body).toMatchObject({ status: 'available', release: { version: '0.1.194' } });
    expect(live[0]?.body.message).toContain('ready for your computers');
    expect(live[0]?.body.message).toContain('‘Update now’ on your hub');
    expect((await thread(run.id)).some((m) => m.text.includes('ready for customers’ computers'))).toBe(true);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('one that changes that part and what the tracker runs needs both on production', async () => {
    const { id, report, posts } = await separateFix('Enrolment fails behind a proxy', [
      { path: 'agent/src/enrol.rs', add: 3, del: 1 },
      { path: 'src/enrollment/proxy.rs', add: 12, del: 0 },
    ]);
    expect(await fixRow(report.id)).toMatchObject({ state: 'merged', separate: 'also' });
    await deploy(dev, '0.1.195', 'development');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('development');
    // Production offers the devices' part with it, but runs an older revision itself.
    const before = prod.health.source_revision;
    prod.health = {
      ...prod.health,
      device_source_revision: await fake().simulateCommitOn({ repo: REPO, branch: 'main' }),
    };
    expect(prod.health.source_revision).toBe(before);
    await follow();
    expect((await fixRow(report.id))?.state).toBe('development');
    await deploy(prod, '0.1.196', 'production');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');
    const live = prod.posts.slice(posts).filter((p) => p.body.status === 'available');
    expect(live).toHaveLength(1);
    expect(live[0]?.body.message).toContain('ready for your computers');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('several fixes of one report going live together', () => {
  it('tell the customer once per stage; the other fix is recorded as told by it', async () => {
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title: 'Totals are rounded twice' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    // A person's second pull request for the same report.
    const second = await fake().simulateOpenPullRequest({
      repo: REPO,
      head: 'anna/rounding',
      title: 'Round once',
      body: `Rounds once.\n\nTracker report: ${PROD_HOST} #${report.number}`,
      login: 'anna-gh',
    });
    await merge(pr.number);
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await fake().simulateClose({ repo: REPO, number: second, login: 'anna-gh', merged: true });
    await w.services.github.poller.pollNow({ burrowId: w.burrowId });
    await follow();
    await follow();
    const rows = async () =>
      (await w.services.db.select().from(trackerFixes).where(eq(trackerFixes.reportId, report.id))).sort(
        (a, b) => a.prNumber - b.prNumber,
      );
    expect((await rows()).map((r) => [r.prNumber, r.state])).toEqual([
      [pr.number, 'merged'],
      [second, 'merged'],
    ]);

    const posts = prod.posts.length;
    await deploy(dev, '0.1.190', 'development');
    await follow();
    expect((await rows()).map((r) => r.state)).toEqual(['development', 'development']);
    expect(prod.posts.slice(posts)).toHaveLength(1);

    await deploy(prod, '0.1.191', 'production');
    await follow();
    const after = await rows();
    expect(after.map((r) => [r.state, r.productionVersion, r.note])).toEqual([
      ['live', '0.1.191', null],
      ['live', '0.1.191', null],
    ]);
    // Both are told under the one notice's request id: the tracker got one “live” message.
    expect(after[0]?.productionRequestId).toBeTruthy();
    expect(after[1]?.productionRequestId).toBe(after[0]?.productionRequestId);
    const live = prod.posts.slice(posts + 1);
    expect(live).toHaveLength(1);
    expect(live[0]?.body).toMatchObject({ status: 'available' });
    // The thread says which fix told the customer.
    const texts = (await thread(run.id)).map((m) => m.text);
    expect(
      texts.some(
        (t) => t.includes('told once') && (t.includes(`PR #${pr.number}`) || t.includes(`PR #${second}`)),
      ),
    ).toBe(true);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('straight to production for a chosen reporter (TA-135…TA-140)', () => {
  let t3: T3CodeStub;
  const launches = () => t3.calls.filter((c) => c.name === 't3_thread_launch');

  beforeAll(async () => {
    t3 = await startT3Code();
    t3.knobs.projects = [
      { id: 'mcp:demo', title: 'Demo site', workspaceRoot: '/srv/demo' },
      {
        id: 'mcp:billing',
        title: 'Invoices',
        workspaceRoot: '/srv/invoices',
        repositoryIdentity: { displayName: REPO },
      },
    ];
    await w.services.db.insert(vaultNetworks).values({
      id: 'vnw_tracker_replies_t3',
      cidr: `${T3_ADDRESS}/32`,
      ports: [t3.port],
      note: 'Fake T3 Code',
      addedAt: w.now(),
    });
    const viewer = await viewerFor(w.services, await accountOf(w.services, IDS.mara), w.burrowId);
    if (!viewer) throw new Error('Mara is no member');
    await createConnection(
      w.services,
      viewer,
      CreateConnectionBody.parse({
        catalogId: 't3code',
        signIn: 'password',
        fields: { url: `http://${T3_HOST}:${t3.port}` },
        login: { password: t3.pairingCode() },
        access: 'manage',
      }),
    );
    // The fake reports' reporter, in any case and among others.
    const [conn] = await w.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, prodId));
    await w.services.db
      .update(catalogConnections)
      .set({ fields: { ...conn?.fields, releaseFor: 'someone@example.com, Rita@Acme.example' } })
      .where(eq(catalogConnections.id, prodId));
  });

  afterAll(async () => {
    await t3?.close();
  });

  /** A production bug report fixed and merged, then live on development: the fix as it is then. */
  async function liveOnDevelopment(title: string, version: string) {
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title });
    await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    const posts = prod.posts.length;
    const revision = await deploy(dev, version, 'development');
    await follow();
    return { id, report, run, posts, revision };
  }

  it('releases the fix of the reporter’s bug in T3 Code once development runs it; the customer hears once it’s live', async () => {
    const before = launches().length;
    const { id, report, run, posts, revision } = await liveOnDevelopment('Invoices list is empty', '0.1.181');
    const fix = await fixRow(report.id);
    expect(fix).toMatchObject({
      state: 'development',
      developmentHost: DEV_HOST,
      developmentVersion: '0.1.181',
    });
    expect(fix?.release).toMatchObject({ revision, threadId: expect.any(String) });
    // Nothing for the customer yet: they hear once production runs it.
    expect(prod.posts.slice(posts)).toEqual([]);
    const texts = async () => (await thread(run.id)).map((m) => m.text);
    expect((await texts()).some((t) => t.includes('straight to production'))).toBe(true);

    // One thread, in the repository's project, with full access, for exactly what development runs.
    expect(launches()).toHaveLength(before + 1);
    const launch = launches().at(-1);
    expect(launch?.args).toMatchObject({ projectId: 'mcp:billing', runtimeMode: 'full-access' });
    const brief = String(launch?.args.message);
    expect(brief).toContain(revision);
    expect(brief).toContain(REPO);
    expect(brief).toContain('Released:');
    // Who filed it never reaches the thread.
    expect(brief.toLowerCase()).not.toContain('rita');

    // The release thread runs; a turn that ends while it waits for the checks is no stop (T3 Code wakes it).
    await follow();
    expect((await fixRow(report.id))?.state).toBe('development');
    t3.finish(fix?.release?.threadId as string, 'The candidate is being prepared. I’ll go on once it is.');
    await follow();
    expect((await fixRow(report.id))?.release?.stoppedAt).toBeUndefined();
    expect(prod.posts.slice(posts)).toEqual([]);
    // Production then runs the fix.
    t3.finish(fix?.release?.threadId as string, 'Released: 0.1.182 is live on production.');
    await deploy(prod, '0.1.182', 'production');
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'live', productionVersion: '0.1.182' });
    const told = prod.posts.slice(posts);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toMatchObject({ status: 'available', release: { version: '0.1.182' } });
    // Once only.
    await follow();
    expect(launches()).toHaveLength(before + 1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a release that stops tells the customer it’s coming with the next update and the person why', async () => {
    const { id, report, run, posts } = await liveOnDevelopment('Exports time out', '0.1.183');
    const fix = await fixRow(report.id);
    expect(fix?.release?.threadId).toBeTruthy();
    t3.finish(fix?.release?.threadId as string, 'Stopped: beta didn’t become healthy.\n\nThe logs say more.');
    await follow();
    const stopped = await fixRow(report.id);
    expect(stopped).toMatchObject({ state: 'development' });
    expect(stopped?.release).toMatchObject({
      why: 'beta didn’t become healthy',
      stoppedAt: expect.any(String),
    });
    const told = prod.posts.slice(posts);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toMatchObject({ status: 'awaiting_release' });
    expect((await thread(run.id)).map((m) => m.text)).toContain(
      'The production release stopped before production ran the fix: beta didn’t become healthy. The customer was told it’s fixed and comes with the next update.',
    );
    const inbox = await w.services.db.select().from(notifications).where(eq(notifications.kind, 'needs_you'));
    expect(
      inbox.some(
        (n) => n.text.includes('production release') && n.text.includes('beta didn’t become healthy'),
      ),
    ).toBe(true);
    // Said once; production running it later still tells the customer it's live.
    await follow();
    expect(prod.posts.slice(posts)).toHaveLength(1);
    await deploy(prod, '0.1.184', 'production');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');
    expect(prod.posts.slice(posts)).toHaveLength(2);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('a chosen reporter’s release that stopped or went quiet', () => {
  let t3: T3CodeStub;
  const launches = () => t3.calls.filter((c) => c.name === 't3_thread_launch');

  beforeAll(async () => {
    t3 = await startT3Code();
    t3.knobs.projects = [
      {
        id: 'mcp:billing',
        title: 'Invoices',
        workspaceRoot: '/srv/invoices',
        repositoryIdentity: { displayName: REPO },
      },
    ];
    // The fake T3 Code's address is allowed already; this one listens on another port.
    await w.services.db
      .update(vaultNetworks)
      .set({ ports: [t3.port] })
      .where(eq(vaultNetworks.cidr, `${T3_ADDRESS}/32`));
    const viewer = await viewerFor(w.services, await accountOf(w.services, IDS.mara), w.burrowId);
    if (!viewer) throw new Error('Mara is no member');
    // The world's earlier T3 Code is gone: this one runs the releases.
    await w.services.db.delete(catalogConnections).where(eq(catalogConnections.catalogId, 't3code'));
    await createConnection(
      w.services,
      viewer,
      CreateConnectionBody.parse({
        catalogId: 't3code',
        signIn: 'password',
        fields: { url: `http://${T3_HOST}:${t3.port}` },
        login: { password: t3.pairingCode() },
        access: 'manage',
      }),
    );
  });

  afterAll(async () => {
    await t3?.close();
  });

  // One release of a repository at a time: a release a test leaves under way would hold the next test's back.
  afterEach(async () => {
    await w.services.db
      .update(trackerFixes)
      .set({ state: 'stopped' })
      .where(inArray(trackerFixes.state, ['merged', 'development']));
  });

  /**
   * A production bug report of the chosen reporter, fixed, merged and live on development (the report's automation:
   * `automationId`, else a new one).
   */
  async function liveOnDevelopment(title: string, version: string, automationId?: string) {
    dev.health = { ...dev.health, environment: 'development' };
    const id = automationId ?? (await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } }));
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title });
    await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    const posts = prod.posts.length;
    await deploy(dev, version, 'development');
    await follow();
    return { id, report, run, posts, fix: await fixRow(report.id) };
  }

  /** As `liveOnDevelopment`: its release started. */
  async function releasing(title: string, version: string) {
    const live = await liveOnDevelopment(title, version);
    expect(live.fix?.release?.threadId).toBeTruthy();
    return { ...live, threadId: live.fix?.release?.threadId as string };
  }

  const releaseNotices = (fixId: string | undefined) =>
    w.services.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `tracker_release:${fixId}:%`));

  it('a stopped release whose thread goes on is followed again, not started a second time beside it', async () => {
    const { id, report, run, fix, threadId } = await releasing('Badges print twice', '0.1.200');
    const before = launches().length;
    t3.finish(threadId, 'Stopped: a browser check failed.');
    await follow();
    expect((await fixRow(report.id))?.release).toMatchObject({ stoppedAt: expect.any(String) });
    // The person tells the thread to mend it and go on; development runs a newer revision meanwhile.
    t3.message(threadId, 'Fix the failing check and carry on.');
    await deploy(dev, '0.1.201', 'development');
    await follow();
    await follow();
    const going = await fixRow(report.id);
    expect(going?.release?.stoppedAt).toBeUndefined();
    expect(going?.release).toMatchObject({ threadId, attempt: 1, revivals: 1 });
    expect(launches()).toHaveLength(before);
    expect((await thread(run.id)).some((m) => m.text.includes('follows it again'))).toBe(true);
    // Stopping again reaches the person again.
    t3.finish(threadId, 'Stopped: the check still fails.');
    await follow();
    expect((await fixRow(report.id))?.release).toMatchObject({ stoppedAt: expect.any(String) });
    await w.services.background.settle();
    expect(await releaseNotices(fix?.id)).toHaveLength(2);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a fix due while another release of the repository goes waits for it, and starts once that one stopped', async () => {
    const first = await releasing('Rota shows nobody', '0.1.202');
    const before = launches().length;
    const second = await liveOnDevelopment('Rota shows everybody twice', '0.1.203', first.id);
    expect(second.fix).toMatchObject({ state: 'development', developmentVersion: '0.1.203' });
    expect(second.fix?.release).toMatchObject({ behind: first.fix?.id });
    expect(second.fix?.release?.threadId).toBeUndefined();
    expect(launches()).toHaveLength(before);
    expect((await thread(second.run.id)).some((m) => m.text.includes('under way'))).toBe(true);
    await follow();
    expect(launches()).toHaveLength(before);
    // The first stops: the second's release starts, and the first doesn't go again beside it.
    t3.finish(first.threadId, 'Stopped: beta didn’t become healthy.');
    await follow();
    await follow();
    await follow();
    expect(launches()).toHaveLength(before + 1);
    const started = await fixRow(second.report.id);
    expect(started?.release).toMatchObject({ attempt: 1, threadId: expect.any(String) });
    expect(started?.release?.threadId).not.toBe(first.threadId);
    expect(started?.release?.behind).toBeUndefined();
    expect((await fixRow(first.report.id))?.release).toMatchObject({ stoppedAt: expect.any(String) });
    // Production then runs both fixes: both are live.
    await deploy(prod, '0.1.204', 'production');
    await follow();
    expect((await fixRow(first.report.id))?.state).toBe('live');
    expect((await fixRow(second.report.id))?.state).toBe('live');
    await w.ok(IDS.mara, deleteAutomation, { automationId: first.id });
  });

  it('a fix that waits for another release is live without a release of its own when production then has it', async () => {
    const first = await releasing('Exports skip Mondays', '0.1.205');
    const before = launches().length;
    const second = await liveOnDevelopment('Exports skip Tuesdays', '0.1.206', first.id);
    expect(second.fix?.release).toMatchObject({ behind: first.fix?.id });
    t3.finish(first.threadId, 'Released: 0.1.206 is live on production.');
    await deploy(prod, '0.1.206', 'production');
    await follow();
    await follow();
    expect((await fixRow(first.report.id))?.state).toBe('live');
    expect((await fixRow(second.report.id))?.state).toBe('live');
    expect(launches()).toHaveLength(before);
    expect(prod.posts.slice(second.posts).filter((p) => p.body.status === 'available')).toHaveLength(2);
    await w.ok(IDS.mara, deleteAutomation, { automationId: first.id });
  });

  it('a fix waits for the same reporter’s other reports still being fixed, and one release takes them all', async () => {
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const before = launches().length;
    // A: fixed and merged. B: its pull request open. C: its run still assessing.
    const a = await reportRun(id, prod, prodId, { title: 'Holidays vanish' });
    await assess(a.run.id, bug());
    const aPr = await fixIt(a.run.id, a.report.number);
    await merge(aPr.pr.number);
    const b = await reportRun(id, prod, prodId, { title: 'Holidays double' });
    await assess(b.run.id, bug());
    const bPr = await fixIt(b.run.id, b.report.number);
    const c = await reportRun(id, prod, prodId, { title: 'Holidays in the wrong month' });
    await follow();
    await deploy(dev, '0.1.207', 'development');
    await follow();
    const held = await fixRow(a.report.id);
    expect(held).toMatchObject({ state: 'development', developmentVersion: '0.1.207' });
    expect(held?.release).toMatchObject({ held: true });
    expect(held?.release?.threadId).toBeUndefined();
    expect(launches()).toHaveLength(before);
    const aSaid = async () => (await thread(a.run.id)).map((m) => m.text).join('\n');
    expect(await aSaid()).toContain(`#${b.report.number} and #${c.report.number}`);
    // C's run now waits for the person's yes: only B is being fixed. Then B is merged and development runs it.
    await assess(c.run.id, bug());
    await follow();
    expect(launches()).toHaveLength(before);
    await merge(bPr.pr.number);
    await follow();
    await deploy(dev, '0.1.208', 'development');
    await follow();
    await follow();
    // One release, B's, for what development runs: it takes A along.
    expect(launches()).toHaveLength(before + 1);
    const releasing = await fixRow(b.report.id);
    expect(releasing?.release).toMatchObject({ threadId: expect.any(String) });
    expect((await fixRow(a.report.id))?.release).toMatchObject({ behind: releasing?.id });
    expect(await aSaid()).toContain(`#${b.report.number}’s fix`);
    t3.finish(releasing?.release?.threadId as string, 'Released: 0.1.208 is live on production.');
    await deploy(prod, '0.1.208', 'production');
    await follow();
    await follow();
    expect((await fixRow(a.report.id))?.state).toBe('live');
    expect((await fixRow(b.report.id))?.state).toBe('live');
    expect(launches()).toHaveLength(before + 1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a fix waits two hours at most for the reporter’s other reports, then goes alone', async () => {
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const before = launches().length;
    const a = await reportRun(id, prod, prodId, { title: 'Invoices round down' });
    await assess(a.run.id, bug());
    const aPr = await fixIt(a.run.id, a.report.number);
    await merge(aPr.pr.number);
    await reportRun(id, prod, prodId, { title: 'Invoices round up' });
    await follow();
    await deploy(dev, '0.1.209', 'development');
    await follow();
    expect((await fixRow(a.report.id))?.release).toMatchObject({ held: true });
    w.advance(RELEASE_HOLD_MS - 5 * 60_000);
    await follow();
    expect(launches()).toHaveLength(before);
    w.advance(5 * 60_000);
    await follow();
    expect(launches()).toHaveLength(before + 1);
    expect((await fixRow(a.report.id))?.release).toMatchObject({ threadId: expect.any(String), attempt: 1 });
    expect((await thread(a.run.id)).some((m) => m.text.includes('longer than two hours'))).toBe(true);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a stopped release goes again for a newer development revision, or for the same one hours later; three at most', async () => {
    const { id, report, run, posts, fix, threadId } = await releasing('Reports lose their filter', '0.1.185');
    const before = launches().length;
    t3.finish(threadId, 'Stopped: the runtime version wasn’t raised.');
    await follow();
    const first = await fixRow(report.id);
    expect(first?.release).toMatchObject({ stoppedAt: expect.any(String) });
    // Development still runs the same revision: nothing starts for now.
    await follow();
    expect(launches()).toHaveLength(before);
    // Someone mended it and development runs a newer revision with the fix: the release goes again, for that one.
    const revision = await deploy(dev, '0.1.186', 'development');
    await follow();
    expect(launches()).toHaveLength(before + 1);
    expect(String(launches().at(-1)?.args.message)).toContain(revision);
    const second = await fixRow(report.id);
    expect(second).toMatchObject({ state: 'development', developmentVersion: '0.1.186' });
    expect(second?.release).toMatchObject({ revision, attempt: 2 });
    expect(second?.release?.stoppedAt).toBeUndefined();
    expect((await thread(run.id)).some((m) => m.text.includes('trying the production release again'))).toBe(
      true,
    );
    // Stopped for something mended outside the code (the person decided). Unrelated merges reaching development don't
    // use up the last try at once: it goes half a day after the stop, for what development runs then.
    t3.finish(second?.release?.threadId as string, 'Stopped: a check needs John to decide.');
    await follow();
    const later = await deploy(dev, '0.1.187', 'development');
    await follow();
    await follow();
    w.advance(RELEASE_SAME_RETRY_MS);
    await follow();
    expect(launches()).toHaveLength(before + 1);
    w.advance(RELEASE_LAST_RETRY_MS - RELEASE_SAME_RETRY_MS);
    await follow();
    expect(launches()).toHaveLength(before + 2);
    const third = await fixRow(report.id);
    expect(third?.release).toMatchObject({ revision: later, attempt: 3 });
    // A third stop starts nothing more, however development moves.
    t3.finish(third?.release?.threadId as string, 'Stopped: beta didn’t become healthy.');
    await follow();
    await deploy(dev, '0.1.188', 'development');
    await follow();
    w.advance(RELEASE_SAME_RETRY_MS);
    await follow();
    expect(launches()).toHaveLength(before + 2);
    await w.services.background.settle();
    const inbox = await w.services.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `tracker_release:${fix?.id}:%`));
    expect(inbox).toHaveLength(3);
    // The customer heard once that it comes with the next update; production running it still tells them it's live.
    expect(prod.posts.slice(posts).filter((p) => p.body.status === 'awaiting_release')).toHaveLength(1);
    await deploy(prod, '0.1.188', 'production');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a release thread is settled in T3 Code once a newer try replaced it, or its fix is live, and it was quiet two hours', async () => {
    t3.clock = () => w.now();
    const { id, report, threadId } = await releasing('Totals round down', '0.1.210');
    t3.finish(threadId, 'Stopped: beta didn’t become healthy.');
    await follow();
    // Someone mended it: development runs a newer revision with the fix, and the release goes again in a new thread.
    await deploy(dev, '0.1.211', 'development');
    await follow();
    const second = await fixRow(report.id);
    const next = second?.release?.threadId as string;
    expect(next).toBeTruthy();
    expect(next).not.toBe(threadId);
    expect(second?.release?.earlier).toEqual([expect.objectContaining({ threadId })]);
    // The replaced thread is settled only once it has been quiet two hours: settling stops what it left running.
    await follow();
    expect(t3.threads.get(threadId)?.settled).toBe(false);
    w.advance(T3_SETTLE_QUIET_MS);
    await follow();
    expect(t3.threads.get(threadId)?.settled).toBe(true);
    expect((await fixRow(report.id))?.release?.earlier).toBeUndefined();
    expect(t3.threads.get(next)?.settled).toBe(false);
    // The new try releases it and production runs it: its thread is settled two quiet hours later, and once only.
    t3.finish(next, 'Released: 0.1.211 is live on production.');
    await deploy(prod, '0.1.211', 'production');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');
    expect(t3.threads.get(next)?.settled).toBe(false);
    w.advance(T3_SETTLE_QUIET_MS);
    await follow();
    expect(t3.threads.get(next)?.settled).toBe(true);
    expect((await fixRow(report.id))?.release?.settledAt).toEqual(expect.any(String));
    const settles = () =>
      t3.calls.filter((c) => c.name === 't3_thread_organize' && c.args.threadId === next).length;
    const once = settles();
    w.advance(T3_SETTLE_QUIET_MS);
    await follow();
    expect(settles()).toBe(once);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a reporter’s fix that changes only what has a release of its own tells the person no release starts', async () => {
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title: 'The installer hangs' });
    await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
    const { pr } = await fixIt(run.id, report.number);
    const fakePr = fake().repos.get(REPO)?.prs.get(pr.number);
    if (fakePr) fakePr.files = [{ path: 'agent/src/installer.rs', add: 4, del: 1 }];
    const before = launches().length;
    await merge(pr.number);
    await follow();
    const fix = await fixRow(report.id);
    expect(fix?.state).toBe('stopped');
    await w.services.background.settle();
    const told = await w.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `tracker_release_apart:${fix?.id}`));
    expect(told).toHaveLength(1);
    expect(launches()).toHaveLength(before);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a reporter’s fix to that part alone is released like any other once production says what it offers of it', async () => {
    dev.health = { ...dev.health, environment: 'development' };
    prod.health = {
      ...prod.health,
      device_release_version: '2.2.0',
      device_source_revision: await deploy(prod, '0.1.197', 'production'),
    };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title: 'The installer screen is blank' });
    await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
    const { pr } = await fixIt(run.id, report.number);
    const fakePr = fake().repos.get(REPO)?.prs.get(pr.number);
    if (fakePr) fakePr.files = [{ path: 'agent/src/installer.rs', add: 4, del: 1 }];
    const before = launches().length;
    await merge(pr.number);
    await follow();
    const posts = prod.posts.length;
    await deploy(dev, '0.1.198', 'development');
    await follow();
    const fix = await fixRow(report.id);
    expect(fix).toMatchObject({ state: 'development', separate: 'only' });
    await w.services.background.settle();
    expect(
      await w.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupKey, `tracker_release_apart:${fix?.id}`)),
    ).toHaveLength(0);
    // Its release starts, and is told to bring out that part too.
    expect(launches()).toHaveLength(before + 1);
    expect(String(launches().at(-1)?.args.message)).toContain('`agent/`');
    // Production runs the release, and offers the part with the fix: the customer hears it is ready for them.
    t3.finish(fix?.release?.threadId as string, 'Released: 0.1.199 is live on production.');
    const revision = await deploy(prod, '0.1.199', 'production');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('development');
    prod.health = { ...prod.health, device_release_version: '2.2.1', device_source_revision: revision };
    await follow();
    expect(await fixRow(report.id)).toMatchObject({ state: 'live', productionVersion: '0.1.199' });
    const told = prod.posts.slice(posts);
    expect(told).toHaveLength(1);
    expect(told[0]?.body.message).toContain('klaar voor je computers');
    expect(told[0]?.body.message).toContain('‘Nu bijwerken’');
    delete prod.health.device_release_version;
    delete prod.health.device_source_revision;
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a release that couldn’t start is tried again without using up a try', async () => {
    const projects = t3.knobs.projects;
    t3.knobs.projects = [];
    try {
      dev.health = { ...dev.health, environment: 'development' };
      const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
      await poll(prodId);
      const { report, run } = await reportRun(id, prod, prodId, { title: 'Timetable prints blank' });
      await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
      const { pr } = await fixIt(run.id, report.number);
      await merge(pr.number);
      await follow();
      const before = launches().length;
      await deploy(dev, '0.1.190', 'development');
      await follow();
      const fix = await fixRow(report.id);
      expect(fix?.release).toMatchObject({ attempt: 1, stoppedAt: expect.any(String) });
      expect(fix?.release?.threadId).toBeUndefined();
      // T3 Code is still without the project half an hour on: tried again, still the first try, the person told once.
      w.advance(RELEASE_START_RETRY_MS);
      await follow();
      expect((await fixRow(report.id))?.release?.attempt).toBe(1);
      // T3 Code has it again: the first real release starts.
      t3.knobs.projects = projects;
      w.advance(RELEASE_START_RETRY_MS);
      await follow();
      expect(launches().length).toBeGreaterThan(before);
      expect((await fixRow(report.id))?.release).toMatchObject({ attempt: 1, threadId: expect.any(String) });
      await w.services.background.settle();
      const told = await w.services.db
        .select()
        .from(notifications)
        .where(like(notifications.dedupKey, `tracker_release_start:${fix?.id}:%`));
      expect(told).toHaveLength(1);
      await w.ok(IDS.mara, deleteAutomation, { automationId: id });
    } finally {
      t3.knobs.projects = projects;
    }
  });

  it('a release thread that went quiet is asked where it stands; one that then doesn’t move has stopped', async () => {
    const { id, report, fix, threadId } = await releasing('Calendar shows the wrong week', '0.1.189');
    const sends = () => t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === threadId);
    // Its turn ends while it waits for the checks.
    t3.finish(threadId, 'Waiting for the checks.');
    await follow();
    await follow();
    expect(sends()).toHaveLength(0);
    w.advance(RELEASE_QUIET_MS);
    await follow();
    expect(sends()).toHaveLength(1);
    expect(String(sends()[0]?.args.message)).toContain('Stopped:');
    // It answers and waits again: still going, and asked again only after another quiet spell.
    t3.finish(threadId, 'Still waiting for the checks; they are halfway.');
    await follow();
    await follow();
    expect(sends()).toHaveLength(1);
    expect((await fixRow(report.id))?.release?.stoppedAt).toBeUndefined();
    w.advance(RELEASE_QUIET_MS);
    await follow();
    expect(sends()).toHaveLength(2);
    // This time T3 Code took the question (it says the thread is at work) but nothing more came: it has stopped.
    await follow();
    expect((await fixRow(report.id))?.release?.stoppedAt).toBeUndefined();
    w.advance(RELEASE_NUDGE_ANSWER_MS);
    await follow();
    expect(sends()).toHaveLength(2);
    expect((await fixRow(report.id))?.release).toMatchObject({
      stoppedAt: expect.any(String),
      why: expect.stringContaining('didn’t answer'),
    });
    await w.services.background.settle();
    const inbox = await w.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `tracker_release:${fix?.id}:1`));
    expect(inbox).toHaveLength(1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a release thread at work that doesn’t move for 90 minutes tells the person once, and is followed on', async () => {
    const { id, report, fix, threadId } = await releasing('Seating plan is empty', '0.1.191');
    const stub = t3.threads.get(threadId);
    expect(stub?.status).toBe('running');
    await follow();
    w.advance(RELEASE_SLOW_MS);
    await follow();
    await follow();
    await w.services.background.settle();
    const slow = await w.services.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `tracker_release_slow:${fix?.id}:%`));
    expect(slow).toHaveLength(1);
    expect((await fixRow(report.id))?.release?.stoppedAt).toBeUndefined();
    // Not asked: it is at work, not between turns.
    expect(t3.calls.filter((c) => c.name === 't3_thread_send' && c.args.threadId === threadId)).toHaveLength(
      0,
    );
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a release thread that keeps moving but runs three hours tells the person once, and is followed on', async () => {
    const { id, report, fix, threadId } = await releasing('Printers list is empty', '0.1.193');
    for (let i = 0; i < 4; i++) {
      t3.step(threadId, { type: 'command_execution', text: '$ release status' });
      w.advance(50 * 60_000);
      await follow();
    }
    await w.services.background.settle();
    const slow = await w.services.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `tracker_release_slow:${fix?.id}:%`));
    expect(slow).toHaveLength(1);
    expect((await fixRow(report.id))?.release?.stoppedAt).toBeUndefined();
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a release whose T3 Code thread is gone has stopped', async () => {
    const { id, report, threadId } = await releasing('Rooms list repeats itself', '0.1.192');
    expect(threadId.startsWith('mcp:thread-')).toBe(true);
    t3.threads.delete(threadId);
    await follow();
    expect((await fixRow(report.id))?.release).toMatchObject({
      stoppedAt: expect.any(String),
      why: expect.stringContaining('gone'),
    });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a reporter’s fix development doesn’t run 90 minutes after its merge reaches the person', async () => {
    dev.health = { ...dev.health, environment: 'development' };
    const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(prodId);
    const { report, run } = await reportRun(id, prod, prodId, { title: 'Holidays are missing' });
    await assess(run.id, bug({ language: 'nl', reply: 'Bedankt voor je melding. We kijken ernaar.' }));
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    const fix = await fixRow(report.id);
    expect(fix?.state).toBe('merged');
    await w.services.db
      .update(trackerFixes)
      .set({ mergedAt: w.now() })
      .where(eq(trackerFixes.id, fix?.id as string));
    const notLive = () =>
      w.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupKey, `tracker_not_live:${fix?.id}`));
    w.advance(60 * 60_000);
    await follow();
    await w.services.background.settle();
    expect(await notLive()).toHaveLength(0);
    w.advance(31 * 60_000);
    await follow();
    await follow();
    await w.services.background.settle();
    expect(await notLive()).toHaveLength(1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('releaseFor "*" releases a merged bug fix straight from merge when development does not auto-deploy', async () => {
    const [origConn] = await w.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, prodId));
    await w.services.db
      .update(catalogConnections)
      .set({ fields: { ...origConn?.fields, releaseFor: '*' } })
      .where(eq(catalogConnections.id, prodId));
    try {
      dev.health = { ...dev.health, environment: 'development' };
      const id = await recipe(prodId, { repo: REPO, fix: { mode: 'ask' } });
      await poll(prodId);
      const { report, run } = await reportRun(id, prod, prodId, {
        title: 'Tailscale installer uses home address',
        reporter: { name: 'Anonymous', email: null },
      });
      await assess(run.id, bug({ language: 'en', reply: 'Thanks for reporting this.' }));
      const { pr } = await fixIt(run.id, report.number);
      const before = launches().length;
      const posts = prod.posts.length;
      await merge(pr.number);
      await follow();
      const merged = await fixRow(report.id);
      expect(merged?.state).toBe('merged');
      // Within the grace window, development gets a chance to deploy on its own first.
      expect(launches()).toHaveLength(before);
      await w.services.db
        .update(trackerFixes)
        .set({ mergedAt: w.now() })
        .where(eq(trackerFixes.id, merged?.id as string));
      w.advance(RELEASE_DEV_GRACE_MS);
      await follow();
      // Still not on development after the grace period: Whombat starts the release from the merged commit.
      expect(launches()).toHaveLength(before + 1);
      const releasingFix = await fixRow(report.id);
      expect(releasingFix?.state).toBe('merged');
      expect(releasingFix?.release?.threadId).toBeTruthy();
      expect(prod.posts.slice(posts)).toEqual([]);
      const launchBrief = String(launches().at(-1)?.args.message);
      expect(launchBrief).toContain('does not run this fix yet');
      expect(launchBrief).toContain('Released:');
      // Once the release deploys Beta/development, the fix advances to `development` keeping the running release
      // without launching a second one or prematurely telling the customer it comes with the next update.
      await deploy(dev, '0.1.220', 'development');
      await follow();
      const onDev = await fixRow(report.id);
      expect(onDev?.state).toBe('development');
      expect(onDev?.release?.threadId).toBe(releasingFix?.release?.threadId);
      expect(launches()).toHaveLength(before + 1);
      expect(prod.posts.slice(posts)).toEqual([]);
      // Once Production runs the fix, the customer hears it is live.
      t3.finish(releasingFix?.release?.threadId as string, 'Released: 0.1.220 is live on production.');
      await deploy(prod, '0.1.220', 'production');
      await follow();
      expect((await fixRow(report.id))?.state).toBe('live');
      expect(prod.posts.slice(posts)).toHaveLength(1);
      expect(prod.posts.slice(posts)[0]?.body).toMatchObject({ status: 'available' });
      await w.ok(IDS.mara, deleteAutomation, { automationId: id });
    } finally {
      await w.services.db
        .update(catalogConnections)
        .set({ fields: origConn?.fields ?? {} })
        .where(eq(catalogConnections.id, prodId));
    }
  });
});

describe('the customer writes back (TA-31)', () => {
  it('starts a run in the report’s thread with what they wrote; history starts nothing', async () => {
    const id = await recipe(devId);
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Rollout never finishes' });
    await assess(
      run.id,
      bug({ kind: 'question', reply: 'Which devices does it happen on?', replyAsks: true }),
    );
    // Newer reports push it down the list: the poller reads as far as the lowest report it watches (TA-31).
    file(dev, { title: 'Newer one' });
    file(dev, { title: 'Newest one' });
    await poll(devId);
    for (const r of (await w.runs(id)).slice(-2)) await assess(r.id, bug({ reply: '' }));
    const runs = (await w.runs(id)).length;
    dev.pageSize = 1;

    dev.reporterWrites(report.id, 'It stops at 40% on Lab PC 1 and Lab PC 2.');
    await poll(devId);
    dev.pageSize = 50;
    const all = await w.runs(id);
    expect(all.length).toBe(runs + 1);
    const answer = all.at(-1) as AutomationRun;
    expect(answer.trigger.summary).toBe(
      `The customer wrote back on Acme dev #${report.number} “Rollout never finishes”: “It stops at 40% on Lab PC 1 and Lab PC 2.”`,
    );
    const row = await loadRunRow(w.services.db, answer.id);
    expect(row.threadRootId).toBe((await loadRunRow(w.services.db, run.id)).threadRootId);
    expect(row.scope).toMatchObject({
      kind: 'tracker',
      event: 'reporter_replied',
      reportId: report.id,
      number: report.number,
      host: DEV_HOST,
    });
    // The signed event names no customer words.
    const { events } = await import('../db/schema/index');
    const [signed] = await w.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'tracker.reporter_replied'))
      .orderBy(asc(events.seq));
    expect(JSON.stringify(signed?.payload)).not.toContain('Lab PC');

    // Still happening: another run, in the same thread.
    await assess(answer.id, bug({ reply: 'Thanks, that helps. We are looking into it.' }));
    dev.reporterWrites(report.id, 'This still happens. Please investigate again.', 'new');
    await poll(devId);
    const again = (await w.runs(id)).at(-1) as AutomationRun;
    expect(again.trigger.summary).toMatch(/^The customer says it still happens on Acme dev #\d+ /);
    expect((await loadRunRow(w.services.db, again.id)).threadRootId).toBe(row.threadRootId);
    await assess(again.id, bug({ reply: '' }));

    // A report first seen now (from before this version): its baseline, nothing fires.
    await w.services.db
      .update(trackerItems)
      .set({ seenStatus: null, seenUpdatedAt: null, seenReporterMessages: null, seenReporterAt: null })
      .where(eq(trackerItems.externalId, report.id));
    dev.reporterWrites(report.id, 'Any news?');
    const before = (await w.runs(id)).length;
    await poll(devId);
    expect((await w.runs(id)).length).toBe(before);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('a customer’s answer on a report being fixed (TA-70)', () => {
  const latest = async (id: string) => (await w.runs(id)).at(-1) as AutomationRun;

  it('doesn’t start a second fix while one is under way, nor ask again after it went live; “Still happening” does', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Battery level shows 0%' });
    await assess(run.id, bug());
    // The fix is approved and at work.
    const { approval } = await card(step(await w.run(run.id), 'approve').approvalId as string);
    await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    await w.settle();
    expect(step(await w.run(run.id), 'fix').state).toBe('waiting');

    // “Any news?” meanwhile: answered, and no second fix or card.
    dev.reporterWrites(report.id, 'Any news on this?');
    await poll(devId);
    let answer = await latest(id);
    expect(answer.id).not.toBe(run.id);
    answer = await assess(answer.id, bug({ reply: 'We are working on it and will let you know.' }));
    expect(step(answer, 'worth_fixing').output).toMatchObject({ result: false });
    expect(step(answer, 'approve').approvalId ?? null).toBeNull();
    expect(step(answer, 'fix').state).toBe('skipped');

    // The first fix lands and goes live.
    const branch = `feat/${(await loadRunRow(w.services.db, run.id)).scope.ref as string}`;
    await w.fakePush(REPO, branch, 'Show the battery level again');
    await w.fakeAgentReply(step(await w.run(run.id), 'fix').dispatchId as string, 'Fixed.');
    await w.settle();
    await w.fakeAgentReply(
      step(await w.run(run.id), 'review').dispatchId as string,
      'Approve: a test covers it.',
    );
    await w.settle();
    const [pr] = await w.services.db.select().from(pullRequests).where(eq(pullRequests.branch, branch));
    await merge(pr?.number as number);
    await follow();
    await deploy(dev, '0.1.193');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');

    // “Works, thanks”, typed: no card for a bug that needs nothing new.
    dev.reporterWrites(report.id, 'Works now, thanks!');
    await poll(devId);
    answer = await assess((await latest(id)).id, bug({ recommends: 'nothing', reply: 'Glad it works.' }));
    expect(step(answer, 'worth_fixing').output).toMatchObject({ result: false });
    expect(step(answer, 'approve').approvalId ?? null).toBeNull();

    // “Still happening” reopens it: the fix chain goes on (here, its card).
    dev.reporterWrites(report.id, 'It is back after the update.', 'new');
    await poll(devId);
    answer = await assess((await latest(id)).id, bug());
    expect(step(answer, 'worth_fixing').output).toMatchObject({ result: true });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('doesn’t try again by itself after an earlier fix didn’t land: that one waits for the person', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Sound stops after sleep' });
    await assess(run.id, bug());
    const { approval } = await card(step(await w.run(run.id), 'approve').approvalId as string);
    await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    await w.settle();
    const branch = `feat/${(await loadRunRow(w.services.db, run.id)).scope.ref as string}`;
    await w.fakePush(REPO, branch, 'Keep sound after sleep');
    await w.fakeAgentReply(
      step(await w.run(run.id), 'fix').dispatchId as string,
      'Pushed, but see the review.',
    );
    await w.settle();
    await w.fakeAgentReply(
      step(await w.run(run.id), 'review').dispatchId as string,
      'Changes needed: the test passes on main too.',
    );
    await w.settle();
    expect(step(await w.run(run.id), 'pr').state).not.toBe('succeeded');

    dev.reporterWrites(report.id, 'Any news on the sound?');
    await poll(devId);
    const answer = await assess(
      ((await w.runs(id)).at(-1) as AutomationRun).id,
      bug({ reply: 'We are still looking into it.' }),
    );
    expect(step(answer, 'worth_fixing').output).toMatchObject({ result: false });
    expect(step(answer, 'approve').approvalId ?? null).toBeNull();
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('holds a second fix decision while the first one waits on its card', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Clock shows the wrong time zone' });
    await assess(run.id, bug());
    // The first run decided to fix it and waits for the person's yes.
    expect(step(await w.run(run.id), 'approve').state).toBe('waiting');
    dev.reporterWrites(report.id, 'Is there any news?');
    await poll(devId);
    const answer = await assess(
      ((await w.runs(id)).at(-1) as AutomationRun).id,
      bug({ reply: 'We are working on it.' }),
    );
    expect(step(answer, 'worth_fixing').output).toMatchObject({ result: false });
    expect(step(answer, 'approve').approvalId ?? null).toBeNull();
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a newer fix that didn’t land counts, not an older one that went live', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Volume resets at login' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    await deploy(dev, '0.1.194');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');

    // A further problem, typed: a second fix is made, and no review approves it.
    dev.reporterWrites(report.id, 'Now the volume resets after sleep too.');
    await poll(devId);
    const second = await assess(((await w.runs(id)).at(-1) as AutomationRun).id, bug());
    expect(step(second, 'worth_fixing').output).toMatchObject({ result: true });
    const { approval } = await card(step(second, 'approve').approvalId as string);
    await w.ok(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    await w.settle();
    const branch = `feat/${(await loadRunRow(w.services.db, second.id)).scope.ref as string}`;
    await w.fakePush(REPO, branch, 'Keep the volume after sleep');
    await w.fakeAgentReply(step(await w.run(second.id), 'fix').dispatchId as string, 'Pushed.');
    await w.settle();
    await w.fakeAgentReply(
      step(await w.run(second.id), 'review').dispatchId as string,
      'Changes needed: it breaks the login volume.',
    );
    await w.settle();

    // Another answer: the newer attempt didn't land, so it waits for the person — no third fix by itself.
    dev.reporterWrites(report.id, 'Any news about the sleep problem?');
    await poll(devId);
    const third = await assess(((await w.runs(id)).at(-1) as AutomationRun).id, bug());
    expect(step(third, 'worth_fixing').output).toMatchObject({ result: false });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('after “Still happening” that brought no fix, a typed answer is judged by the landed fix, not held as unlanded', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Bluetooth mouse lags' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    await deploy(dev, '0.1.195');
    await follow();
    expect((await fixRow(report.id))?.state).toBe('live');
    // “Still happening”, but what still happens isn't clear yet: no fix, a question back.
    dev.reporterWrites(report.id, 'Still happening.', 'new');
    await poll(devId);
    await assess(
      ((await w.runs(id)).at(-1) as AutomationRun).id,
      bug({ kind: 'unclear', recommends: 'nothing', reply: 'Which mouse is it?', replyAsks: true }),
    );
    // A typed answer that calls for no change: held, as its fix landed — not “waits for you”.
    dev.reporterWrites(report.id, 'A Logitech one.');
    await poll(devId);
    const answer = await assess(
      ((await w.runs(id)).at(-1) as AutomationRun).id,
      bug({ recommends: 'nothing', reply: 'Thanks, we are looking at it.' }),
    );
    expect(step(answer, 'worth_fixing').output).toMatchObject({ result: false });
    expect(JSON.stringify(step(answer, 'worth_fixing').output)).not.toContain('waits for you');
    // One that calls for a change goes on.
    dev.reporterWrites(report.id, 'It lags only on battery.');
    await poll(devId);
    const next = await assess(((await w.runs(id)).at(-1) as AutomationRun).id, bug());
    expect(step(next, 'worth_fixing').output).toMatchObject({ result: true });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('a merged fix development doesn’t run hours later (TA-61)', () => {
  it('reaches the person once, only after what development runs was looked at', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Filters reset on reload' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    const fix = await fixRow(report.id);
    expect(fix?.state).toBe('merged');
    // The fake GitHub dates its merge by the wall clock; the world's clock is the one that moves here.
    await w.services.db
      .update(trackerFixes)
      .set({ mergedAt: w.now() })
      .where(eq(trackerFixes.id, fix?.id as string));
    const notLive = () =>
      w.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupKey, `tracker_not_live:${fix?.id}`));
    // Development still runs an older revision six hours on: the person hears, once.
    w.advance(7 * 60 * 60_000);
    await follow();
    await follow();
    await w.services.background.settle();
    expect(await notLive()).toHaveLength(1);
    expect((await notLive())[0]).toMatchObject({ kind: 'needs_you' });
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('reaches the person too when GitHub keeps erring on whether development runs it', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Icons are blurry on 4K screens' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    const fix = await fixRow(report.id);
    await w.services.db
      .update(trackerFixes)
      .set({ mergedAt: w.now() })
      .where(eq(trackerFixes.id, fix?.id as string));
    await deploy(dev, '0.1.185');
    const github = fake();
    const real = github.compareStatus.bind(github);
    github.compareStatus = async () => {
      throw new Error('GitHub answered 503');
    };
    try {
      w.advance(7 * 60 * 60_000);
      await follow();
      await follow();
      await w.services.background.settle();
    } finally {
      github.compareStatus = real;
    }
    expect((await fixRow(report.id))?.state).toBe('merged');
    const rows = await w.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `tracker_not_live:${fix?.id}`));
    expect(rows).toHaveLength(1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('reaches the person too when GitHub keeps erring about the merged pull request', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Wi-Fi list is empty after login' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    const github = fake();
    const real = github.getPullRequest.bind(github);
    try {
      await merge(pr.number);
      // The fake GitHub dates its merge by the wall clock; the world's clock is the one that moves here.
      await w.services.db.update(pullRequests).set({ mergedAt: w.now() }).where(eq(pullRequests.id, pr.id));
      github.getPullRequest = async () => {
        throw new Error('GitHub answered 502');
      };
      const fix = await fixRow(report.id);
      await follow();
      expect((await fixRow(report.id))?.state).toBe('open');
      w.advance(7 * 60 * 60_000);
      await follow();
      await follow();
      await w.services.background.settle();
      const rows = await w.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupKey, `tracker_not_live:${fix?.id}`));
      expect(rows).toHaveLength(1);
    } finally {
      github.getPullRequest = real;
    }
    // GitHub answers again: the fix moves on.
    await follow();
    expect((await fixRow(report.id))?.state).toBe('merged');
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('says nothing when development turns out to run it', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Totals round wrong' });
    await assess(run.id, bug());
    const { pr } = await fixIt(run.id, report.number);
    await merge(pr.number);
    await follow();
    const fix = await fixRow(report.id);
    await w.services.db
      .update(trackerFixes)
      .set({ mergedAt: w.now() })
      .where(eq(trackerFixes.id, fix?.id as string));
    // Whombat away for hours; development deployed it meanwhile.
    w.advance(7 * 60 * 60_000);
    await deploy(dev, '0.1.182');
    await follow();
    await w.services.background.settle();
    expect((await fixRow(report.id))?.state).toBe('live');
    const rows = await w.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `tracker_not_live:${fix?.id}`));
    expect(rows).toHaveLength(0);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('the live notice the tracker doesn’t take', () => {
  it('a report that changed under it twice is told on the next pass; one the tracker refuses reaches the person once', async () => {
    const id = await recipe(devId, { repo: REPO, fix: { mode: 'ask' } });
    await poll(devId);
    const notTold = (fixId: string | undefined) =>
      w.services.db
        .select()
        .from(notifications)
        .where(eq(notifications.dedupKey, `tracker_not_told:${fixId}:development`));

    // Two 409s in a row: not told yet, still followed, nobody bothered; the next pass tells the customer.
    const first = await reportRun(id, dev, devId, { title: 'Columns lose their width' });
    await assess(first.run.id, bug());
    const one = await fixIt(first.run.id, first.report.number);
    await merge(one.pr.number);
    await follow();
    await deploy(dev, '0.1.190');
    dev.conflictsLeft = 2;
    await follow();
    await w.services.background.settle();
    const waiting = await fixRow(first.report.id);
    expect(waiting?.state).toBe('merged');
    expect(await notTold(waiting?.id)).toHaveLength(0);
    await follow();
    expect((await fixRow(first.report.id))?.state).toBe('live');
    expect(dev.reports.get(first.report.id)?.status).toBe('available');

    // The tracker refuses it outright: the thread says so and the person's Inbox has it, once.
    const second = await reportRun(id, dev, devId, { title: 'Search ignores accents' });
    await assess(second.run.id, bug());
    const two = await fixIt(second.run.id, second.report.number);
    await merge(two.pr.number);
    await follow();
    await deploy(dev, '0.1.191');
    dev.refuse = 'This report can’t be changed any more.';
    await follow();
    await w.services.background.settle();
    dev.refuse = null;
    const refused = await fixRow(second.report.id);
    expect(refused?.state).toBe('live');
    const rows = await notTold(refused?.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'needs_you' });
    expect(rows[0]?.text).toContain(`#${second.report.number}`);
    await follow();
    await w.services.background.settle();
    expect(await notTold(refused?.id)).toHaveLength(1);

    // The tracker errs on every notice while it runs the fix: nothing for the person at first, once after an hour of it,
    // and the customer is still told once it answers again.
    const third = await reportRun(id, dev, devId, { title: 'Sorting by date is reversed' });
    await assess(third.run.id, bug());
    const three = await fixIt(third.run.id, third.report.number);
    await merge(three.pr.number);
    await follow();
    await deploy(dev, '0.1.192');
    dev.postsDown = 500;
    await follow();
    await w.services.background.settle();
    const erring = await fixRow(third.report.id);
    expect(erring?.state).toBe('merged');
    expect(await notTold(erring?.id)).toHaveLength(0);
    w.advance(60 * 60_000);
    await follow();
    await follow();
    await w.services.background.settle();
    expect(await notTold(erring?.id)).toHaveLength(1);
    dev.postsDown = null;
    await follow();
    expect((await fixRow(third.report.id))?.state).toBe('live');
    expect(dev.reports.get(third.report.id)?.status).toBe('available');
    expect(await notTold(erring?.id)).toHaveLength(1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});

describe('a watched report deeper than a cycle reads (TA-31)', () => {
  it('is read on its own, so the customer’s answer there starts a run', async () => {
    const id = await recipe(devId);
    await poll(devId);
    const { report, run } = await reportRun(id, dev, devId, { title: 'Printers vanish after a reboot' });
    await assess(
      run.id,
      bug({ kind: 'question', reply: 'Which printers does it happen with?', replyAsks: true }),
    );
    // Seven newer reports, one to a page: the watched one sits past the pages a cycle reads.
    for (let i = 0; i < 7; i++) file(dev, { title: `A newer report ${i + 1}` });
    await poll(devId);
    dev.pageSize = 1;
    const replied = async () =>
      (await w.runs(id)).filter((r) =>
        (r as AutomationRun & { trigger: { event?: string } }).trigger.summary?.includes('wrote back'),
      );
    try {
      dev.reporterWrites(report.id, 'The HP printers in room 12.');
      // The deeper ones are read ten a cycle in turn (more watched reports, more cycles until its turn).
      for (let i = 0; i < 8 && !(await replied()).length; i++) await poll(devId);
    } finally {
      dev.pageSize = 50;
    }
    expect((await replied()).length).toBeGreaterThanOrEqual(1);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });
});
