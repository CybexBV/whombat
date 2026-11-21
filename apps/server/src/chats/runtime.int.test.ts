/**
 * What answers in Chat on the server (docs/decisions/chat-runtime.md CR-01…CR-11; chat-runtime-server.md CR-S…). Needs
 * Postgres: a thread's choice, a turn's resolved runtime and what answered a reply are rows the commit pipeline, the
 * dispatch queue, the claim and the completion read and write in their transactions.
 *
 * `chats.runtime` shows the caller's assistant, both providers (ready, models with fast, gateway, usage) and a thread's
 * choice; `chats.setThreadRuntime`, `chats.start` and `messages.send` check and store a choice (null when it is the
 * assistant's own) and tell the person's devices; `chats.threads` lists it. A turn woken in such a thread is resolved to
 * it: claimed only by a runner with that provider, carried to the runner in the context, refused when the provider can't
 * run. A thread that has a turn keeps its provider (HN-06); one that follows the assistant follows its new provider, and
 * the runner's refusal of the old provider's session gets its retry the whole thread (HN-07). A reply says what answered
 * it, corrected by the completion; a thread's fallback never touches the assistant's own. `agents.update` takes fast
 * replies.
 */
import { ensureCredentialHome, writeCredentialMeta } from '@whombat/agent-runtime/providers';
import {
  api,
  buildPath,
  ChatRuntimeView,
  ChatThreadRuntimeResponse,
  type DispatchContext,
  type ProviderModel,
  type RealtimeEvent,
  runnerApi,
  topics,
} from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateAgent } from '../commands/agents';
import { sendMessage } from '../commands/messages';
import {
  burrows,
  chatThreadRuntimes,
  dispatches,
  events,
  messages,
  principals,
  subscriptionUsage,
} from '../db/schema/index';
import { runInDispatchScope } from '../runtime/dispatch-scope';
import { IDS } from '../seed/test-world';
import { signInsEnv } from '../test/github';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { startChat } from './commands';
import { listThreads } from './read';
import { setChatThreadRuntime } from './runtime';

// The person's provider sign-ins (usage, readiness) read in this process: no runner relays them here.
const t = useTestServer({ seed: true, app: true, env: signInsEnv() });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const CLAUDE_RUNNER = 'rnr_chat-claude';
const CODEX_RUNNER = 'rnr_chat-codex';
let mine: PersonalSetup;
let mara = '';
let maraAccount = '';
const frames: { topic: string; event: RealtimeEvent }[] = [];

const CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: true,
    fast: 'off',
  },
  { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'medium', 'high'], isDefault: false },
];
const CODEX_MODELS: ProviderModel[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    isDefault: true,
    fast: 'on',
  },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: null, efforts: ['low', 'medium'], isDefault: false },
];

const post = (url: string, payload: unknown) =>
  t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });

/** A runner's beat with both tools' lists, and a claim that says which providers it takes. */
async function connect(runnerId: string, providers: ('claude' | 'codex')[]) {
  const beat = await post('/internal/runner/heartbeat', {
    runnerId,
    active: [],
    status: {
      hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
      providers: [
        { provider: 'claude', state: 'ready', version: '2.1.296', detail: null, models: CLAUDE_MODELS },
        { provider: 'codex', state: 'ready', version: '0.162.1', detail: null, models: CODEX_MODELS },
      ],
      checkedAt: new Date().toISOString(),
    },
  });
  expect(beat.statusCode).toBe(200);
  return claim(runnerId, providers, 0);
}

async function claim(runnerId: string, providers: ('claude' | 'codex')[], waitMs = 300) {
  const res = await post('/internal/runner/claim', { runnerId, providers, waitMs });
  expect(res.statusCode).toBe(200);
  return (runnerApi.claim.response.parse(res.json()).dispatch ?? null) as DispatchContext | null;
}

async function complete(runnerId: string, ctx: DispatchContext, body: Record<string, unknown>) {
  const res = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
    runnerId,
    attempt: ctx.dispatch.attempts,
    ...body,
  });
  expect(res.statusCode).toBe(200);
}

