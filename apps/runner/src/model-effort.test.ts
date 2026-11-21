/**
 * An agent's model and effort in the runner (Whombat model-effort.md ME-02…ME-05): every Claude Code and Codex turn gets
 * its effort — the agent's own, else automatic for the kind of turn — kept within what its model takes by the runner's
 * list of the tool's models; and a model the tool refuses before the turn did anything runs the same turn once more on
 * the tool's default, which the completion says. Anything else fails as before. Fast replies likewise (chat-runtime.md
 * CR-06…CR-08, chat-runtime-runner.md CR-R01, CR-R05, CR-R07), and every completion says what the turn ran on (`ran`).
 */
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  type TurnEvent,
  type TurnInput,
  type WhombatMcp,
} from '@whombat/agent-runtime';
import type { AgentModelRuntime, DispatchContext, ProviderModel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import { createRegistry, type ProviderRegistry, type RegistryOptions } from './registry';
import { testContext } from './test-context';
import { testPolicy } from './test-sandbox';
import { effortsOf, runDispatch, type TurnDeps } from './turn';

class FakeApi implements RunnerApi {
  completed: { id: string; body: Record<string, unknown> }[] = [];
  progressCalls: Record<string, unknown>[] = [];
  async claim() {
    return null;
  }
  async progress(_id: string, body: Record<string, unknown>) {
    this.progressCalls.push(body);
    return { cancel: false, reason: null };
  }
  async complete(id: string, body: Record<string, unknown>) {
    this.completed.push({ id, body });
  }
  async heartbeat() {
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

class FakeMcp implements WhombatMcp {
  calls: { name: string; args: unknown }[] = [];
  async call(name: string, args: unknown) {
    this.calls.push({ name, args });
    return { ok: true, isError: false, body: { status: 'ok' } };
  }
  async close() {}
}

const CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: null,
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
  { id: 'haiku', label: 'Haiku', description: null, efforts: [], isDefault: false },
];

/** Claude Code's list with fast replies on Opus (CR-06). */
const FAST_CLAUDE: ProviderModel[] = CLAUDE_MODELS.map((m) => (m.id === 'opus' ? { ...m, fast: 'off' } : m));

/** Codex's: the default without fast replies on by default, Sol with them on by default. */
const CODEX_MODELS: ProviderModel[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    description: null,
    efforts: ['high'],
    isDefault: true,
    fast: 'off',
  },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: null, efforts: ['high'], isDefault: false, fast: 'on' },
];

/** A live provider playing one list of events per attempt; what each attempt was started with. */
function provider(attempts: TurnEvent[][], kind: AgentProvider['kind'] = 'claude') {
  const seen: TurnInput[] = [];
  const p: AgentProvider = {
    kind,
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => ({ ...BASIC_CAPABILITIES, steering: true }),
    async *runTurn(input) {
      seen.push({ ...input });
      for (const e of attempts[seen.length - 1] ?? []) yield e;
    },
  };
  return { p, seen };
}

function deps(p: AgentProvider, models: ProviderModel[] | null = CLAUDE_MODELS) {
  const api = new FakeApi();
  const mcp = new FakeMcp();
  const registry: ProviderRegistry = {
    claims: () => [p.kind],
    for: () => p,
    report: () => [],
    // The scripted Hermes (HE-46): turns the server sent without a sign-in run on no one's.
    hermesScripted: () => true,
    models: () => models,
  };
  const d: TurnDeps = {
    api,
    registry,
    serverUrl: 'http://whombat.test',
    workspacesRoot: '/tmp/whombat-test-workspaces',
    managed: testPolicy(),
    log: () => {},
    progressMs: 5,
    connectMcp: async () => mcp,
  };
  return { d, api, mcp };
}

