/**
 * A person's pod on the runner (hermes-native.md HN-W01…HN-W16): started by the first turn, at most `cap` live turns,
 * restarted for another shape only when idle, quiesced for Hermes-home steps, stopped when idle; its routers hand a
 * command, a login, a browser connection and a model request only to the live turn of the session that asks, and its
 * egress is the person's plus their live turns' grants. The pod runs unwalled here (`unwalledSandbox`); the walls are
 * agent-runtime's `pod-sandbox.test.ts`, the commands' `commands/commands-sandbox.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, request } from 'node:http';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EgressPolicy, SandboxSession, SandboxTask } from '@whombat/agent-runtime';
import { FAKE_POD_HERMES } from '@whombat/agent-runtime/testing/hermes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandGuard } from './commands/api';
import { FakeServer } from './commands/fakes';
import { AgentNet } from './commands/net';
import type { CommandsBox } from './commands/place';
import { TurnCommands } from './commands/turn';
import { PodManager, type PodShape, type PodTurnRoutes } from './pods';
import { StandInChromium, StandInChromiumHost, StandInKeptServer } from './test-devtools';
import { unwalledSandbox } from './test-sandbox';

const shape = (root: string, over: Partial<PodShape> = {}): PodShape => ({
  profile: join(root, 'hermes'),
  bin: FAKE_POD_HERMES,
  installs: [],
  readable: [],
  path: [],
  env: { HERMES_HOME: join(root, 'hermes') },
  credential: null,
  denied: [],
  mcpUrl: 'http://127.0.0.1:9/mcp',
  egress: { allow: ['api.anthropic.com'] },
  ...over,
});

const routes = (dispatchId: string, over: Partial<PodTurnRoutes> = {}): PodTurnRoutes => ({
  dispatchId,
  commands: null,
  logins: null,
  gatewayToken: null,
  egress: { allow: [] },
  ...over,
});

/** A turn's commands for the pod's routing (no guard hits, no keys). */
function turnCommands(dispatchId: string): Promise<TurnCommands> {
  return TurnCommands.open(
    { api: new FakeServer(), guard: commandGuard, net: null, log: () => {} },
    {
      dispatchId,
      lease: { runnerId: 'rnr_test', attempt: 1 },
      context: null,
      binds: [],
      cwd: '/',
      env: {},
      readOnlyInside: [],
      wantsKeys: false,
    },
  );
}

/** One command's request to the pod's commands service: the environment it would run with, or its refusal. */
async function command(socketPath: string, session: string | null): Promise<Record<string, unknown>> {
  const socket = connect(socketPath);
  socket.write(`${JSON.stringify({ v: 1, session, cwd: '/', argv: ['bash', '-c', 'true'], tty: false })}\n`);
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buf = '';
      socket.on('data', (d: Buffer) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) resolve(buf.slice(0, nl));
      });
      socket.on('error', reject);
    });
    return JSON.parse(line) as Record<string, unknown>;
  } finally {
    socket.destroy();
  }
}

/** One line from the pod's logins socket for `request`. */
function askLogin(socketPath: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(JSON.parse(buf)));
    socket.write(`${JSON.stringify(body)}\n`);
  });
}

function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      stream.off('data', onData);
      resolve(buf.slice(0, nl));
    };
    stream.on('data', onData);
  });
}