async function view(thread?: string) {
  const ep = api.chats.runtime;
  const res = await t.api.inject({
    method: 'GET',
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}${thread ? `?thread=${thread}` : ''}`,
    headers: { cookie: mara },
  });
  return {
    status: res.statusCode,
    body: res.statusCode === 200 ? ChatRuntimeView.parse(res.json()) : res.json(),
  };
}

async function setRuntime(rootId: string, runtime: unknown, cookie = mara) {
  const ep = api.chats.setThreadRuntime;
  const res = await t.api.inject({
    method: 'PUT',
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', rootId })}`,
    headers: { cookie },
    payload: { runtime } as object,
  });
  return {
    status: res.statusCode,
    body: res.statusCode === 200 ? ChatThreadRuntimeResponse.parse(res.json()) : res.json(),
  };
}

/** Mara's top-level message in her Chat: a new thread, its id. */
async function ask(text: string, extra: Record<string, unknown> = {}) {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: mine.dmId, text, ...extra });
  if (res.status !== 'ok') throw new Error(res.status);
  return (res.result as { id: string }).id;
}

const turnsOf = (messageId: string) =>
  t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, mine.agentId)));

const choiceOf = async (rootId: string) =>
  (await t.services.db.select().from(chatThreadRuntimes).where(eq(chatThreadRuntimes.rootId, rootId)))[0] ??
  null;

const messageRow = async (id: string) =>
  (await t.services.db.select().from(messages).where(eq(messages.id, id)))[0];

beforeAll(async () => {
  mine = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null, grants: [] });
  await t.services.guides.settle();
  await t.services.db
    .update(principals)
    .set({
      runtime: { provider: 'claude' },
    })
    .where(eq(principals.id, mine.agentId));
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  maraAccount =
    (await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara)))[0]?.accountId ?? '';
  // Mara's own Claude and ChatGPT sign-ins: her assistant's turns run on them (one-person.md OP-S09).
  for (const provider of ['claude', 'codex'] as const) await signIn(provider);
  Object.assign(t.services.runtime.options, { retryBackoffMs: 0, pollMs: 20 });
  t.services.bus.onFrame((f) => {
    if (f.event.type === 'chat.thread_runtime' || f.event.type === 'message.updated')
      frames.push({ topic: f.topic, event: f.event });
  });
  // Only Claude Code at first: ChatGPT isn't set up.
  await connect(CLAUDE_RUNNER, ['claude']);
});

/** The person's own sign-in to a provider (an API key), as the sign-in flow records it. */
async function signIn(provider: 'claude' | 'codex') {
  const root = t.services.config.WHOMBAT_CREDENTIALS_ROOT as string;
  const home = await ensureCredentialHome(root, provider);
  await writeCredentialMeta(home, {
    v: 1,
    provider,
    authMode: 'api_key',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login: null,
    signal: null,
  });
}

/** Every turn ends before the next case: each case reads only what it queued. */
beforeEach(async () => {
  await t.services.db
    .update(dispatches)
    .set({ state: 'cancelled', finishedAt: new Date() })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
  frames.length = 0;
});

describe('with only Claude set up (CR-04)', () => {
  it('chats.runtime shows the assistant’s own, both providers, the models with fast and the 5-hour window', async () => {
    await t.services.db.insert(subscriptionUsage).values({
      accountId: maraAccount,
      provider: 'claude',
      kind: 'subscription',
      windows: [
        {
          kind: 'five_hour',
          label: '5-hour',
          usedPct: 38,
          resetsAt: '2026-10-19T20:00:00.000Z',
          status: 'ok',
        },
      ],
    });
    const { status, body } = await view();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      assistantId: mine.agentId,
      assistantName: 'Dusty',
      default: { provider: 'claude' },
    });
    expect(body).not.toHaveProperty('thread');
    const [claude, codex] = (body as ChatRuntimeView).providers;
    expect(claude).toMatchObject({
      provider: 'claude',
      ready: true,
      fastBlocked: null,
      usage: { usedPct: 38 },
    });
    expect(claude?.models.find((m) => m.id === 'opus')?.fast).toBe('off');
    expect(codex).toMatchObject({ provider: 'codex', ready: false, usage: null });
  });

  it('refuses a thread on a provider that isn’t set up', async () => {
    const root = await ask('What’s on my calendar?');
    const res = await setRuntime(root, { provider: 'codex' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_failed' });
    expect(res.body.error.message).toContain('ChatGPT');
    expect(await choiceOf(root)).toBeNull();
  });

  it('a thread whose provider can’t run is answered with the readiness words, never moved (CR-04)', async () => {
    const root = await ask('Plan my week.');
    // Its first turn ended; its choice is from when ChatGPT still worked.
    await t.services.db.insert(chatThreadRuntimes).values({
      rootId: root,
      burrowId: t.burrowId,
      conversationId: mine.dmId,
      runtime: { provider: 'codex' },
      setById: IDS.mara,
      setAt: new Date(),
    });
    await t.services.db
      .update(dispatches)
      .set({ state: 'done', finishedAt: new Date() })
      .where(eq(dispatches.messageId, root));
    const reply = await ask('And next week?', { threadRootId: root });
    const [turn] = await turnsOf(reply);
    expect(turn?.runtime).toEqual({ provider: 'codex' });
    // The Claude runner never takes it.
    expect(await claim(CLAUDE_RUNNER, ['claude'], 0)).toBeNull();
    const unrunnableMs = t.services.runtime.options.unrunnableMs;
    Object.assign(t.services.runtime.options, { unrunnableMs: 0 });
    try {
      await t.services.runtime.sweepUnrunnable();
    } finally {
      Object.assign(t.services.runtime.options, { unrunnableMs });
    }
    const [after] = await turnsOf(reply);
    expect(after).toMatchObject({ state: 'failed', error: 'unrunnable:provider' });
  });
});

