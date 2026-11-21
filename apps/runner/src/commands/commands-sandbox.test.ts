/**
 * The agent's commands in a real pod (one-person.md OP-07, OP-S105…OP-S112; bubblewrap, nsenter and a systemd --user
 * scope on this host, as agent-runtime's `pod-sandbox.test.ts`): the runner's `PodManager` with the real managed
 * sandbox, a stand-in Hermes that runs commands as Hermes's terminal environment does (`whombat-command`), and the
 * commands-network daemon's proxy in this process. What a command sees, what it must not, and what lives on. Skipped —
 * with the reason — where the host can't build the sandbox.
 */
import { type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer, request } from 'node:http';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_POLICY, type NetPolicy, startControl, startProxy } from '@whombat/agent-net';
import {
  ManagedSandbox,
  onPath,
  SANDBOX_COMMANDS_SOCKET,
  SANDBOX_LOGINS_SOCKET,
  type SandboxSession,
  SystemdUserCgroups,
} from '@whombat/agent-runtime';
import { FAKE_POD_HERMES } from '@whombat/agent-runtime/testing/hermes';
import { COMMANDS_INIT_PATH } from '@whombat/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasChromium } from '../browser';
import { PodManager, type PodShape, type PodTurn } from '../pods';
import { commandGuard, type RunnerCommandsApi } from './api';
import { AgentNet } from './net';
import { type CommandsBox, CommandsPlace } from './place';
import { TurnCommands } from './turn';

const slice = `wbcmdtest${process.pid}.slice`;
const bwrap = onPath('bwrap');
const nsenter = onPath('nsenter');
const probeDir = mkdtempSync(join(tmpdir(), 'wb-cmdprobe-'));
const probe =
  bwrap && nsenter
    ? new ManagedSandbox({
        bwrap,
        nsenter,
        cgroups: new SystemdUserCgroups({ slice, generation: 'gcmdprobe' }),
        stateDir: probeDir,
        prefix: 'gcmdprobe',
      })
    : null;
const availability = probe ? await probe.probe() : { ok: false, detail: 'no bubblewrap or nsenter' };
if (!availability.ok) console.warn(`commands sandbox tests skipped: ${availability.detail}`);

// After every describe (each starts a scope of its own in the slice, which brings the slice back): the probe's scope,
// whether or not a describe ran, and the slice itself, so no unit of this run outlives it.
afterAll(async () => {
  await probe?.shutdown();
  spawnSync('systemctl', ['--user', 'stop', slice]);
  rmSync(probeDir, { recursive: true, force: true });
});

function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      stream.off('data', onData);
      stream.off('end', onEnd);
      resolve(buf.slice(0, nl));
    };
    const onEnd = () => reject(new Error(`ended: ${buf}`));
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}

const api: RunnerCommandsApi = {
  authorizeCommand: async () => ({
    outcome: 'blocked',
    approvalId: null,
    message: 'whombat: not here.',
    open: [],
  }),
  authorizeWait: async () => ({ outcome: 'declined', scope: null, message: 'no', open: [] }),
  turnKeys: async () => ({
    files: [{ path: 'ssh/id_test', mode: '600', base64: Buffer.from('secret-key\n').toString('base64') }],
    env: [{ name: 'DEPLOY_TOKEN', value: 'tok-1234' }],
    mcpServers: [],
    entries: [],
  }),
  notify: async () => {},
};

