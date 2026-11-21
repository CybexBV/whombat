/**
 * Every implemented endpoint, called once with valid input. Outside production each response is
 * validated against the contract by the route layer, so a success status means it matches `@whombat/core`.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyEndpoint, api, buildPath, toQueryString } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { recordChecks, reviewPr } from '../commands/prs';
import { IDS } from '../seed/test-world';
import { signInToGitHub } from '../test/github';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { sessionFor } from '../test/tokens';

// Provider sign-ins of this suite in a folder of its own, run in this process (no runner to relay them, SUB-22).
const signIns = mkdtempSync(join(tmpdir(), 'wb-endpoints-signins-'));
const t = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: signIns, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
let mara = '';
const called = new Set<string>();

beforeAll(async () => {
  const session = await sessionFor(t.services, IDS.mara);
  mara = session.cookie;
  // Mara's own GitHub sign-in: what connecting GitHub needs (EA-10).
  await signInToGitHub(signIns, session.accountId);
});

async function call(
  ep: AnyEndpoint,
  params: Record<string, string | number> = {},
  body?: unknown,
  query?: Record<string, unknown>,
  cookie = mara,
) {
  called.add(ep.id);
  const url = `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}${toQueryString(query)}`;
  const res = await t.api.inject({
    method: ep.method,
    url,
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  if (res.statusCode >= 400) throw new Error(`${ep.id} → ${res.statusCode}: ${res.body}`);
  expect(res.statusCode, ep.id).toBe(ep.status);
  return ep.contentType === 'text/csv' ? res.body : res.json();
}

describe('every endpoint', () => {
  it('answers with contract-valid bodies', async () => {
    const b = { burrow: 'burrow-hq' };
    await call(api.me.get);
    await call(api.me.getPreferences);
    expect(await call(api.me.updatePreferences, {}, { theme: 'dark' })).toEqual({
      theme: 'dark',
      timeZone: null,
    });
    expect(await call(api.me.updatePreferences, {}, { theme: 'light' })).toEqual({
      theme: 'light',
      timeZone: null,
    });
    await call(api.me.updateProfile, {}, { title: 'Engineering lead' });

    await call(api.burrows.slugCheck, {}, undefined, { name: 'Moss Co' });
    await call(api.burrows.get, b);
    await call(api.burrows.update, b, { timeZone: 'Europe/Amsterdam' });
    // “Agents may reach your local network” (resourceful-agents.md RA-41): on already, so nothing to sign.
    expect(await call(api.burrows.setAgentsReachLan, b, { agentsReachLan: true })).toMatchObject({
      burrow: { agentsReachLan: true },
      eventId: null,
    });
    await call(api.onboarding.get, b);
    await call(api.onboarding.update, b, { step: 2 });
    const repos = await call(api.repos.list, b);
    await call(api.repos.update, { repoId: repos.repos[1].id }, { enabled: true });
    await call(api.repos.sync, b);
    const github = await call(api.github.status, b);
    expect(github).toMatchObject({ mode: 'fake', connected: true, signInNeeded: false });
    expect(await call(api.github.connect, b)).toMatchObject({ connected: true, login: 'whombat' });
    const choices = await call(api.github.repos, b, undefined, { limit: 3 });
    expect(choices.repos).toHaveLength(3);
    await call(api.repos.add, b, { fullName: 'whombat/docs', enabled: false });

    await call(api.conversations.bootstrap, b);
    await call(api.conversations.list, b, undefined, { kind: 'branch' });
    await call(api.conversations.get, { conversationId: IDS.billing });
    // Mara's own Chat with the agent (one-agent.md OA-04: no channels to make).
    const moss = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    await call(api.conversations.update, { conversationId: moss }, { topic: 'Greener things' });
    const sent = await call(api.messages.send, { conversationId: moss }, { text: 'First!' });
    await call(api.conversations.markRead, { conversationId: moss }, { messageId: sent.message.id });
    await call(api.messages.list, { conversationId: moss });
    await call(api.messages.get, { messageId: sent.message.id });
    await call(api.messages.thread, { messageId: sent.message.id });
    await call(api.messages.react, { messageId: sent.message.id }, { value: 'yay', on: true });
    const offered = await t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.billing,
      text: 'Use Typeset.',
      more: 'why not the other two',
    });
    await call(api.messages.more, { messageId: (offered as { result: { id: string } }).result.id });
    // Attachments: the bytes travel on their own routes (files/attachments.int.test.ts).
    const reserved = await call(api.uploads.create, b, { conversationId: moss, name: 'a.txt', size: 3 });
    await call(api.uploads.discard, { attachmentId: reserved.attachment.id });

    await call(api.prs.list, b);
    await call(api.prs.get, { number: 482 });
    await call(api.runs.list, b, undefined, { agent: 'dusty' });
    await call(api.runs.get, { number: 1907 });
    await call(api.runs.log, { number: 1907 });
    const paused = await call(api.runs.pause, { number: 1907 });
    expect(paused.run.status).toBe('paused');
    expect((await call(api.runs.resume, { number: 1907 })).run.status).toBe('live');
    const taken = await call(api.runs.takeOver, { number: 1907 });
    expect(taken).toMatchObject({
      run: { status: 'taken_over', takenOverById: IDS.mara },
      branch: 'feat/invoice-pdf',
    });
    await call(api.approvals.list, b, undefined, { state: 'pending' });
    await call(api.approvals.get, { number: 12 });
    await call(api.approvals.decide, { number: 12 }, { decision: 'approve' });
    await call(api.approvals.undo, { number: 12 });
    await call(api.plans.get, { planId: 'pln_invoice-pdf' });
    await call(api.plans.updateStep, { planId: 'pln_invoice-pdf', stepId: 'stp_pdf-3' }, { state: 'done' });
    await call(api.plans.list, {}, undefined, { conversationId: IDS.billing, status: 'all' });
    const made = await call(
      api.plans.create,
      {},
      {
        conversationId: IDS.billing,
        title: 'Endpoint plan',
        steps: [
          { title: 'One', ownerId: IDS.mara },
          { title: 'Two', ownerId: IDS.dusty },
        ],
      },
    );
    const planId = made.plan.id as string;
    const [one, two] = made.plan.steps.map((st: { id: string }) => st.id) as [string, string];
    await call(api.plans.update, { planId }, { title: 'Endpoint plan v2', order: [two, one] });
    const added = await call(api.plans.addStep, { planId }, { title: 'Three', ownerId: IDS.mara });
    await call(api.plans.removeStep, { planId, stepId: added.plan.steps.at(-1).id });
    const started = await call(api.plans.startStep, { planId, stepId: two }, {});
    expect(started.dispatchId).toMatch(/^dsp_/);
    await call(api.plans.createCanvas, { planId });

    // The agent (one-agent.md OA-09): read it, its schedules (RA-30; pause, resume and remove:
    // schedules/schedules.int.test.ts), its name and keys, and whose sign-in it runs on.
    const profile = await call(api.agent.get, b);
    expect(profile.agent).toMatchObject({ name: 'Dusty', handle: 'dusty', face: 'dusty' });
    expect(await call(api.schedules.list, b)).toEqual({ schedules: [] });
    const renamed = await call(api.agent.update, b, { name: 'Bramble', face: 'banjo' });
    expect(renamed.agent).toMatchObject({ name: 'Bramble', face: 'banjo' });
    const keys = await call(api.agent.setKeys, b, {
      grants: [
        { keyId: 'messages.search', tier: 'can' },
        { keyId: 'deploy', tier: 'can' },
      ],
    });
    expect(keys.grants).toEqual([
      { agentId: profile.agent.id, keyId: 'messages.search', tier: 'can' },
      { agentId: profile.agent.id, keyId: 'deploy', tier: 'can' },
    ]);
    const texts = keys.events.map((e: { text: string }) => e.text);
    // One signed Keys event per changed key, by the agent's new name: the new one, and the others that went.
    expect(texts).toContainEqual(expect.stringMatching(/Bramble.*Deploy$/));
    expect(texts.every((x: string) => x.includes('Bramble'))).toBe(true);
    expect(await call(api.agent.commandAllowances, b)).toEqual({ allowances: [] });
    expect(await call(api.host.info, b)).toMatchObject({ services: { available: false } });
    expect(await call(api.host.agents, b)).toHaveProperty('providers');
    expect((await call(api.host.recheckAgents, b)).defaultProvider).toBe('claude');

    await call(api.audit.list, b, undefined, { actor: 'people', kind: 'keys' });
    await call(api.audit.get, { eventId: 'evt_9f18' });
    await call(api.audit.export, b, undefined, { kind: 'asks' });
    await call(api.audit.verify, b);

    await call(api.search.query, b, undefined, { q: 'rounding' });
    const asked = await call(api.search.ask, b, { q: 'rounding?' });
    await call(api.search.getAnswer, { answerId: asked.answer.id });
    // Answers are written by the researcher (post_answer, runtime phase); stand one in to post it.
    await t.services.sql`
      update search_answers set status = 'ready', text = 'Twice before [1].',
        citations = '[{"n":1,"resultId":"hist_thread-credit-note"}]'::jsonb
      where id = ${asked.answer.id}`;
    const posted = await call(
      api.search.postAnswer,
      { answerId: asked.answer.id },
      { conversationId: IDS.incidents },
    );
    expect(posted.message.card).toMatchObject({
      kind: 'answer',
      query: 'rounding?',
      receipts: [{ n: 1, source: '#incidents', detail: 'Mara Okafor', resultId: 'hist_thread-credit-note' }],
    });

    await call(api.canvases.list, b);
    const canvas = await call(api.canvases.create, b, { title: 'Moss notes', conversationId: moss });
    await call(api.canvases.get, { slug: 'invoice-pdf-export-plan' });
    await call(api.canvases.collabToken, { slug: 'invoice-pdf-export-plan' });
    // A Yjs relative position (base64), as the editor sends it.
    const comment = await call(
      api.canvases.addComment,
      { slug: canvas.canvas.slug },
      { anchor: { relativePosition: 'AAEFAA==', quote: 'moss' }, text: 'Nice.' },
    );
    await call(
      api.canvases.addComment,
      { slug: canvas.canvas.slug },
      { parentId: comment.comment.id, text: 'Agreed.' },
    );
    await call(
      api.canvases.resolveComment,
      { slug: canvas.canvas.slug, commentId: comment.comment.id },
      { resolved: true },
    );

    await call(api.notifications.inbox, b, undefined, { filter: 'needs_you' });
    await call(api.notifications.markRead, b, { all: true });
    const device = await call(
      api.devices.register,
      {},
      { platform: 'android', provider: 'fcm', token: 'fcm-1' },
    );
    await call(api.devices.update, { deviceId: device.device.id }, { liveActivityToken: 'la-1' });
    await call(
      api.devices.registerLiveActivity,
      { deviceId: device.device.id },
      { kind: 'run', runId: 'run_1907', pushToken: 'p-1' },
    );
    await call(api.devices.remove, { deviceId: device.device.id });

    // Connectors (docs/decisions/connectors.md) with the fake Google: set up, connect, check, disconnect.
    await call(api.connectors.status);
    await call(
      api.connectors.setGoogleApp,
      {},
      {
        clientId: '1234567890-abc.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
        userType: 'external',
      },
    );
    // The hosted UI hands over what Google put on its address bar (AG-14); the fake's consent answers at once.
    const consent = new URL(
      (
        await call(
          api.connections.startGoogle,
          {},
          { services: ['mail', 'calendar'], returnTo: '/burrow-hq/settings?tab=connections' },
        )
      ).authorizeUrl,
    );
    expect(
      await call(
        api.connections.finishGoogle,
        {},
        { code: consent.searchParams.get('code'), state: consent.searchParams.get('state') },
      ),
    ).toEqual({ returnPath: '/burrow-hq/settings?tab=connections&connected=google' });
    const { connections } = await call(api.connectors.status);
    await call(api.connections.check, { connectionId: connections[0].id });
    await call(api.connections.remove, { connectionId: connections[0].id });
    await call(api.connectors.removeGoogleApp);

    // Merge into main once checks are green and the review approves.
    await t.commit(IDS.dusty, recordChecks, {
      prNumber: 482,
      checks: [
        {
          name: 'unit',
          state: 'passed',
          note: '41/41',
          durationMs: 1,
          tests: { passed: 41, total: 41 },
          url: null,
        },
      ],
    });
    // Its keys were set to two above: the review needs “Approve pull requests” back.
    await call(api.agent.setKeys, b, {
      grants: [
        { keyId: 'messages.search', tier: 'can' },
        { keyId: 'deploy', tier: 'can' },
        { keyId: 'pr.approve', tier: 'can' },
      ],
    });
    const approved = await t.commit(IDS.dusty, reviewPr, {
      prNumber: 482,
      decision: 'approve',
      body: '',
      comments: [],
    });
    expect(approved.status).toBe('ok');
    const merged = await call(api.prs.merge, { number: 482 }, { method: 'squash' });
    expect(merged).toMatchObject({ status: 'merged', pr: { state: 'merged', mergedById: IDS.mara } });

    // One burrow per box (one-agent.md OA-01): a second one is refused.
    const second = await t.api.inject({
      method: 'POST',
      url: `${api.burrows.create.base}${api.burrows.create.path}`,
      headers: { cookie: mara },
      payload: { name: 'Moss Co' },
    });
    expect(second.statusCode).toBe(409);
    const done = await call(api.onboarding.complete, b, { invites: [] });
    // The burrow's own agent (one-agent.md OA-S08).
    expect(done.agent).toMatchObject({ id: IDS.dusty });
  });

  // Supervised automations (docs/decisions/bp-automations.md): every endpoint once, through REST.
  it('answers the automation endpoints with contract-valid bodies', async () => {
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const b = { burrow: 'burrow-hq' };
    const c = (
      ep: AnyEndpoint,
      params: Record<string, string | number> = {},
      body?: unknown,
      query?: Record<string, unknown>,
    ) => call(ep, { ...b, ...params }, body, query, cookie);
    const { templates } = await c(api.automations.templates);
    expect(templates.map((x: { id: string }) => x.id)).toEqual(['suspected_bug', 'repo_check']);
    const created = await c(
      api.automations.create,
      {},
      {
        name: 'Hello',
        source: { kind: 'blank', conversationId: IDS.billing },
      },
    );
    const id = created.automation.id;
    await c(api.automations.get, { id });
    const saved = await c(
      api.automations.saveDraft,
      { id },
      {
        definition: {
          version: 1,
          conversationId: IDS.billing,
          triggers: [{ kind: 'manual' }, { kind: 'webhook' }].slice(0, 1),
          steps: [{ id: 'hi', kind: 'post_message', text: 'Hi {{trigger.text}}' }],
        },
      },
    );
    await c(api.automations.setKeys, { id }, { grants: [{ keyId: 'pr.open', tier: 'ask' }] });
    const published = await c(
      api.automations.publish,
      { id },
      { enable: true, definitionHash: saved.automation.draftHash },
    );
    expect(published.automation).toMatchObject({ status: 'published', currentVersion: 1 });
    await c(api.automations.export, { id });
    await c(api.automations.saveDraft, { id }, { definition: { version: 1 } });
    await c(api.automations.discardDraft, { id });
    await c(api.automations.setEnabled, { id }, { enabled: false });
    await c(api.automations.setEnabled, { id }, { enabled: true });
    // Incoming webhooks: refused by the managed policy.
    const hook = await t.api.inject({
      method: 'POST',
      url: `${api.automations.webhook.base}${buildPath(api.automations.webhook.path, { ...b, id })}`,
      headers: { cookie },
      payload: { enabled: true, rotateSecret: true },
    });
    expect(hook.statusCode).toBe(403);
    expect(hook.json().error.details).toMatchObject({ code: 'managed.automation_webhooks' });
    const started = await c(api.automations.runNow, { id }, { test: false, text: 'there' });
    const number = started.run.number;
    await c(api.automations.list);
    await c(api.automations.runs, {}, undefined, { automation: id });
    await c(api.automations.run, { number });
    await c(api.automations.pauseRun, { number });
    await c(api.automations.resumeRun, { number });
    await c(api.automations.cancelRun, { number });
    // Settling an uncertain step: the run's first step is made uncertain (a crash mid-call, simulated).
    const again = await c(api.automations.runNow, { id }, { test: false });
    await t.services.db.execute(
      sql`update automation_run_steps set state = 'uncertain' where run_id = ${again.run.id} and idx = 0`,
    );
    const reviewed = await c(
      api.automations.reviewStep,
      { number: again.run.number, stepId: 'hi' },
      { resolution: 'failed' },
    );
    expect(reviewed.run.steps[0].state).toBe('failed');
  });

  // Automations from the simple form, samples, a test run on one, and Delete (automation-recipes.md), through REST.
  it('answers the recipe, samples and delete endpoints with contract-valid bodies', async () => {
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const b = { burrow: 'burrow-hq' };
    const c = (ep: AnyEndpoint, params: Record<string, string | number> = {}, body?: unknown) =>
      call(ep, { ...b, ...params }, body, undefined, cookie);
    const created = await c(
      api.automations.create,
      {},
      {
        source: {
          kind: 'recipe',
          recipe: {
            when: { kind: 'github', repo: 'whombat/billing', events: ['issue_opened', 'pr_opened'] },
            job: 'assess',
            instructions: 'Assess it.',
            conversationId: IDS.billing,
            replyOnGitHub: true,
          },
        },
        publish: true,
      },
    );
    expect(created.automation).toMatchObject({
      status: 'published',
      summary: expect.stringContaining('assesses it in billing-v2'),
      deletedAt: null,
    });
    const id = created.automation.id;
    const fake = t.services.github.fake;
    if (!fake) throw new Error('no FakeGitHub');
    const issue = await fake.simulateOpenIssue({ repo: 'whombat/billing', title: 'Try me', login: 'jdoe' });
    const { samples } = await c(api.automations.samples, { id });
    expect(samples).toContainEqual(
      expect.objectContaining({
        kind: 'issue',
        number: issue,
        title: 'Try me',
        author: 'jdoe',
        draft: false,
      }),
    );
    const tried = await c(api.automations.runNow, { id }, { test: true, sample: { number: issue } });
    expect(tried.run.trigger).toMatchObject({ kind: 'github', summary: `Tried on whombat/billing#${issue}` });
    expect(await c(api.automations.delete, { id })).toEqual({ id, cancelledRuns: 1 });
    // Its run page still shows it, deleted; the lists and `get` don't.
    const page = await c(api.automations.run, { number: tried.run.number });
    expect(page.automation.deletedAt).not.toBeNull();
    expect(page.run.status).toBe('cancelled');
    const { automations } = await c(api.automations.list);
    expect(automations.some((a: { id: string }) => a.id === id)).toBe(false);
    const gone = await t.api.inject({
      method: 'GET',
      url: `${api.automations.get.base}${buildPath(api.automations.get.path, { ...b, id })}`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('provider sign-ins and AI clients (CT-70, CT-72)', async () => {
    const cookie = (await sessionFor(t.services, IDS.mara)).cookie;
    const c = (ep: AnyEndpoint, params: Record<string, string> = {}, body?: unknown) =>
      call(ep, params, body, undefined, cookie);
    const listed = await c(api.signins.list);
    expect(listed.consoles).toEqual([]);
    const login = await c(api.signins.loginStart, {}, { provider: 'claude', authMode: 'api_key' });
    expect(login.state).toBe('awaiting_secret');
    expect((await c(api.signins.loginStatus, { loginId: login.loginId })).state).toBe('awaiting_secret');
    expect((await c(api.signins.loginCancel, { loginId: login.loginId })).state).toBe('cancelled');
    expect(await c(api.signins.logout, { provider: 'codex' })).toEqual({ removed: false });
    // Not a key: refused before anything is stored or checked (no network).
    const key = await c(api.signins.loginStart, {}, { provider: 'claude', authMode: 'api_key' });
    const submitted = await c(
      api.signins.loginSubmit,
      { loginId: key.loginId },
      { secret: 'not-an-anthropic-key' },
    );
    expect(submitted.state).toBe('failed');
    const clients = await c(api.clients.list);
    // Claude Code is the only client: ChatGPT needs nothing installed (hermes-native.md HN-A01).
    expect(clients.clients.map((c: { provider: string }) => c.provider)).toEqual(['claude']);
    expect(clients.canManage).toBe(true);
  });
});