function ctx(runtime: Partial<AgentModelRuntime>, dispatch: Partial<DispatchContext['dispatch']> = {}) {
  const base = testContext();
  return {
    ...base,
    dispatch: { ...base.dispatch, trigger: 'dm' as const, ...dispatch },
    agent: { ...base.agent, runtime: { ...base.agent.runtime, provider: 'claude' as const, ...runtime } },
  } as DispatchContext;
}

const REFUSED: TurnEvent = {
  type: 'error',
  message:
    "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it. (HTTP 404)",
  retryable: false,
  code: 'model_not_found',
};

describe('every turn’s effort (ME-02, ME-03)', () => {
  const effortOf = async (
    runtime: Partial<AgentModelRuntime>,
    extra: Partial<DispatchContext['dispatch']> = {},
    models?: ProviderModel[] | null,
  ) => {
    const { p, seen } = provider([[{ type: 'final', text: 'ok' }]]);
    await runDispatch(ctx(runtime, extra), deps(p, models).d, new AbortController().signal);
    return seen[0]?.effort;
  };

  it('automatic: medium for a conversation, high for code work — Claude Code like Codex', async () => {
    expect(await effortOf({})).toBe('medium');
    expect(await effortOf({}, { trigger: 'run_control', mode: 'run' })).toBe('high');
  });

  it('the agent’s own level, kept within what its model takes', async () => {
    expect(await effortOf({ effort: 'low' }, { trigger: 'run_control', mode: 'run' })).toBe('low');
    // Opus takes up to max: ultra becomes max. Haiku takes none: none is sent.
    expect(await effortOf({ model: 'opus', effort: 'ultra' })).toBe('max');
    expect(await effortOf({ model: 'haiku', effort: 'high' })).toBeNull();
    // No model of its own: the default's efforts.
    expect(await effortOf({ effort: 'ultra' })).toBe('max');
    // A model the list doesn't have, or no list: the effort as it is.
    expect(await effortOf({ model: 'claude-x', effort: 'ultra' })).toBe('ultra');
    expect(await effortOf({ model: 'haiku', effort: 'high' }, {}, null)).toBe('high');
  });

  it('nothing for a provider without models', async () => {
    const { p, seen } = provider([[{ type: 'final', text: 'ok' }]], 'local');
    const local = ctx({ effort: 'high' });
    local.localModel = { v: 1, baseUrl: 'http://192.168.1.20:11434/v1', model: 'llama4', apiKey: null };
    await runDispatch(local, deps(p).d, new AbortController().signal);
    expect(seen[0]).not.toHaveProperty('effort');
  });

  it('effortsOf: the named model’s, else the default’s; unknown is null', () => {
    expect(effortsOf(CLAUDE_MODELS, 'haiku')).toEqual([]);
    expect(effortsOf(CLAUDE_MODELS, undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsOf(CLAUDE_MODELS, 'claude-x')).toBeNull();
    expect(effortsOf(null, 'opus')).toBeNull();
  });
});

describe('a refused model falls back to the default for the turn (ME-05)', () => {
  it('runs the same turn again without the model and says so in the completion', async () => {
    const { p, seen } = provider([
      [
        { type: 'session', sessionId: 'sess_refused' },
        { type: 'text_delta', text: 'There’s an issue…' },
        REFUSED,
      ],
      [
        { type: 'session', sessionId: 'sess_default' },
        { type: 'final', text: 'Hello.' },
      ],
    ]);
    const { d, api, mcp } = deps(p);
    const out = await runDispatch(ctx({ model: 'fable', effort: 'xhigh' }), d, new AbortController().signal);
    expect(out.outcome).toBe('done');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ model: 'fable', effort: 'xhigh' });
    expect(seen[1]?.model).toBeUndefined();
    // The default's efforts: Opus takes xhigh.
    expect(seen[1]?.effort).toBe('xhigh');
    // Its follow-ups were the first attempt's: they wait for their own turn.
    expect(seen[1]?.steering).toBeUndefined();
    const done = api.completed.at(-1)?.body;
    expect(done).toMatchObject({
      outcome: 'done',
      providerSessionId: 'sess_default',
      modelFallback: { model: 'fable', detail: REFUSED.type === 'error' ? REFUSED.message : '' },
    });
    // The answer is posted once; the refusal never is.
    expect(mcp.calls.map((c) => JSON.stringify(c.args)).join('\n')).not.toContain(
      'issue with the selected model',
    );
  });

  it('a turn that did something first fails as before', async () => {
    const { p, seen } = provider([
      [{ type: 'tool_call', name: 'read_thread', input: {} }, REFUSED],
      [{ type: 'final', text: 'never' }],
    ]);
    const { d, api } = deps(p);
    const out = await runDispatch(ctx({ model: 'fable' }), d, new AbortController().signal);
    expect(out.outcome).toBe('failed');
    expect(seen).toHaveLength(1);
    expect(api.completed.at(-1)?.body).not.toHaveProperty('modelFallback');
  });

  it('any other failure, or an agent on the default model, fails as before', async () => {
    for (const [runtime, error] of [
      [
        { model: 'fable' },
        {
          type: 'error',
          message: 'Invalid API key · Fix external API key (HTTP 401)',
          retryable: false,
          code: 'authentication_failed',
          credentialState: 'auth_revoked',
        },
      ],
      [{}, REFUSED],
    ] as [Partial<AgentModelRuntime>, TurnEvent][]) {
      const { p, seen } = provider([[error], [{ type: 'final', text: 'never' }]]);
      const { d, api } = deps(p);
      const out = await runDispatch(ctx(runtime), d, new AbortController().signal);
      expect(out.outcome).toBe('failed');
      expect(seen).toHaveLength(1);
      expect(api.completed.at(-1)?.body).not.toHaveProperty('modelFallback');
    }
  });

  it('once only: a default that fails too is an ordinary failure, with the fallback said', async () => {
    const { p, seen } = provider([
      [REFUSED],
      [{ type: 'error', message: 'the model stopped answering', retryable: true }],
    ]);
    const { d, api } = deps(p);
    const out = await runDispatch(ctx({ model: 'fable' }), d, new AbortController().signal);
    expect(out.outcome).toBe('failed');
    expect(seen).toHaveLength(2);
    expect(api.completed.at(-1)?.body).toMatchObject({
      outcome: 'failed',
      error: 'the model stopped answering',
      modelFallback: { model: 'fable' },
    });
  });
});

