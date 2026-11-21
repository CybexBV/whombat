/**
 * The person's pod with the real Hermes (hermes-native.md HN-W01…HN-W16; one-person.md OP-S84): Hermes Agent and Whombat's plugin
 * from a Hermes environment (`pnpm hermes:test --hermes pin --keep` makes one), a stub OpenAI-compatible model (no
 * credentials anywhere), the real managed sandbox (bubblewrap, a systemd --user scope) and the runner's `PodManager`;
 * the agent's commands run in their wrappers in the pod (one-person.md OP-07), the commands' proxy in this process.
 *
 *   node --import tsx apps/runner/scripts/pod-e2e.ts --env <hermes environment> [--turns 4]
 *
 * It checks what the pod promises — each turn's MCP token reaches its own call, two conversations of one person answer
 * at once, every command reaches its own turn, a call from a session without a policy is blocked — and measures a
 * turn's start (the viewer started → Hermes's first model request) on today's cold path (a sandbox and a Hermes per
 * turn) and in the pod. Prints one JSON report; exits non-zero when a check fails. Leaves nothing running.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EMPTY_POLICY, type NetPolicy, startControl, startProxy } from '@whombat/agent-net';
import {
  HermesProvider,
  ManagedSandbox,
  onPath,
  POD_INIT_PATH,
  SystemdUserCgroups,
  type TurnEvent,
} from '@whombat/agent-runtime';
import { base } from '@whombat/agent-runtime/testing/contexts';
import { DispatchContext } from '@whombat/core/contracts';
import { type CommandGuard, commandGuard } from '../src/commands/api';
import { FakeServer } from '../src/commands/fakes';
import { AgentNet } from '../src/commands/net';
import type { CommandsBox } from '../src/commands/place';
import { TurnCommands } from '../src/commands/turn';
import { PodManager, type PodShape } from '../src/pods';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const envDir = resolve(flag('--env') ?? '');
const TURNS = Number(flag('--turns') ?? 4);
if (!flag('--env')) {
  process.stderr.write('usage: pod-e2e.ts --env <hermes environment with the plugin> [--turns N]\n');
  process.exit(2);
}
const HERMES = join(envDir, 'venv', 'bin', 'hermes');
const PLUGIN = fileURLToPath(new URL('../../../packages/hermes-whombat', import.meta.url));
const pythonInstall = (() => {
  try {
    const link = readlinkSync(join(envDir, 'venv', 'bin', 'python'));
    const target = isAbsolute(link) ? link : join(envDir, 'venv', 'bin', link);
    return dirname(dirname(target));
  } catch {
    return null;
  }
})();

const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'wb-pod-e2e-'));
const slice = `wbpode2e${process.pid}.slice`;
const cleanups: (() => Promise<void> | void)[] = [];
const report: Record<string, unknown> = {};
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
const ms = (a: number, b: number) => Math.round(b - a);

/* The stub model --------------------------------------------------------------------------------------------------- */

interface ModelRequest {
  t: number;
  lastUser: string;
  tools: string[];
  effort: unknown;
}
const requests: ModelRequest[] = [];
const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join(' ')
      : '';

function answerModel(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', async () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-1', object: 'model' }] }));
      return;
    }
    const json = JSON.parse(body || '{}') as {
      messages?: { role: string; content: unknown }[];
      tools?: { function?: { name?: string } }[];
      stream?: boolean;
      model?: string;
      reasoning_effort?: unknown;
    };
    const messages = json.messages ?? [];
    const users = messages.filter((m) => m.role === 'user');
    const lastUser = textOf(users.at(-1)?.content);
    const last = messages.at(-1);
    const tools = (json.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean);
    requests.push({
      t: performance.now(),
      lastUser: lastUser.slice(0, 200),
      tools,
      effort: json.reasoning_effort,
    });
    let answer: string | null = null;
    let call: { name: string; args: Record<string, unknown> } | null = null;
    if (last?.role === 'tool') {
      const result = textOf(last.content).replace(/\s+/g, ' ');
      answer = `DONE ${/TOKEN=\S+ PID=\d+/.exec(result)?.[0] ?? /from-[ab]/.exec(result)?.[0] ?? result.slice(0, 160)}`;
    } else {
      const sleep = /SLEEP=([0-9.]+)/.exec(lastUser);
      if (sleep) await new Promise((r) => setTimeout(r, Number(sleep[1]) * 1000));
      const tool = /TOOL=(.+?)(?:$| \|\|)/.exec(lastUser);
      if (tool?.[1]) call = { name: 'terminal', args: { command: tool[1].trim() } };
      const mcp = /MCP=(\w+)/.exec(lastUser);
      if (mcp) {
        const name = tools.find((t) => t.endsWith(`__${mcp[1]}`));
        if (name) call = { name, args: {} };
        else answer = `NO_SUCH_TOOL ${mcp[1]}`;
      }
    }
    answer ??= call ? null : 'OK';
    const id = `c${requests.length}`;
    const message = call
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_${id}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }
      : { role: 'assistant', content: answer };
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          model: json.model,
          choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finish: string | null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    if (call)
      chunk(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${id}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
        null,
      );
    else chunk({ role: 'assistant', content: answer }, null);
    chunk({}, call ? 'tool_calls' : 'stop');
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
}