describe('PodManager', () => {
  let root: string;
  let managers: PodManager[];
  let servers: Server[];
  let egress: EgressPolicy[];
  let tasks: SandboxTask[];
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
    root = mkdtempSync(join(tmpdir(), 'wb-pods-'));
    mkdirSync(join(root, 'hermes'), { recursive: true });
    mkdirSync(join(root, 'workspaces'), { recursive: true });
    managers = [];
    servers = [];
    egress = [];
    tasks = [];
  });

  afterEach(async () => {
    for (const m of managers) await m.close();
    for (const s of servers) s.close();
    for (const c of cleanups) await c();
    rmSync(root, { recursive: true, force: true });
  });

  function manager(over: Partial<ConstructorParameters<typeof PodManager>[0]> = {}): PodManager {
    const sandbox = unwalledSandbox();
    const m = new PodManager({
      sandboxes: {
        ...sandbox,
        async open(task: SandboxTask): Promise<SandboxSession> {
          tasks.push(task);
          const session = await sandbox.open(task);
          return { ...session, setEgress: (p) => egress.push(p) };
        },
      },
      hermes: () => ({ gateway: ['gateway', 'run'], acp: ['acp'] }),
      stateDir: join(root, 'pods'),
      hermesRoot: join(root, 'hermes'),
      roots: () => [join(root, 'workspaces')],
      serverUrl: 'http://127.0.0.1:9',
      log: () => {},
      ...over,
    });
    managers.push(m);
    return m;
  }

  it('starts the person’s pod on the first turn and hands it a hermes acp of the pod', async () => {
    const pods = manager();
    const turn = await pods.admit(shape(root), routes('d1'));
    mkdirSync(join(root, 'workspaces', 'repo'), { recursive: true });
    const viewer = turn.spawnAcp(join(root, 'workspaces', 'repo'));
    viewer.stdin.write('hi\n');
    expect(JSON.parse(await nextLine(viewer.stdout))).toMatchObject({ echo: 'hi' });
    expect(tasks).toHaveLength(1);
    // The pod's fixed environment; never a turn's token.
    expect(tasks[0]?.env).toMatchObject({ WHOMBAT_POD: '1' });
    expect(JSON.stringify(tasks[0]?.env)).not.toContain('TOKEN');
    expect(tasks[0]?.pod).toBe(true);
    viewer.stdin.destroy();
    await turn.release();
    // The next turn takes the same pod.
    const again = await pods.admit(shape(root), routes('d2'));
    expect(tasks).toHaveLength(1);
    await again.release();
  });

  it('keeps a person at `cap` live turns: the next waits for a slot', async () => {
    const pods = manager({ cap: 1 });
    const first = await pods.admit(shape(root), routes('d1'));
    let second: Awaited<ReturnType<PodManager['admit']>> | null = null;
    const waiting = pods.admit(shape(root), routes('d2')).then((t) => {
      second = t;
      return t;
    });
    // A third, given up while waiting: it never gets a slot.
    const stop = new AbortController();
    const gaveUp = pods.admit(shape(root), routes('d3'), stop.signal);
    stop.abort(new Error('stopped'));
    await expect(gaveUp).rejects.toThrow('stopped');
    expect(second).toBeNull();
    await first.release();
    await (await waiting).release();
    expect(pods.pods()[0]?.turns).toBe(0);
  });

  it('lets several turns of one person run at once up to the cap (step 2)', async () => {
    const pods = manager({ cap: 4 });
    const turns = await Promise.all(['a', 'b', 'c', 'd'].map((d) => pods.admit(shape(root), routes(d))));
    expect(pods.pods()[0]?.turns).toBe(4);
    for (const t of turns) await t.release();
  });

  it('restarts a pod for another shape only once it is idle', async () => {
    const pods = manager({ cap: 4 });
    const first = await pods.admit(shape(root), routes('d1'));
    const other = shape(root, {
      credential: { home: join(root, 'credentials', 'claude'), files: [], env: { CLAUDE_CONFIG_DIR: 'x' } },
    });
    const waiting = pods.admit(other, routes('d2'));
    // Still the first shape's pod while its turn runs.
    await first.release();
    const second = await waiting;
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.credentialHome).toBe(join(root, 'credentials', 'claude'));
    // A turn that needs no sign-in of its own (ChatGPT's is in the profile) runs in that pod.
    const third = await pods.admit(shape(root), routes('d3'));
    expect(tasks).toHaveLength(2);
    await third.release();
    await second.release();
  });

  it('quiesces for a Hermes-home step: running turns end, the pod stops, new turns wait', async () => {
    const pods = manager();
    const turn = await pods.admit(shape(root), routes('d1'));
    const quiesced = pods.quiesce();
    await turn.release();
    const lift = await quiesced;
    expect(pods.pods()).toEqual([]);
    let admitted = false;
    const waiting = pods.admit(shape(root), routes('d2')).then((t) => {
      admitted = true;
      return t;
    });
    // A step still runs: nothing is admitted until it lets go.
    await new Promise((r) => setImmediate(r));
    expect(admitted).toBe(false);
    lift();
    await (await waiting).release();
    expect(tasks).toHaveLength(2);
  });

  it('never cuts a running review short: a stop waits for its marker, a step only as long as it waits', async () => {
    const pods = manager({ reviewWaitMs: 60_000 });
    const turn = await pods.admit(shape(root), routes('d1'));
    await turn.release();
    const marker = join(shape(root).profile, 'whombat-review', '1-1');
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(marker, '');
    const gaveUp = new AbortController();
    const step = pods.quiesce(gaveUp.signal);
    gaveUp.abort(new Error('busy'));
    await expect(step).rejects.toThrow('busy');
    expect(pods.pods()[0]?.state).toBe('stopping');
    // The review ends: the pod goes.
    rmSync(marker);
    await vi.waitFor(() => expect(pods.pods()).toEqual([]));
  });

  it('stops an idle pod, and starts a new one after pod-init died', async () => {
    const stopped = vi.fn();
    const pods = manager({
      idleMs: 1,
      log: (_l, msg) => {
        if (msg.includes('stopped')) stopped();
      },
    });
    const turn = await pods.admit(shape(root), routes('d1'));
    await turn.release();
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
    expect(pods.pods()).toEqual([]);
    const next = await pods.admit(shape(root), routes('d2'));
    expect(tasks).toHaveLength(2);
    await next.release();
  });

  it('gives a command the live turn of the session it names, the agent’s home without one', async () => {
    const box: CommandsBox = {
      guard: commandGuard,
      net: new AgentNet({ control: join(root, 'none.sock'), log: () => {} }),
      proxySocket: join(root, 'none.sock'),
      log: () => {},
      agentHome: join(root, 'agent', 'home'),
      tools: null,
      nixLd: { ld: null, libraryPath: null },
      hostPath: '/usr/bin:/bin',
      containers: null,
      notify: async () => {},
    };
    const pods = manager({ cap: 2, commands: box, chromium: false });
    const ta = await pods.admit(shape(root), routes('da', { commands: await turnCommands('da') }));
    const tb = await pods.admit(shape(root), routes('db', { commands: await turnCommands('db') }));
    const service = ta.commands?.socket as string;
    const turnOf = async (session: string | null) =>
      ((await command(service, session)).run as { env: Record<string, string> } | undefined)?.env
        .WHOMBAT_TURN ?? null;
    // Before Hermes named the session: nobody's, so the agent's home and nothing of a turn.
    expect(await turnOf('sess-a')).toBeNull();
    ta.bind('sess-a');
    tb.bind('sess-b');
    expect(await turnOf('sess-a')).toBe('da');
    expect(await turnOf('sess-b')).toBe('db');
    expect(await turnOf(null)).toBeNull();
    expect(await turnOf('sess-other')).toBeNull();
    // A turn naming a session another live turn has takes nothing of it.
    tb.bind('sess-a');
    expect(await turnOf('sess-a')).toBe('da');
    await ta.release();
    expect(await turnOf('sess-a')).toBeNull();
    await tb.release();
    // The pod holds its commands: their service, their proxy, the agent's home.
    expect(tasks[0]?.commands?.socket).toBe(service);
    expect(tasks[0]?.stateDirs).toContain(join(root, 'agent', 'home'));
  });

  it('gives a login only to the live turn of the session that asks', async () => {
    const pods = manager({ cap: 2 });
    const fetched: string[] = [];
    const logins = (entry: string) => ({
      entries: new Set([entry]),
      fetchSecret: async (id: string) => {
        fetched.push(id);
        return { password: `pw-${id}`, otp: null };
      },
    });
    const ta = await pods.admit(shape(root), routes('da', { logins: logins('vlt_a') }));
    const tb = await pods.admit(shape(root), routes('db', { logins: logins('vlt_b') }));
    ta.bind('sess-a');
    tb.bind('sess-b');
    const socket = tasks[0]?.logins?.socket as string;
    expect(await askLogin(socket, { entry: 'vlt_a', session: 'sess-a' })).toEqual({
      password: 'pw-vlt_a',
      otp: null,
    });
    expect((await askLogin(socket, { entry: 'vlt_b', session: 'sess-a' })).error).toBeTruthy();
    expect((await askLogin(socket, { entry: 'vlt_a' })).error).toBeTruthy();
    await ta.release();
    expect((await askLogin(socket, { entry: 'vlt_a', session: 'sess-a' })).error).toBeTruthy();
    expect(fetched).toEqual(['vlt_a']);
    await tb.release();
  });

  it('sends model requests with the newest gateway turn’s token', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createHttpServer((req, res) => {
      seen.push(req.headers);
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const pods = manager({ cap: 3, serverUrl: `http://127.0.0.1:${port}`, lingerMs: 0 });
    const ta = await pods.admit(shape(root), routes('da'));
    const tb = await pods.admit(shape(root), routes('db', { gatewayToken: 'tok-b' }));
    const tc = await pods.admit(shape(root), routes('dc', { gatewayToken: 'tok-c' }));
    await ta.release();
    const gateway = tasks[0]?.gateway?.socket as string;
    const post = (headers: Record<string, string>) =>
      new Promise<number>((r) => {
        const req = request(
          { socketPath: gateway, path: '/ai-gateway/claude/v1/messages', method: 'POST', headers },
          (res) => {
            res.resume();
            r(res.statusCode ?? 0);
          },
        );
        req.end('{}');
      });
    expect(await post({ 'x-api-key': 'placeholder' })).toBe(200);
    expect(seen[0]?.['x-api-key']).toBe('tok-c');
    await tc.release();
    expect(await post({ authorization: 'Bearer placeholder' })).toBe(200);
    expect(seen[1]?.authorization).toBe('Bearer tok-b');
    await tb.release();
    expect(await post({ authorization: 'Bearer placeholder' })).toBe(503);
  });

  it('lets the person’s Hermes go once idle when a sign-in changes, and a home made again restarts it', async () => {
    const pods = manager({ cap: 2 });
    const home = join(root, 'credentials', 'mara', 'claude');
    mkdirSync(home, { recursive: true });
    const claude = shape(root, { credential: { home, files: [], env: { CLAUDE_CONFIG_DIR: home } } });
    const running = await pods.admit(claude, routes('d1'));
    pods.retire();
    // Still its turn's; the next turn waits for the pod to go, then starts a new one.
    const next = pods.admit(claude, routes('d2'));
    await running.release();
    await (await next).release();
    expect(tasks).toHaveLength(2);
    // The sign-in made its home again (a sign-out, then a new sign-in): the old mount is stale, a new pod mounts it.
    rmSync(home, { recursive: true });
    mkdirSync(home, { recursive: true });
    await (await pods.admit(claude, routes('d3'))).release();
    expect(tasks).toHaveLength(3);
    // An idle pod goes at once.
    pods.retire();
    await vi.waitFor(() => expect(pods.pods()).toEqual([]));
  });

  it('lets one turn per thread run: the next of the same thread waits, another thread doesn’t', async () => {
    const pods = manager({ cap: 4 });
    const first = await pods.admit(shape(root), routes('d1'), undefined, { threads: ['conv/t1'] });
    let same = false;
    const waiting = pods.admit(shape(root), routes('d2'), undefined, { threads: ['conv/t1'] }).then((t) => {
      same = true;
      return t;
    });
    const other = await pods.admit(shape(root), routes('d3'), undefined, { threads: ['conv/t2'] });
    expect(same).toBe(false);
    await first.release();
    await (await waiting).release();
    await other.release();
  });

  it('keeps an ended turn’s egress and gateway token for the review after its answer, then drops them', async () => {
    let now = 1_000;
    const pods = manager({ cap: 2, lingerMs: 50, now: () => now });
    const turn = await pods.admit(
      shape(root),
      routes('d1', { egress: { allow: ['ollama.test'] }, gatewayToken: 'tok' }),
    );
    await turn.release();
    expect(egress.at(-1)?.allow).toEqual(['api.anthropic.com', 'ollama.test']);
    now += 60;
    await vi.waitFor(() => expect(egress.at(-1)?.allow).toEqual(['api.anthropic.com']));
  });

  it('opens the egress of the person’s live turns while they run', async () => {
    const pods = manager({ cap: 2, lingerMs: 0 });
    const ta = await pods.admit(shape(root), routes('da', { egress: { allow: 'public' } }));
    expect(egress.at(-1)?.allow).toBe('public');
    const tb = await pods.admit(shape(root), routes('db', { egress: { allow: ['ollama.test'] } }));
    await ta.release();
    expect(egress.at(-1)?.allow).toEqual(['api.anthropic.com', 'ollama.test']);
    await tb.release();
    expect(egress.at(-1)?.allow).toEqual(['api.anthropic.com']);
  });
  /** The box's commands for a pod with the person's browser (a stand-in Chromium, no holder). */
  const browserBox = (): CommandsBox => ({
    guard: commandGuard,
    net: new AgentNet({ control: join(root, 'none.sock'), log: () => {} }),
    proxySocket: join(root, 'none.sock'),
    log: () => {},
    agentHome: join(root, 'agent', 'home'),
    tools: null,
    nixLd: { ld: null, libraryPath: null },
    hostPath: '/usr/bin:/bin',
    containers: null,
    notify: async () => {},
  });

  /** A pod whose browser is a stand-in Chromium, and the server's kept sites standing in. */
  async function keptPods(over: Partial<ConstructorParameters<typeof PodManager>[0]> = {}) {
    const chromium = await StandInChromium.open();
    const host = new StandInChromiumHost(chromium);
    const server = new StandInKeptServer();
    const logs: string[] = [];
    const pods = manager({
      cap: 2,
      commands: browserBox(),
      chromium: true,
      browserHost: () => host,
      keptSites: server.api,
      log: (_l, msg, extra) => logs.push(`${msg} ${JSON.stringify(extra ?? {})}`),
      ...over,
    });
    cleanups.push(async () => {
      await host.kill();
      await chromium.close();
    });
    /** Hermes's first CDP request through the pod's relay: Chromium starts for it. */
    const browse = (socketPath: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ socketPath, path: '/json/list', headers: { host: '127.0.0.1' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
    return { chromium, host, server, pods, logs, browse };
  }

  it('keeps nothing by default: no cookie read, sent or restored, no renewal', async () => {
    const { chromium, server, pods, browse } = await keptPods({ idleMs: 1 });
    const turn = await pods.admit(shape(root), routes('d1'));
    turn.bind('sess-1');
    expect(await browse(turn.browser?.socket as string)).toBe(200);
    chromium.cookies.push({ name: 'sid', value: 'secret-sid', domain: 'accounts.example.com', path: '/' });
    chromium.pages = ['https://accounts.example.com/'];
    // A turn that may not keep sites (an outsiders’ turn has no say): refused, and nothing read.
    const socket = tasks[0]?.logins?.socket as string;
    expect(
      await askLogin(socket, { keep: { origins: ['https://accounts.example.com'] }, session: 'sess-1' }),
    ).toEqual({ ok: false, error: expect.any(String) });
    await turn.release();
    await vi.waitFor(() => expect(pods.pods()).toEqual([]));
    // The fresh browser asked once and got nothing; nothing else happened.
    expect(server.methods()).toEqual(['restore']);
    expect(chromium.heard.filter((h) => !h.startsWith('GET'))).toEqual([]);
  });

  it('keeps a site for a person’s turn without logins, renews it after the turn and at the stop', async () => {
    const { chromium, server, pods, logs, browse } = await keptPods();
    const turn = await pods.admit(shape(root), routes('d1', { keptSites: server.turn() }));
    turn.bind('sess-1');
    const socket = tasks[0]?.logins?.socket as string;
    expect(await browse(turn.browser?.socket as string)).toBe(200);
    chromium.cookies.push(
      { name: 'sid', value: 'secret-sid', domain: 'accounts.example.com', path: '/', httpOnly: true },
      { name: 'other', value: 'secret-other', domain: '.elsewhere.test', path: '/' },
    );
    chromium.pages = ['https://accounts.example.com/home'];
    const kept = await askLogin(socket, {
      keep: { origins: ['https://accounts.example.com'], hours: 8 },
      session: 'sess-1',
    });
    expect(kept).toMatchObject({ ok: true, site: { site: 'accounts.example.com', hours: 8 } });
    expect(JSON.stringify(kept)).not.toContain('secret-');
    expect(server.calls.at(-1)?.cookies?.map((c) => c.name)).toEqual(['sid']);
    // Another session's request reaches nothing; the list is the server's.
    expect((await askLogin(socket, { kept: 'list', session: 'sess-other' })).ok).toBe(false);
    expect(await askLogin(socket, { kept: 'list', session: 'sess-1' })).toMatchObject({
      ok: true,
      sites: [{ site: 'accounts.example.com' }],
    });
    // The turn leaves the pod with the site's page open: renewed with its cookies now.
    await turn.release();
    await vi.waitFor(() => expect(server.methods()).toContain('renew'));
    expect(
      server.calls
        .filter((c) => c.method === 'renew')
        .at(-1)
        ?.cookies?.map((c) => c.name),
    ).toEqual(['sid']);
    // The pod stops: renewed once more while its Chromium still runs.
    await pods.close();
    expect(server.methods().filter((m) => m === 'renew')).toHaveLength(2);
    expect(logs.join('\n')).not.toContain('secret-');
  });

  it('renews the kept sites from a Chromium the watchdog ends, and the next one starts with them', async () => {
    const { chromium, host, server, pods, browse } = await keptPods({
      browserWatch: { intervalMs: 20, commandMs: 100, closeMs: 200 },
    });
    const turn = await pods.admit(shape(root), routes('d1', { keptSites: server.turn() }));
    turn.bind('sess-1');
    const socket = tasks[0]?.logins?.socket as string;
    expect(await browse(turn.browser?.socket as string)).toBe(200);
    chromium.cookies.push({ name: 'sid', value: 'secret-sid', domain: 'accounts.example.com', path: '/' });
    chromium.pages = ['https://accounts.example.com/home'];
    expect(
      await askLogin(socket, { keep: { origins: ['https://accounts.example.com'] }, session: 'sess-1' }),
    ).toMatchObject({ ok: true });
    // The site signed in again, then the browser's renderers died: no page answers, no new one starts.
    chromium.cookies = chromium.cookies.map((c) => ({ ...c, value: 'secret-sid-2' }));
    chromium.stuckPages.add('https://accounts.example.com/home');
    chromium.noNewPages = true;
    await vi.waitFor(() => expect(host.ended).toBe(1), { timeout: 5000 });
    // Renewed from it before it went, with the cookies as they were then.
    expect(
      server.calls
        .filter((c) => c.method === 'renew')
        .at(-1)
        ?.cookies?.map((c) => c.value),
    ).toEqual(['secret-sid-2']);
    // Hermes's next request gets a fresh Chromium, signed in to the kept site.
    expect(await browse(turn.browser?.socket as string)).toBe(200);
    expect(host.starts).toBe(2);
    expect(chromium.pages).toEqual([]);
    expect(chromium.cookies.map((c) => [c.name, c.value])).toEqual([['sid', 'secret-sid-2']]);
    await turn.release();
  });

  it('starts a new pod’s browser signed in to the kept site, before Hermes gets it', async () => {
    const { chromium, server, pods, browse } = await keptPods();
    await server.turn().keep({
      origins: ['https://accounts.example.com'],
      cookies: [{ name: 'sid', value: 'secret-sid', domain: 'accounts.example.com', path: '/' }],
    });
    const turn = await pods.admit(shape(root), routes('d1'));
    chromium.heard.length = 0;
    expect(await browse(turn.browser?.socket as string)).toBe(200);
    expect(chromium.names()).toEqual(['sid']);
    expect(chromium.heard.indexOf('Storage.setCookies')).toBeGreaterThanOrEqual(0);
    expect(chromium.heard.indexOf('Storage.setCookies')).toBeLessThan(
      chromium.heard.indexOf('GET /json/list'),
    );
    await turn.release();
  });
});
