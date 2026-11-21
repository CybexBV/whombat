/**
 * The Automations list at a glance (docs/decisions/automation-list.md AL-S01…AL-S08, contracts CT-328), on a real
 * database with the in-memory FakeGitHub: `glance` named per viewer (REST and realtime frames), `recentRuns` with
 * `waitingOn` for the whole list, the list's `canManage`, and `github.avatar` only for owners the burrow has a reason to
 * show, to its members only.
 */
import {
  type AutomationDefinitionInput,
  type AutomationRecipeInput,
  api,
  newId,
  recipeInstructions,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { accounts, approvals, automationRuns } from '../db/schema/index';
import { FAKE_AVATAR_PNG, type FakeGitHub } from '../github/fake';
import { inProcessApi, TEST_ACCOUNT_COOKIE } from '../test/api';
import { IDS, useAutomationWorld } from '../test/automations';
import { sessionFor } from '../test/tokens';
import { createAutomation, deleteAutomation, runAutomationNow, saveAutomationDraft } from './commands';
import { loadAutomationRow, loadRunRow, toAutomation } from './store';

const w = useAutomationWorld();
const REPO = 'whombat/billing';
const caller = inProcessApi(() => w.services);
const cookies = new Map<string, string>();
let outsider = '';

beforeAll(async () => {
  cookies.set(IDS.mara, (await sessionFor(w.services, IDS.mara)).cookie);
  // Someone signed in to this Whombat who isn't in the burrow.
  const accountId = newId('account');
  await w.services.db
    .insert(accounts)
    .values({ id: accountId, email: 'outsider@example.com', name: 'Outsider', createdAt: w.now() });
  outsider = `${TEST_ACCOUNT_COOKIE}=${accountId}`;
});

async function get(path: string, cookie: string) {
  return caller.inject({ method: 'GET', url: `/api/v1/burrows/burrow-hq${path}`, headers: { cookie } });
}

/** The Automations list as `who` sees it. */
async function list(who: string) {
  const res = await get('/automations', cookies.get(who) ?? '');
  expect(res.statusCode).toBe(200);
  return api.automations.list.response.parse(res.json());
}

async function listed(id: string, who: string = IDS.mara) {
  const automation = (await list(who)).automations.find((a) => a.id === id);
  if (!automation) throw new Error(`${id} isn't listed`);
  return automation;
}

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

const def = (steps: AutomationDefinitionInput['steps'], extra: Partial<AutomationDefinitionInput> = {}) =>
  ({
    version: 1,
    conversationId: IDS.billing,
    triggers: [{ kind: 'manual' }],
    steps,
    ...extra,
  }) as AutomationDefinitionInput;

/** A recipe made and published in one go by Mara. */
async function recipe(r: Partial<AutomationRecipeInput> & Pick<AutomationRecipeInput, 'when' | 'job'>) {
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    source: {
      kind: 'recipe',
      recipe: {
        instructions: recipeInstructions(r.job, r.when),
        conversationId: IDS.incidents,
        ...r,
      },
    },
    publish: true,
  });
  return automationId;
}

/** A draft only (not published), imported by Mara. */
async function draft(definition: AutomationDefinitionInput, name = 'Draft') {
  const { automationId } = await w.ok(IDS.mara, createAutomation, {
    name,
    source: {
      kind: 'import',
      file: {
        whombat: 'automation',
        name,
        description: '',
        definition: JSON.parse(JSON.stringify(definition)),
      },
    },
  });
  return automationId;
}

async function runNow(automationId: string) {
  const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId, test: false });
  return (await loadRunRow(w.services.db, runId as string)).number;
}