/* The agent's commands --------------------------------------------------------------------------------------------- */

/** Every command the guard read, and whose turn (null: a session with no live turn). */
const commands: { dispatchId: string | null; command: string }[] = [];
const recording =
  (dispatchId: string | null): CommandGuard =>
  (command, ctx) => {
    commands.push({ dispatchId, command: command.slice(0, 80) });
    return commandGuard(command, ctx);
  };

/* Hermes's profile ------------------------------------------------------------------------------------------------- */

const profile = join(root, 'hermes', 'profiles', 'alice');
const workspaces = join(root, 'workspaces');
const cwd = join(workspaces, 'repo');
mkdirSync(profile, { recursive: true, mode: 0o700 });
mkdirSync(cwd, { recursive: true });
const MCP_ECHO = join(root, 'mcp', 'whoami.mjs');
mkdirSync(dirname(MCP_ECHO), { recursive: true });
writeFileSync(
  MCP_ECHO,
  `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  if (r.id === undefined) continue;
  const result = r.method === 'initialize'
    ? { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } }
    : r.method === 'tools/list'
      ? { tools: [{ name: 'whoami', description: 'who am I', inputSchema: { type: 'object', properties: {} } }] }
      : r.method === 'tools/call'
        ? { content: [{ type: 'text', text: 'TOKEN=' + process.env.TURN_TOKEN + ' PID=' + process.pid }] }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
}
`,
);

function writeConfig(pod: boolean): void {
  const config = {
    model: { provider: 'whombat-model', default: 'stub-1' },
    providers: {
      'whombat-model': {
        name: 'whombat-model',
        base_url: 'http://stub.test/v1',
        transport: 'chat_completions',
        default_model: 'stub-1',
        api_key: 'no-key-required',
      },
    },
    plugins: { enabled: ['whombat'], auto_update_check_hours: 0 },
    terminal: { backend: 'whombat_commands' },
    bot_desktop: { placement: 'gateway' },
    auth: { adopt_external_logins: false },
    approvals: { mode: 'manual', timeout: 7200 },
    compression: { enabled: false },
    auxiliary: { title_generation: { enabled: false }, background_review: { enabled: false } },
    curator: { enabled: false },
    memory: { memory_enabled: true, user_profile_enabled: true },
    browser: { backend: 'off' },
    agent: {
      disabled_toolsets: ['browser'],
      ...(pod ? { agent_cache: { max_size: 16, idle_ttl_secs: 1800 } } : {}),
    },
    vault: { onepassword: { enabled: false }, bitwarden: { enabled: false } },
    tools: { tool_search: { enabled: 'off' }, connectors: { enabled: false } },
    display: { busy_input_mode: 'steer' },
    updates: { check: false },
    model_catalog: { enabled: false },
    models_dev: { url: 'http://127.0.0.1:9/' },
    web: { keyless_fallback: false },
    telemetry: { shared_metrics: { enabled: false, send: false } },
    security: { allow_lazy_installs: false },
    lsp: { enabled: false },
    kanban: { dispatch_in_gateway: false, notify_in_gateway: false },
    nous: { keepalive_interval_seconds: 0 },
    gateway: pod
      ? { standalone: true, unmanaged_idle_exit_seconds: 0, respawn_storm: { max_starts: 0 } }
      : { standalone: true, unmanaged_idle_exit_seconds: 60, respawn_storm: { max_starts: 0 } },
  };
  writeFileSync(join(profile, 'config.yaml'), `${JSON.stringify(config, null, 1)}\n`, { mode: 0o600 });
  writeFileSync(join(profile, 'SOUL.md'), 'You are a test agent.\n');
  writeFileSync(join(profile, 'whombat.md'), 'MARK_POD\n');
}

