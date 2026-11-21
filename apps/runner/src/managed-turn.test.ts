import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  type ManagedSandbox,
  type SandboxSession,
  type SandboxTask,
  SandboxUnavailable,
  type SandboxViolation,
  type TurnEvent,
  type TurnInput,
  type WhombatMcp,
} from '@whombat/agent-runtime';
import { PAGES_MANIFEST, zipEnd, zipEntries, zipEntryData, zipEntryRange } from '@whombat/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import { FakeServer } from './commands/fakes';
import { AgentNet } from './commands/net';
import { nextGeneration, RunnerAlreadyRunning } from './generation';
import { egressPolicy, type ManagedPolicy } from './managed';
import { parseGrants } from './managed-setup';
import { PREVIEW_NO_FOLDER } from './preview';
import { testContext } from './test-context';
import { runDispatch, type TurnDeps } from './turn';

/** The contract's `DispatchContext.credential` (contracts 3.0, one-person.md OP-S09) as the server sends it with a claim. */
function withCredential<T extends object>(ctx: T, provider: 'claude' | 'codex' = 'claude'): T {
  return { ...ctx, credential: { v: 1, provider, authMode: 'api_key' } };
}

class Api implements RunnerApi {
  completed: Record<string, unknown>[] = [];
  beats: Record<string, unknown>[] = [];
  failProgress = false;
  async claim() {
    return null;
  }
  async progress(_id: string, body: Record<string, unknown>) {
    if (this.failProgress) throw new Error('ECONNREFUSED');
    this.beats.push(body);
    return { cancel: false, reason: null };
  }
  async complete(_id: string, body: Record<string, unknown>) {
    this.completed.push(body);
  }
  async heartbeat() {
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

const mcp: WhombatMcp = { call: async () => ({ ok: true, isError: false, body: {} }), close: async () => {} };

function fakeProvider(
  run: (input: TurnInput, signal: AbortSignal) => AsyncGenerator<TurnEvent>,
): AgentProvider {
  return {
    kind: 'claude',
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => BASIC_CAPABILITIES,
    runTurn: run,
  };
}

/** A sandbox that records what it was asked for (the real one is tested in agent-runtime). */
function stubSandbox(opts: { unavailable?: string; violations?: SandboxViolation[] } = {}) {
  const tasks: SandboxTask[] = [];
  let killed = 0;
  let closed = 0;
  const sandbox = {
    node: process.execPath,
    config: { deniedPaths: [], bwrap: '/usr/bin/bwrap' },
    async open(task: SandboxTask): Promise<SandboxSession> {
      if (opts.unavailable) throw new SandboxUnavailable(opts.unavailable);
      tasks.push(task);
      return {
        id: task.id,
        mcpUrl: 'http://127.0.0.1:47100/mcp',
        spawn: () => {
          throw new Error('not in this test');
        },
        kill: async () => {
          killed++;
        },
        close: async () => {
          closed++;
        },
        violations: async () => opts.violations ?? [],
        stats: async () => null,
        commandsCgroup: () => null,
        egressEvents: () => [],
        setEgress: () => {},
        cgroupPath: () => '/sys/fs/cgroup/test',
      };
    },
  } as unknown as ManagedSandbox;
  return { sandbox, tasks, killed: () => killed, closed: () => closed };
}

let root: string;
let credentials: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-mturn-'));
  credentials = join(root, 'credentials');
});

/** The person's own Claude sign-in (an API key, as the sign-in flow stores it), the one home of Claude (OP-09). */
function signIn(accountId: string) {
  const home = join(credentials, 'claude');
  mkdirSync(home, { recursive: true });
  chmodSync(join(credentials), 0o700);
  chmodSync(home, 0o700);
  writeFileSync(join(home, 'api-key'), 'sk-ant-test-0000000000000000000000\n', { mode: 0o600 });
  writeFileSync(
    join(home, 'whombat-credential.json'),
    JSON.stringify({
      v: 1,
      provider: 'claude',
      authMode: 'api_key',
      owner: 'person',
      accountId,
      createdAt: '2026-09-25T10:00:00.000Z',
      expiresAt: null,
      verified: 'valid',
      verifiedAt: null,
      creatorAttested: false,
      login: null,
      signal: null,
    }),
    { mode: 0o600 },
  );
  return home;
}

