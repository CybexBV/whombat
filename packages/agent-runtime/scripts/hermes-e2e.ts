/**
 * End-to-end check of `HermesProvider` against the real `hermes acp` on this machine (hermes-engine.md step 1, stream
 * R; hermes-native.md HN-02): ChatGPT on Hermes's own `openai-codex` provider, a throwaway `HERMES_HOME` under
 * `$WHOMBAT_HERMES_E2E_ROOT` (default `~/.cache/wb-tmp/hermes/r-test/`), and Whombat's MCP tools from a small SDK server
 * here (stateless JSON, like the real one). Not part of `pnpm check`:
 *
 *   pnpm hermes:e2e                 # every scenario on ChatGPT
 *   pnpm hermes:e2e answer stop     # some of them
 *   WHOMBAT_HERMES_E2E_CLI=claude pnpm hermes:e2e   # the bundled Claude DirectSDK provider
 *   WHOMBAT_HERMES_E2E_MODEL=none pnpm hermes:e2e answer   # a turn that names no model (an agent nobody picked one for)
 *
 * ChatGPT's login is Hermes's own (HN-03), in the run's profile: from `WHOMBAT_HERMES_E2E_LOGIN` (a directory holding a
 * Hermes `auth.json`, moved into the profile for the run and back after it: one file, so refresh tokens never fork),
 * else Hermes's device-code login now (the link and code printed; the login goes with the run's profile).
 *
 * Scenarios: answer · resume · mcp · permission · stop · after-stop · follow-up, plus `voices` (the five faces answer the
 * same question, printed for reading; agent-voices.md AV-06), `migration` (a session on Claude’s retired route is never
 * resumed: a fresh one, hermes-native.md HN-07), `sandbox` only when named: a turn inside the real managed sandbox
 * (bubblewrap, systemd user cgroups), as on the appliance, with the profile its writable state and its commands in
 * their wrappers (an outsiders' place, one-person.md OP-07, OP-17: the model runs one and says what it printed), and
 * `WHOMBAT_HERMES_E2E_GRANT` (`10.0.0.5/32:8317`) for a model proxy on the LAN; `browser` only when named too
 * (hermes-engine.md HE-42): the runner's CDP relay to Chromium on this host, a page served here, and Hermes's browser
 * tools reading it through a loopback port standing in for the sandbox's bridge (agent-browser beside `hermes`,
 * `pnpm hermes:install`). Prints
 * each turn's events in short and the timings (Hermes start → first event, first text, the whole turn); exits 1 when
 * one failed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type AddressInfo, connect, createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DispatchContext } from '@whombat/core';
import { AGENT_FACES, type AgentFace, agentCharacter } from '@whombat/core/domain';
import { KEY_CATALOG } from '@whombat/core/keys';
// The runner's own pieces (HE-S137, one-person.md OP-07): the browser's relay, the commands of an outsiders' turn.
import { Browser } from '../../../apps/runner/src/browser';
import { commandGuard } from '../../../apps/runner/src/commands/api';
import { FakeServer } from '../../../apps/runner/src/commands/fakes';
import { AgentNet } from '../../../apps/runner/src/commands/net';
import { CommandsPlace } from '../../../apps/runner/src/commands/place';
import { TurnCommands } from '../../../apps/runner/src/commands/turn';
import { COMMANDS_INIT_PATH } from '../../commands/src/paths';
import { SystemdUserCgroups } from '../src/access/managed/cgroup';
import { ManagedSandbox } from '../src/access/managed/sandbox';
import { onPath } from '../src/access/sandbox';
import type { TurnEvent, TurnHost, TurnInput, TurnSteer, TurnSteering } from '../src/contract';
import {
  hermesBin,
  hermesPersonProfile,
  hermesPythonBeside,
  prepareHermesProfile,
} from '../src/hermes/profile';
import { HermesProvider } from '../src/hermes/provider';
import { turnPrompt } from '../src/persona/prompt';
import { listCliModels } from '../src/providers/cli-check';
import {
  chatgptDeviceLogin,
  chatgptInstall,
  chatgptModels,
  chatgptSteps,
} from '../src/providers/login/chatgpt';
import { base } from '../src/testing/contexts';

const cli = (process.env.WHOMBAT_HERMES_E2E_CLI ?? 'codex') as 'codex' | 'claude';
const root = join(
  process.env.WHOMBAT_HERMES_E2E_ROOT ?? join(homedir(), '.cache/wb-tmp/hermes/r-test'),
  `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const bin = process.env.WHOMBAT_HERMES_BIN?.trim() || hermesBin();
const wanted = new Set(process.argv.slice(2));
const scenario = (name: string) =>
  (wanted.size === 0 && !['sandbox', 'browser', 'migration', 'voices'].includes(name)) || wanted.has(name);

/** Whombat's MCP tools, as the real server serves them: stateless streamable HTTP, JSON answers, a bearer token. */
async function startMcp() {
  const token = `tok_${randomUUID()}`;
  const calls: { name: string; args: unknown }[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const mcp = new Server({ name: 'whombat', version: '0.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'set_status',
          description: 'Say what you are doing now.',
          inputSchema: { type: 'object', properties: { doing: { type: 'string' } }, required: ['doing'] },
        },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({ name: request.params.name, args: request.params.arguments });
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => void transport.close());
    await mcp.connect(transport);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, token, calls, close: () => server.close() };
}

