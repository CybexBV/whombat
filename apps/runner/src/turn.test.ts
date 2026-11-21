import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  credentialPaths,
  type TurnEvent,
  type TurnInput,
  type WhombatMcp,
} from '@whombat/agent-runtime';
import { RUNNER_SHUTDOWN } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerApi } from './api';
import { networkFor, sandboxFor, turnPrompt, whombatMd } from './prompt';
import type { ProviderRegistry } from './registry';
import { Runner } from './runner';
import { testContext } from './test-context';
import { testPolicy } from './test-sandbox';
import { completionUsage, confinementFor, runDispatch, type TurnDeps } from './turn';
import { runnerTmpDir } from './workspace';

/** The hash a turn reports with its session (`SOUL.md` and `whombat.md`'s) while contracts 0.123 ask for one. */

class FakeApi implements RunnerApi {
  progressCalls: { id: string; body: Record<string, unknown> }[] = [];
  completed: { id: string; body: Record<string, unknown> }[] = [];
  heartbeats: string[][] = [];
  cancelOnProgress: 'paused' | 'taken_over' | null = null;
  /** Answer cancel only once this holds (e.g. the provider runs); the first beat never cancels. */
  cancelWhen: () => boolean = () => true;
  queue: ReturnType<typeof testContext>[] = [];