/** The agent's dispatch for the person, with the claim's credential (the person asked: PI). */
function personCtx() {
  const ctx = testContext();
  const person = ctx.principals.find((p) => p.kind === 'person') ?? ctx.principals[0];
  return withCredential({ ...ctx, onBehalfOf: person ? { person, connections: [] } : null } as typeof ctx);
}

function deps(api: Api, provider: AgentProvider, managed: ManagedPolicy): TurnDeps {
  const home = join(root, 'whombat');
  return {
    api,
    registry: { claims: () => ['claude'], for: () => provider, report: () => [] },
    serverUrl: 'http://127.0.0.1:4620',
    workspacesRoot: join(home, 'workspaces'),
    host: {
      home: root,
      whombatHome: home,
      runnerTmp: join(root, 'tmp'),
      env: { PATH: '/usr/bin' },
    },
    log: () => {},
    progressMs: 5,
    connectMcp: async () => mcp,
    managed,
  };
}

const done = (text = 'ok'): TurnEvent[] => [{ type: 'final', text }];
async function* play(events: TurnEvent[]) {
  for (const e of events) yield e;
}

describe('a managed turn', () => {
  it('runs in the sandbox with the person’s home, the provider’s egress and the MCP bridge', async () => {
    const ctx = personCtx();
    const home = signIn(ctx.onBehalfOf?.person.id as string);
    const sb = stubSandbox();
    let seen: TurnInput | undefined;
    const api = new Api();
    const out = await runDispatch(
      ctx,
      deps(
        api,
        fakeProvider(async function* (input) {
          seen = input;
          yield* play(done());
        }),
        { credentialsRoot: credentials, sandbox: sb.sandbox, generation: 3 },
      ),
      new AbortController().signal,
    );
    expect(out.outcome).toBe('done');
    expect(seen?.host?.credentialHome).toBe(home);
    expect(seen?.host?.spawn).toBeTypeOf('function');
    expect(seen?.mcp.url).toBe('http://127.0.0.1:47100/mcp');
    // The person's home is the provider's login, never readable by the tools in its own sandbox.
    expect(seen?.host?.confinement?.denyRead).toContain(home);
    // Only the CLI's config dir is writable (a subscription refreshes its login there), the key file readable;
    // Whombat's record next to them isn't in the task.
    expect(sb.tasks[0]).toMatchObject({
      credentialHome: join(home, 'config'),
      readable: expect.arrayContaining([join(home, 'api-key')]),
      mcpUrl: 'http://127.0.0.1:4620/mcp',
      egress: { allow: expect.arrayContaining(['api.anthropic.com', 'github.com']) },
    });
    expect(sb.tasks[0]?.egress.allow).not.toContain('api.openai.com');
    expect(sb.closed()).toBe(1);
  });

  it('gets any public host (never a private one) only with the web key, and grants only when configured', () => {
    const grants = parseGrants('10.20.0.0/16:5432;fd12::/48');
    expect(egressPolicy('codex', { network: true }, { grants })).toEqual({
      allow: 'public',
      grants: [{ cidr: '10.20.0.0/16', ports: [5432] }, { cidr: 'fd12::/48' }],
    });
    const plain = egressPolicy('codex', { network: false }, { egressAllow: ['registry.npmjs.org'] });
    expect(plain.allow).toEqual(
      expect.arrayContaining(['api.openai.com', 'chatgpt.com', 'github.com', 'registry.npmjs.org']),
    );
    expect(plain.allow).not.toContain('api.anthropic.com');
    expect(plain.grants).toBeUndefined();
  });

  const outcomes: [
    string,
    () => {
      managed: Partial<ManagedPolicy>;
      events?: TurnEvent[];
      throws?: string;
      prepare?: (accountId: string) => void;
    },
    string,
    boolean,
  ][] = [
    // A refusal before the turn keeps the resolver's app code (SUB-50); what the turn ran into is `managed:<outcome>`.
    ['not signed in', () => ({ managed: {} }), 'provider.not_signed_in', true],
    [
      'auth expired',
      () => ({
        managed: {},
        prepare: signIn,
        events: [{ type: 'error', message: 'OAuth token has expired. Please run /login', retryable: false }],
      }),
      'managed:auth_expired',
      true,
    ],
    [
      'quota exhausted',
      () => ({
        managed: {},
        prepare: signIn,
        events: [{ type: 'error', message: 'Claude AI usage limit reached|1790000000', retryable: false }],
      }),
      'managed:quota_exhausted',
      true,
    ],
    [
      'provider outage',
      () => ({
        managed: {},
        prepare: signIn,
        events: [{ type: 'error', message: 'API Error: 529 overloaded_error', retryable: true }],
      }),
      'managed:provider_outage',
      false,
    ],
    [
      'provider missing',
      () => ({ managed: {}, prepare: signIn, throws: 'spawn /opt/claude ENOENT' }),
      'managed:provider_missing',
      true,
    ],
  ];

  it.each(outcomes)(
    '%s → its own outcome, and no other login is tried',
    async (_name, setup, code, final) => {
      const s = setup();
      const ctx = personCtx();
      s.prepare?.(ctx.onBehalfOf?.person.id as string);
      const sb = stubSandbox();
      const api = new Api();
      const out = await runDispatch(
        ctx,
        deps(
          api,
          fakeProvider(async function* () {
            yield* play(s.events ?? []);
            if (s.throws) throw new Error(s.throws);
          }),
          { credentialsRoot: credentials, sandbox: sb.sandbox, ...s.managed },
        ),
        new AbortController().signal,
      );
      expect(out.outcome).toBe('failed');
      expect(api.completed.at(-1)).toMatchObject({ outcome: 'failed', error: code });
      // Final states are refusals the agent says (never retried); an outage is an ordinary, retryable failure.
      expect(Boolean(api.completed.at(-1)?.refusal)).toBe(final);
    },
  );

  it('records the resolver’s own code and words when the person hasn’t signed in (SUB-50)', async () => {
    let ran = false;
    const api = new Api();
    const out = await runDispatch(
      personCtx(),
      deps(
        api,
        fakeProvider(async function* () {
          ran = true;
          yield* play(done());
        }),
        { credentialsRoot: credentials, sandbox: stubSandbox().sandbox },
      ),
      new AbortController().signal,
    );
    expect(ran).toBe(false);
    const said = /haven’t signed in to Claude on this Whombat/;
    expect(out).toMatchObject({
      outcome: 'failed',
      error: 'provider.not_signed_in',
      refusal: expect.stringMatching(said),
    });
    // What the server records on the dispatch (and the app reads): the contract's code, and the agent's words.
    expect(api.completed.at(-1)).toMatchObject({ outcome: 'failed', error: 'provider.not_signed_in' });
  });

  it('is refused, never run outside, when the sandbox is missing or can’t start', async () => {
    const ctx = personCtx();
    signIn(ctx.onBehalfOf?.person.id as string);
    for (const managed of [
      { credentialsRoot: credentials },
      { credentialsRoot: credentials, sandbox: stubSandbox({ unavailable: 'no user namespaces' }).sandbox },
    ]) {
      let ran = false;
      const api = new Api();
      await runDispatch(
        ctx,
        deps(
          api,
          fakeProvider(async function* () {
            ran = true;
            yield* play(done());
          }),
          managed,
        ),
        new AbortController().signal,
      );
      expect(ran).toBe(false);
      expect(api.completed.at(-1)).toMatchObject({
        outcome: 'failed',
        refusal: expect.stringMatching(/sandbox/),
      });
    }
  });

  it('reports the limit that stopped it', async () => {
    const ctx = personCtx();
    signIn(ctx.onBehalfOf?.person.id as string);
    const sb = stubSandbox({ violations: ['output_limit'] });
    const api = new Api();
    await runDispatch(
      ctx,
      deps(
        api,
        fakeProvider(async function* () {
          yield { type: 'error', message: 'Claude exited before finishing the turn', retryable: true };
        }),
        { credentialsRoot: credentials, sandbox: sb.sandbox },
      ),
      new AbortController().signal,
    );
    expect(api.completed.at(-1)).toMatchObject({
      error: 'managed:output_limit',
      refusal: expect.stringMatching(/printed/),
    });
  });

  it('stops at its wall time and kills the task', async () => {
    const ctx = personCtx();
    signIn(ctx.onBehalfOf?.person.id as string);
    const sb = stubSandbox();
    const api = new Api();
    const out = await runDispatch(
      ctx,
      deps(
        api,
        fakeProvider(async function* (_input, signal) {
          await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        }),
        { credentialsRoot: credentials, sandbox: sb.sandbox, wallMs: 50 },
      ),
      new AbortController().signal,
    );
    expect(out.outcome).toBe('failed');
    expect(api.completed.at(-1)).toMatchObject({ error: 'managed:wall_time' });
    expect(sb.closed()).toBe(1);
  });

  it('stops and kills the task at once when it can’t renew its lease for a lease period', async () => {
    const ctx = personCtx();
    signIn(ctx.onBehalfOf?.person.id as string);
    const sb = stubSandbox();
    const api = new Api();
    let aborted = false;
    await runDispatch(
      ctx,
      deps(
        api,
        fakeProvider(async function* (_input, signal) {
          // The server stops answering once the task runs: on a slow machine a lease period can pass before the
          // provider starts, and the turn then (rightly) never starts it (DG-49).
          api.failProgress = true;
          await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
          aborted = true;
        }),
        { credentialsRoot: credentials, sandbox: sb.sandbox, leaseMs: 40 },
      ),
      new AbortController().signal,
    );
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sb.killed()).toBeGreaterThanOrEqual(1);
  });
});