describe('a thread’s choice (CR-02, CR-03, CR-05, CR-06)', () => {
  beforeAll(async () => {
    await connect(CODEX_RUNNER, ['codex']);
  });

  it('is checked in plain words, stored, told to the person’s devices and read back', async () => {
    const root = await ask('Is pve-02 healthy?');
    const refused = async (runtime: unknown, fact: string) => {
      const res = await setRuntime(root, runtime);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.message).toContain(fact);
    };
    await refused({ provider: 'codex', model: 'gpt-x' }, '“gpt-x”');
    await refused({ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, 'GPT-6 Luna');
    await refused({ provider: 'claude', model: 'sonnet', fast: true }, 'Opus');

    const set = await setRuntime(root, { provider: 'codex', effort: 'high', fast: false });
    expect(set).toEqual({
      status: 200,
      body: { thread: { provider: 'codex', effort: 'high', fast: false } },
    });
    expect(await choiceOf(root)).toMatchObject({ setById: IDS.mara, conversationId: mine.dmId });
    expect(frames).toContainEqual({
      topic: topics.me(IDS.mara),
      event: expect.objectContaining({
        type: 'chat.thread_runtime',
        rootId: root,
        runtime: { provider: 'codex', effort: 'high', fast: false },
      }),
    });
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'chat.thread_runtime_set'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(event?.actorId).toBe(IDS.mara);
    expect((await view(root)).body).toMatchObject({ thread: { provider: 'codex', effort: 'high' } });
    const threads = await listThreads(t.services.db, { id: IDS.mara, burrowId: t.burrowId });
    expect(threads.threads.find((th) => th.rootId === root)?.runtime).toEqual({
      provider: 'codex',
      effort: 'high',
      fast: false,
    });

    // The assistant's own is stored as nothing, and so is null.
    expect((await setRuntime(root, { provider: 'claude' })).body).toEqual({ thread: null });
    expect(await choiceOf(root)).toBeNull();
    expect((await view(root)).body).toMatchObject({ thread: null });
  });

  it('turns fast replies away through the AI gateway, and shows it', async () => {
    const root = await ask('Quick one.');
    await t.services.db
      .update(burrows)
      .set({ aiGateway: { connectionId: 'con_gateway', claude: false, codex: true } })
      .where(eq(burrows.id, t.burrowId));
    try {
      const codex = (await view()).body.providers.find((p: { provider: string }) => p.provider === 'codex');
      expect(codex).toMatchObject({ ready: true, fastBlocked: 'gateway', usage: null });
      const res = await setRuntime(root, { provider: 'codex', fast: true });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('AI gateway');
    } finally {
      await t.services.db.update(burrows).set({ aiGateway: null }).where(eq(burrows.id, t.burrowId));
    }
  });

  it('is on a top-level message of the person’s Chat', async () => {
    const root = await ask('Who am I?');
    const reply = await ask('Really?', { threadRootId: root });
    expect((await setRuntime(reply, { provider: 'codex' })).status).toBe(404);
    // A channel's message isn't a Chat thread.
    const sent = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: 'Morning!' });
    if (sent.status !== 'ok') throw new Error(sent.status);
    expect((await setRuntime((sent.result as { id: string }).id, { provider: 'codex' })).status).toBe(404);
    // Nor as an agent, whatever it holds.
    await expect(
      t.commit(mine.agentId, setChatThreadRuntime, { rootId: root, runtime: { provider: 'codex' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await view('msg_nothere12345')).status).toBe(404);
  });

  it('a queued turn of the thread takes a change at once', async () => {
    const root = await ask('Summarise my inbox.');
    const [turn] = await turnsOf(root);
    expect(turn?.runtime).toBeNull();
    await setRuntime(root, { provider: 'codex', model: 'gpt-6-luna' });
    const [after] = await turnsOf(root);
    expect(after?.runtime).toEqual({ provider: 'codex', model: 'gpt-6-luna' });
  });
});