function context(prompt: string, sessionId: string | null, face: AgentFace = 'dusty') {
  return DispatchContext.parse(
    base({
      dispatch: {
        ...base().dispatch,
        id: `dsp_${randomUUID().slice(0, 8)}`,
        trigger: 'dm',
        providerSessionId: sessionId,
      },
      agent: {
        ...base().agent,
        name: agentCharacter(face).name,
        handle: 'dusty',
        face,
        runtime: { provider: cli },
        // “Use a web browser” at Allowed (HE-44): the turn's policy lets Hermes's browser tools run.
        keys: {
          ...base().agent.keys,
          can: [...base().agent.keys.can, { id: 'browser.use', label: KEY_CATALOG['browser.use'].label }],
        },
      },
      credential: { v: 1, provider: cli, authMode: 'subscription' },
      trigger: { ...base().trigger, text: prompt },
    }),
  );
}

/** Follow-ups handed to the provider once it opens (the runner's `TurnFollowUps`, in short). */
function steering(items: TurnSteer[], at: (ev: TurnEvent) => boolean) {
  let take: ((s: TurnSteer) => boolean) | null = null;
  const taken: string[] = [];
  const s: TurnSteering & { hand(ev: TurnEvent): void; taken: string[] } = {
    open(t) {
      take = t;
    },
    close() {
      take = null;
    },
    hand(ev) {
      if (!take || !items.length || !at(ev)) return;
      for (const item of items.splice(0)) if (take(item)) taken.push(item.id);
    },
    taken,
  };
  return s;
}

interface TurnRun {
  events: TurnEvent[];
  session: string | null;
  final: string;
  ms: { firstEvent: number | null; firstText: number | null; total: number };
  error: string | null;
}