const ALLOW_ALL = `${JSON.stringify({ rules: [], default: 'allow' })}\n`;
function sessionPolicy(session: string): void {
  const dir = join(profile, 'whombat-turns', session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'policy.json'), ALLOW_ALL, { mode: 0o600 });
}

/* One turn over ACP ------------------------------------------------------------------------------------------------- */

interface Turn {
  text: string;
  startMs: number;
  toModelMs: number | null;
  session: string;
  error?: string;
}

/** A small ACP client over a viewer's stdio (newline-delimited JSON-RPC): requests, updates, permission answers. */
function acpClient(child: ChildProcess) {
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let text = '';
  const write = (msg: unknown) => child.stdin?.write(`${JSON.stringify(msg)}\n`);
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  lines.on('line', (line) => {
    let msg: {
      id?: number;
      method?: string;
      params?: {
        update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
        options?: { kind: string; optionId: string }[];
      };
      result?: unknown;
      error?: { message?: string; data?: unknown };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
        text += u.content.text ?? '';
    } else if (msg.method && msg.id !== undefined) {
      const allow = msg.params?.options?.find((o) => o.kind.startsWith('allow'));
      write({
        jsonrpc: '2.0',
        id: msg.id,
        ...(msg.method === 'session/request_permission'
          ? {
              result: {
                outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' },
              },
            }
          : { error: { code: -32601, message: 'not supported' } }),
      });
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
      else p?.resolve(msg.result);
    }
  });
  const gone = new Promise<never>((_r, reject) =>
    child.once('exit', () => reject(new Error('the viewer exited'))),
  );
  gone.catch(() => {});
  return {
    text: () => text,
    request: (method: string, params: unknown, timeoutMs = 180_000) =>
      Promise.race([
        new Promise<unknown>((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          write({ jsonrpc: '2.0', id, method, params });
          setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs).unref();
        }),
        gone,
      ]),
  };
}

async function turn(options: {
  spawn: () => ChildProcess;
  resume: string | null;
  prompt: string;
  token: string;
  onSession?: (id: string) => void;
}): Promise<Turn> {
  const started = performance.now();
  const child = options.spawn();
  child.stderr?.resume();
  const acp = acpClient(child);
  try {
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const mcpServers = [
      {
        name: 'whombat',
        command: process.execPath,
        args: [MCP_ECHO],
        env: [{ name: 'TURN_TOKEN', value: options.token }],
      },
    ];
    let session = options.resume;
    if (session) await acp.request('session/resume', { sessionId: session, cwd, mcpServers });
    else
      session = ((await acp.request('session/new', { cwd, mcpServers })) as { sessionId: string }).sessionId;
    options.onSession?.(session);
    const sent = performance.now();
    const before = requests.length;
    await acp.request('session/prompt', {
      sessionId: session,
      prompt: [{ type: 'text', text: options.prompt }],
    });
    const marker = options.prompt.split(' ')[0] as string;
    const first = requests.slice(before).find((r) => r.lastUser.includes(marker));
    return {
      text: acp.text().slice(-200),
      startMs: ms(started, sent),
      toModelMs: first ? ms(started, first.t) : null,
      session,
    };
  } catch (err) {
    return {
      text: acp.text(),
      startMs: 0,
      toModelMs: null,
      session: options.resume ?? '',
      error: String(err).slice(0, 300),
    };
  } finally {
    child.stdin?.destroy();
    child.kill('SIGTERM');
  }
}