  async claim(_body: unknown, signal?: AbortSignal) {
    const next = this.queue.shift();
    if (next) return next;
    await new Promise((r) => {
      const t = setTimeout(r, 5);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        r(null);
      });
    });
    return null;
  }
  async progress(id: string, body: Record<string, unknown>) {
    this.progressCalls.push({ id, body });
    return this.cancelOnProgress && this.progressCalls.length > 1 && this.cancelWhen()
      ? { cancel: true, reason: this.cancelOnProgress }
      : { cancel: false, reason: null };
  }
  async complete(id: string, body: Record<string, unknown>) {
    this.completed.push({ id, body });
  }
  async heartbeat(body: { active: string[] }) {
    this.heartbeats.push(body.active);
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

/** A provider that plays back events; waits for abort when `hang` is set. */
function provider(
  events: TurnEvent[],
  opts: {
    hang?: boolean;
    throws?: string;
    kind?: AgentProvider['kind'];
  } = {},
) {
  const seen: { input?: TurnInput; aborted?: boolean } = {};
  const p: AgentProvider = {
    kind: opts.kind ?? 'local',
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => BASIC_CAPABILITIES,
    async *runTurn(input, signal) {
      seen.input = input;
      for (const e of events) yield e;
      if (opts.throws) throw new Error(opts.throws);
      if (opts.hang) {
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        seen.aborted = true;
      }
    },
  };
  return { p, seen };
}

/** The scripted Hermes (HE-46): turns the server sent without a sign-in run on no one's. */
function registryOf(p: AgentProvider | null): ProviderRegistry {
  return { claims: () => ['local'], for: () => p, report: () => [], hermesScripted: () => true };
}

function deps(api: FakeApi, p: AgentProvider | null, mcp = new FakeMcp()): TurnDeps & { mcp: FakeMcp } {
  return {
    api,
    registry: registryOf(p),
    serverUrl: 'http://whombat.test',
    workspacesRoot: '/tmp/whombat-test-workspaces',
    log: () => {},
    progressMs: 5,
    connectMcp: async () => mcp,
    managed: testPolicy(),
    mcp,
  };
}

describe('runDispatch without a task sandbox (MR-13, HE-48)', () => {
  it('refuses a turn whose sandbox can’t start instead of running it unsandboxed', async () => {
    const api = new FakeApi();
    const { p, seen } = provider([{ type: 'final', text: 'should not run' }]);
    const d = { ...deps(api, p), managed: {} };
    const out = await runDispatch(testContext(), d, new AbortController().signal);
    expect(out).toMatchObject({ outcome: 'failed', refusal: expect.stringMatching(/sandbox/) });
    expect(seen.input).toBeUndefined();
  });
});

describe('a scripted Hermes on a managed runner (HE-46)', () => {
  it('runs a turn the server sent without a sign-in; a real Hermes is refused one', async () => {
    const ctx = { ...testContext(), credential: null };
    const errorOf = async (scripted: boolean) => {
      const api = new FakeApi();
      const { p } = provider([{ type: 'final', text: 'hello' }], { kind: 'claude' });
      const d = { ...deps(api, p), managed: {} };
      d.registry = { ...d.registry, hermesScripted: () => scripted };
      await runDispatch(ctx, d, new AbortController().signal);
      return String(api.completed.at(-1)?.body.error);
    };
    // Real: refused at the sign-in. Scripted: past the sign-in, on to the sandbox (none in this test).
    expect(await errorOf(false)).toContain('not_signed_in');
    expect(await errorOf(true)).toContain('sandbox');
  });
});

describe('the session and the usage a turn reports (HE-18, PE-04)', () => {
  /** A chat turn handed the session `sess_old`; its window full or only new. */
  const resumed = (onlyNew: boolean) => {
    const ctx = testContext();
    return {
      ...ctx,
      dispatch: { ...ctx.dispatch, providerSessionId: 'hermes:sess_old' },
      memory: {
        status: 'ok' as const,
        reason: null,
        instructions: [],
        knowledge: [],
        checkpoint: null,
        summary: null,
        session: {
          key: 'cnv_billing-v2',
          resumed: onlyNew,
          since: null,
          reason: null,
          scratchKey: 'billing',
        },
        budget: null,
        usage: null,
        dropped: [],
      },
    };
  };
  const usage = {
    inputTokens: 63_310,
    outputTokens: 300,
    cacheReadTokens: 61_200,
    cacheWriteTokens: 2_100,
    largestCallInputTokens: 32_106,
    costUsd: 0.05,
  };

  it('resumes the session it was handed, and reports it with the usage as billed', async () => {
    const api = new FakeApi();
    const { p, seen } = provider([
      { type: 'session', sessionId: 'hermes:sess_old' },
      { type: 'final', text: 'Done.', usage },
    ]);
    const lines: string[] = [];
    await runDispatch(
      resumed(true),
      { ...deps(api, p), log: (_l, m) => void lines.push(m) },
      new AbortController().signal,
    );
    expect(seen.input?.resumeSessionId).toBe('hermes:sess_old');
    expect(api.completed.at(-1)?.body).toMatchObject({
      outcome: 'done',
      providerSessionId: 'hermes:sess_old',
      usage,
    });
    // One timing line per setup step (TE-12).
    for (const step of ['workdir', 'prompt', 'files', 'ready', 'provider'])
      expect(lines.some((l) => l.includes(`· setup · ${step} `))).toBe(true);
  });

  it('resumes it whatever its window holds: Hermes keeps the prompt it froze (HE-S33)', async () => {
    for (const onlyNew of [true, false]) {
      const { p, seen } = provider([{ type: 'final', text: 'Done.' }]);
      const out = await runDispatch(resumed(onlyNew), deps(new FakeApi(), p), new AbortController().signal);
      expect(out).toMatchObject({ outcome: 'done' });
      expect(seen.input?.resumeSessionId).toBe('hermes:sess_old');
    }
  });

  it('a provider’s slip in its counts can’t cost the turn its completion', () => {
    expect(
      completionUsage({
        inputTokens: 10.6,
        outputTokens: -3,
        cacheReadTokens: Number.NaN,
        largestCallInputTokens: 7,
        costUsd: -1,
      }),
    ).toEqual({ inputTokens: 11, outputTokens: 0, largestCallInputTokens: 7 });
  });
});

describe('runDispatch', () => {
  it.each(['answer', 'empty', 'timeout', 'cancel'] as const)(
    'recovers the missing disk result on its own session: %s',
    async (ending) => {
      const api = new FakeApi();
      const ctx = testContext();
      ctx.conversation.kind = 'dm';
      ctx.dispatch.trigger = 'dm';
      ctx.dispatch.threadRootId = 'msg_disk';
      const inputs: TurnInput[] = [];
      const external = new AbortController();
      const p: AgentProvider = {
        kind: 'local',
        available: async () => ({ ok: true, version: 'test' }),
        capabilities: () => ({ ...BASIC_CAPABILITIES, sessionResume: true }),
        async *runTurn(input, signal) {
          inputs.push(input);
          yield { type: 'session', sessionId: 'hermes:disk' };
          if (!input.replyOnly) {
            yield {
              type: 'tool_call',
              name: 'reply_in_thread',
              id: 'post',
              input: { messageId: 'msg_disk', text: 'On it.' },
            };
            yield { type: 'tool_result', name: 'reply_in_thread', id: 'post', ok: true };
            yield { type: 'tool_call', name: 'terminal', input: { command: 'df -h' } };
            yield { type: 'tool_call', name: 'report_done', input: { summary: 'Checked the disk' } };
            yield {
              type: 'final',
              text: 'MORE: the cleanup options',
              usage: { inputTokens: 1000, outputTokens: 30 },
            };
          } else if (ending === 'timeout' || ending === 'cancel') {
            if (ending === 'cancel') external.abort('shutdown');
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              );
          } else {
            yield {
              type: 'final',
              text: ending === 'answer' ? 'Old builds are filling the disk.' : 'MORE: cleanup',
              usage: { inputTokens: 200, outputTokens: 20 },
            };
          }
        },
      };
      const d = { ...deps(api, p), replyRecoveryMs: 20 };
      const out = await runDispatch(ctx, d, external.signal);
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toMatchObject({
        resumeSessionId: 'hermes:disk',
        freshIfSessionGone: false,
        replyOnly: true,
        attachments: [],
      });
      expect(inputs[1]?.prompt).toContain('Do not repeat');
      if (ending === 'answer') {
        expect(out.outcome).toBe('done');
        expect(d.mcp.calls).toEqual([
          {
            name: 'reply_in_thread',
            args: { messageId: 'msg_disk', text: 'Old builds are filling the disk.' },
          },
        ]);
        expect(api.completed[0]?.body.usage).toMatchObject({ inputTokens: 1200, outputTokens: 50 });
      } else {
        expect(out.outcome).toBe('failed');
        expect(d.mcp.calls).toEqual([]);
        expect(api.completed[0]?.body).toMatchObject({
          error: ending === 'cancel' ? RUNNER_SHUTDOWN : 'reply_incomplete',
        });
      }
    },
  );

  it('reports failure when the final answer cannot be delivered', async () => {
    const api = new FakeApi();
    const { p } = provider([{ type: 'final', text: 'The disk check is complete.' }]);
    const mcp = new FakeMcp();
    mcp.call = async () => ({ ok: false, isError: true, body: { status: 'blocked' } });
    const out = await runDispatch(testContext(), deps(api, p, mcp), new AbortController().signal);
    expect(out.outcome).toBe('failed');
    expect(api.completed[0]?.body.outcome).toBe('failed');
  });

  it('keeps a coding run’s completion independent of an optional conversation post', async () => {
    const api = new FakeApi();
    const { p } = provider([{ type: 'final', text: 'The branch is ready.' }]);
    const mcp = new FakeMcp();
    mcp.call = async () => ({ ok: false, isError: true, body: { status: 'blocked' } });
    const ctx = testContext();
    ctx.dispatch.mode = 'run';
    const out = await runDispatch(ctx, deps(api, p, mcp), new AbortController().signal);
    expect(out.outcome).toBe('done');
    expect(api.completed[0]?.body.outcome).toBe('done');
  });

  it('offers “More detail” from a last MORE: line of the final text, without the line', async () => {
    const api = new FakeApi();
    const { p } = provider([{ type: 'final', text: 'Use Typeset.\n\nMORE: why not the other two' }]);
    const d = deps(api, p);
    await runDispatch(testContext(), d, new AbortController().signal);
    expect(d.mcp.calls).toEqual([
      {
        name: 'post_message',
        args: { conversationId: 'cnv_pr482', text: 'Use Typeset.', more: 'why not the other two' },
      },
    ]);
  });

  it('a turn without commands or a scratch folder is told how to reach the conversation’s Files (FS-10)', async () => {
    const { p, seen } = provider([{ type: 'final', text: 'Done.' }]);
    const entry = {
      id: 'att_skp',
      name: 'model.skp',
      contentType: 'application/octet-stream',
      size: 1024,
      kind: 'file' as const,
      sha256: 'c'.repeat(64),
      folder: '',
      messageId: null,
      addedAt: '2026-10-05T09:00:00.000Z',
    };
    const ctx = {
      ...testContext(),
      files: {
        conversationId: 'cnv_billing-v2',
        count: 1,
        totalBytes: 1024,
        truncated: false,
        entries: [entry],
      },
    };
    await runDispatch(ctx, deps(new FakeApi(), p), new AbortController().signal);
    expect(seen.input?.prompt).toContain(
      'This conversation’s Files hold 1 file, 1 KB: list_files lists them and read_attachment reads text ones.',
    );
  });

  it('forwards the turn’s rate-limit readings, merged, with a beat and with complete (UI-R08)', async () => {
    const api = new FakeApi();
    const window = (kind: 'five_hour' | 'seven_day', usedPct: number, status: 'ok' | 'limited' = 'ok') => ({
      kind,
      label: kind === 'five_hour' ? '5-hour' : '7-day',
      usedPct,
      resetsAt: '2100-01-01T00:00:00.000Z',
      status,
      windowMinutes: kind === 'five_hour' ? 300 : 10080,
    });
    const reading = (at: string, windows: ReturnType<typeof window>[]) => ({
      type: 'rate_limits' as const,
      usage: {
        provider: 'claude' as const,
        kind: 'subscription' as const,
        plan: null,
        windows,
        observedAt: at,
        error: null,
      },
    });
    const { p } = provider([
      reading('2026-09-29T19:00:00.000Z', [window('five_hour', 81), window('seven_day', 40)]),
      reading('2026-09-29T19:00:05.000Z', [window('five_hour', 100, 'limited')]),
      { type: 'error', message: 'Rate limited', retryable: false, credentialState: 'quota_exhausted' },
    ]);
    await runDispatch(testContext(), deps(api, p), new AbortController().signal);
    const merged = {
      provider: 'claude',
      plan: null,
      observedAt: '2026-09-29T19:00:05.000Z',
      windows: [window('five_hour', 100, 'limited'), window('seven_day', 40)],
    };
    expect(api.completed.at(-1)?.body).toMatchObject({ outcome: 'failed', rateLimits: merged });
    // Beats carry a reading only when it changed.
    const beats = api.progressCalls.map((c) => c.body.rateLimits).filter(Boolean);
    expect(beats.length).toBeLessThanOrEqual(2);
  });

  it('reports provider errors and crashes as failed', async () => {
    const api = new FakeApi();
    const errored = await runDispatch(
      testContext(),
      deps(api, provider([{ type: 'error', message: 'no flex capacity for the model', retryable: true }]).p),
      new AbortController().signal,
    );
    expect(errored).toMatchObject({ outcome: 'failed', error: 'no flex capacity for the model' });
    const crashed = await runDispatch(
      testContext(),
      deps(api, provider([], { throws: 'codex exited with 137' }).p),
      new AbortController().signal,
    );
    expect(crashed).toMatchObject({ outcome: 'failed', error: 'codex exited with 137' });
    // Each failure says why, classified for the server's card (essentials-agents.md EA-08).
    expect(api.completed.map((c) => c.body)).toEqual([
      { outcome: 'failed', error: 'no flex capacity for the model', failure: { code: 'provider' } },
      { outcome: 'failed', error: 'codex exited with 137', failure: { code: 'internal' } },
    ]);
  });

  it('reports a turn broken by a take over (token revoked before the next beat) as cancelled', async () => {
    const api = new FakeApi();
    // The first beat (before the turn) sees a live dispatch; the tool call then fails because the
    // server ended the dispatch, and the next beat answers why.
    api.cancelOnProgress = 'taken_over';
    const { p } = provider([{ type: 'session', sessionId: 'sess-7' }], {
      throws: 'Streamable HTTP error: A live agent token is required.',
    });
    const out = await runDispatch(
      testContext(),
      { ...deps(api, p), progressMs: 60_000 },
      new AbortController().signal,
    );
    expect(out).toMatchObject({ outcome: 'cancelled', reason: 'taken_over', providerSessionId: 'sess-7' });
    // The session with the stable prompt it ran with (PE-03).
    expect(api.completed).toEqual([
      {
        id: 'dsp_turn',
        body: {
          outcome: 'cancelled',
          providerSessionId: 'sess-7',
        },
      },
    ]);
  });

  it('stops the provider when progress answers cancel (pause) and completes cancelled', async () => {
    const api = new FakeApi();
    api.cancelOnProgress = 'paused';
    const { p, seen } = provider([{ type: 'session', sessionId: 'sess-9' }], { hang: true });
    // Paused while the provider runs: on a slow machine the 5 ms beat may come twice before it starts, and a pause
    // then (rightly) stops the turn before the provider runs at all (DG-49).
    api.cancelWhen = () => seen.input !== undefined;
    const out = await runDispatch(testContext(), deps(api, p), new AbortController().signal);
    expect(seen.aborted).toBe(true);
    expect(out).toMatchObject({ outcome: 'cancelled', reason: 'paused', providerSessionId: 'sess-9' });
    expect(api.completed).toEqual([
      {
        id: 'dsp_turn',
        body: {
          outcome: 'cancelled',
          providerSessionId: 'sess-9',
        },
      },
    ]);
  });

  it('hands the dispatch back on shutdown instead of cancelling it', async () => {
    const api = new FakeApi();
    const { p, seen } = provider([], { hang: true });
    const external = new AbortController();
    const running = runDispatch(testContext(), deps(api, p), external.signal);
    // Shut down once the provider is running (not on a timer: a slow machine may not be there yet).
    await vi.waitFor(() => expect(seen.input).toBeDefined(), { timeout: 10_000, interval: 2 });
    external.abort('shutdown');
    const out = await running;
    expect(seen.aborted).toBe(true);
    expect(out).toMatchObject({ outcome: 'failed', reason: 'shutdown' });
    expect(api.completed[0]?.body).toEqual({ outcome: 'failed', error: RUNNER_SHUTDOWN });
  });

  it('fails the turn when no provider can run the agent', async () => {
    const api = new FakeApi();
    const out = await runDispatch(testContext(), deps(api, null), new AbortController().signal);
    expect(out).toMatchObject({ outcome: 'failed', error: 'No claude provider on this runner' });
  });
});