async function turn(
  provider: HermesProvider,
  mcp: { url: string; token: string },
  prompt: string,
  options: {
    session?: string | null;
    stopWhen?: (ev: TurnEvent) => boolean;
    followUps?: { items: TurnSteer[]; at: (ev: TurnEvent) => boolean };
    host?: TurnHost;
    browser?: TurnInput['browser'];
    face?: AgentFace;
    /** The prompt carries the whole conversation: a session Hermes can't run the turn in is replaced (HN-07). */
    fresh?: boolean;
  } = {},
): Promise<TurnRun> {
  const cwd = join(root, 'cwd');
  await mkdir(cwd, { recursive: true });
  const steer = options.followUps ? steering(options.followUps.items, options.followUps.at) : null;
  const input: TurnInput = {
    context: context(prompt, options.session ?? null, options.face),
    prompt,
    mcp,
    cwd,
    sandbox: 'workspace-write',
    network: false,
    model,
    ...(options.session ? { resumeSessionId: options.session } : {}),
    ...(options.fresh ? { freshIfSessionGone: true } : {}),
    ...(steer ? { steering: steer } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
  };
  const controller = new AbortController();
  const t0 = Date.now();
  const run: TurnRun = {
    events: [],
    session: null,
    final: '',
    ms: { firstEvent: null, firstText: null, total: 0 },
    error: null,
  };
  for await (const ev of provider.runTurn(input, controller.signal)) {
    run.events.push(ev);
    run.ms.firstEvent ??= Date.now() - t0;
    if (ev.type === 'text_delta') run.ms.firstText ??= Date.now() - t0;
    if (ev.type === 'session') run.session = ev.sessionId;
    if (ev.type === 'final') run.final = ev.text;
    if (ev.type === 'error') run.error = ev.message;
    steer?.hand(ev);
    if (options.stopWhen?.(ev) && !controller.signal.aborted) {
      console.log(`    … stopping after ${Date.now() - t0} ms`);
      controller.abort();
    }
  }
  run.ms.total = Date.now() - t0;
  return run;
}

function show(name: string, r: TurnRun) {
  const short = r.events
    .filter((e) => e.type !== 'text_delta' && e.type !== 'thinking')
    .map((e) => {
      if (e.type === 'tool_call') return `tool_call ${e.name}${e.category ? `/${e.category}` : ''}`;
      if (e.type === 'tool_result') return `tool_result ${e.name} ${e.ok ? 'ok' : 'failed'}`;
      if (e.type === 'permission') return `permission ${e.tool} ${e.allowed ? 'allowed' : 'denied'}`;
      if (e.type === 'final') return `final “${e.text.slice(0, 80)}”`;
      if (e.type === 'error') return `error ${e.message.slice(0, 160)}`;
      if (e.type === 'steered') return `steered ${e.id}`;
      if (e.type === 'session') return `session ${e.sessionId.slice(0, 22)}…`;
      return e.type;
    });
  console.log(
    `\n${name}: ${r.ms.total} ms (first event ${r.ms.firstEvent} ms, first text ${r.ms.firstText ?? '–'} ms)`,
  );
  for (const s of short) console.log(`    ${s}`);
}

/**
 * The model a turn runs on: `WHOMBAT_HERMES_E2E_MODEL`, else the CLI's listed default; `none`: no model, as for an agent
 * nobody picked one for (the runner names none, HE-67).
 */
const noModel = process.env.WHOMBAT_HERMES_E2E_MODEL?.trim() === 'none';
let model = noModel ? '' : (process.env.WHOMBAT_HERMES_E2E_MODEL?.trim() ?? '');

const results: { name: string; ok: boolean; note: string }[] = [];
const check = (name: string, ok: boolean, note = '') => {
  results.push({ name, ok, note });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};

/** Processes still running with a `HERMES_HOME` under this run's root (Hermes, its gateway, its model clients). */
function leftovers(): number {
  let n = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (env.split('\0').some((kv) => kv.startsWith(`HERMES_HOME=${root}`))) n++;
    } catch {
      // gone, or not ours
    }
  }
  return n;
}

/**
 * A turn inside the real managed sandbox, as the runner opens an outsiders' turn (OP-17): Hermes under
 * `commands-init.mjs`, its commands in their wrappers, the network through the task's egress.
 */
