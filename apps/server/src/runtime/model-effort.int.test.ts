/**
 * An agent's model and effort on the server (docs/decisions/model-effort.md ME-01…ME-07): the runner's model lists reach
 * `host.agents` (`ProviderSetup.models`); `agents.update` saves the whole model runtime with one Keys line per part that
 * changed, checks a new model and effort against the list (any model name while there is none), and a new provider
 * clears both; `agents.hire` checks them the same way; a completion's `modelFallback` is kept on the agent with where the
 * turn ran (`AgentProfile.modelFallback`) and cleared by a later turn on its model or a change of model.
 */
import {
  AgentProfile,
  AgentSetupStatus,
  api,
  buildPath,
  type DispatchContext,
  type ProviderModel,
  runnerApi,
} from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { updateAgent } from '../commands/agents';
import { sendMessage } from '../commands/messages';
import { dispatches, events, principals } from '../db/schema/index';
import { loadPrincipalRow } from '../read/principals';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { fallbackWhere } from './model-fallback';

const t = useTestServer({ seed: true, app: true });
const AUTH = { authorization: 'Bearer dev-runner-token' };
const RUNNER = 'rnr_model-effort';
let mara = '';

const CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: true,
  },
  {
    id: 'fable',
    label: 'Fable',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: false,
  },
  { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'medium', 'high'], isDefault: false },
];

const status = (models: ProviderModel[] | null) => ({
  hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
  providers: [
    {
      provider: 'claude',
      state: 'ready',
      version: '2.1.296 (Claude Code)',
      detail: null,
      ...(models ? { models } : {}),
    },
    { provider: 'codex', state: 'ready', version: 'codex-cli 0.162.1', detail: null },
  ],
  checkedAt: new Date().toISOString(),
});

const post = (url: string, payload: unknown) =>
  t.api.inject({ method: 'POST', url, headers: AUTH, payload: payload as object });

async function beat(models: ProviderModel[] | null) {
  const res = await post('/internal/runner/heartbeat', {
    runnerId: RUNNER,
    active: [],
    status: status(models),
  });
  expect(res.statusCode).toBe(200);
}

async function setup() {
  const ep = api.host.agents;
  const res = await t.api.inject({
    method: 'GET',
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie: mara },
  });
  expect(res.statusCode).toBe(200);
  return AgentSetupStatus.parse(res.json());
}

async function profile(agent: string) {
  const ep = api.agent.get;
  const res = await t.api.inject({
    method: 'GET',
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', agent })}`,
    headers: { cookie: mara },
  });
  expect(res.statusCode).toBe(200);
  return AgentProfile.parse(res.json());
}

async function lastKeysLine(agentId: string) {
  const [row] = await t.services.db
    .select()
    .from(events)
    .where(and(eq(events.aboutId, agentId), eq(events.type, 'agent.updated')))
    .orderBy(desc(events.seq))
    .limit(1);
  return row?.text;
}

const runtimeOf = async (id: string) =>
  (await t.services.db.select().from(principals).where(eq(principals.id, id)))[0]?.runtime;

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
  Object.assign(t.services.runtime.options, { retryBackoffMs: 0, pollMs: 20 });
});

describe('the tools’ model lists (ME-04, ME-07)', () => {
  it('pass from the runner’s checks to host.agents', async () => {
    await beat(CLAUDE_MODELS);
    const providers = (await setup()).providers;
    expect(providers.find((p) => p.provider === 'claude')?.models).toEqual(CLAUDE_MODELS);
    // A runner that listed none: not known.
    expect(providers.find((p) => p.provider === 'codex')).not.toHaveProperty('models');
  });
});