describe('the runner generation', () => {
  it('advances once per start and is held by one runner at a time', async () => {
    const state = join(root, 'state');
    const first = await nextGeneration(state, 'rnr_box');
    expect(first).toMatchObject({ generation: 1, prefix: 'g1', runnerId: 'rnr_box_g1' });
    await expect(nextGeneration(state, 'rnr_box')).rejects.toBeInstanceOf(RunnerAlreadyRunning);
    await first.lock.release();
    const second = await nextGeneration(state, 'rnr_box');
    expect(second.runnerId).toBe('rnr_box_g2');
    await second.lock.release();
  });
});

describe('previews from the turn’s own folder (resourceful-agents.md RA-DS70)', () => {
  const commandsCtx = { productionServers: [], homeNetworks: ['192.168.1.0/24'], lan: false };
  const commandsDeps = (): NonNullable<TurnDeps['commands']> => ({
    box: {
      guard: () => null,
      net: new AgentNet({ control: join(tmpdir(), 'wb-none.sock'), log: () => {} }),
      proxySocket: join(tmpdir(), 'wb-none.sock'),
      log: () => {},
      agentHome: join(credentials, '..', 'agent', 'home'),
      tools: null,
      nixLd: { ld: null, libraryPath: null },
      hostPath: '/usr/bin:/bin',
      containers: null,
      notify: async () => {},
    },
    api: new FakeServer(),
    chromium: false,
  });

  /** A runner API whose server asks for one folder (a browser_preview) once the provider built it. */
  class PreviewApi extends Api {
    want: { id: string; dir: string; pages?: { open: string; title: string } } | null = null;
    sent: Record<string, unknown>[] = [];
    /** Page sets sent (`show_pages`), as the parts of their files. */
    sets: Uint8Array[][] = [];
    #got: (() => void) | null = null;
    readonly got = new Promise<void>((r) => {
      this.#got = r;
    });
    override async progress() {
      return { cancel: false, reason: null, ...(this.want ? { previews: [this.want] } : {}) };
    }
    // Called unbound, like the real API's functions.
    submitPreview = async (_id: string, _previewId: string, body: Record<string, unknown>) => {
      this.sent.push(body);
      this.#got?.();
    };
    submitPages = async (_id: string, _previewId: string, _lease: unknown, parts: readonly Uint8Array[]) => {
      this.sets.push([...parts]);
      this.#got?.();
    };
  }
  const askFor = (
    api: PreviewApi,
    dir: string,
    build?: (cwd: string) => void,
    pages?: { open: string; title: string },
  ) =>
    fakeProvider(async function* (input) {
      build?.(input.cwd);
      api.want = { id: 'pvw_aaaaaaaaaaaa', dir, ...(pages ? { pages } : {}) };
      await Promise.race([api.got, new Promise((r) => setTimeout(r, 2000))]);
      yield* play(done());
    });

  it('a conversation turn reads a preview or an upload from the work folder, by any of its names (RA-DS70)', async () => {
    const ctx = { ...personCtx(), commands: commandsCtx } as ReturnType<typeof personCtx>;
    signIn(ctx.onBehalfOf?.person.id as string);
    for (const dir of ['site/dist', '~/work/site/dist']) {
      const api = new PreviewApi();
      const out = await runDispatch(
        ctx,
        {
          ...deps(
            api,
            askFor(api, dir, (cwd) => {
              mkdirSync(join(cwd, 'site', 'dist'), { recursive: true });
              writeFileSync(join(cwd, 'site', 'dist', 'index.html'), '<h1>Built in the work folder</h1>');
            }),
            { credentialsRoot: credentials, sandbox: stubSandbox().sandbox, generation: 3 },
          ),
          commands: commandsDeps(),
        },
        new AbortController().signal,
      );
      expect(out.outcome).toBe('done');
      expect(api.sent).toHaveLength(1);
      const files = api.sent[0]?.files as { path: string; data: string }[];
      expect(files.map((f) => [f.path, Buffer.from(f.data, 'base64').toString()])).toEqual([
        ['index.html', '<h1>Built in the work folder</h1>'],
      ]);
    }
  });

  it('a page set is read from the work folder, packed and sent as its bytes (page-sets.md)', async () => {
    const ctx = { ...personCtx(), commands: commandsCtx } as ReturnType<typeof personCtx>;
    signIn(ctx.onBehalfOf?.person.id as string);
    const api = new PreviewApi();
    const build = (cwd: string) => {
      mkdirSync(join(cwd, 'mockups', 'round-2'), { recursive: true });
      writeFileSync(join(cwd, 'mockups', 'index.html'), '<a href="round-2/">Round 2</a><img src="gone.png">');
      writeFileSync(join(cwd, 'mockups', 'round-2', 'index.html'), '<h1>Round 2</h1>');
    };
    const out = await runDispatch(
      ctx,
      {
        ...deps(api, askFor(api, 'mockups', build, { open: 'index.html', title: 'Mockups' }), {
          credentialsRoot: credentials,
          sandbox: stubSandbox().sandbox,
          generation: 3,
        }),
        commands: commandsDeps(),
      },
      new AbortController().signal,
    );
    expect(out.outcome).toBe('done');
    expect(api.sent).toEqual([]);
    expect(api.sets).toHaveLength(1);
    const zip = Buffer.concat((api.sets[0] ?? []).map((p) => Buffer.from(p)));
    const end = zipEnd(zip, zip.length);
    if (!end) throw new Error('not a set');
    const entries = zipEntries(
      zip.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
      end,
    );
    if (!Array.isArray(entries)) throw new Error(entries.error);
    // No browser in this turn: no cover.
    expect(entries.map((e) => e.path)).toEqual(['index.html', 'round-2/index.html', PAGES_MANIFEST]);
    const last = entries.at(-1);
    if (!last) throw new Error('no manifest');
    const range = zipEntryRange(last);
    const manifest = JSON.parse(
      Buffer.from(zipEntryData(last, zip.subarray(range.start, range.end)) as Uint8Array).toString(),
    );
    expect(manifest).toMatchObject({ title: 'Mockups', open: 'index.html', cover: false });
    expect(manifest.problems).toEqual([expect.stringContaining('gone.png')]);
  });

  it('a turn without a folder of its own says where previews and uploads are read from', async () => {
    const ctx = personCtx();
    signIn(ctx.onBehalfOf?.person.id as string);
    const api = new PreviewApi();
    await runDispatch(
      ctx,
      deps(api, askFor(api, 'dist'), {
        credentialsRoot: credentials,
        sandbox: stubSandbox().sandbox,
        generation: 3,
      }),
      new AbortController().signal,
    );
    expect(api.sent).toEqual([{ error: PREVIEW_NO_FOLDER }]);
  });
});