async function inSandbox(provider: HermesProvider, mcp: { url: string; token: string }) {
  const bwrap =
    ['/usr/bin/bwrap', '/run/current-system/sw/bin/bwrap'].find((p) => existsSync(p)) ?? '/usr/bin/bwrap';
  const nsenter = onPath('nsenter') ?? '/usr/bin/nsenter';
  const slice = `wbhermes${process.pid}.slice`;
  // Short: its sockets' paths have 107 bytes at most.
  const stateDir = mkdtempSync(join(tmpdir(), 'wbh-'));
  const sandbox = new ManagedSandbox({
    bwrap,
    nsenter,
    cgroups: new SystemdUserCgroups({ slice, generation: 'ghermes' }),
    stateDir,
    prefix: 'ghermes',
  });
  /** Everything the run made for the sandbox goes: its scope, its slice, its control files. */
  const release = async () => {
    await sandbox.shutdown();
    spawnSync('systemctl', ['--user', 'stop', slice], { stdio: 'ignore' });
    await rm(stateDir, { recursive: true, force: true });
  };
  const probe = await sandbox.probe();
  if (!probe.ok) {
    await release();
    check('sandbox available', false, probe.detail);
    return;
  }
  // Whatever fails from here on, the sandbox's scope, slice and files still go.
  try {
    const cwd = join(root, 'cwd');
    await mkdir(cwd, { recursive: true });
    const prompt = 'Run the shell command `echo boxed-$((6*7))` and reply with exactly what it printed.';
    const base: TurnInput = {
      context: context(prompt, null),
      prompt,
      mcp,
      cwd,
      sandbox: 'workspace-write',
      network: false,
      model,
    };
    const needs = await provider.sandboxNeeds(base);
    const commands = await TurnCommands.open(
      { api: new FakeServer(), guard: commandGuard, net: null, log: () => {} },
      {
        dispatchId: `dsp_h${process.pid}`,
        lease: { runnerId: 'rnr_e2e', attempt: 1 },
        context: null,
        binds: [{ src: cwd, dest: cwd, mode: 'rw' }],
        cwd,
        env: {},
        readOnlyInside: [],
        wantsKeys: false,
      },
    );
    const place = await CommandsPlace.open(
      {
        guard: commandGuard,
        net: new AgentNet({ control: join(stateDir, 'none.sock'), log: () => {} }),
        proxySocket: join(stateDir, 'none.sock'),
        log: () => {},
        agentHome: join(root, 'agent-home'),
        tools: null,
        nixLd: { ld: null, libraryPath: null },
        hostPath: process.env.PATH ?? '/usr/bin:/bin',
        containers: null,
        notify: async () => {},
      },
      {
        kind: 'outside',
        base: join(stateDir, 'place'),
        node: sandbox.node,
        skills: needs.stateDirs?.[0] ? join(needs.stateDirs[0], 'skills') : null,
        roots: [],
        binds: commands.turn.binds,
      },
    );
    place.admit(commands);
    const grant = process.env.WHOMBAT_HERMES_E2E_GRANT?.split(':');
    const session = await sandbox.open({
      id: `dsp_h${process.pid}`,
      cwd,
      writeCwd: true,
      // ChatGPT's login is Hermes's, in the profile: the task's writable state (HN-03).
      stateDirs: [...(needs.stateDirs ?? []), ...place.stateDirs],
      installs: [
        ...(needs.installs ?? []),
        // An editable install's sources (Hermes's clone, our plugin), `:`-separated.
        ...(process.env.WHOMBAT_HERMES_E2E_SRC?.split(':').filter(Boolean) ?? []),
      ],
      readable: [...(needs.readable ?? []), ...place.readable],
      env: {
        ...(needs.env ?? {}),
        ...place.env,
        // Claude's login is this host's, as the run's other turns use it (DirectSDK's model client).
        ...(cli === 'claude' ? { CLAUDE_CONFIG_DIR: join(homedir(), '.claude') } : {}),
      },
      ...(cli === 'claude' ? { credentialHome: join(homedir(), '.claude') } : {}),
      commands: place.sandbox,
      egress: {
        allow: [
          'api.openai.com',
          '*.openai.com',
          'chatgpt.com',
          '*.chatgpt.com',
          '*.anthropic.com',
          'claude.ai',
          '*.claude.com',
        ],
        ...(grant ? { grants: [{ cidr: grant[0] as string, ports: [Number(grant[1] ?? 443)] }] } : {}),
      },
      mcpUrl: mcp.url,
    });
    const config = place.hostConfig({ bwrap, nsenter, cgroup: session.commandsCgroup() });
    try {
      const r = await turn(provider, { ...mcp, url: session.mcpUrl ?? mcp.url }, base.prompt, {
        host: {
          spawn: (c, a, o) =>
            session.spawn(sandbox.node, [COMMANDS_INIT_PATH, JSON.stringify(config), c, ...a], o),
        },
      });
      show('sandbox', r);
      check(
        'sandbox turn runs its command in its wrapper',
        /boxed-42/.test(r.final) && !r.error,
        r.error ?? r.final.slice(0, 80),
      );
    } finally {
      await session.close();
      await place.close();
      await commands.close();
    }
  } finally {
    // The task cgroups' supervisor scope and the run's slice too, as the runner does at its own end.
    await release();
  }
  check('sandbox leaves nothing running', leftovers() === 0);
}