/* The run ---------------------------------------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const model = createHttpServer(answerModel);
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => model.close(() => r())));
  const modelPort = (model.address() as { port: number }).port;
  const bwrap = '/usr/bin/bwrap';
  const sandbox = new ManagedSandbox({
    bwrap,
    nsenter: onPath('nsenter') ?? '/usr/bin/nsenter',
    cgroups: new SystemdUserCgroups({ slice, generation: 'gpode2e' }),
    stateDir: join(root, 'state'),
    prefix: 'gpode2e',
    deniedPaths: [],
    egress: {
      resolve: async (name) => {
        if (name !== 'stub.test') throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
        return [{ address: '93.184.215.14', family: 4 }];
      },
      dial: () => ({ host: '127.0.0.1', port: modelPort }),
    },
  });
  cleanups.push(async () => {
    await sandbox.shutdown();
    spawn('systemctl', ['--user', 'stop', slice]).on('error', () => {});
  });
  const probe = await sandbox.probe();
  if (!probe.ok) throw new Error(`no sandbox here: ${probe.detail}`);
  const installs = [envDir, ...(pythonInstall ? [pythonInstall] : [])];
  const readable = [PLUGIN, dirname(MCP_ECHO), dirname(POD_INIT_PATH)];
  const hermesEnv = {
    HERMES_HOME: profile,
    HERMES_QUIET: '1',
  };
  // The commands' network: the daemon's proxy and control socket, here (the wall lets public hosts through).
  let netPolicy: NetPolicy | null = null;
  mkdirSync(join(root, 'net'), { recursive: true });
  const proxy = await startProxy({
    path: join(root, 'net', 'proxy.sock'),
    policy: () => netPolicy,
    facts: () => ({ hostAddresses: [], deny: [] }),
  });
  const control = await startControl({
    path: join(root, 'net', 'control.sock'),
    apply: (p) => {
      netPolicy = p;
    },
    current: () => netPolicy ?? EMPTY_POLICY,
  });
  cleanups.push(
    () => proxy.close(),
    () => control.close(),
  );
  const net = new AgentNet({ control: join(root, 'net', 'control.sock'), log: () => {} });
  const box: CommandsBox = {
    guard: recording(null),
    net,
    proxySocket: join(root, 'net', 'proxy.sock'),
    log: () => {},
    agentHome: join(root, 'agent', 'home'),
    tools: null,
    nixLd: { ld: null, libraryPath: null },
    hostPath: process.env.PATH ?? '/usr/bin:/bin',
    containers: null,
    notify: async () => {},
  };

  // Today's cold path: a sandbox and a Hermes (and its gateway) per turn.
  writeConfig(false);
  writeFileSync(join(profile, 'whombat-policy.json'), ALLOW_ALL);
  const cold: Turn[] = [];
  let coldSession: string | null = null;
  for (let i = 0; i < TURNS; i++) {
    const session = await sandbox.open({
      id: `cold${i}`,
      cwd,
      writeCwd: false,
      stateDirs: [profile],
      installs,
      readable,
      env: hermesEnv,
      egress: { allow: ['stub.test'] },
    });
    const t = await turn({
      spawn: () =>
        session.spawn(HERMES, ['acp'], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }),
      resume: coldSession,
      prompt: `C${i} hello`,
      token: `C${i}`,
    });
    await session.close();
    coldSession ??= t.session;
    cold.push(t);
  }
  report.cold = cold.map(({ startMs, toModelMs, error }) => ({
    startMs,
    toModelMs,
    ...(error ? { error } : {}),
  }));
  check(
    cold.every((t) => !t.error),
    'the cold path answers',
  );

  // The pod.
  writeConfig(true);
  rmSync(join(profile, 'whombat-policy.json'), { force: true });
  const pods = new PodManager({
    sandboxes: sandbox,
    hermes: () => ({ gateway: ['gateway', 'run', '--quiet'], acp: ['acp'] }),
    stateDir: join(root, 'pods'),
    hermesRoot: join(root, 'hermes'),
    roots: () => [workspaces],
    serverUrl: 'http://127.0.0.1:9',
    log: (level, msg) => {
      if (level !== 'debug') process.stderr.write(`pod-e2e · ${msg}\n`);
    },
    cap: 2,
    commands: box,
    chromium: false,
  });
  cleanups.unshift(() => pods.close());
  const shape: PodShape = {
    profile,
    bin: HERMES,
    installs,
    readable,
    path: [],
    env: hermesEnv,
    credential: null,
    denied: [],
    mcpUrl: 'http://127.0.0.1:9/mcp',
    egress: { allow: ['stub.test'] },
  };
  const routes = async (dispatchId: string) => ({
    dispatchId,
    commands: await TurnCommands.open(
      { api: new FakeServer(), guard: recording(dispatchId), net, log: () => {} },
      {
        dispatchId,
        lease: { runnerId: 'rnr_e2e', attempt: 1 },
        context: { productionServers: [], homeNetworks: [], lan: false },
        binds: [{ src: cwd, dest: cwd, mode: 'rw' as const }],
        cwd,
        env: {},
        readOnlyInside: [],
        wantsKeys: false,
      },
    ),
    logins: null,
    gatewayToken: null,
    egress: { allow: [] as string[] },
  });
  const podTurn = async (
    dispatchId: string,
    resume: string | null,
    prompt: string,
    token: string,
    threads: string[],
  ) => {
    const admitted = performance.now();
    const slot = await pods.admit(shape, await routes(dispatchId), undefined, { threads });
    const admitMs = ms(admitted, performance.now());
    try {
      const t = await turn({
        spawn: () => slot.spawnAcp(cwd),
        resume,
        prompt,
        token,
        onSession: (id) => {
          slot.bind(id);
          sessionPolicy(id);
        },
      });
      return { ...t, admitMs };
    } finally {
      await slot.release();
    }
  };
  const warm: (Turn & { admitMs: number })[] = [];
  let podSession: string | null = null;
  for (let i = 0; i < TURNS; i++) {
    const t = await podTurn(`p${i}`, podSession, `P${i} hello`, `P${i}`, ['thread:a']);
    podSession ??= t.session;
    warm.push(t);
  }
  report.pod = warm.map(({ admitMs, startMs, toModelMs, error }) => ({
    admitMs,
    startMs,
    toModelMs,
    ...(error ? { error } : {}),
  }));
  check(
    warm.every((t) => !t.error),
    'the pod answers',
  );

  // Each turn's MCP token reaches its own call (HN-W04).
  const tokenTurn = await podTurn('tok', podSession, 'MCP=whoami', 'T-own', ['thread:a']);
  report.mcpToken = tokenTurn.text;
  check(tokenTurn.text.includes('TOKEN=T-own'), 'a turn’s own MCP token reaches its call');

  // Two conversations of one person at once (HN-W10), each command reaching its own turn (HN-W04, OP-07).
  const concurrentStart = performance.now();
  const both = await Promise.all([
    podTurn('ca', null, 'SLEEP=2 TOOL=echo from-a', 'A', ['thread:b']),
    podTurn('cb', null, 'SLEEP=2 TOOL=echo from-b', 'B', ['thread:c']),
  ]);
  report.concurrentWallMs = ms(concurrentStart, performance.now());
  report.concurrent = both.map((t) => ({ text: t.text.slice(-60), error: t.error ?? null }));
  check(
    both.every((t) => /DONE .*from-[ab]/.test(t.text)),
    'two conversations answer at once',
  );
  check((report.concurrentWallMs as number) < 2 * 2000 + 3000, 'the two ran at the same time');
  for (const [i, own] of ['ca', 'cb'].entries()) {
    const mine = commands.filter((c) => c.dispatchId === own).map((c) => c.command);
    const word = i === 0 ? 'from-a' : 'from-b';
    const other = i === 0 ? 'from-b' : 'from-a';
    check(
      mine.some((c) => c.includes(word)) && !mine.some((c) => c.includes(other)),
      `turn ${i} ran its commands in its own turn`,
    );
  }
  check(
    !commands.some((c) => c.dispatchId === null && /from-[ab]/.test(c.command)),
    'every command of a turn reached its turn',
  );

  // A session without a policy is blocked (HN-W06): the tool call's result says so, nothing runs.
  const before = commands.length;
  const slot = await pods.admit(shape, await routes('nopolicy'), undefined, { threads: ['thread:d'] });
  try {
    const t = await turn({
      spawn: () => slot.spawnAcp(cwd),
      resume: null,
      prompt: 'TOOL=echo should-not-run',
      token: 'N',
      onSession: (id) => slot.bind(id),
    });
    report.noPolicy = t.text.slice(-120);
    check(!commands.slice(before).some((c) => c.command.includes('should-not-run')), 'no policy, no command');
  } finally {
    await slot.release();
  }
  report.commands = commands.length;

  // The runner's own path: HermesProvider in the pod (its config.yaml, the session's files, `/reasoning` on a resumed
  // session), a model on the person's network standing in for the person's provider.
  await pods.close();
  const provider = new HermesProvider({
    kind: 'local',
    bin: HERMES,
    root: join(root, 'hermes'),
    env: { ...process.env, WHOMBAT_HERMES_BIN: HERMES },
  });
  const ctx = (effort: string, session: string | null) =>
    DispatchContext.parse(
      base({
        dispatch: { ...base().dispatch, trigger: 'dm', providerSessionId: session },
        localModel: { v: 1, baseUrl: 'http://stub.test/v1', model: 'stub-1', apiKey: null },
        agent: { ...base().agent, runtime: { provider: 'local', model: 'stub-1', effort } },
        onBehalfOf: {
          person: { id: 'prn_mara', kind: 'person', name: 'Mara', handle: 'mara', title: null },
          accountId: 'acc_alice',
          connections: [],
        },
      }),
    );
  const providerTurn = async (prompt: string, effort: string, resume: string | null) => {
    const context = ctx(effort, resume);
    const draft = {
      context,
      prompt,
      mcp: { url: 'http://127.0.0.1:9/mcp', token: `tok-${prompt.slice(0, 4)}` },
      cwd,
      sandbox: 'workspace-write' as const,
      network: false,
      ...(resume ? { resumeSessionId: resume } : {}),
    };
    const needs = await provider.podNeeds(draft);
    if (!needs) throw new Error('no pod for this turn');
    const slot = await pods2.admit(
      {
        ...shape,
        ...needs,
        installs: [...installs, ...needs.installs],
        readable: [...readable, ...needs.readable],
      },
      await routes(`pt-${prompt.slice(0, 4)}`),
    );
    const events: TurnEvent[] = [];
    let session: string | null = null;
    try {
      const turnInput = {
        ...draft,
        host: { spawn: () => slot.spawnAcp(cwd) },
        pod: {
          mcpUrl: slot.mcpUrl,
          spawnAcp: (c: string) => slot.spawnAcp(c),
          bind: (sid: string) => {
            session = sid;
            slot.bind(sid);
          },
        },
        ...(slot.mcpUrl ? { mcp: { ...draft.mcp, url: slot.mcpUrl } } : {}),
      };
      for await (const e of provider.runTurn(turnInput, new AbortController().signal)) events.push(e);
    } finally {
      await slot.release();
    }
    return { events, session: session as string | null };
  };
  const pods2 = new PodManager({
    sandboxes: sandbox,
    hermes: () => ({ gateway: ['gateway', 'run', '--quiet'], acp: ['acp'] }),
    stateDir: join(root, 'pods2'),
    hermesRoot: join(root, 'hermes'),
    roots: () => [workspaces],
    serverUrl: 'http://127.0.0.1:9',
    log: () => {},
    commands: box,
    chromium: false,
  });
  cleanups.unshift(() => pods2.close());
  const finalOf = (events: TurnEvent[]) =>
    events
      .filter((e): e is Extract<TurnEvent, { type: 'final' }> => e.type === 'final')
      .map((e) => e.text)
      .join('');
  const errorOf = (events: TurnEvent[]) => events.find((e) => e.type === 'error');
  const first = await providerTurn('TOOL=echo via-provider', 'low', null);
  report.providerFirst = { final: finalOf(first.events).slice(-60), error: errorOf(first.events) ?? null };
  check(finalOf(first.events).includes('via-provider'), 'a provider turn in the pod runs its command');
  check(Boolean(first.session), 'the provider bound its session');
  const policyFile = join(
    provider.profileOf({ context: ctx('low', null) }),
    'whombat-turns',
    `${first.session}`,
    'policy.json',
  );
  check(existsSync(policyFile), 'the session’s policy is written');
  const seen = requests.length;
  const resumed = await providerTurn('R2 again', 'high', first.session ? `hermes:${first.session}` : null);
  const sent = requests.slice(seen);
  report.providerResumed = {
    final: finalOf(resumed.events).slice(-60),
    error: errorOf(resumed.events) ?? null,
    efforts: sent.map((r) => r.effort ?? null),
  };
  check(!errorOf(resumed.events), 'a resumed provider turn in the pod answers');
  check(
    sent.some((r) => r.effort === 'high' && r.lastUser.includes('R2')),
    'the resumed session runs on the turn’s effort (HN-L11)',
  );
  check(resumed.session === first.session, 'the resumed turn ran in the same session');
  check(
    !finalOf(resumed.events).toLowerCase().includes('reasoning'),
    'the effort command’s reply isn’t posted',
  );
  report.failures = failures;
}

try {
  await main();
} catch (err) {
  failures.push(String(err));
  report.error = String(err);
} finally {
  for (const c of cleanups) await Promise.resolve(c()).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
process.exit(failures.length ? 1 : 0);