describe('runDispatch: observed activity (work-supervision WS-11, WS-12)', () => {
  it('sends reports early after new activity, keeps them after a failed beat, and says the last word before complete', async () => {
    const api = new FakeApi();
    let failures = 1;
    const answer = api.progress.bind(api);
    api.progress = async (id, body) => {
      if (body.activity && failures-- > 0) {
        api.progressCalls.push({ id, body });
        throw new Error('network down');
      }
      return answer(id, body);
    };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const p: AgentProvider = {
      kind: 'claude',
      available: async () => ({ ok: true, version: 'test' }),
      capabilities: () => BASIC_CAPABILITIES,
      async *runTurn() {
        yield {
          type: 'tool_call',
          name: 'Bash',
          id: 'c1',
          category: 'command',
          input: { command: 'pnpm test' },
        };
        await pause(450);
        yield {
          type: 'tool_result',
          name: 'Bash',
          id: 'c1',
          ok: false,
          outcome: { exitCode: 1, error: 'error' },
        };
        yield { type: 'thinking' };
        await pause(450);
        yield { type: 'tool_call', name: 'Read', id: 'r1', category: 'read', input: { file_path: 'a.ts' } };
        yield { type: 'final', text: '' };
      },
    };
    // No interval beats in this test: only the early flushes and the last word.
    const d = { ...deps(api, p), progressMs: 60_000 };
    const out = await runDispatch(
      testContext({ dispatch: { ...testContext().dispatch, attempts: 3, runnerId: 'rnr_t' } }),
      d,
      new AbortController().signal,
    );
    expect(out.outcome).toBe('done');
    const sent = api.progressCalls
      .filter((c) => c.body.activity)
      .map((c) =>
        (c.body.activity as { key: string; seq: number; status: string }[]).map((a) => [
          a.key,
          a.seq,
          a.status,
        ]),
      );
    expect(sent).toEqual([
      // The flush ≈300 ms after the call: the beat fails …
      [['3:c1', 1, 'running']],
      // … so the next one carries c1 again, as it is now.
      [['3:c1', 2, 'failed']],
      // The last word before complete: the read that was still running.
      [['3:r1', 3, 'running']],
    ]);
    // Every beat names the lease; the last one came before complete.
    expect(api.progressCalls.every((c) => c.body.runnerId === 'rnr_t' && c.body.attempt === 3)).toBe(true);
    expect(api.completed).toHaveLength(1);
  });
});