describe('fast replies and what the turn ran on (CR-06…CR-08)', () => {
  /** Runs one dispatch with `attempts`; what each attempt was started with and the completion's body. */
  const run = async (
    runtime: Partial<AgentModelRuntime>,
    attempts: TurnEvent[][],
    options: { kind?: AgentProvider['kind']; models?: ProviderModel[] | null } = {},
  ) => {
    const { p, seen } = provider(attempts, options.kind);
    const { d, api } = deps(p, options.models === undefined ? FAST_CLAUDE : options.models);
    const provided = { provider: options.kind ?? ('claude' as const), ...runtime };
    const c = ctx(provided);
    if (options.kind === 'local')
      c.localModel = { v: 1, baseUrl: 'http://192.168.1.20:11434/v1', model: 'llama4', apiKey: null };
    const out = await runDispatch(c, d, new AbortController().signal);
    return { out, seen, done: api.completed.at(-1)?.body };
  };
  const answer: TurnEvent = { type: 'final', text: 'ok' };

  it('asks for them where the model offers them, says how fast it ran and why not', async () => {
    const fast = await run({ model: 'opus', fast: true }, [[{ type: 'speed', fast: true }, answer]]);
    expect(fast.seen[0]?.fast).toBe(true);
    expect(fast.done).toMatchObject({
      outcome: 'done',
      ran: { model: 'opus', effort: 'medium', fast: true },
    });
    expect(fast.done?.ran).not.toHaveProperty('fastSkipped');
    const busy = await run({ fast: true }, [[{ type: 'speed', fast: false, skipped: 'busy' }, answer]]);
    // No model of its own: the default's (Opus) fast replies, and `ran.model` null.
    expect(busy.seen[0]?.fast).toBe(true);
    expect(busy.done?.ran).toEqual({ model: null, effort: 'medium', fast: false, fastSkipped: 'busy' });
  });

  it('false turns them off; nothing is sent when the runtime doesn’t say or the model has none', async () => {
    expect((await run({ model: 'opus', fast: false }, [[answer]])).seen[0]?.fast).toBe(false);
    const quiet = await run({ model: 'opus' }, [[answer]]);
    expect(quiet.seen[0]?.fast).toBeNull();
    expect(quiet.done?.ran).toEqual({ model: 'opus', effort: 'medium', fast: false });
    // Haiku has none (and takes no effort): nothing sent, and no reason either — it wasn't on offer.
    const haiku = await run({ model: 'haiku', fast: true }, [[answer]]);
    expect(haiku.seen[0]?.fast).toBeNull();
    expect(haiku.done?.ran).toEqual({ model: 'haiku', effort: null, fast: false });
    // No list: nothing sent (turnFast).
    expect((await run({ model: 'opus', fast: true }, [[answer]], { models: null })).seen[0]?.fast).toBeNull();
  });

  it('Codex: what was asked, else the model’s own default', async () => {
    const codex = { kind: 'codex' as const, models: CODEX_MODELS };
    const on = await run({ model: 'gpt-6-sol' }, [[answer]], codex);
    expect(on.seen[0]?.fast).toBeNull();
    expect(on.done?.ran).toMatchObject({ model: 'gpt-6-sol', fast: true });
    const off = await run({ model: 'gpt-6-sol', fast: false }, [[answer]], codex);
    expect(off.seen[0]?.fast).toBe(false);
    expect(off.done?.ran).toMatchObject({ fast: false });
    expect(off.done?.ran).not.toHaveProperty('fastSkipped');
    const asked = await run({ fast: true }, [[answer]], codex);
    expect(asked.seen[0]?.fast).toBe(true);
    // Medium isn't among this list's efforts: the nearest higher one (ME-03).
    expect(asked.done?.ran).toEqual({ model: null, effort: 'high', fast: true });
  });

  it('a failed turn says it too; a provider without models never does', async () => {
    const failed = await run({ model: 'opus', fast: true }, [
      [{ type: 'error', message: 'the model stopped answering', retryable: true }],
    ]);
    expect(failed.done).toMatchObject({ outcome: 'failed', ran: { model: 'opus', fast: true } });
    const scripted = await run({ fast: true }, [[answer]], { kind: 'local' });
    expect(scripted.seen[0]).not.toHaveProperty('fast');
    expect(scripted.done).not.toHaveProperty('ran');
  });

  it('the fallback keeps fast replies only if the default offers them (CR-R07)', async () => {
    const kept = await run({ model: 'fable', fast: true }, [[REFUSED], [answer]], {
      models: FAST_CLAUDE.map((m) => (m.id === 'fable' ? { ...m, fast: 'off' } : m)),
    });
    expect(kept.seen.map((i) => i.fast)).toEqual([true, true]);
    expect(kept.done?.ran).toEqual({ model: null, effort: 'medium', fast: true });
    // Asked on Opus, refused; the default (Sonnet here) has none: nothing sent, and the reply says why it was slow.
    const sonnetDefault: ProviderModel[] = [
      { ...FAST_CLAUDE[0], isDefault: false } as ProviderModel,
      { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['high'], isDefault: true },
    ];
    const dropped = await run({ model: 'opus', fast: true }, [[REFUSED], [answer]], {
      models: sonnetDefault,
    });
    expect(dropped.seen.map((i) => i.fast)).toEqual([true, null]);
    expect(dropped.done).toMatchObject({
      modelFallback: { model: 'opus' },
      ran: { model: null, effort: 'high', fast: false, fastSkipped: 'unavailable' },
    });
  });
});