/**
 * The runner's relay to a Chromium on this host (HE-S137), a page served here: `run` gets the relay's socket and the
 * word the page's heading has. (In a pod Chromium runs in the commands' network: `commands-sandbox.test.ts`.)
 */
async function withBrowser(run: (socket: string, word: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'wbh-browser-'));
  const word = `Marmalade ${Math.floor(1000 + Math.random() * 9000)}`;
  const site = createServer((_q, s) => s.end(`<title>E2E</title><h1>${word}</h1>`));
  await new Promise<void>((r) => site.listen(8765, '127.0.0.1', () => r()));
  const relay = await Browser.open(
    {
      host: {
        // This host's own bash: the script runs Chromium here, not in an appliance's wrapper.
        shell: '/bin/bash',
        start: async (argv) => {
          const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
          const { Duplex } = await import('node:stream');
          const stream = new Duplex({
            read() {},
            write(chunk, _enc, cb) {
              child.stdin.write(chunk, cb);
            },
            destroy(_err, cb) {
              child.kill('SIGTERM');
              cb(null);
            },
          });
          child.stdout.on('data', (d: Buffer) => stream.push(d));
          child.stderr.on('data', (d: Buffer) => stream.push(d));
          child.on('close', () => stream.push(null));
          return stream as unknown as import('node:net').Socket;
        },
        connect: (port) => connect(port, '127.0.0.1'),
      },
      socket: join(home, 'cdp.sock'),
      log: (l, m) => console.log(`    [relay ${l}] ${m}`),
    },
    { name: 'e2e', sites: null },
  );
  try {
    await run(relay.socket, word);
  } finally {
    await relay.close();
    site.close();
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * ChatGPT's login in the run's profile (HN-03): `WHOMBAT_HERMES_E2E_LOGIN`'s, moved in (and back by the returned
 * function), else Hermes's device-code login now.
 */
async function chatgptLogin(): Promise<() => Promise<void>> {
  const python = hermesPythonBeside(bin, process.env);
  const steps = chatgptSteps(python, process.env);
  if (!steps) throw new Error('ChatGPT needs a real Hermes with our plugin (pnpm hermes:install).');
  const hermesRoot = root;
  const profile = hermesPersonProfile(hermesRoot);
  await prepareHermesProfile(hermesRoot, profile);
  const kept = process.env.WHOMBAT_HERMES_E2E_LOGIN?.trim();
  if (kept) {
    await chatgptInstall(steps, kept, profile);
    return () => chatgptInstall(steps, profile, kept);
  }
  const staging = join(hermesRoot, 'signin', 'e2e');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const login = chatgptDeviceLogin({ steps, home: staging });
  const code = await login.code;
  console.log(`\nSign in to ChatGPT: open ${code.verificationUri} and enter ${code.userCode}\n`);
  const outcome = await login.done;
  if (!outcome.ok) throw new Error(`ChatGPT sign-in: ${outcome.message}`);
  await chatgptInstall(steps, staging, profile);
  return async () => {};
}