describe('“{name} is thinking” after the agent said something (WG-01)', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Each beat's `thinking`, runs of the same value folded into one. */
  const thinkingRuns = (api: FakeApi) =>
    api.progressCalls.map((c) => c.body.thinking).filter((v, i, all) => i === 0 || v !== all[i - 1]);
  const playing = (events: TurnEvent[]): AgentProvider => ({
    kind: 'claude',
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => BASIC_CAPABILITIES,
    async *runTurn() {
      for (const e of events) {
        yield e;
        await pause(40);
      }
    },
  });
  const preamble: TurnEvent = {
    type: 'tool_call',
    name: 'reply_in_thread',
    id: 'm1',
    input: { text: 'I’m using the health-report skill for a read-only check.' },
  };
  const command: TurnEvent = {
    type: 'tool_call',
    name: 'Bash',
    id: 'c1',
    category: 'command',
    input: { command: 'curl -s http://unraid/api' },
  };
  const answer: TurnEvent = {
    type: 'tool_call',
    name: 'reply_in_thread',
    id: 'm2',
    input: { text: 'BlackBox' },
  };

  it('a reply that posts, then works, thinks again until its answer', async () => {
    const api = new FakeApi();
    const out = await runDispatch(
      testContext(),
      deps(
        api,
        playing([preamble, command, { type: 'tool_result', name: 'Bash', id: 'c1', ok: true }, answer]),
      ),
      new AbortController().signal,
    );
    expect(out.outcome).toBe('done');
    expect(thinkingRuns(api)).toEqual([true, false, true, false]);
  });

  it('a retry of a turn that posted thinks only once it acts; a run never does', async () => {
    const retry = new FakeApi();
    const ctx = testContext();
    await runDispatch(
      { ...ctx, dispatch: { ...ctx.dispatch, postedAt: '2026-10-08T13:51:48.000Z' } },
      deps(retry, playing([{ type: 'thinking' }, command, answer])),
      new AbortController().signal,
    );
    expect(thinkingRuns(retry)).toEqual([false, true, false]);

    const run = new FakeApi();
    await runDispatch(
      { ...ctx, dispatch: { ...ctx.dispatch, mode: 'run' } },
      deps(run, playing([preamble, command, answer])),
      new AbortController().signal,
    );
    expect(thinkingRuns(run)).toEqual([false]);
  });
});