describe('glance', () => {
  it('a recipe at a glance: its trigger, agent, room and tags, mildest first', async () => {
    const id = await recipe({
      when: { kind: 'github', repo: REPO, events: ['issue_opened'] },
      job: 'assess',
      replyOnGitHub: true,
      fix: { mode: 'ask' },
    });
    const mara = await listed(id, IDS.mara);
    expect(mara.glance).toEqual({
      source: 'github',
      repo: REPO,
      trigger: 'New issue · billing',
      agentStep: true,
      room: 'incidents',
      does: [
        { id: 'assess', label: 'Assesses', tone: 'plain' },
        { id: 'comment', label: 'Comments on GitHub', tone: 'plain' },
        { id: 'fix_ask', label: 'Fixes after a yes', tone: 'changes' },
      ],
    });
    // The detail says the same as the list.
    const detail = await get(`/automations/${id}`, cookies.get(IDS.mara) ?? '');
    expect(api.automations.get.response.parse(detail.json()).automation.glance).toEqual(mara.glance);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a message recipe names its room, in reads and frames alike', async () => {
    const id = await recipe({ when: { kind: 'message', contains: ['deploy', 'ship it'] }, job: 'answer' });
    const mara = await listed(id, IDS.mara);
    expect(mara.glance).toMatchObject({
      source: 'message',
      repo: null,
      trigger: 'Message with “deploy”…',
      room: 'incidents',
      does: [{ id: 'answer', label: 'Answers', tone: 'plain' }],
    });
    // Realtime: the frame carries it as the list does (one-person.md OP-S69).
    const row = await loadAutomationRow(w.services.db, w.burrowId, id);
    expect((await toAutomation(w.services.db, row)).glance).toEqual(mara.glance);
    await w.ok(IDS.mara, deleteAutomation, { automationId: id });
  });

  it('a step editor’s definition and a valid draft have one; a draft that doesn’t validate has none', async () => {
    const steps = await draft(
      def([
        { id: 'ask', kind: 'dispatch_agent', prompt: 'Check the invoices.' },
        {
          id: 'pr',
          kind: 'open_pull_request',
          repo: REPO,
          branch: 'fix/invoices',
          title: 'Fix the invoices',
        },
      ]),
    );
    expect((await listed(steps)).glance).toEqual({
      source: 'manual',
      repo: null,
      trigger: 'Only when started by hand',
      agentStep: true,
      room: 'billing-v2',
      does: [
        { id: 'agent', label: 'Asks the agent', tone: 'plain' },
        { id: 'open_pr', label: 'Opens a pull request', tone: 'changes' },
      ],
    });
    const { automationId: broken } = await w.ok(IDS.mara, createAutomation, {
      source: { kind: 'blank', conversationId: IDS.billing },
    });
    await w.ok(IDS.mara, saveAutomationDraft, {
      automationId: broken,
      definition: { version: 1, conversationId: IDS.billing, triggers: [] },
    });
    const half = await listed(broken);
    expect(half.draftProblems.length).toBeGreaterThan(0);
    expect(half.glance).toBeNull();
    for (const automationId of [steps, broken]) await w.ok(IDS.mara, deleteAutomation, { automationId });
  });
});

describe('recent runs', () => {
  it('the latest ten of every automation in the list, newest first; lastRun is the newest', async () => {
    const many = await w.publish(def([{ id: 'note', kind: 'post_message', text: 'Done.' }]), {
      name: 'Many',
    });
    const few = await w.publish(def([{ id: 'note', kind: 'post_message', text: 'Done.' }]), { name: 'Few' });
    const none = await w.publish(def([{ id: 'note', kind: 'post_message', text: 'Done.' }]), {
      name: 'None',
    });
    const manyNumbers: number[] = [];
    for (let i = 0; i < 12; i++) {
      manyNumbers.push(await runNow(many));
      w.advance(1000);
    }
    // Made in the same instant: the number decides.
    const fewNumbers = [await runNow(few), await runNow(few)];
    await w.settle();

    const { automations } = await list(IDS.mara);
    const byId = new Map(automations.map((a) => [a.id, a]));
    expect(byId.get(many)?.recentRuns.map((r) => r.number)).toEqual(manyNumbers.slice(-10).reverse());
    expect(byId.get(few)?.recentRuns.map((r) => r.number)).toEqual([...fewNumbers].reverse());
    expect(byId.get(none)?.recentRuns).toEqual([]);
    expect(byId.get(none)?.lastRun).toBeNull();
    for (const id of [many, few]) expect(byId.get(id)?.lastRun).toEqual(byId.get(id)?.recentRuns[0]);
    expect(byId.get(many)?.recentRuns[0]).toMatchObject({ status: 'succeeded', waitingOn: null });

    // One automation's detail says the same as the list.
    const detail = await get(`/automations/${many}`, cookies.get(IDS.mara) ?? '');
    expect(api.automations.get.response.parse(detail.json()).automation.recentRuns).toEqual(
      byId.get(many)?.recentRuns,
    );
    for (const automationId of [many, few, none]) await w.ok(IDS.mara, deleteAutomation, { automationId });
  });

  it('says what a run waits on a person for: a yes, a review, or nothing', async () => {
    const asks = await w.publish(
      def([
        { id: 'approve', kind: 'request_approval', title: 'Go ahead?', details: 'It posts a note.' },
        { id: 'note', kind: 'post_message', text: 'Approved, going on.' },
      ]),
      { name: 'Asks first' },
    );
    const waits = await w.publish(def([{ id: 'pause', kind: 'wait', minutes: 60 }]), { name: 'Waits' });
    await runNow(asks);
    await runNow(waits);
    await w.settle();
    let [asking, waiting] = [await listed(asks), await listed(waits)];
    expect(asking.recentRuns[0]).toMatchObject({ status: 'waiting', waitingOn: 'approval' });
    expect(asking.lastRun).toMatchObject({ status: 'waiting', waitingOn: 'approval' });
    // Waiting on time is nobody's to answer.
    expect(waiting.recentRuns[0]).toMatchObject({ status: 'waiting', waitingOn: null });

    // A yes: it goes on and waits for nobody.
    const runId = asking.recentRuns[0]?.id ?? '';
    const approvalId = (await w.run(runId)).steps[0]?.approvalId ?? '';
    const [approval] = await w.services.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.state).toBe('pending');
    await w.ok(IDS.mara, decideApproval, { number: approval?.number as number, decision: 'approve' });
    await w.settle();
    asking = await listed(asks);
    expect(asking.recentRuns[0]).toMatchObject({ id: runId, status: 'succeeded', waitingOn: null });

    // A run that needs review (a step whose effect is uncertain) waits for a person to look.
    await w.services.db
      .update(automationRuns)
      .set({ status: 'needs_review' })
      .where(eq(automationRuns.id, waiting.recentRuns[0]?.id ?? ''));
    waiting = await listed(waits);
    expect(waiting.recentRuns[0]).toMatchObject({ status: 'needs_review', waitingOn: 'review' });
    for (const automationId of [asks, waits]) await w.ok(IDS.mara, deleteAutomation, { automationId });
  });
});

