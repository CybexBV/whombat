/**
 * The managed sandbox for real (docs/decisions/managed-sandbox.md, tests): bubblewrap, user / pid / net
 * namespaces, seccomp and a systemd --user scope per task on this host. Skipped — with the reason — only where
 * the host can't run it (no bubblewrap, no unprivileged user namespaces, no user manager).
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../support/process-group';
import { DelegatedCgroups, SystemdUserCgroups } from './cgroup';
import {
  ManagedSandbox,
  SANDBOX_BROWSER_ORIGIN,
  SANDBOX_GATEWAY_ORIGIN,
  SANDBOX_LOGINS_SOCKET,
  SANDBOX_PORTS,
  type SandboxTask,
  SandboxUnavailable,
} from './sandbox';

const testing = fileURLToPath(new URL('./testing/', import.meta.url));

/** Runner-level credentials an operator might have in the runner's environment: none may reach a task. */
const PLANTED_SECRETS: Record<string, string> = Object.fromEntries(
  [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_API_KEY',
    'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'AZURE_OPENAI_API_KEY',
    'AZURE_CLIENT_SECRET',
    'HF_TOKEN',
    'NPM_TOKEN',
    'DATABASE_URL',
    'WHOMBAT_MASTER_KEY',
    'RUNNER_TOKEN',
    'STRIPE_SECRET_KEY',
    'MY_SERVICE_PASSWORD',
    'SENTRY_AUTH_TOKEN',
    'SSH_AUTH_SOCK',
  ].map((k) => [k, `LEAK-${k}`]),
);
/** And a credential smuggled through git's command-line config. */
const PLANTED_GIT = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraheader',
  GIT_CONFIG_VALUE_0: 'Authorization: Bearer LEAK-git',
};
const slice = `wbtest${process.pid}.slice`;
const bwrap =
  ['/usr/bin/bwrap', '/run/current-system/sw/bin/bwrap'].find((p) => existsSync(p)) ?? '/usr/bin/bwrap';

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
}

function collect(child: ChildProcess): { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  return { out: () => out, err: () => err };
}

const probeDir = mkdtempSync(join(tmpdir(), 'wb-sbprobe-'));
const probeSandbox = new ManagedSandbox({
  bwrap,
  cgroups: new SystemdUserCgroups({ slice, generation: 'gprobe' }),
  stateDir: probeDir,
  prefix: 'gprobe',
});
const availability = await probeSandbox.probe();
if (!availability.ok) console.warn(`managed sandbox tests skipped: ${availability.detail}`);

// After every describe (each starts a scope of its own in the slice, which brings the slice back): the probe's scope,
// whether or not a describe ran, and the slices themselves, so no unit of this run outlives it.
afterAll(async () => {
  await probeSandbox.shutdown();
  for (const s of [slice, `wbtestcrash${process.pid}.slice`]) spawnSync('systemctl', ['--user', 'stop', s]);
  rmSync(probeDir, { recursive: true, force: true });
});