describe('working directory and confinement', () => {
  // A fake host: ~ and Whombat's own directory.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wb-runner-host-')));
  mkdirSync(join(home, 'Code', 'billing'), { recursive: true });
  const host = { home, whombatHome: join(home, '.whombat') };
  const withRuntime = (runtime: Partial<ReturnType<typeof testContext>['agent']['runtime']>) => {
    const ctx = testContext();
    return { ...ctx, agent: { ...ctx.agent, runtime: { ...ctx.agent.runtime, ...runtime } } };
  };

  it('confines a turn: credentials wherever the environment moved them, toolchain settings open', () => {
    const xdg = join(home, 'xdg');
    mkdirSync(join(xdg, 'mise'), { recursive: true });
    const commit = { allowRead: ['/r/config'], allowWrite: ['/r/objects'], denyWrite: ['/r/objects/info'] };
    const c = confinementFor(
      { cwd: '/w', release: async () => {}, note: null, git: null, commit, env: {} },
      { ...host, env: { XDG_CONFIG_HOME: xdg, CODEX_HOME: '/srv/codex' } },
      '/srv/workspaces',
    );
    expect(c.denyRead).toEqual(
      expect.arrayContaining([xdg, '/srv/codex', join(home, '.config'), '/srv/workspaces']),
    );
    expect(c.allowRead).toEqual([join(xdg, 'mise'), '/r/config']);
    expect(c.allowWrite).toEqual(['/r/objects']);
    expect(c.denyWrite).toEqual(['/r/objects/info']);
  });

  it('denies the credentials root to every turn, also outside WHOMBAT_HOME (review CON-3)', () => {
    const cwd = { cwd: '/w', release: async () => {}, note: null, git: null, commit: null, env: {} };
    // WHOMBAT_CREDENTIALS_ROOT=/var/lib/whombat-credentials (SUB-22): the runner's own root…
    const c = confinementFor(
      cwd,
      { ...host, credentialsRoot: '/var/lib/whombat-credentials' },
      '/srv/workspaces',
    );
    expect(c.denyRead).toContain('/var/lib/whombat-credentials');
    // …and wherever the environment says it is.
    const e = confinementFor(
      cwd,
      { ...host, env: { WHOMBAT_CREDENTIALS_ROOT: '/srv/creds' } },
      '/srv/workspaces',
    );
    expect(e.denyRead).toContain('/srv/creds');
    expect(
      credentialPaths({ home, whombatHome: '/x', env: { WHOMBAT_CREDENTIALS_ROOT: '/srv/creds' } }),
    ).toContain('/srv/creds');
  });

  it('keeps empty working directories in its private temporary directory, denied to every sandbox (BP-C38)', async () => {
    const runnerTmp = join(home, 'tmp', 'whombat-runner-test');
    mkdirSync(join(home, 'tmp'), { recursive: true });
    const api = new FakeApi();
    const { p, seen } = provider([{ type: 'final', text: 'ok' }], { kind: 'claude' });
    await runDispatch(
      withRuntime({ provider: 'claude' }),
      { ...deps(api, p), host: { ...host, runnerTmp } },
      new AbortController().signal,
    );
    expect(seen.input?.cwd).toBe(join(runnerTmp, 'scratch', testContext().dispatch.id));
    expect(statSync(runnerTmp).mode & 0o777).toBe(0o700);
    expect(statSync(join(runnerTmp, 'scratch')).mode & 0o777).toBe(0o700);
    expect(seen.input?.host?.confinement?.denyRead).toContain(runnerTmp);
  });

  it('makes every kind of folder in its temporary directory at once, private (M11)', async () => {
    const runnerTmp = join(home, 'tmp', 'whombat-runner-kinds');
    mkdirSync(join(home, 'tmp'), { recursive: true });
    const read = await runnerTmpDir({ ...host, runnerTmp }, 'read');
    expect(read).toBe(join(runnerTmp, 'read'));
    for (const kind of ['scratch', 'read'])
      expect(statSync(join(runnerTmp, kind)).mode & 0o777, kind).toBe(0o700);
  });

  it('refuses the turn when its temporary directory is not private, and says why', async () => {
    const runnerTmp = join(home, 'tmp', 'whombat-runner-open');
    mkdirSync(runnerTmp, { recursive: true });
    chmodSync(runnerTmp, 0o755);
    const api = new FakeApi();
    const { p, seen } = provider([{ type: 'final', text: 'never' }], { kind: 'claude' });
    const out = await runDispatch(
      withRuntime({ provider: 'claude' }),
      { ...deps(api, p), host: { ...host, runnerTmp } },
      new AbortController().signal,
    );
    expect(seen.input).toBeUndefined();
    expect(out.refusal).toBe(
      'I can’t start: Whombat’s scratch directory ~/tmp/whombat-runner-open is open to other users (mode 755). Someone who runs this Whombat can remove it (or start the runner with another TMPDIR), then ask me again.',
    );
  });
});