describe('github.avatar', () => {
  const avatar = (owner: string, cookie: string) => get(`/github/owners/${owner}/avatar`, cookie);
  const PNG_URL = `data:image/png;base64,${FAKE_AVATAR_PNG.toString('base64')}`;

  it('the owner of a burrow repo, any case: the picture as a data URL, fetched once', async () => {
    const reads = fake().avatarReads.length;
    const res = await avatar('whombat', cookies.get(IDS.mara) ?? '');
    expect(res.statusCode).toBe(200);
    expect(api.github.avatar.response.parse(res.json())).toEqual({ owner: 'whombat', image: PNG_URL });
    const again = await avatar('WhOmBaT', cookies.get(IDS.mara) ?? '');
    expect(again.json()).toEqual({ owner: 'WhOmBaT', image: PNG_URL });
    expect(fake().avatarReads.slice(reads)).toEqual(['whombat']);
  });

  it('an owner only an automation watches (a draft too); none once it is deleted', async () => {
    const watching = await draft(
      def([{ id: 'note', kind: 'post_message', text: 'New issue.' }], {
        triggers: [{ kind: 'github', event: 'issue_opened', repo: 'Octo-Org/site' }],
      }),
    );
    const noPicture = await draft(
      def([{ id: 'note', kind: 'post_message', text: 'New issue.' }], {
        triggers: [{ kind: 'github', event: 'issue_opened', repo: 'nopicture/site' }],
      }),
    );
    const cookie = cookies.get(IDS.mara) ?? '';
    const res = await avatar('octo-org', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: 'octo-org', image: PNG_URL });
    // GitHub has no picture of it: no image, not a 404.
    const none = await avatar('nopicture', cookie);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ owner: 'nopicture', image: null });

    await w.ok(IDS.mara, deleteAutomation, { automationId: watching });
    expect((await avatar('octo-org', cookie)).statusCode).toBe(404);
    await w.ok(IDS.mara, deleteAutomation, { automationId: noPicture });
  });

  it('anyone else’s is a 404 without a fetch; people outside the burrow are refused', async () => {
    const reads = fake().avatarReads.length;
    const stranger = await avatar('stranger', cookies.get(IDS.mara) ?? '');
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await avatar('under_score', cookies.get(IDS.mara) ?? '')).statusCode).toBe(400);
    expect((await avatar('whombat', outsider)).statusCode).toBe(403);
    expect(fake().avatarReads.slice(reads)).toEqual([]);
  });
});