describe('a new thread’s choice with its first message (CR-02, CT-469)', () => {
  it('chats.start stores it before the assistant is woken', async () => {
    const res = await t.commit(IDS.mara, startChat, {
      text: 'Draft a reply to Joris.',
      runtime: { provider: 'codex', effort: 'low' },
    });
    if (res.status !== 'ok') throw new Error(res.status);
    const root = res.result.messageId;
    expect((await choiceOf(root))?.runtime).toEqual({ provider: 'codex', effort: 'low' });
    const [turn] = await turnsOf(root);
    expect(turn).toMatchObject({ threadRootId: root, runtime: { provider: 'codex', effort: 'low' } });
  });

  it('messages.send stores it for a top-level message of the sender’s Chat, and fails the send when refused', async () => {
    const root = await ask('Book the train.', { runtime: { provider: 'codex', fast: true } });
    expect((await choiceOf(root))?.runtime).toEqual({ provider: 'codex', fast: true });
    expect((await turnsOf(root))[0]?.runtime).toEqual({ provider: 'codex', fast: true });
    expect(frames.map((f) => f.event.type)).toContain('chat.thread_runtime');

    // The assistant's own: nothing stored, the turn on the assistant's runtime.
    const own = await ask('And a hotel.', { runtime: { provider: 'claude' } });
    expect(await choiceOf(own)).toBeNull();
    expect((await turnsOf(own))[0]?.runtime).toBeNull();

    // Refused: nothing is sent.
    const before = await t.services.db.select({ id: messages.id }).from(messages);
    await expect(
      ask('And a car.', { runtime: { provider: 'claude', model: 'fable' } }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(await t.services.db.select({ id: messages.id }).from(messages)).toHaveLength(before.length);

    // A reply, or another room: ignored.
    const reply = await ask('Window seat.', { threadRootId: root, runtime: { provider: 'claude' } });
    expect(await choiceOf(reply)).toBeNull();
    expect((await choiceOf(root))?.runtime).toEqual({ provider: 'codex', fast: true });
    const elsewhere = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'Hello all',
      runtime: { provider: 'codex', model: 'nope' },
    });
    expect(elsewhere.status).toBe('ok');
  });
});