describe('TurnInput from keys', () => {
  it('writes only in a workspace on a branch the agent holds the key for', () => {
    const ctx = testContext();
    expect(sandboxFor(ctx)).toBe('read-only');
    const ws = {
      repo: 'whombat/billing',
      branch: 'feat/invoice-pdf',
      baseBranch: 'main',
      defaultBranch: 'main',
      writeApproved: false,
      cloneUrl: '',
      access: 'write' as const,
    };
    expect(sandboxFor({ ...ctx, workspace: ws })).toBe('workspace-write');
    expect(sandboxFor({ ...ctx, workspace: { ...ws, branch: 'main' } })).toBe('read-only');
    // An automation's read-only checkout stays read-only whatever the keys say (bp-automations BP-C26).
    expect(sandboxFor({ ...ctx, workspace: { ...ws, access: 'read' } })).toBe('read-only');
    // The key is classified against the repository's default branch, not the base (BP-C36): `main` with a base of
    // `develop` is still main, and no key of an agent writes it.
    expect(sandboxFor({ ...ctx, workspace: { ...ws, branch: 'main', baseBranch: 'develop' } })).toBe(
      'read-only',
    );
    expect(
      sandboxFor({
        ...ctx,
        workspace: { ...ws, branch: 'main', baseBranch: 'develop', writeApproved: true },
      }),
    ).toBe('read-only');
    expect(networkFor(ctx)).toBe(false);
    const researcher = {
      ...ctx,
      agent: {
        ...ctx.agent,
        keys: { can: [{ id: 'web.browse' as const, label: 'Browse the web' }], ask: [], cannot: [] },
      },
    };
    expect(networkFor(researcher)).toBe(true);
  });

  it('writes on a branch its key asks for only when a person approved this turn’s branch (BP-C37)', () => {
    const ctx = testContext();
    const feature = { id: 'branch.feature.readwrite' as const, label: 'Read and write feat/* branches' };
    const asks = {
      ...ctx,
      agent: {
        ...ctx.agent,
        keys: { can: [], ask: [feature], cannot: [{ id: 'merge.main' as const, label: 'Merge into main' }] },
      },
    };
    const ws = {
      repo: 'whombat/billing',
      branch: 'feat/bug-3',
      baseBranch: 'main',
      defaultBranch: 'main',
      cloneUrl: '',
      access: 'write' as const,
      writeApproved: false,
    };
    expect(sandboxFor({ ...asks, workspace: ws })).toBe('read-only');
    expect(sandboxFor({ ...asks, workspace: { ...ws, writeApproved: true } })).toBe('workspace-write');
    // A read-only checkout stays read-only, approved or not.
    expect(sandboxFor({ ...asks, workspace: { ...ws, access: 'read', writeApproved: true } })).toBe(
      'read-only',
    );
    // A key of No is not overridden by an approval.
    const no = { ...asks, agent: { ...asks.agent, keys: { can: [], ask: [], cannot: [feature] } } };
    expect(sandboxFor({ ...no, workspace: { ...ws, writeApproved: true } })).toBe('read-only');
    expect(turnPrompt({ ...asks, workspace: { ...ws, writeApproved: true } })).toContain(
      'checkout of whombat/billing on feat/bug-3: change code there',
    );
  });

  it('says what blocked means, and has network from the turn after “Browse the web” is given', () => {
    const ctx = testContext();
    // What a tool's blocked answer means is every session's whombat.md (HE-S31); the key's name is the tool's to say.
    expect(whombatMd(ctx)).toContain('blocked');
    expect(whombatMd(ctx)).toContain('grant_key');
    expect(networkFor(ctx)).toBe(false);
    // An approved request moves the key to `can`: the next dispatch's persona holds it.
    const k = ctx.agent.keys;
    const given = {
      ...ctx,
      agent: {
        ...ctx.agent,
        keys: { ...k, can: [...k.can, { id: 'web.browse' as const, label: 'Browse the web' }] },
      },
    };
    expect(networkFor(given)).toBe(true);
  });
});