async function main() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  console.log(`hermes ${bin} · ${cli} · root ${root}`);
  const giveBack = cli === 'codex' ? await chatgptLogin() : async () => {};
  // The runner's list of models: its default is what a turn naming none tells Hermes (HE-67) — ChatGPT's from Hermes.
  const steps = chatgptSteps(hermesPythonBeside(bin, process.env), process.env);
  const models = model
    ? null
    : cli === 'codex'
      ? steps
        ? await chatgptModels(steps, tmpdir())
        : null
      : await listCliModels(cli);
  const listed = models?.find((m) => m.isDefault)?.id ?? null;
  if (!model && !noModel) model = listed ?? models?.[0]?.id ?? '';
  console.log(`model ${model || '(none)'}`);
  const mcp = await startMcp();
  const logs: string[] = [];
  const provider = new HermesProvider({
    kind: cli,
    bin,
    root,
    defaultModel: () => listed,
    // agent-browser beside `hermes` (HE-S300), as the provider puts it on the PATH inside the sandbox.
    env: {
      ...process.env,
      PATH: `${dirname(bin)}:${process.env.PATH ?? ''}`,
      WHOMBAT_HOME: join(root, 'whombat-home'),
    },
    log: (m) => {
      logs.push(m);
      console.log(`    [${m}]`);
    },
  });
  let session: string | null = null;
  try {
    if (scenario('answer') || scenario('resume') || scenario('mcp') || scenario('migration')) {
      const r = await turn(provider, mcp, 'Reply with exactly the word: pong');
      show('answer', r);
      session = r.session;
      check('answer', /pong/i.test(r.final) && !r.error, r.error ?? r.final.slice(0, 60));
      check('answer leaves nothing running', leftovers() === 0);
    }
    if (scenario('voices')) {
      // The same question for every face (AV-06): read the answers, the check is only that each turn answered.
      const question =
        'The backup disk on our file server is at 92% of 4 TB. Is that a problem, and what should we do?';
      for (const face of AGENT_FACES) {
        // The real turn's words: the preface (with the face's cue, AV-08) and then the question.
        const r = await turn(provider, mcp, turnPrompt(context(question, null, face)), { face });
        console.log(`\n  ${face}:\n    ${r.final.trim().replace(/\n/g, '\n    ')}\n`);
        check(`voices ${face}`, !r.error && r.final.trim().length > 0, r.error ?? r.final.slice(0, 60));
      }
    }
    if (scenario('migration') && session) {
      if (cli !== 'claude') throw new Error('The migration scenario needs WHOMBAT_HERMES_E2E_CLI=claude.');
      // Reproduce the retired route only in this harness's disposable profile. Production uses Hermes's ACP mutation.
      const patched = spawnSync(
        join(dirname(bin), 'python'),
        [
          '-c',
          `
import json, sqlite3, sys
from pathlib import Path
from hermes_state_local import POLICY_PREFIX
for path in Path(sys.argv[1]).glob('profiles/*/state.db'):
    with sqlite3.connect(path) as db:
        for key, value in db.execute('SELECT key, value FROM state_meta WHERE key LIKE ?', (POLICY_PREFIX + '%',)).fetchall():
            receipt = json.loads(value)
            config = json.loads(receipt['policy']['config_json'])
            config['model'].update(provider='claude-cli', api_mode='claude_code', base_url='claude-cli://local')
            receipt['policy']['config_json'] = json.dumps(config)
            db.execute('UPDATE state_meta SET value=? WHERE key=?', (json.dumps(receipt), key))
`,
          root,
        ],
        { encoding: 'utf8' },
      );
      if (patched.status !== 0) throw new Error(patched.stderr);
      const r = await turn(provider, mcp, 'Reply with exactly the word: pong', { session, fresh: true });
      show('saved Claude session on the retired route', r);
      check('the retired route’s session is not resumed', !!r.session && r.session !== session);
      check('a fresh session answers through DirectSDK', /pong/i.test(r.final) && !r.error, r.error ?? '');
      check(
        'the runner saw the session on another provider',
        logs.some((line) => line.includes('claude-cli') && line.includes('not resumed')),
      );
      // The thread goes on in the fresh session (it was asked for pong too).
      session = r.session;
    }
    if (scenario('resume') && session) {
      const r = await turn(
        provider,
        mcp,
        'Which word did I ask you to reply with before? Answer with that word only.',
        {
          session,
        },
      );
      show('resume', r);
      check('resume keeps the session', r.session === session, `${r.session} vs ${session}`);
      check('resume remembers', /pong/i.test(r.final), r.final.slice(0, 60));
    }
    if (scenario('mcp')) {
      const before = mcp.calls.length;
      const r = await turn(
        provider,
        mcp,
        'Call the set_status tool of the whombat MCP server with doing set to "testing Hermes", then reply with: done',
        { session },
      );
      show('mcp', r);
      check('mcp reaches Whombat', mcp.calls.length > before, `${mcp.calls.length - before} call(s)`);
    }
    if (scenario('permission')) {
      // Outside the working directory and TMPDIR (both writable); removed below.
      const outside = join(homedir(), '.cache', `whombat-hermes-e2e-${process.pid}.txt`);
      const r = await turn(
        provider,
        mcp,
        `Use a shell command to write the word hi into ${outside}. If you can't, say so in one sentence.`,
      );
      show('permission (guarded)', r);
      const asked = r.events.filter((e) => e.type === 'permission');
      const wrote = await readFile(outside, 'utf8').catch(() => null);
      // Hermes's own loop asks through its approvals, for Claude and ChatGPT alike (HN-02).
      check('permission asked and answered', asked.length > 0, `${asked.length} question(s)`);
      check('guarded denial holds', wrote === null, wrote === null ? 'not written' : 'written');
      await rm(outside, { force: true });
    }
    if (scenario('stop') || scenario('after-stop')) {
      const r = await turn(
        provider,
        mcp,
        'Run the shell command `sleep 90; echo finished` and then tell me what it printed.',
        { session, stopWhen: (ev) => ev.type === 'tool_call' },
      );
      show('stop', r);
      check('stop ends without an error', !r.error, r.error ?? '');
      check('stop leaves nothing running', leftovers() === 0);
      session = r.session ?? session;
    }
    if (scenario('after-stop') && session) {
      const r = await turn(provider, mcp, 'Reply with exactly the word: again', { session });
      show('after stop', r);
      check('a turn after Stop answers', /again/i.test(r.final) && !r.error, r.error ?? r.final.slice(0, 60));
    }
    if (scenario('follow-up')) {
      // `/steer` into the running turn, ChatGPT's as Claude's (HN-02).
      const r = await turn(
        provider,
        mcp,
        'Run the shell command `sleep 15; echo one` and tell me what it printed.',
        {
          session,
          followUps: {
            items: [
              {
                id: 'msg_follow1',
                prompt: 'John added this while you were working: also end your answer with the word BANANA.',
              },
            ],
            at: (ev) => ev.type === 'tool_call',
          },
        },
      );
      show('follow-up', r);
      check(
        'follow-up delivered',
        r.events.some((e) => e.type === 'steered'),
      );
      check('follow-up answered', /banana/i.test(r.final), r.final.slice(0, 80));
    }
    if (scenario('sandbox')) await inSandbox(provider, mcp);
    if (scenario('browser'))
      await withBrowser(async (socket, word) => {
        // The sandbox's bridge standing in on the host (a free port): Hermes runs here, its CLI on the host's login.
        const bridge = createNetServer((c) => {
          const up = connect(socket);
          c.pipe(up);
          up.pipe(c);
          const done = () => {
            c.destroy();
            up.destroy();
          };
          for (const x of [c, up]) {
            x.on('error', done);
            x.on('close', done);
          }
        });
        await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
        const port = (bridge.address() as AddressInfo).port;
        try {
          const r = await turn(
            provider,
            mcp,
            'Use your web browser (the browser tools): open http://127.0.0.1:8765/ and tell me the exact text of the page’s main heading.',
            { browser: { cdpUrl: `http://127.0.0.1:${port}`, sites: null } },
          );
          show('browser', r);
          check(
            'browser: Hermes used its browser tools',
            r.events.some((e) => e.type === 'tool_call' && /browser_/.test(e.name)),
          );
          check(
            'browser: the answer has the page’s heading',
            r.final.includes(word),
            r.error ?? r.final.slice(0, 120),
          );
        } finally {
          bridge.close();
        }
      });
  } finally {
    mcp.close();
    await giveBack().catch((err: unknown) => console.log(`    ChatGPT login not moved back: ${String(err)}`));
  }
  console.log('\nSummary');
  for (const r of results)
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!process.env.WHOMBAT_HERMES_E2E_KEEP) await rm(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

await main();