describe.runIf(availability.ok)('the agent’s commands in a pod', () => {
  let root: string;
  let sandbox: ManagedSandbox;
  let pods: PodManager;
  let turn: PodTurn;
  let viewer: ChildProcessWithoutNullStreams;
  let policy: NetPolicy | null = null;
  let upstream: HttpServer;
  let docker: Server;
  const closers: (() => Promise<unknown> | unknown)[] = [];
  const profile = () => join(root, 'hermes', 'profiles', 'alice');
  const agentHome = () => join(root, 'agent', 'home');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'c-'));
    // The profile with what a command must never see beside its skills.
    mkdirSync(join(profile(), 'skills', 'notes'), { recursive: true });
    writeFileSync(join(profile(), 'skills', 'notes', 'SKILL.md'), '# notes\n');
    writeFileSync(join(profile(), 'auth.json'), '{"secret":"chatgpt"}\n');
    writeFileSync(join(profile(), 'whombat-policy.json'), '{}\n');
    mkdirSync(join(profile(), 'whombat-turns', 'sess-a'), { recursive: true });
    writeFileSync(join(profile(), 'whombat-turns', 'sess-a', 'policy.json'), '{}\n');
    mkdirSync(join(root, 'credentials', 'claude'), { recursive: true });
    writeFileSync(join(root, 'credentials', 'claude', '.credentials.json'), 'sk-secret\n');
    mkdirSync(join(root, 'workspaces', 'repo'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'repo', 'README.md'), 'the checkout\n');
    mkdirSync(join(root, 'workspaces', 'other'), { recursive: true });
    // A public site for the proxy (`public.example`), dialled here.
    upstream = createHttpServer((_q, s) => s.end('hello from outside'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as AddressInfo).port;
    mkdirSync(join(root, 'net'), { recursive: true });
    const proxy = await startProxy({
      path: join(root, 'net', 'proxy.sock'),
      policy: () => policy,
      facts: () => ({ hostAddresses: [], deny: [] }),
      resolve4: async (h) => (h === 'public.example' ? ['93.184.216.34'] : ['10.9.9.9']),
      dial: () => ({ host: '127.0.0.1', port }),
    });
    const control = await startControl({
      path: join(root, 'net', 'control.sock'),
      apply: (p) => {
        policy = p;
      },
      current: () => policy ?? EMPTY_POLICY,
    });
    closers.push(proxy.close, control.close);
    // The container engine's socket stands in as a listening socket.
    docker = createServer((s) => s.end('docker\n'));
    await new Promise<void>((r) => docker.listen(join(root, 'podman.sock'), () => r()));
    const net = new AgentNet({ control: join(root, 'net', 'control.sock'), log: () => {} });
    const box: CommandsBox = {
      guard: commandGuard,
      net,
      proxySocket: join(root, 'net', 'proxy.sock'),
      log: () => {},
      agentHome: agentHome(),
      tools: null,
      nixLd: { ld: null, libraryPath: null },
      hostPath: process.env.PATH ?? '/usr/bin:/bin',
      containers: join(root, 'podman.sock'),
      notify: async () => {},
    };
    sandbox = new ManagedSandbox({
      bwrap: bwrap as string,
      nsenter: nsenter as string,
      cgroups: new SystemdUserCgroups({ slice, generation: 'gcmd' }),
      stateDir: join(root, 'state'),
      prefix: 'gcmd',
      deniedPaths: [join(root, 'credentials')],
    });
    pods = new PodManager({
      sandboxes: sandbox,
      hermes: () => ({ gateway: ['gateway', 'run'], acp: ['acp'] }),
      stateDir: join(root, 'pods'),
      hermesRoot: join(root, 'hermes'),
      roots: () => [join(root, 'workspaces')],
      serverUrl: 'http://127.0.0.1:9',
      log: () => {},
      commands: box,
      chromium: hasChromium(['/usr/bin', '/bin', '/run/current-system/sw/bin']),
    });
    const shape: PodShape = {
      profile: profile(),
      bin: FAKE_POD_HERMES,
      installs: [join(FAKE_POD_HERMES, '..')],
      readable: [],
      path: [],
      env: { HERMES_HOME: profile() },
      credential: null,
      denied: [join(root, 'credentials')],
      mcpUrl: 'http://127.0.0.1:9/mcp',
      egress: { allow: [] },
    };
    const commands = await TurnCommands.open(
      { api, guard: commandGuard, net, log: () => {} },
      {
        dispatchId: 'dsp_cmdtest0001',
        lease: { runnerId: 'rnr_test', attempt: 1 },
        context: { productionServers: [], homeNetworks: [], lan: false },
        binds: [
          { src: join(root, 'workspaces', 'repo'), dest: join(root, 'workspaces', 'repo'), mode: 'rw' },
        ],
        cwd: join(root, 'workspaces', 'repo'),
        env: { GIT_AUTHOR_NAME: 'Dusty' },
        readOnlyInside: [],
        wantsKeys: true,
      },
    );
    turn = await pods.admit(shape, {
      dispatchId: 'dsp_cmdtest0001',
      commands,
      logins: null,
      gatewayToken: null,
      egress: { allow: [] },
    });
    turn.bind('sess-a');
    viewer = turn.spawnAcp(join(root, 'workspaces', 'repo'));
  }, 120_000);

  afterAll(async () => {
    viewer?.stdin.end();
    await pods?.close();
    for (const c of closers) await c();
    upstream?.close();
    docker?.close();
    await sandbox?.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  /** One command through the stand-in Hermes (its terminal environment's launcher), in `session`. */
  async function run(script: string, session: string | null = 'sess-a') {
    viewer.stdin.write(`${JSON.stringify({ run: { argv: ['bash', '-c', script], session } })}\n`);
    const answer = JSON.parse(await nextLine(viewer.stdout)) as {
      ran: { code: number; stdout: string; stderr: string };
    };
    return answer.ran;
  }

  it('runs as the agent in its home, with the turn’s checkout, keys and environment', async () => {
    const r = await run(
      'echo "$HOME"; id -un; pwd; cat README.md; echo "$GIT_AUTHOR_NAME $DEPLOY_TOKEN $WHOMBAT_TURN"; cat /run/whombat/keys/ssh/id_test; echo kept > "$HOME/note"; echo "$PATH" | cut -d: -f1; test -S /run/whombat/docker.sock && echo "$DOCKER_HOST"',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      agentHome(),
      'agent',
      join(root, 'workspaces', 'repo'),
      'the checkout',
      'Dusty tok-1234 dsp_cmdtest0001',
      'secret-key',
      '/run/whombat/bin',
      'unix:///run/whombat/docker.sock',
    ]);
    expect(readFileSync(join(agentHome(), 'note'), 'utf8')).toBe('kept\n');
  }, 60_000);

  it('sees nothing of Hermes’s home but its skills, no sign-in, no policy, none of the pod’s sockets', async () => {
    const hidden = [
      profile(),
      join(profile(), 'auth.json'),
      join(profile(), 'whombat-policy.json'),
      join(profile(), 'whombat-turns', 'sess-a', 'policy.json'),
      join(root, 'credentials', 'claude', '.credentials.json'),
      join(root, 'workspaces', 'other'),
      SANDBOX_LOGINS_SOCKET,
      SANDBOX_COMMANDS_SOCKET,
      // The desk kiosk's Chromium policies (every URL blocked, no DevTools): never the agent's (OP-S117).
      '/etc/chromium',
      '/etc/chromium/policies',
      join(root, 'pods'),
      join(root, 'net', 'control.sock'),
    ];
    const r = await run(
      [
        ...hidden.map((p) => `if test -e '${p}' && ! test -d '${p}/skills'; then echo "seen ${p}"; fi`),
        `ls '${join(profile(), 'skills')}'`,
        `test -e '${profile()}/auth.json' && echo "seen auth"`,
        'true',
      ].join('\n'),
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['notes']);
  }, 60_000);

  it('sees only the commands’ processes, and reaches none of the pod’s loopback services', async () => {
    const r = await run(
      'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline; echo; done; for port in 47100 47101 47104 47105; do (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && echo "REACH-$port"; done; true',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/fake-pod-hermes|pod-init|shim\.mjs/);
    expect(r.stdout).not.toMatch(/REACH-\d/);
  }, 60_000);

  it('goes out through the proxy only where the wall allows', async () => {
    const r = await run(
      'curl -s --max-time 5 http://public.example/; echo; curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://inside.example/; echo',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['hello from outside', '403']);
  }, 60_000);

  it('keeps a server and a background job of one command for the next ones', async () => {
    const started = await run(
      "nohup node -e \"require('http').createServer((q,s)=>s.end('neighbour')).listen(4567,'127.0.0.1')\" >/dev/null 2>&1 & echo $!",
    );
    const pid = started.stdout.trim();
    expect(pid).toMatch(/^\d+$/);
    let r = { stdout: '', code: 1, stderr: '' };
    for (let i = 0; i < 40 && !r.stdout.includes('neighbour'); i++) {
      await new Promise((res) => setTimeout(res, 150));
      r = await run('curl -s --max-time 2 http://127.0.0.1:4567/ || true');
    }
    expect(r.stdout).toBe('neighbour');
    expect((await run(`kill -0 ${pid} && echo alive`)).stdout.trim()).toBe('alive');
    expect((await run(`kill ${pid}; sleep 0.2; kill -0 ${pid} 2>/dev/null || echo gone`)).stdout.trim()).toBe(
      'gone',
    );
  }, 60_000);

  it('runs each command in a cgroup of its own under the pod’s, its OOM score raised', async () => {
    // A job the command leaves behind keeps its cgroup: `<pod>/commands/run/c-<id>` in the generation's scope. Its
    // output goes elsewhere, or the command's stdout stays open and the stand-in Hermes waits for the job.
    const r = await run(
      'cat /proc/self/cgroup; cat /proc/self/oom_score_adj; (sleep 30 >/dev/null 2>&1 &) ; true',
    );
    expect(r.code, r.stderr).toBe(0);
    // Its own cgroup namespace: it sees no cgroup above its own.
    expect(r.stdout.trim().split('\n')).toEqual(['0::/', '500']);
    const slicePath = spawnSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', slice], {
      encoding: 'utf8',
    }).stdout.trim();
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory()) {
          const path = join(dir, e.name);
          if (/\/commands\/run\/c-[\w-]+$/.test(path)) found.push(path);
          walk(path, depth + 1);
        }
    };
    walk(join('/sys/fs/cgroup', slicePath), 0);
    expect(found.length).toBeGreaterThan(0);
    await run('pkill -f "sleep 30"; true');
  }, 60_000);

  it('gives a session with no live turn the agent’s home and nothing of a turn', async () => {
    const r = await run(
      'echo "$HOME [$DEPLOY_TOKEN]"; test -e /run/whombat/keys && echo keys; true',
      'sess-gone',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`${agentHome()} []`);
  }, 60_000);

  it.runIf(hasChromium(['/usr/bin', '/bin', '/run/current-system/sw/bin']))(
    'starts the person’s Chromium in the commands’ network, which opens what a command serves there',
    async () => {
      // A page a command serves on the commands' loopback.
      await run(
        "nohup node -e \"require('http').createServer((q,s)=>s.end('<title>served</title>')).listen(8766,'127.0.0.1')\" >/dev/null 2>&1 &",
      );
      const relay = turn.browser?.socket as string;
      const get = (path: string, method = 'GET') =>
        new Promise<string>((resolve, reject) => {
          const req = request(
            { socketPath: relay, path, method, headers: { host: '127.0.0.1:47105' } },
            (res) => {
              let body = '';
              res.on('data', (c: Buffer) => {
                body += c.toString();
              });
              res.on('end', () => resolve(body));
            },
          );
          req.on('error', reject);
          req.end();
        });
      const version = JSON.parse(await get('/json/version')) as { webSocketDebuggerUrl?: string };
      expect(version.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:47105\/devtools\/browser\//);
      // Open the command's page in a new tab and read its title through DevTools.
      await get('/json/new?http://127.0.0.1:8766/', 'PUT');
      let title = '';
      for (let i = 0; i < 50 && title !== 'served'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const tabs = JSON.parse(await get('/json/list')) as { title?: string; url?: string }[];
        title = tabs.find((t) => t.url?.startsWith('http://127.0.0.1:8766'))?.title ?? '';
      }
      expect(title).toBe('served');
    },
    90_000,
  );

  it('asks before a consequential command, and doesn’t run it when that’s blocked', async () => {
    const r = await run('git push --force origin main');
    expect(r.code).toBe(126);
    expect(r.stderr).toContain('whombat: not here.');
  }, 60_000);
});