describe.runIf(availability.ok)('ManagedSandbox on this host', () => {
  let root: string;
  let sandbox: ManagedSandbox;
  const servers: (Server | HttpServer)[] = [];
  let hostPort = 0;
  let hostHits = 0;
  let mcpPort = 0;
  let webPort = 0;
  let webHits: string[] = [];
  const paths: Record<string, string> = {};

  const listenUnix = async (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    const s = createServer((c) => c.end('reached\n'));
    await new Promise<void>((r) => s.listen(path, r));
    servers.push(s);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wb-sandbox-'));
    const file = (rel: string, content: string) => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, content, { mode: 0o600 });
      return p;
    };
    paths.ownCredential = file('persist/credentials/alice/claude/.credentials.json', '{"alice":"token"}');
    paths.otherCredential = file('persist/credentials/bob/claude/.credentials.json', '{"bob":"token"}');
    paths.masterKey = file('persist/secrets/master.key', 'MASTER');
    paths.identityKey = file('persist/identity/content.key', 'IDENTITY');
    paths.whombatHomeFile = file('persist/whombat/home/runner.token', 'RUNNER');
    paths.dockerSocket = join(root, 'run/docker.sock');
    paths.managerSocket = join(root, 'run/whombat-manager/control.sock');
    paths.helperSocket = join(root, 'run/whombat-update-helper.sock');
    paths.postgresSocket = join(root, 'run/postgresql/.s.PGSQL.5432');
    for (const s of ['dockerSocket', 'managerSocket', 'helperSocket', 'postgresSocket'])
      await listenUnix(paths[s] as string);

    // A host service on loopback (v4 and v6) that must never be reached.
    const host = createServer((c) => {
      hostHits++;
      c.end();
    });
    await new Promise<void>((r) => host.listen({ port: 0, host: '::', ipv6Only: false }, r));
    hostPort = (host.address() as { port: number }).port;
    servers.push(host);
    // The Whombat server standing in: /mcp answers, anything else too (the bridge must not forward it).
    const mcp = createHttpServer((req, res) => res.writeHead(req.url?.startsWith('/mcp') ? 200 : 299).end());
    await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
    mcpPort = (mcp.address() as { port: number }).port;
    servers.push(mcp);
    // "Public" web servers (the resolver maps test names to public addresses, `dial` to this server).
    const web = createHttpServer((req, res) => {
      webHits.push(`${req.headers.host}${req.url}`);
      if (req.url === '/hello') return res.end('hello from allowed.test\n');
      if (req.url === '/to-private') return res.writeHead(302, { location: 'http://10.0.0.5/secret' }).end();
      if (req.url === '/to-loopback')
        return res.writeHead(302, { location: `http://127.0.0.1:${hostPort}/` }).end();
      if (req.url === '/to-v6-loopback')
        return res.writeHead(302, { location: `http://[::1]:${hostPort}/` }).end();
      if (req.url === '/to-metadata')
        return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    webPort = (web.address() as { port: number }).port;
    servers.push(web);

    // The task's repository: a malicious pre-commit hook and postinstall script.
    const repo = join(root, 'workspaces/repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, '.git/hooks/pre-commit'), `#!/bin/sh\nexec node ${testing}probe.mjs hook\n`);
    chmodSync(join(repo, '.git/hooks/pre-commit'), 0o755);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        name: 'victim',
        version: '1.0.0',
        scripts: { postinstall: `node ${testing}probe.mjs npm` },
      }),
    );
    mkdirSync(join(repo, '.probe-out'));

    sandbox = new ManagedSandbox({
      bwrap,
      cgroups: new SystemdUserCgroups({ slice, generation: 'g1' }),
      stateDir: join(root, 'state'),
      prefix: 'g1',
      deniedPaths: [join(root, 'persist'), join(root, 'run')],
      passEnv: ['PROBE_TARGETS', 'PROBE_OUT', 'PROBE_MCP_URL', 'PROBE_API_KEY'],
      egress: {
        resolve: async (name) => {
          const table: Record<string, string[]> = {
            'allowed.test': ['93.184.215.14'],
            'rebind.test': ['93.184.215.16', '10.0.0.1'],
            'other.test': ['93.184.215.17'],
          };
          const found = table[name];
          if (!found) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
          return found.map((address) => ({ address, family: 4 }));
        },
        dial: (_address, _port) => ({ host: '127.0.0.1', port: webPort }),
      },
    });
  }, 30_000);

  afterAll(async () => {
    await sandbox?.shutdown();
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
  });

  const task = (over: Partial<SandboxTask> = {}): SandboxTask => ({
    id: `d${Math.random().toString(36).slice(2, 10)}`,
    cwd: join(root, 'workspaces/repo'),
    writeCwd: true,
    credentialHome: join(root, 'persist/credentials/alice/claude'),
    denied: [join(root, 'persist/credentials')],
    installs: [testing],
    egress: { allow: ['allowed.test', 'rebind.test'] },
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    ...over,
  });

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '/run/user/1000/openssh_agent',
    ...extra,
  });

  it('keeps a provider and its tools (hook, postinstall, MCP server) away from everything but the task', async () => {
    const session = await sandbox.open(task());
    // Credentials in the runner's own environment and in the provider's: none reaches the task.
    const saved = { ...process.env };
    Object.assign(process.env, PLANTED_SECRETS, PLANTED_GIT);
    try {
      const targets = {
        ...paths,
        hostHome: homedir(),
        hostTmp: tmpdir(),
        hostPort,
        runnerPid: process.pid,
        runnerMarker: 'vitest',
        sshAgent: saved.SSH_AUTH_SOCK ?? '/run/user/1000/openssh_agent',
        // The direct DNS checks get no answer and wait this out, in each of the three probes; a real answer from
        // outside would come within milliseconds.
        timeoutMs: 500,
      };
      const child = session.spawn(process.execPath, [join(testing, 'fake-provider.mjs')], {
        cwd: join(root, 'workspaces/repo'),
        env: env({
          ...PLANTED_SECRETS,
          ...PLANTED_GIT,
          // A secret-looking name is dropped even when it is listed to pass.
          PROBE_API_KEY: 'LEAK-listed',
          PROBE_TARGETS: JSON.stringify(targets),
          PROBE_OUT: join(root, 'workspaces/repo/.probe-out'),
          PROBE_MCP_URL: session.mcpUrl as string,
        }),
      });
      const io = collect(child);
      child.stdin.end();
      const { code } = await exited(child);
      expect(code, io.err()).toBe(0);
      const provider = JSON.parse(io.out().trim().split('\n').pop() as string);
      expect(provider).toMatchObject({
        commit: 'ok',
        npm: 'ok',
        mcpServer: 'ok',
        mcp: 200,
        serverOther: 403,
        leaked: [],
      });
      expect(readFileSync(join(root, 'workspaces/repo/provider-done.txt'), 'utf8')).toContain('provider');
      for (const label of ['hook', 'npm', 'mcp-server']) {
        const results = JSON.parse(
          readFileSync(join(root, `workspaces/repo/.probe-out/${label}.json`), 'utf8'),
        );
        const reached = Object.entries(results)
          .filter(([, r]) => (r as { reached: boolean }).reached)
          .map(([name]) => name);
        // The run's owner's own credential home is the one thing outside the task it may use (for its provider).
        expect(reached, `${label}: ${JSON.stringify(results, null, 1)}`).toEqual(['ownCredential']);
      }
      expect(hostHits).toBe(0);
      expect(existsSync(join(tmpdir(), 'whombat-probe-hook'))).toBe(false);
      // Not even in the control files the runner writes for the sandbox.
      const control = join(root, 'state', readdirSync(join(root, 'state'))[0] as string);
      for (const f of readdirSync(control).filter((n) => n.endsWith('.json')))
        expect(readFileSync(join(control, f), 'utf8')).not.toContain('LEAK-');
    } finally {
      for (const k of [...Object.keys(PLANTED_SECRETS), ...Object.keys(PLANTED_GIT)]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await session.close();
    }
  }, 60_000);

  it('lets allowlisted hosts through the proxy and nothing else, redirects included', async () => {
    const session = await sandbox.open(task());
    webHits = [];
    try {
      const script = [
        'set +e',
        'echo "hello=$(curl -sS -m 5 http://allowed.test/hello)"',
        'echo "tunnel=$(curl -sS -m 5 --proxytunnel http://allowed.test/hello)"',
        `echo "direct=$(curl -s -m 3 --noproxy '*' -o /dev/null -w '%{http_code}' http://93.184.215.14/)"`,
        'for p in to-private to-loopback to-v6-loopback to-metadata; do echo "$p=$(curl -sS -m 5 -L -o /dev/null -w "%{http_code}" http://allowed.test/$p)"; done',
        'echo "notallowed=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://other.test/)"',
        'echo "notallowedtls=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" https://other.test/ 2>&1 | tail -c 60)"',
        'echo "rebind=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://rebind.test/)"',
        'echo "literal=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://10.0.0.1/)"',
        // Through the proxy explicitly (NO_PROXY would send it to the sandbox's own loopback), v4 and v6.
        `echo "loopbackproxy=$(curl -sS -m 5 --noproxy '' -x "$HTTP_PROXY" -o /dev/null -w "%{http_code}" http://127.0.0.1:${hostPort}/)"`,
        `echo "loopback6proxy=$(curl -sS -m 5 --noproxy '' -x "$HTTP_PROXY" -o /dev/null -w "%{http_code}" http://[::1]:${hostPort}/)"`,
        `echo "loopbackdirect=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${hostPort}/)"`,
        'echo "dns-allowed=$(getent hosts allowed.test | cut -d" " -f1)"',
        'getent hosts other.test >/dev/null; echo "dns-other=$?"',
        'getent hosts localhost | head -1 | cut -d" " -f1 | sed "s/^/dns-localhost=/"',
      ].join('\n');
      const child = session.spawn('/bin/sh', ['-c', script], { env: env() });
      const io = collect(child);
      child.stdin.end();
      await exited(child);
      const lines = Object.fromEntries(
        io
          .out()
          .trim()
          .split('\n')
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      expect(lines.hello).toBe('hello from allowed.test');
      expect(lines.tunnel).toBe('hello from allowed.test');
      expect(lines.direct).toBe('000');
      // Each hop is a new request: the redirect to a private or metadata address is refused by the proxy. A
      // redirect to loopback isn't proxied at all (NO_PROXY): it goes to the sandbox's own loopback, where
      // nothing listens on that port — the host's service is never reached (hostHits below).
      for (const hop of ['to-private', 'to-metadata']) expect(lines[hop], JSON.stringify(lines)).toBe('403');
      for (const hop of ['to-loopback', 'to-v6-loopback']) expect(lines[hop]).toBe('302');
      expect(lines.notallowed).toBe('403');
      expect(lines.notallowedtls).toMatch(/403/);
      expect(lines.rebind).toBe('403');
      expect(lines.literal).toBe('403');
      expect(lines.loopbackproxy).toBe('403');
      expect(lines.loopback6proxy).toBe('403');
      expect(lines.loopbackdirect).toBe('000');
      expect(lines['dns-allowed']).toBe('93.184.215.14');
      expect(lines['dns-other']).not.toBe('0');
      expect(['127.0.0.1', '::1']).toContain(lines['dns-localhost']);
      expect(hostHits).toBe(0);
      // Only the allowed requests reached the (public stand-in) server.
      expect(webHits.every((h) => h.startsWith('allowed.test'))).toBe(true);
      const denied = session.egressEvents().filter((e) => !e.allowed);
      expect(denied.map((e) => e.host)).toEqual(
        expect.arrayContaining(['10.0.0.5', '127.0.0.1', '169.254.169.254', 'other.test', 'rebind.test']),
      );
    } finally {
      await session.close();
    }
  }, 60_000);

  it('stops a fork bomb at the pids limit and kills it whole', async () => {
    const session = await sandbox.open(task({ limits: { pids: 48 } }));
    try {
      const child = session.spawn('/bin/sh', ['-c', 'bomb() { bomb | bomb & }; bomb; sleep 30'], {
        env: env(),
      });
      child.stdin.end();
      collect(child);
      // Until the cgroup reports the limit hit (it took up to 2.5 s before), instead of always waiting that long.
      const deadline = Date.now() + 15_000;
      while (!(await session.violations()).includes('pids_limit') && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(await session.violations()).toContain('pids_limit');
      const cg = session.cgroupPath();
      await session.kill();
      expect(readFileSync(join(cg, 'cgroup.procs'), 'utf8').trim()).toBe('');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('kills a task at its memory limit', async () => {
    const session = await sandbox.open(task({ limits: { memoryBytes: 96 * 1024 * 1024 } }));
    try {
      const child = session.spawn(
        '/usr/bin/python3',
        [
          '-c',
          'import time\nb=[]\nfor i in range(64): b.append(b"x" * (16<<20)); time.sleep(0.01)\nprint("survived")',
        ],
        { env: env() },
      );
      const io = collect(child);
      child.stdin.end();
      await exited(child);
      expect(io.out()).not.toContain('survived');
      expect(await session.violations()).toContain('memory_limit');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('bridges the AI gateway forwarder to 127.0.0.1:47104 for the CLI, and nothing of it is in the payload’s view (AIG-08)', async () => {
    // The runner's forwarder standing in: an HTTP answer that says what it heard.
    const ctl = join(root, 'aig', 'ctl');
    mkdirSync(ctl, { recursive: true, mode: 0o700 });
    const socket = join(ctl, 'gateway.sock');
    const svc = createHttpServer((req, res) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ heard: `${req.method} ${req.url}`, auth: req.headers.authorization ?? null })),
    );
    await new Promise<void>((r) => svc.listen(socket, r));
    servers.push(svc);
    const session = await sandbox.open(task({ gateway: { socket } }));
    try {
      const child = session.spawn(
        '/bin/sh',
        [
          '-c',
          [
            // What Claude Code and Codex do with the base URL (NO_PROXY keeps loopback off the egress proxy).
            `node -e 'fetch("${SANDBOX_GATEWAY_ORIGIN}/ai-gateway/claude/v1/messages", { method: "POST", headers: { authorization: "Bearer wat_x" }, body: "{}" }).then((r) => r.text()).then((t) => console.log(t), (e) => console.log("error " + e.cause?.code))'`,
            `ls ${ctl} 2>&1`,
            // Every unix socket the payload can see outside the read-only system: none (the gateway's isn't bound).
            `node -e 'const fs = require("fs"); const out = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d); } catch { return; } for (const e of es) { const p = (d === "/" ? "" : d) + "/" + e; if (["/proc", "/sys", "/usr", "/nix", "/dev"].includes(p)) continue; let st; try { st = fs.lstatSync(p); } catch { continue; } if (st.isSocket()) out.push(p); else if (st.isDirectory()) walk(p); } }; walk("/"); console.log(JSON.stringify(out))'`,
            // No provider login rides in the environment (MSB-18): the CLI is pointed at the gateway by its settings.
            'env | grep -E "^(ANTHROPIC|OPENAI|CODEX_API|CLAUDE_CODE_OAUTH)" || echo "no logins"',
          ].join('; '),
        ],
        { env: env({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OPENAI_API_KEY: 'LEAK' }) },
      );
      const io = collect(child);
      child.stdin.end();
      expect((await exited(child)).code, io.err()).toBe(0);
      const lines = io.out().trim().split('\n');
      expect(JSON.parse(lines[0] as string)).toEqual({
        heard: 'POST /ai-gateway/claude/v1/messages',
        auth: 'Bearer wat_x',
      });
      expect(lines[1]).toMatch(/No such file or directory/);
      expect(JSON.parse(lines[2] as string)).toEqual([]);
      expect(lines[3]).toBe('no logins');
      expect(SANDBOX_PORTS.gateway).toBe(47104);
    } finally {
      await session.close();
    }
    // Without the gateway there is no bridge on 47104.
    const plain = await sandbox.open(task());
    try {
      const child = plain.spawn(
        process.execPath,
        [
          '-e',
          `require("net").connect(${SANDBOX_PORTS.gateway}, "127.0.0.1").on("connect", () => console.log("open")).on("error", (e) => console.log(e.code))`,
        ],
        { env: env() },
      );
      const io = collect(child);
      child.stdin.end();
      await exited(child);
      expect(io.out().trim()).toBe('ECONNREFUSED');
    } finally {
      await plain.close();
    }
  }, 30_000);

  it('bridges the browser’s CDP relay to 127.0.0.1:47105 and binds the logins socket file alone (HE-S137, HE-S141)', async () => {
    // The runner's CDP relay and logins service standing in.
    const ctl = join(root, 'browser', 'ctl');
    mkdirSync(ctl, { recursive: true, mode: 0o700 });
    const relay = join(ctl, 'cdp.sock');
    const cdp = createHttpServer((req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ heard: req.url })),
    );
    await new Promise<void>((r) => cdp.listen(relay, r));
    servers.push(cdp);
    const loginsDir = join(root, 'logins', 'ctl');
    mkdirSync(loginsDir, { recursive: true, mode: 0o700 });
    const logins = join(loginsDir, 'logins.sock');
    const svc = createServer((c) => c.end('{"ok":true}\n'));
    await new Promise<void>((r) => svc.listen(logins, r));
    servers.push(svc);
    const session = await sandbox.open(task({ browser: { socket: relay }, logins: { socket: logins } }));
    try {
      const child = session.spawn(
        '/bin/sh',
        [
          '-c',
          [
            `node -e 'fetch("${SANDBOX_BROWSER_ORIGIN}/json/version").then((r) => r.text()).then((t) => console.log(t), (e) => console.log("error " + e.cause?.code))'`,
            `node -e 'const s = require("net").connect(process.env.WHOMBAT_LOGINS_SOCKET); s.on("data", (d) => process.stdout.write(d)); s.on("error", (e) => console.log(e.code))'`,
            `echo "$WHOMBAT_LOGINS_SOCKET"`,
            `ls ${ctl} ${loginsDir} 2>&1 | grep -c "No such file"`,
          ].join('; '),
        ],
        { env: env() },
      );
      const io = collect(child);
      child.stdin.end();
      expect((await exited(child)).code, io.err()).toBe(0);
      const lines = io.out().trim().split('\n');
      expect(JSON.parse(lines[0] as string)).toEqual({ heard: '/json/version' });
      expect(JSON.parse(lines[1] as string)).toEqual({ ok: true });
      expect(lines[2]).toBe(SANDBOX_LOGINS_SOCKET);
      // Neither service's folder is in the payload's view.
      expect(lines[3]).toBe('2');
      expect(SANDBOX_PORTS.browser).toBe(47105);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('kills a task that floods its output', async () => {
    const session = await sandbox.open(task({ limits: { outputBytes: 1024 * 1024 } }));
    try {
      const child = session.spawn('/usr/bin/yes', ['flood'], { env: env() });
      collect(child);
      child.stdin.end();
      const exit = await exited(child);
      expect(exit.code === 0).toBe(false);
      expect(await session.violations()).toContain('output_limit');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('gives the payload blocking stdio, so a burst of output waits for a slow reader instead of failing', async () => {
    const session = await sandbox.open(task());
    try {
      // The shell's own descriptors (a Node payload would switch its stdio to non-blocking by itself), then 4 MiB
      // through `head`, which gives up on EAGAIN.
      const script = [
        "sleep 1; for fd in 0 1 2; do sed -n 's/^flags:[[:space:]]*//p' /proc/$$/fdinfo/$fd; done >&2",
        'head -c 4194304 /dev/zero',
      ].join('\n');
      const child = session.spawn('/bin/sh', ['-c', script], { env: env() });
      const closed = new Promise((r) => child.once('close', r));
      // Nobody reads stdout for a second: the payload's writes have to block, not fail with EAGAIN.
      child.stdout.pause();
      let err = '';
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      let bytes = 0;
      child.stdout.on('data', (d: Buffer) => {
        bytes += d.length;
      });
      child.stdin.on('error', () => {});
      child.stdin.end();
      await new Promise((r) => setTimeout(r, 1000));
      child.stdout.resume();
      expect(await closed, err).toBe(0);
      const flags = err.trim().split('\n').slice(0, 3);
      expect(flags.map((f) => (Number.parseInt(f, 8) & 0o4000) !== 0)).toEqual([false, false, false]);
      expect(bytes).toBe(4 * 1024 * 1024);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('cancellation (the providers’ process-group kill) takes down the whole tree, setsid children too', async () => {
    const n = 300_000 + (process.pid % 90_000);
    const marker = `sleep ${n}`;
    const session = await sandbox.open(task());
    try {
      const child = session.spawn(
        '/bin/sh',
        ['-c', `sleep ${n}1 & setsid sleep ${n} & nohup sleep ${n}2 >/dev/null 2>&1 & echo started; wait`],
        { env: env() },
      );
      const io = collect(child);
      child.stdin.end();
      while (!io.out().includes('started')) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      expect(execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()).not.toBe('');
      await killProcessTree(child, { graceMs: 200 });
      await new Promise((r) => setTimeout(r, 300));
      expect(() => execFileSync('pgrep', ['-f', marker])).toThrow();
      const cg = session.cgroupPath();
      if (existsSync(cg)) expect(readFileSync(join(cg, 'cgroup.procs'), 'utf8').trim()).toBe('');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('denies kernel interfaces by seccomp and still nests the providers’ own sandboxes', async () => {
    const session = await sandbox.open(task());
    try {
      const py = [
        'import ctypes',
        'libc = ctypes.CDLL(None, use_errno=True)',
        'for name, nr in (("keyctl", 250), ("bpf", 321), ("perf_event_open", 298), ("userfaultfd", 323), ("open_by_handle_at", 304), ("io_uring_setup", 425)):',
        '    r = libc.syscall(nr, 0, 0, 0, 0, 0)',
        '    print(name, r, ctypes.get_errno())',
      ].join('\n');
      const script = `python3 -c '${py}'; ${bwrap} --unshare-all --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev -- /bin/true && echo nested-ok; unshare -Ur id -u`;
      const child = session.spawn('/bin/sh', ['-c', script], { env: env() });
      const io = collect(child);
      child.stdin.end();
      await exited(child);
      const out = io.out();
      for (const name of ['keyctl', 'bpf', 'perf_event_open', 'userfaultfd', 'open_by_handle_at'])
        expect(out, io.err()).toContain(`${name} -1 1\n`);
      expect(out).toContain('io_uring_setup -1 38\n');
      expect(out).toContain('nested-ok');
      expect(out).toContain('\n0\n');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('terminates the tree of a runner that crashed, and a restarted generation removes what is left', async () => {
    const n = 400_000 + (process.pid % 90_000);
    // Its own slice: a new generation kills every other generation's scope in the slice.
    const crashSlice = `wbtestcrash${process.pid}.slice`;
    const marker = `sleep ${n}`;
    const script = join(root, 'crashing-runner.mts');
    writeFileSync(
      script,
      `import { ManagedSandbox, SystemdUserCgroups } from ${JSON.stringify(fileURLToPath(new URL('./index.ts', import.meta.url)))};
const sb = new ManagedSandbox({ bwrap: ${JSON.stringify(bwrap)}, cgroups: new SystemdUserCgroups({ slice: ${JSON.stringify(crashSlice)}, generation: 'g7' }), stateDir: ${JSON.stringify(join(root, 'state-crash'))}, prefix: 'g7' });
const s = await sb.open({ id: 'crash', cwd: ${JSON.stringify(join(root, 'workspaces/repo'))}, writeCwd: true, egress: { allow: [] } });
const c = s.spawn('/bin/sh', ['-c', "setsid sleep ${n} & echo up; wait"], { env: { PATH: '/usr/bin:/bin' } });
c.stdout.on('data', (d) => process.stdout.write(d));
`,
    );
    // `node --import tsx`: the runner is this process itself (a `tsx` CLI would be a parent that dies alone).
    const runner = spawn(process.execPath, ['--import', 'tsx', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: fileURLToPath(new URL('.', import.meta.url)),
    });
    const io = collect(runner);
    const deadline = Date.now() + 20_000;
    while (!io.out().includes('up') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(io.out(), io.err()).toContain('up');
    await new Promise((r) => setTimeout(r, 300));
    expect(execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()).not.toBe('');
    runner.kill('SIGKILL');
    await exited(runner);
    // bubblewrap dies with its parent, and with it the task's pid namespace: nothing outlives the runner.
    const gone = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < gone) {
      try {
        execFileSync('pgrep', ['-f', marker]);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);

    // g7's generation scope outlived its runner (its anchor), and a task that did survive in it (planted: a
    // process put in a g7 task cgroup outside any sandbox): the next generation's start kills both.
    const g7Unit = `${crashSlice.replace(/\.slice$/, '')}-g7.scope`;
    const g7Dir = execFileSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', g7Unit], {
      encoding: 'utf8',
    }).trim();
    expect(g7Dir).not.toBe('');
    const g7 = new DelegatedCgroups({ root: `/sys/fs/cgroup${g7Dir}`, generation: 'g7' });
    const planted = await g7.create('planted', { memoryBytes: 64 * 1024 * 1024, pids: 16, cpuWeight: 100 });
    const wrapped = planted.wrap('sleep', [`${n}9`]);
    const survivor = spawn(wrapped.command, wrapped.args, { detached: true, stdio: 'ignore' });
    survivor.unref();
    await planted.attached(survivor.pid as number);
    expect(execFileSync('pgrep', ['-f', `${marker}9`], { encoding: 'utf8' }).trim()).not.toBe('');
    const restarted = new ManagedSandbox({
      bwrap,
      cgroups: new SystemdUserCgroups({ slice: crashSlice, generation: 'g8' }),
      stateDir: join(root, 'state-g8'),
      prefix: 'g8',
    });
    const killed = await restarted.killOrphans();
    expect(killed).toContain('g7');
    const until = Date.now() + 3_000;
    let survived = true;
    while (survived && Date.now() < until) {
      try {
        execFileSync('pgrep', ['-f', `${marker}9`]);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        survived = false;
      }
    }
    expect(survived).toBe(false);
    await restarted.shutdown();
  }, 60_000);

  it.runIf(existsSync(join(homedir(), '.local/bin/claude')))(
    'runs the real Claude Code binary inside (no model call)',
    async () => {
      const session = await sandbox.open(task());
      try {
        const child = session.spawn(join(homedir(), '.local/bin/claude'), ['--version'], {
          env: env({ DISABLE_AUTOUPDATER: '1' }),
        });
        const io = collect(child);
        child.stdin.end();
        const { code } = await exited(child);
        expect(code, io.err()).toBe(0);
        expect(io.out()).toMatch(/\d+\.\d+\.\d+ \(Claude Code\)/);
      } finally {
        await session.close();
      }
    },
    30_000,
  );

  it.runIf(existsSync(join(homedir(), '.local/bin/codex')))(
    'runs the real Codex binary inside (no model call)',
    async () => {
      const session = await sandbox.open(task());
      try {
        const child = session.spawn('codex', ['--version'], { env: env() });
        const io = collect(child);
        child.stdin.end();
        const { code } = await exited(child);
        expect(code, io.err()).toBe(0);
        expect(io.out()).toMatch(/codex-cli \d+\.\d+\.\d+/);
      } finally {
        await session.close();
      }
    },
    30_000,
  );
});

/** The native Codex binary the npm launcher (`~/.local/bin/codex`) runs, as the runner starts it. */
const codexNative = join(
  homedir(),
  '.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
);

describe.runIf(availability.ok && existsSync(codexNative))(
  'ManagedSandbox with the real Codex app-server',
  () => {
    let root: string;
    let sandbox: ManagedSandbox;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'wb-sandbox-codex-'));
      mkdirSync(join(root, 'repo/.codex-home'), { recursive: true });
      sandbox = new ManagedSandbox({
        bwrap,
        cgroups: new SystemdUserCgroups({ slice, generation: 'g3' }),
        stateDir: join(root, 'state'),
        prefix: 'g3',
        egress: { resolve: async () => [] },
      });
    });

    afterAll(async () => {
      await sandbox?.shutdown();
      rmSync(root, { recursive: true, force: true });
    });

    // A non-blocking stdout makes the app-server drop its connection on the first EAGAIN: every later
    // notification, `turn/completed` included, is lost and the turn waits forever.
    it('keeps the app-server’s stdout blocking', async () => {
      const session = await sandbox.open({
        id: 'dcodex',
        cwd: join(root, 'repo'),
        writeCwd: true,
        egress: { allow: [] },
      });
      try {
        const child = session.spawn(codexNative, ['app-server'], {
          cwd: join(root, 'repo'),
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CODEX_HOME: join(root, 'repo/.codex-home') },
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
        });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => {});
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '0' }, capabilities: {} } })}\n`,
        );
        while (!out.includes('"id":1')) await new Promise((r) => setTimeout(r, 50));
        const procs = execFileSync(
          'find',
          [session.cgroupPath(), '-name', 'cgroup.procs', '-exec', 'cat', '{}', '+'],
          {
            encoding: 'utf8',
          },
        )
          .split('\n')
          .filter(Boolean);
        const server = procs.find((pid) => {
          try {
            return readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith(`${codexNative}\0app-server`);
          } catch {
            return false;
          }
        });
        expect(server).toBeDefined();
        const flags = (fd: number) =>
          Number.parseInt(
            readFileSync(`/proc/${server}/fdinfo/${fd}`, 'utf8').match(/flags:\s*(\d+)/)?.[1] ?? '',
            8,
          );
        expect([1, 2].map((fd) => (flags(fd) & 0o4000) !== 0)).toEqual([false, false]);
        await killProcessTree(child, { graceMs: 200 });
      } finally {
        await session.close();
      }
    }, 30_000);
  },
);

describe('ManagedSandbox where the boundary is missing', () => {
  it('fails clearly without bubblewrap', async () => {
    const sb = new ManagedSandbox({
      bwrap: '/nonexistent/bwrap',
      cgroups: new SystemdUserCgroups({ slice, generation: 'gnone' }),
      stateDir: mkdtempSync(join(tmpdir(), 'wb-sbnone-')),
      prefix: 'g1',
    });
    await expect(sb.open({ id: 'x', cwd: tmpdir(), writeCwd: false, egress: { allow: [] } })).rejects.toThrow(
      SandboxUnavailable,
    );
    await expect(sb.probe()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('not installed'),
    });
  });

  it.runIf(availability.ok)('fails clearly without task cgroups', async () => {
    const sb = new ManagedSandbox({
      bwrap,
      cgroups: new SystemdUserCgroups({ slice, generation: 'gnocg', systemdRun: '/nonexistent/systemd-run' }),
      stateDir: mkdtempSync(join(tmpdir(), 'wb-sbnocg-')),
      prefix: 'g1',
    });
    const err = await sb
      .open({ id: 'x', cwd: tmpdir(), writeCwd: false, egress: { allow: [] } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SandboxUnavailable);
    expect((err as SandboxUnavailable).detail).toMatch(/no task cgroups/);
  });
});