describe('Runner', () => {
  it('runs claimed dispatches up to the concurrency limit and hands them back on stop', async () => {
    const api = new FakeApi();
    api.queue = [
      testContext({ dispatch: { ...testContext().dispatch, id: 'dsp_a' } }),
      testContext({ dispatch: { ...testContext().dispatch, id: 'dsp_b' } }),
      testContext({ dispatch: { ...testContext().dispatch, id: 'dsp_c' } }),
    ];
    const { p } = provider([], { hang: true });
    const runner = new Runner({
      api,
      registry: registryOf(p),
      serverUrl: 'http://whombat.test',
      workspacesRoot: '/tmp/whombat-test-workspaces',
      concurrency: 2,
      waitMs: 5,
      heartbeatMs: 5,
      progressMs: 5,
      managed: testPolicy(),
    });
    runner.start();
    // Wait for the state (two turns in flight, a heartbeat listing both), not for a fixed time.
    await vi.waitFor(
      () => {
        expect(runner.inFlight.sort()).toEqual(['dsp_a', 'dsp_b']);
        expect(api.heartbeats.at(-1)?.sort()).toEqual(['dsp_a', 'dsp_b']);
      },
      { timeout: 10_000, interval: 5 },
    );
    expect(api.queue).toHaveLength(1);
    await runner.stop();
    expect(api.completed.map((c) => [c.id, c.body.error]).sort()).toEqual([
      ['dsp_a', RUNNER_SHUTDOWN],
      ['dsp_b', RUNNER_SHUTDOWN],
    ]);
    expect(runner.inFlight).toEqual([]);
  });

  it('keeps a dispatch handed out to it again while its last run there still ends', async () => {
    const api = new FakeApi();
    const first = testContext({ dispatch: { ...testContext().dispatch, id: 'dsp_a', attempts: 1 } });
    const again = testContext({ dispatch: { ...testContext().dispatch, id: 'dsp_a', attempts: 2 } });
    api.queue = [first];
    let endFirst = () => {};
    const firstEnds = new Promise<void>((r) => {
      endFirst = r;
    });
    const p: AgentProvider = {
      kind: 'local',
      available: async () => ({ ok: true, version: 'test' }),
      capabilities: () => BASIC_CAPABILITIES,
      async *runTurn(input, signal) {
        const stopped = new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        // The first run ends by itself (it lost its lease); the second runs until it is stopped.
        await (input.context.dispatch.attempts === 1 ? Promise.race([firstEnds, stopped]) : stopped);
        yield* [];
      },
    };
    const runner = new Runner({
      api,
      registry: registryOf(p),
      serverUrl: 'http://whombat.test',
      workspacesRoot: '/tmp/whombat-test-workspaces',
      concurrency: 2,
      waitMs: 5,
      heartbeatMs: 5,
      progressMs: 5,
      managed: testPolicy(),
    });
    runner.start();
    await vi.waitFor(() => expect(runner.inFlight).toEqual(['dsp_a']), { timeout: 10_000, interval: 5 });
    api.queue.push(again);
    await vi.waitFor(() => expect(api.queue).toHaveLength(0), { timeout: 10_000, interval: 5 });
    endFirst();
    await vi.waitFor(() => expect(api.completed).toHaveLength(1), { timeout: 10_000, interval: 5 });
    // The second run is still this runner's: listed, and stopped with it.
    expect(runner.inFlight).toEqual(['dsp_a']);
    await runner.stop(3_000);
    expect(api.completed.map((c) => c.body.error)).toContain(RUNNER_SHUTDOWN);
  });
});