describe.runIf(availability.ok)('an outsiders’ turn’s commands (OP-17)', () => {
  let root: string;
  let sandbox: ManagedSandbox;
  let place: CommandsPlace;
  let session: SandboxSession;
  let viewer: ChildProcessWithoutNullStreams;
  const agentHome = () => join(root, 'agent', 'home');
  const feedback = () => join(root, 'hermes', 'profiles', '_feedback');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wb-out-'));
    mkdirSync(agentHome(), { recursive: true });
    // The outsiders' own profile: a lent sign-in in it during the turn (OP-17), its skills beside.
    mkdirSync(join(feedback(), 'skills', 'triage'), { recursive: true });
    writeFileSync(join(feedback(), 'skills', 'triage', 'SKILL.md'), '# triage\n');
    writeFileSync(join(feedback(), 'auth.json'), '{"access_token":"lent"}\n');
    writeFileSync(join(feedback(), 'config.yaml'), 'model: {}\n');
    writeFileSync(join(agentHome(), 'diary.txt'), 'the person’s\n');
    mkdirSync(join(root, 'workspaces', 'repo'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'repo', 'README.md'), 'the checkout\n');
    const docker = createServer((s) => s.end());
    await new Promise<void>((r) => docker.listen(join(root, 'podman.sock'), () => r()));
    const box: CommandsBox = {
      guard: commandGuard,
      net: new AgentNet({ control: join(root, 'none.sock'), log: () => {} }),
      proxySocket: join(root, 'none.sock'),
      log: () => {},
      agentHome: agentHome(),
      tools: null,
      nixLd: { ld: null, libraryPath: null },
      hostPath: process.env.PATH ?? '/usr/bin:/bin',
      containers: join(root, 'podman.sock'),
      notify: async () => {},
    };
    sandbox = new ManagedSandbox({
      bwrap: bwrap as string,
      nsenter: nsenter as string,
      cgroups: new SystemdUserCgroups({ slice, generation: 'gout' }),
      stateDir: join(root, 'state'),
      prefix: 'gout',
    });
    const repo = join(root, 'workspaces', 'repo');
    const commands = await TurnCommands.open(
      { api, guard: commandGuard, net: null, log: () => {} },
      {
        dispatchId: 'dsp_outside00001',
        lease: { runnerId: 'rnr_test', attempt: 1 },
        context: null,
        binds: [{ src: repo, dest: repo, mode: 'ro' }],
        cwd: repo,
        env: {},
        readOnlyInside: [],
        wantsKeys: false,
      },
    );
    place = await CommandsPlace.open(box, {
      kind: 'outside',
      base: join(root, 'task'),
      node: sandbox.node,
      skills: join(feedback(), 'skills'),
      roots: [],
      binds: commands.turn.binds,
    });
    place.admit(commands);
    session = await sandbox.open({
      id: 'out_test',
      cwd: repo,
      writeCwd: false,
      installs: [join(FAKE_POD_HERMES, '..')],
      stateDirs: [feedback(), ...place.stateDirs],
      readable: place.readable,
      env: place.env,
      commands: place.sandbox,
      // A browser relay, as an assessment's turn has: its folder is mounted read-only, which mustn't cover the commands'.
      browser: { socket: place.browserSocket },
      egress: { allow: [] },
    });
    const config = place.hostConfig({
      bwrap: bwrap as string,
      nsenter: nsenter as string,
      cgroup: session.commandsCgroup(),
    });
    viewer = session.spawn(
      sandbox.node,
      [COMMANDS_INIT_PATH, JSON.stringify(config), FAKE_POD_HERMES, 'acp'],
      {
        cwd: repo,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    closersOut.push(async () => docker.close());
  }, 120_000);

  const closersOut: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    viewer?.stdin.end();
    await session?.close();
    await place?.close();
    for (const c of closersOut) await c();
    await sandbox?.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  it('sees neither the agent’s home, its profile’s sign-in nor the container engine, and only reads its checkout', async () => {
    viewer.stdin.write(
      `${JSON.stringify({
        run: {
          argv: [
            'bash',
            '-c',
            `echo "$HOME"; test -e '${agentHome()}' && echo home-seen; test -e '${join(root, 'podman.sock')}' && echo engine-seen; test -e /run/whombat/docker.sock && echo docker-seen; echo "[$DOCKER_HOST]"; test -e /run/whombat/agent.sock && echo notify-seen; test -e /run/whombat/keys && echo keys-seen; test -e '${join(feedback(), 'auth.json')}' && echo auth-seen; test -e '${join(feedback(), 'config.yaml')}' && echo config-seen; ls '${join(feedback(), 'skills')}'; cat README.md; echo x > README.md 2>/dev/null || echo read-only`,
          ],
          session: 'any',
        },
      })}\n`,
    );
    const { ran } = JSON.parse(await nextLine(viewer.stdout)) as {
      ran: { code: number; stdout: string; stderr: string };
    };
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trim().split('\n')).toEqual([place.home, '[]', 'triage', 'the checkout', 'read-only']);
  }, 60_000);
});