describe('agents.update (ME-01, ME-04)', () => {
  it('saves the model and the effort, one Keys line each', async () => {
    await beat(CLAUDE_MODELS);
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'codex' } });
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude' } });
    expect(await lastKeysLine(IDS.dusty)).toBe('Moved Dusty to claude');
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', model: 'sonnet', effort: 'high' },
    });
    expect(await lastKeysLine(IDS.dusty)).toBe('Set Dusty’s model to Sonnet. Set Dusty’s effort to High');
    expect(await runtimeOf(IDS.dusty)).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'high' });
    expect((await profile('dusty')).agent.runtime).toMatchObject({ model: 'sonnet', effort: 'high' });
    // Back to the defaults: the whole model runtime every time.
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', model: 'sonnet' },
    });
    expect(await lastKeysLine(IDS.dusty)).toBe('Set Dusty’s effort to Automatic');
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude', effort: 'low' } });
    expect(await lastKeysLine(IDS.dusty)).toBe(
      'Set Dusty’s model to Default (Opus). Set Dusty’s effort to Low',
    );
  });

  it('refuses a model or an effort the list doesn’t have, with the reason', async () => {
    await beat(CLAUDE_MODELS);
    await expect(
      t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude', model: 'claude-x' } }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Claude Code has no model called “claude-x” on this Whombat.',
      extra: { fields: { runtime: ['Claude Code has no model called “claude-x” on this Whombat.'] } },
    });
    await expect(
      t.commit(IDS.mara, updateAgent, {
        runtime: { provider: 'claude', model: 'sonnet', effort: 'max' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed', message: 'Sonnet doesn’t take Max effort.' });
    await expect(
      t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude', effort: 'ultra' } }),
    ).rejects.toMatchObject({ message: 'Default (Opus) doesn’t take Ultra effort.' });
  });

  it('without a list, any model name up to 120 characters and any effort', async () => {
    await beat(null);
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'ultra' },
    });
    expect(await lastKeysLine(IDS.dusty)).toBe(
      'Set Dusty’s model to claude-fable-5-1[1m]. Set Dusty’s effort to Ultra',
    );
    await expect(
      t.commit(IDS.mara, updateAgent, {
        runtime: { provider: 'claude', model: 'x'.repeat(121) },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // An agent whose model left the list keeps it: only what changes is checked.
    await beat(CLAUDE_MODELS);
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'high' },
    });
    expect(await runtimeOf(IDS.dusty)).toMatchObject({ model: 'claude-fable-5-1[1m]', effort: 'high' });
  });

  it('a new provider clears the model and the effort, and says only that', async () => {
    await beat(CLAUDE_MODELS);
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', model: 'fable', effort: 'xhigh' },
    });
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'codex' } });
    expect(await lastKeysLine(IDS.dusty)).toBe('Moved Dusty to codex');
    const runtime = await runtimeOf(IDS.dusty);
    expect(runtime).toMatchObject({ provider: 'codex' });
    expect(runtime).not.toHaveProperty('model');
    expect(runtime).not.toHaveProperty('effort');
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude' } });
  });
});

describe('the model fallback (ME-05)', () => {
  async function turn(complete: Record<string, unknown>) {
    const res = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: '@Dusty hello?' });
    if (res.status !== 'ok') throw new Error('send failed');
    const claimed = await post('/internal/runner/claim', {
      runnerId: RUNNER,
      providers: ['claude'],
      waitMs: 500,
    });
    const ctx = runnerApi.claim.response.parse(claimed.json()).dispatch as DispatchContext;
    expect(ctx.agent.runtime).toMatchObject({ model: 'fable', effort: 'high' });
    const done = await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
      runnerId: RUNNER,
      attempt: ctx.dispatch.attempts,
      ...complete,
    });
    expect(done.statusCode).toBe(200);
    const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, ctx.dispatch.id));
    return row;
  }

  it('is kept with where the turn ran, and cleared by a turn on the model or a change of model', async () => {
    await beat(CLAUDE_MODELS);
    await t.commit(IDS.mara, updateAgent, {
      runtime: { provider: 'claude', model: 'fable', effort: 'high' },
    });
    expect((await profile('dusty')).modelFallback).toBeNull();

    await turn({
      outcome: 'done',
      modelFallback: {
        model: 'fable',
        detail: 'There’s an issue with the selected model (claude-fable-5-1).',
      },
    });
    const fallback = (await profile('dusty')).modelFallback;
    // The person's own sign-in (one-person.md OP-S09).
    expect(fallback).toMatchObject({ model: 'fable', where: { kind: 'account', name: 'Mara' } });
    expect(fallback).not.toHaveProperty('detail');

    // A turn on its model clears it.
    await turn({ outcome: 'done' });
    expect((await profile('dusty')).modelFallback).toBeNull();

    // A failed turn that fell back keeps it too; a change of model clears it.
    await turn({ outcome: 'failed', error: 'API Error: 500', modelFallback: { model: 'fable', detail: '' } });
    expect((await profile('dusty')).modelFallback).toMatchObject({ model: 'fable' });
    await t.commit(IDS.mara, updateAgent, { runtime: { provider: 'claude', model: 'opus' } });
    expect((await profile('dusty')).modelFallback).toBeNull();
  });

  it('says where: the AI gateway, else the person’s own sign-in (one-person.md OP-S09)', async () => {
    const [maraRow] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const account = maraRow?.accountId as string;
    const dusty = (await loadPrincipalRow(t.services.db, IDS.dusty)) as NonNullable<
      Awaited<ReturnType<typeof loadPrincipalRow>>
    >;
    const row = { burrowId: t.burrowId, gatewayProvider: null, onBehalfOfAccountId: account };
    // A gateway whose switch is off by now: its name is gone with it.
    expect(await fallbackWhere(t.services.db, { ...row, gatewayProvider: 'claude' }, dusty)).toEqual({
      kind: 'gateway',
      name: null,
    });
    expect(await fallbackWhere(t.services.db, row, dusty)).toEqual({ kind: 'account', name: 'Mara' });
    // Work for nobody runs on the person's sign-in too.
    expect(await fallbackWhere(t.services.db, { ...row, onBehalfOfAccountId: null }, dusty)).toEqual({
      kind: 'account',
      name: 'Mara',
    });
  });
});