describe('a turn on a thread’s choice (CR-02, CR-03, CR-07, CR-08)', () => {
  it('is claimed by that provider’s runner and carries the choice to it', async () => {
    const root = await ask('Check the backups.', { runtime: { provider: 'codex', effort: 'high' } });
    expect(await claim(CLAUDE_RUNNER, ['claude'], 0)).toBeNull();
    const ctx = await claim(CODEX_RUNNER, ['codex']);
    expect(ctx?.dispatch.messageId).toBe(root);
    expect(ctx?.agent.runtime).toMatchObject({ provider: 'codex', effort: 'high' });
    expect(ctx?.agent.runtime).not.toHaveProperty('model');
    if (ctx) await complete(CODEX_RUNNER, ctx, { outcome: 'done' });
  });

  it('a thread that has a turn keeps its provider; its model, effort and fast replies stay free (HN-06)', async () => {
    const root = await ask('Tell me about Rome.');
    // Its turn hasn't started: the queued turn takes another provider (CR-02).
    expect((await setRuntime(root, { provider: 'codex' })).status).toBe(200);
    expect((await setRuntime(root, null)).body).toEqual({ thread: null });
    const first = await claim(CLAUDE_RUNNER, ['claude']);
    expect(first?.dispatch.messageId).toBe(root);
    if (!first) throw new Error('no turn');
    await complete(CLAUDE_RUNNER, first, { outcome: 'done', providerSessionId: 'hermes:local-rome' });

    // Started on Claude: ChatGPT is refused in plain words, nothing stored.
    const refused = await setRuntime(root, { provider: 'codex', effort: 'high' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('validation_failed');
    expect(refused.body.error.message).toContain('ChatGPT');
    expect(refused.body.error.message).toContain('new chat');
    expect(await choiceOf(root)).toBeNull();
    // Claude's own model and effort, and back to the assistant's own: free.
    expect((await setRuntime(root, { provider: 'claude', model: 'sonnet', effort: 'low' })).body).toEqual({
      thread: { provider: 'claude', model: 'sonnet', effort: 'low' },
    });
    await ask('And Florence?', { threadRootId: root });
    const second = await claim(CLAUDE_RUNNER, ['claude']);
    if (!second) throw new Error('no turn');
    expect(second.dispatch.providerSessionId).toBe('hermes:local-rome');
    expect(second.agent.runtime).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'low' });
    await complete(CLAUDE_RUNNER, second, { outcome: 'done', providerSessionId: 'hermes:local-rome' });
    expect((await setRuntime(root, null)).body).toEqual({ thread: null });

    // Started on ChatGPT: going back to the assistant's own (Claude) is another provider too.
    const trip = await ask('Plan a weekend in Ghent.', { runtime: { provider: 'codex' } });
    const planned = await claim(CODEX_RUNNER, ['codex']);
    if (!planned) throw new Error('no turn');
    await complete(CODEX_RUNNER, planned, { outcome: 'done', providerSessionId: 'hermes:local-ghent' });
    expect((await setRuntime(trip, null)).status).toBe(400);
    expect((await setRuntime(trip, { provider: 'codex', effort: 'low' })).status).toBe(200);
    expect((await choiceOf(trip))?.runtime).toEqual({ provider: 'codex', effort: 'low' });
  });

  it('a thread that follows the assistant follows its new provider; the old session’s refusal gets the whole thread (HN-07)', async () => {
    const root = await ask('Tell me about Lisbon.');
    const first = await claim(CLAUDE_RUNNER, ['claude']);
    if (!first) throw new Error('no turn');
    await complete(CLAUDE_RUNNER, first, { outcome: 'done', providerSessionId: 'hermes:local-lisbon' });
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'codex' } });
    try {
      await ask('And Porto?', { threadRootId: root });
      expect(await claim(CLAUDE_RUNNER, ['claude'], 0)).toBeNull();
      const second = await claim(CODEX_RUNNER, ['codex']);
      if (!second) throw new Error('no turn');
      expect(second.agent.runtime.provider).toBe('codex');
      // The server can't tell what Hermes keeps: it hands over the thread's session with only what is new.
      expect(second.dispatch.providerSessionId).toBe('hermes:local-lisbon');
      expect(second.session).toMatchObject({ resumed: true });
      // The runner finds that session on Claude and doesn't run there: the retry starts afresh with the whole thread.
      await complete(CODEX_RUNNER, second, {
        outcome: 'failed',
        error: 'Hermes couldn’t pick up this conversation again.',
        providerSessionId: 'hermes:local-lisbon',
      });
      const retry = await claim(CODEX_RUNNER, ['codex']);
      if (!retry) throw new Error('no retry');
      expect(retry.dispatch.id).toBe(second.dispatch.id);
      expect(retry.dispatch.providerSessionId).toBeNull();
      expect(retry.session).toMatchObject({ resumed: false });
      const shown = [retry.thread?.root.text, ...(retry.thread?.replies.map((m) => m.text) ?? [])];
      expect(shown).toEqual(expect.arrayContaining(['Tell me about Lisbon.', 'And Porto?']));
      await complete(CODEX_RUNNER, retry, { outcome: 'done', providerSessionId: 'hermes:local-porto' });
      // Still following: nothing stored for the thread.
      expect(await choiceOf(root)).toBeNull();
    } finally {
      await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude' } });
    }
  });

  it('says what answered each reply, corrected from what the runner says ran', async () => {
    const root = await ask('Find me a recipe.', { runtime: { provider: 'codex', effort: 'high' } });
    const ctx = await claim(CODEX_RUNNER, ['codex']);
    if (!ctx) throw new Error('no turn');
    const replied = await runInDispatchScope(
      { dispatchId: ctx.dispatch.id, agentId: mine.agentId, onBehalfOfAccountId: maraAccount },
      () =>
        t.commit(mine.agentId, sendMessage, {
          conversationId: mine.dmId,
          threadRootId: root,
          text: 'Here’s one with lentils.',
        }),
    );
    if (replied.status !== 'ok') throw new Error(replied.status);
    const replyId = (replied.result as { id: string }).id;
    expect((await messageRow(replyId))?.ranOn).toEqual({
      provider: 'codex',
      model: null,
      modelLabel: 'GPT-6.1 Sol',
      effort: 'high',
      fast: true,
    });
    // Not outside a turn.
    const loose = await t.commit(mine.agentId, sendMessage, {
      conversationId: mine.dmId,
      threadRootId: root,
      text: 'Also: soup.',
    });
    if (loose.status !== 'ok') throw new Error(loose.status);
    expect((await messageRow((loose.result as { id: string }).id))?.ranOn).toBeNull();

    frames.length = 0;
    await complete(CODEX_RUNNER, ctx, {
      outcome: 'done',
      ran: { model: null, effort: 'high', fast: false, fastSkipped: 'busy' },
    });
    expect((await messageRow(replyId))?.ranOn).toMatchObject({
      fast: false,
      fastSkipped: 'busy',
      effort: 'high',
    });
    expect(frames).toContainEqual({
      topic: topics.conversation(mine.dmId),
      event: expect.objectContaining({
        type: 'message.updated',
        message: expect.objectContaining({
          id: replyId,
          ranOn: expect.objectContaining({ fastSkipped: 'busy' }),
        }),
      }),
    });
  });

  it('a thread’s model that wasn’t available shows on its reply, never on the assistant (CR-08)', async () => {
    const root = await ask('Write a poem.', { runtime: { provider: 'codex', model: 'gpt-6-luna' } });
    const ctx = await claim(CODEX_RUNNER, ['codex']);
    if (!ctx) throw new Error('no turn');
    expect(ctx.agent.runtime).toMatchObject({ provider: 'codex', model: 'gpt-6-luna' });
    const replied = await runInDispatchScope(
      { dispatchId: ctx.dispatch.id, agentId: mine.agentId, onBehalfOfAccountId: maraAccount },
      () =>
        t.commit(mine.agentId, sendMessage, {
          conversationId: mine.dmId,
          threadRootId: root,
          text: 'Roses…',
        }),
    );
    if (replied.status !== 'ok') throw new Error(replied.status);
    await complete(CODEX_RUNNER, ctx, {
      outcome: 'done',
      modelFallback: { model: 'gpt-6-luna', detail: 'model not found' },
      ran: { model: null, effort: 'medium', fast: true },
    });
    expect((await messageRow((replied.result as { id: string }).id))?.ranOn).toMatchObject({
      model: null,
      modelLabel: 'GPT-6.1 Sol',
      modelSkipped: 'gpt-6-luna',
    });
    const [agent] = await t.services.db.select().from(principals).where(eq(principals.id, mine.agentId));
    expect(agent?.modelFallback).toBeNull();
  });
});

describe('fast replies on the assistant itself (CR-10)', () => {
  const keysLine = async () =>
    (
      await t.services.db
        .select()
        .from(events)
        .where(and(eq(events.aboutId, mine.agentId), eq(events.type, 'agent.updated')))
        .orderBy(desc(events.seq))
        .limit(1)
    )[0]?.text;

  it('agents.update takes fast where the model offers it, with its Keys line', async () => {
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', fast: true },
    });
    expect(await keysLine()).toBe('Turned on fast replies for Dusty');
    expect((await view()).body.default).toEqual({ provider: 'claude', fast: true });
    await expect(
      t.commit(IDS.mara, updateAgent, {
        runtime: { provider: 'claude', model: 'sonnet', fast: true },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', fast: false },
    });
    expect(await keysLine()).toBe('Turned off fast replies for Dusty');
    // A new provider clears it and says only that.
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'codex' } });
    expect(await keysLine()).toBe('Moved Dusty to codex');
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude' } });
  });
});
