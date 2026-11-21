/**
 * The runner's side of the agent's commands without a sandbox (one-person.md OP-07, OP-S105…OP-S112): the wrapper's
 * command lines, what of a turn a command sees, the guard and a person's answer, the wall's policy, the helper's
 * socket. The real thing runs in `commands-sandbox.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_POLICY, type NetPolicy, startControl } from '@whombat/agent-net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandGuard } from './api';
import { turnBinds } from './binds';
import { FakeServer } from './fakes';
import { AgentNet } from './net';
import { type CommandsBox, CommandsPlace } from './place';
import { hermesCommand } from './repeats';
import { commandText, limiter, ONCE_GRACE_MS, TurnCommands, type TurnCommandsTurn } from './turn';
import { bindArgs, commandArgs, etcFiles, holderArgs, IN, launcher } from './wrapper';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-commands-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const none = () => null;
const view = {
  etcNames: ['ssl', 'localtime'],
  etc: '/c/etc',
  tmp: '/c/tmp',
  bin: '/c/bin',
  binds: [{ src: '/home/a', dest: '/home/a', mode: 'rw' as const }],
  agentSocket: '/c/agent.sock',
  gh: null,
  docker: '/run/whombat-containers/podman.sock',
  keys: [{ path: 'ssh/id_ed25519', mode: 0o600, base64: 'eA==' }],
  tty: false,
  cwd: '/home/a/work',
};

describe('the wrapper’s command lines', () => {
  it('a command: its own mount, ipc and uts namespaces, the holder’s proc, the turn’s keys as fds on a tmpfs', () => {
    const args = commandArgs(view, none);
    const joined = args.join(' ');
    expect(args.slice(0, 3)).toEqual(['--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try']);
    expect(args).not.toContain('--unshare-pid');
    expect(args).not.toContain('--unshare-net');
    expect(args).toContain('--new-session');
    expect(joined).toContain('--bind /proc /proc');
    expect(joined).toContain('--bind /c/tmp /tmp');
    expect(joined).toContain(`--ro-bind /c/bin ${IN.bin}`);
    expect(joined).toContain(`--ro-bind /c/agent.sock ${IN.agentSocket}`);
    expect(joined).toContain(`--ro-bind /run/whombat-containers/podman.sock ${IN.docker}`);
    expect(joined).toContain(`--perms 0700 --tmpfs ${IN.keys}`);
    expect(joined).toContain(`--perms 0600 --file 3 ${IN.keys}/ssh/id_ed25519`);
    expect(joined).toContain('--ro-bind /etc/ssl /etc/ssl');
    expect(joined).toContain('--ro-bind /c/etc/passwd /etc/passwd');
    expect(args.slice(-4)).toEqual(['--remount-ro', '/', '--chdir', '/home/a/work']);
    // A terminal keeps its session; no keys, no keys folder; no socket that isn't the place's.
    const bare = commandArgs({ ...view, keys: [], agentSocket: null, docker: null, tty: true }, none);
    expect(bare).not.toContain('--new-session');
    expect(bare.join(' ')).not.toMatch(/keys|agent\.sock|docker\.sock/);
  });

  it('the holder: its own user, network and pid namespaces, the proxy bridged, a fresh proc', () => {
    const args = holderArgs(
      {
        binds: [{ src: '/home/a', dest: '/home/a', mode: 'rw' }],
        node: '/n/bin/node',
        netScript: '/s/commands-net.mjs',
        proxy: '/home/whombat-task/.whombat/proxy.sock',
        inbound: '/c/in.sock',
        services: true,
      },
      none,
    );
    for (const ns of ['--unshare-user', '--unshare-net', '--unshare-pid']) expect(args).toContain(ns);
    expect(args.join(' ')).toContain('--proc /proc');
    expect(args.join(' ')).toContain(`--ro-bind /home/whombat-task/.whombat/proxy.sock ${IN.proxy}`);
    const config = JSON.parse(args.at(-1) as string);
    expect(config).toMatchObject({
      proxy: IN.proxy,
      inbound: '/c/in.sock',
      port: 3128,
      services: [20000, 20099],
    });
  });

  it('binds parents first, read-only winning on the same path', () => {
    expect(
      bindArgs([
        { src: '/w/repo/.git/config', dest: '/w/repo/.git/config', mode: 'ro' },
        { src: '/w/repo', dest: '/w/repo', mode: 'rw' },
        { src: '/w/repo', dest: '/w/repo', mode: 'ro' },
      ]),
    ).toEqual(['--ro-bind', '/w/repo', '/w/repo', '--ro-bind', '/w/repo/.git/config', '/w/repo/.git/config']);
  });

  it('a helper’s launcher starts Node without its proxy switch, the command’s arguments as they are', () => {
    // A script path with a quote in it, as a helper's could have.
    const script = join(root, "it's.mjs");
    writeFileSync(
      script,
      'console.log(JSON.stringify({ proxy: process.env.NODE_USE_ENV_PROXY ?? null, https: process.env.HTTPS_PROXY, args: process.argv.slice(2) }));\n',
    );
    const file = join(root, 'whombat-connect');
    writeFileSync(file, launcher(process.execPath, script), { mode: 0o755 });
    const r = spawnSync(file, ['host name', '22'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:3128' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      proxy: null,
      https: 'http://127.0.0.1:3128',
      args: ['host name', '22'],
    });
  });

  it('the agent’s /etc: its user with its home, ssh through the proxy with the turn’s keys', () => {
    const etc = etcFiles({ home: '/persist/whombat/agent/home', shell: '/bin/bash' });
    expect(etc.passwd).toContain('agent:x:1000:1000:Whombat agent:/persist/whombat/agent/home:/bin/bash');
    expect(etc.ssh_config).toContain(`Include ${IN.keys}/ssh_config`);
    expect(etc.ssh_config).toContain(`ProxyCommand ${IN.bin}/whombat-connect %h %p`);
  });
});

describe('what of a turn a command sees (OP-S109)', () => {
  it('its folder and git folders, a readable file through its own folder, ~/files read-only; never a denied one', () => {
    const repo = join(root, 'repo');
    const objects = join(root, 'repos', 'x.git');
    const attach = join(root, 'tmp', 'att-dsp_1');
    const secret = join(root, 'denied');
    const files = join(root, 'files-tree');
    for (const d of [repo, join(repo, '.git'), objects, attach, secret, files, join(root, 'home')])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(attach, 'a.pdf'), 'x');
    writeFileSync(join(repo, '.git', 'config'), '[core]\n');
    const binds = turnBinds({
      task: {
        cwd: repo,
        writeCwd: true,
        writable: [objects],
        readable: [join(attach, 'a.pdf'), join(root, 'tmp')],
        readOnlyInside: [join(repo, '.git', 'config'), join(repo, '.git', 'hooks')],
      },
      denied: [secret],
      dispatchId: 'dsp_1',
      files: { tree: files, home: join(root, 'home') },
      covered: [join(root, 'home')],
    });
    expect(binds).toEqual([
      { src: repo, dest: repo, mode: 'rw' },
      { src: join(root, 'tmp'), dest: join(root, 'tmp'), mode: 'ro' },
      { src: objects, dest: objects, mode: 'rw' },
      { src: join(repo, '.git', 'config'), dest: join(repo, '.git', 'config'), mode: 'ro' },
      { src: files, dest: join(root, 'home', 'files'), mode: 'ro' },
    ]);
    // A folder with a denied one inside isn't bound at all.
    const none = turnBinds({
      task: { cwd: root, writeCwd: false },
      denied: [secret],
      dispatchId: 'dsp_1',
    });
    expect(none).toEqual([]);
  });
});

describe('a turn’s commands: the guard, a person’s answer, the keys (AC-40…AC-42)', () => {
  const turnOf = (over: Partial<TurnCommandsTurn> = {}): TurnCommandsTurn => ({
    dispatchId: 'dsp_turn00000001',
    lease: { runnerId: 'rnr_x', attempt: 2 },
    context: {
      productionServers: [
        {
          entryId: 'vlt_server000001',
          name: 'web-1',
          host: 'web1.example.com',
          port: 22,
          addresses: ['203.0.113.10'],
        },
      ],
      homeNetworks: ['192.168.1.0/24'],
      lan: false,
    },
    binds: [],
    cwd: '/w',
    env: { GIT_AUTHOR_NAME: 'Dusty' },
    readOnlyInside: [],
    wantsKeys: true,
    ...over,
  });
  const gone = new AbortController().signal;

  async function opened(
    server: FakeServer,
    over: Partial<TurnCommandsTurn> = {},
    log: (level: string, msg: string) => void = () => {},
  ) {
    const policies: NetPolicy[] = [];
    const control = await startControl({
      path: join(root, 'control.sock'),
      apply: (p) => policies.push(p),
      current: () => EMPTY_POLICY,
    });
    const net = new AgentNet({ control: join(root, 'control.sock'), log: () => {}, now: () => clock });
    const turn = await TurnCommands.open(
      {
        api: server,
        guard: commandGuard,
        net,
        log,
        approvalWaitMs: 60_000,
        resolve4: async () => ['203.0.113.10'],
        now: () => clock,
      },
      turnOf(over),
    );
    return { turn, net, policies, close: control.close };
  }
  let clock = 1_000_000;

  it('runs an ordinary command with the turn’s environment and keys, asked for once', async () => {
    const server = new FakeServer();
    server.keys = {
      files: [{ path: 'ssh/id_test', mode: '600', base64: 'eA==' }],
      env: [{ name: 'DEPLOY_TOKEN', value: 'tok' }],
      mcpServers: [],
      entries: [],
    };
    let asked = 0;
    const turnKeys = server.turnKeys.bind(server);
    server.turnKeys = async () => {
      asked++;
      return turnKeys();
    };
    const { turn, policies, close } = await opened(server);
    const d = await turn.decide(['bash', '-c', 'ls'], () => {}, gone);
    await turn.decide(['bash', '-c', 'ls -l'], () => {}, gone);
    expect(d).toMatchObject({
      outcome: 'run',
      env: { GIT_AUTHOR_NAME: 'Dusty', DEPLOY_TOKEN: 'tok', WHOMBAT_TURN: 'dsp_turn00000001' },
      keys: [{ path: 'ssh/id_test', mode: 0o600 }],
    });
    expect(asked).toBe(1);
    expect(server.authorized).toEqual([]);
    // The wall knows the turn's production server and its home networks.
    expect(policies.at(-1)).toMatchObject({ production: ['203.0.113.10'], homeNetworks: ['192.168.1.0/24'] });
    await close();
  });

  it('looks the servers’ names up together, starts without a slow one and closes the wall on it when it answers', async () => {
    const policies: NetPolicy[] = [];
    const waiting: { want: string; resolve: () => void }[] = [];
    const control = await startControl({
      path: join(root, 'control.sock'),
      apply: (p) => {
        policies.push(p);
        for (const w of waiting.filter((x) => p.production.includes(x.want))) w.resolve();
      },
      current: () => EMPTY_POLICY,
    });
    const closedOn = (want: string) => new Promise<void>((resolve) => waiting.push({ want, resolve }));
    const net = new AgentNet({ control: join(root, 'control.sock'), log: () => {} });
    // The fast names answer only once all three lookups have started: one after another, the first would never answer.
    let started = 0;
    let allStarted: () => void = () => {};
    const together = new Promise<void>((r) => {
      allStarted = r;
    });
    let slowAnswer: (addresses: string[]) => void = () => {};
    const resolve4 = async (host: string) => {
      if (++started === 3) allStarted();
      if (host === 'old.local') return new Promise<string[]>((r) => (slowAnswer = r));
      await together;
      return host === 'db1.example.com' ? ['203.0.113.20'] : ['203.0.113.10'];
    };
    const server = new FakeServer();
    server.reply = { outcome: 'blocked', approvalId: null, message: 'no', open: [] };
    const turn = await TurnCommands.open(
      { api: server, guard: commandGuard, net, log: () => {}, resolve4, resolveWaitMs: 100 },
      turnOf({
        context: {
          productionServers: [
            {
              entryId: 'vlt_server000001',
              name: 'web-1',
              host: 'web1.example.com',
              port: 22,
              addresses: ['203.0.113.10'],
            },
            { entryId: 'vlt_server000002', name: 'db-1', host: 'db1.example.com', port: 22, addresses: [] },
            {
              entryId: 'vlt_server000003',
              name: 'old-1',
              host: 'old.local',
              port: 22,
              addresses: ['203.0.113.30'],
            },
          ],
          homeNetworks: ['192.168.1.0/24'],
          lan: false,
        },
      }),
    );
    // The server's addresses and what answered in time; the slow name isn't waited for.
    expect(new Set(policies.at(-1)?.production)).toEqual(
      new Set(['203.0.113.10', '203.0.113.20', '203.0.113.30']),
    );
    const late = closedOn('192.168.1.40');
    slowAnswer(['192.168.1.40']);
    await late;
    expect(policies.at(-1)).toMatchObject({ homeNetworks: ['192.168.1.0/24'], lan: false });
    expect(new Set(policies.at(-1)?.production)).toEqual(
      new Set(['203.0.113.10', '203.0.113.20', '203.0.113.30', '192.168.1.40']),
    );
    // The guard knows the late address as that server's: a command to it asks first.
    await turn.decide(['bash', '-c', 'ssh deploy@192.168.1.40 ./ship'], () => {}, gone);
    expect(server.authorized[0]).toMatchObject({ category: 'deploy_production', target: 'old-1' });
    await turn.close();
    net.close();
    await control.close();
  });

  it('runs at most two name lookups at once, the rest in the order they came', async () => {
    const limit = limiter(2);
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const finish: (() => void)[] = [];
    const jobs = [0, 1, 2, 3, 4].map((n) =>
      limit(async () => {
        order.push(n);
        most = Math.max(most, ++running);
        await new Promise<void>((r) => finish.push(r));
        running--;
        return n;
      }),
    );
    // Two run; finishing one lets exactly the next one in, even with a newcomer arriving meanwhile.
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    finish.shift()?.();
    const late = limit(async () => {
      order.push(9);
      return 9;
    });
    while (order.length < 3) await new Promise((r) => setImmediate(r));
    expect(order).toEqual([0, 1, 2]);
    while (finish.length) {
      finish.shift()?.();
      await new Promise((r) => setImmediate(r));
    }
    expect(await Promise.all([...jobs, late])).toEqual([0, 1, 2, 3, 4, 9]);
    expect(order).toEqual([0, 1, 2, 3, 4, 9]);
    expect(most).toBe(2);
  });

  it('asks before a consequential command, says the waiting line, and opens the server for it once', async () => {
    const server = new FakeServer();
    server.reply = {
      outcome: 'pending',
      approvalId: 'apr_aaaaaaaaaaaa',
      message: 'Waiting for Mara…',
      open: [],
    };
    server.waits = [
      { outcome: 'run', scope: 'once', message: '', open: [{ host: 'web1.example.com', port: 22 }] },
    ];
    const { turn, policies, close } = await opened(server);
    const said: string[] = [];
    const d = await turn.decide(['bash', '-c', 'ssh deploy@203.0.113.10 ./ship'], (l) => said.push(l), gone);
    expect(said).toEqual(['Waiting for Mara…']);
    expect(server.authorized[0]).toMatchObject({ category: 'deploy_production', target: 'web-1' });
    expect(d.outcome).toBe('run');
    const once = d.outcome === 'run' ? d.once : [];
    expect(policies.at(-1)?.open).toMatchObject([{ address: '203.0.113.10', port: 22 }]);
    // A minute after the command ended the opening goes.
    turn.ran(['bash', '-c', 'ssh deploy@203.0.113.10 ./ship'], 0, once);
    await new Promise((r) => setTimeout(r, 30));
    clock += ONCE_GRACE_MS + 1;
    await turn.close();
    expect(policies.at(-1)?.open).toEqual([]);
    await close();
  });

  it('says so in the journal when the wall didn’t take the end of the turn’s openings', async () => {
    const server = new FakeServer();
    server.reply = {
      outcome: 'pending',
      approvalId: 'apr_aaaaaaaaaaaa',
      message: 'Waiting for Mara…',
      open: [],
    };
    server.waits = [
      { outcome: 'run', scope: 'task', message: '', open: [{ host: 'web1.example.com', port: 22 }] },
    ];
    const logs: { level: string; msg: string }[] = [];
    const { turn, policies, close } = await opened(server, {}, (level, msg) => logs.push({ level, msg }));
    await turn.decide(['bash', '-c', 'ssh deploy@203.0.113.10 ./ship'], () => {}, gone);
    expect(policies.at(-1)?.open).toMatchObject([{ address: '203.0.113.10', port: 22 }]);
    await close();
    await turn.close();
    expect(logs.find((l) => l.level === 'error')?.msg).toMatch(/opening/);
  });

  it('doesn’t run a command a person declined, nor one that failed the same way three times, nor any when closed', async () => {
    const server = new FakeServer();
    server.reply = { outcome: 'blocked', approvalId: null, message: 'whombat: main is protected.', open: [] };
    const { turn, close } = await opened(server);
    expect(await turn.decide(['bash', '-c', 'git push --force origin main'], () => {}, gone)).toEqual({
      outcome: 'refuse',
      code: 126,
      line: 'whombat: main is protected.',
    });
    const failing = ['bash', '-c', 'npm test'];
    for (let i = 0; i < 3; i++) {
      expect((await turn.decide(failing, () => {}, gone)).outcome).toBe('run');
      turn.ran(failing, 1);
    }
    expect(await turn.decide(failing, () => {}, gone)).toMatchObject({ outcome: 'refuse', code: 1 });
    const closed = await opened(new FakeServer(), { closed: 'whombat: not here.' });
    expect(await closed.turn.decide(['bash', '-c', 'ls'], () => {}, gone)).toMatchObject({
      outcome: 'refuse',
      line: 'whombat: not here.',
    });
    await close();
    await closed.close();
  });

  it('reads the agent’s command out of Hermes’s script, and a plain argv as it is', () => {
    const script = [
      'source /tmp/hermes-snap-abc.sh >/dev/null 2>&1 || true',
      "builtin cd -- '/w' || exit 126",
      "eval 'git push --force origin '\\''main'\\'''",
      '__hermes_ec=$?',
    ].join('\n');
    expect(hermesCommand(commandText(['bash', '-c', script]))).toBe("git push --force origin 'main'");
    // A command of several lines (a why first) spans the script's lines.
    const lines = script.replace("eval 'git", "eval '# why: ship the fix\ngit");
    expect(hermesCommand(lines)).toBe("# why: ship the fix\ngit push --force origin 'main'");
    expect(commandText(['node', 'x.js'])).toBe('node x.js');
  });

  it('sends the why the command starts with, and the command after it', async () => {
    const server = new FakeServer();
    server.reply = { outcome: 'blocked', approvalId: null, message: 'no', open: [] };
    const { turn, close } = await opened(server);
    const script = [
      "builtin cd -- '/w' || exit 126",
      "eval '# why: the fix is reviewed\ngit push origin main'",
      '__hermes_ec=$?',
    ].join('\n');
    await turn.decide(['bash', '-c', script], () => {}, gone);
    expect(server.authorized[0]).toMatchObject({
      command: 'git push origin main',
      category: 'push_main',
      reason: 'the fix is reviewed',
    });
    await close();
  });
});

describe('the commands’ PATH on a host without the image’s tools', () => {
  it('names the bound node install where the host’s PATH reaches it through a link', async () => {
    // A version manager's `node/24` → `node/24.21.0`: only the install is inside the sandbox, not the link.
    const install = join(root, 'node', '24.21.0');
    mkdirSync(join(install, 'bin'), { recursive: true });
    writeFileSync(join(install, 'bin', 'node'), '');
    symlinkSync(install, join(root, 'node', '24'));
    const box: CommandsBox = {
      guard: commandGuard,
      net: new AgentNet({ control: join(root, 'none.sock'), log: () => {} }),
      proxySocket: join(root, 'none.sock'),
      log: () => {},
      agentHome: join(root, 'agent', 'home'),
      tools: null,
      nixLd: { ld: null, libraryPath: null },
      hostPath: `${join(root, 'node', '24', 'bin')}:/usr/bin:/bin`,
      containers: null,
      notify: async () => {},
    };
    const place = await CommandsPlace.open(box, {
      kind: 'person',
      base: join(root, 'pod'),
      node: join(root, 'node', '24', 'bin', 'node'),
      skills: null,
      roots: [],
    });
    const path = place.ownSpec().env.PATH?.split(':') ?? [];
    expect(path).toContain(join(install, 'bin'));
    expect(path).not.toContain(join(root, 'node', '24', 'bin'));
    await place.close();
  });
});

describe('the helper’s socket (RA-31)', () => {
  it('wakes the agent for one of the place’s turns with its lease, and says what the commands reach', async () => {
    const notified: unknown[] = [];
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
      notify: async (body) => {
        notified.push(body);
      },
    };
    const place = await CommandsPlace.open(box, {
      kind: 'person',
      base: join(root, 'pod'),
      node: process.execPath,
      skills: null,
      roots: [],
    });
    const turn = await TurnCommands.open(
      { api: new FakeServer(), guard: commandGuard, net: null, log: () => {} },
      {
        dispatchId: 'dsp_notify000001',
        lease: { runnerId: 'rnr_x', attempt: 3 },
        context: null,
        binds: [],
        cwd: '/',
        env: {},
        readOnlyInside: [],
        wantsKeys: false,
      },
    );
    place.bind('sess-a', turn);
    place.release(turn);
    const ask = (body: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const s = connect(join(place.dir, 'agent.sock'));
        let buf = '';
        s.on('data', (d) => {
          buf += d.toString();
        });
        s.on('close', () => resolve(JSON.parse(buf)));
        s.write(`${JSON.stringify(body)}\n`);
      });
    // After its turn ended too: a background job's.
    expect(
      await ask({ op: 'notify', turn: 'dsp_notify000001', text: 'build done', eventId: 'evt_12345678' }),
    ).toEqual({
      ok: true,
    });
    expect(notified).toEqual([
      {
        fromDispatchId: 'dsp_notify000001',
        runnerId: 'rnr_x',
        attempt: 3,
        eventId: 'evt_12345678',
        text: 'build done',
      },
    ]);
    expect(
      (await ask({ op: 'notify', turn: 'dsp_other0000001', text: 'x', eventId: 'evt_12345678' })).ok,
    ).toBe(false);
    expect(await ask({ op: 'status' })).toEqual({
      ok: true,
      status: { homeNetworks: [], lan: false, docker: false },
    });
    await place.close();
  });
});