describe('the registry’s model lists (ME-04)', () => {
  /**
   * Registry options whose Claude Code answers `versions` (one per check) and lists `lists` (one per call; null: it
   * failed); Hermes lists ChatGPT's models (`chatgpt`, HN-04), once per Hermes version.
   */
  function exportsWith(
    lists: (ProviderModel[] | null)[],
    versions: string[],
    chatgpt: ProviderModel[] | null = CODEX_MODELS,
  ) {
    const calls: unknown[] = [];
    const chatgptCalls: unknown[] = [];
    let checks = 0;
    const exports: RegistryOptions = {
      hermesCheck: async () => ({ ready: true, version: '0.22.5', problem: null, detail: null }),
      cliCheck: async () => ({
        ok: true,
        version: versions[Math.min(checks++, versions.length - 1)] ?? 'v1',
      }),
      listModels: async (kind, executable) => {
        if (kind === 'codex') {
          chatgptCalls.push(executable);
          return chatgpt;
        }
        calls.push({ executable });
        return lists[calls.length - 1] ?? null;
      },
    };
    return { exports, calls, chatgptCalls };
  }

  it('lists Claude Code once per version and ChatGPT’s from Hermes, reports them and keeps them for the turns', async () => {
    let t = 0;
    const { exports, calls, chatgptCalls } = exportsWith(
      [CLAUDE_MODELS, CLAUDE_MODELS.slice(0, 1)],
      ['v1', 'v1', 'v2'],
    );
    const registry = await createRegistry({
      ...exports,
      now: () => t,
      modelsExecutable: () => '/opt/claude',
      modelsTmpRoot: '/tmp/runner',
    });
    await registry.modelsSettled?.();
    expect(registry.models?.('claude')).toEqual(CLAUDE_MODELS);
    expect(registry.models?.('codex')).toEqual(CODEX_MODELS);
    expect(calls).toEqual([{ executable: '/opt/claude' }]);
    // ChatGPT's list comes from Hermes, with no client of its own to run.
    expect(chatgptCalls).toEqual([undefined]);
    const claude = registry.status?.().providers.find((c) => c.provider === 'claude');
    expect(claude?.models).toEqual(CLAUDE_MODELS);
    expect(registry.status?.().providers.find((c) => c.provider === 'codex')?.models).toEqual(CODEX_MODELS);
    // The same version again: not listed again.
    t += 700_000;
    await registry.recheck?.({ force: true });
    await registry.modelsSettled?.();
    expect(calls).toHaveLength(1);
    expect(chatgptCalls).toHaveLength(1);
    // Another version: listed again.
    await registry.recheck?.({ force: true });
    await registry.modelsSettled?.();
    expect(calls).toHaveLength(2);
    expect(registry.models?.('claude')).toEqual(CLAUDE_MODELS.slice(0, 1));
  });

  it('after a failure, again at most every ten minutes; no executable, no listing', async () => {
    let t = 0;
    const { exports, calls } = exportsWith([null, CLAUDE_MODELS], ['v1'], null);
    const registry = await createRegistry({ ...exports, now: () => t });
    await registry.modelsSettled?.();
    expect(registry.models?.('claude')).toBeNull();
    expect(registry.models?.('codex')).toBeNull();
    t += 60_000;
    await registry.recheck?.({ force: true });
    await registry.modelsSettled?.();
    expect(calls).toHaveLength(1);
    t += 600_000;
    await registry.recheck?.({ force: true });
    await registry.modelsSettled?.();
    expect(calls).toHaveLength(2);
    expect(registry.models?.('claude')).toEqual(CLAUDE_MODELS);

    const none = exportsWith([CLAUDE_MODELS], ['v1']);
    const without = await createRegistry({ ...none.exports, modelsExecutable: () => null });
    await without.modelsSettled?.();
    expect(none.calls).toEqual([]);
    expect(without.models?.('claude')).toBeNull();
  });
});
