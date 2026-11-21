/**
 * git's GitHub transport (docs/decisions/resourceful-agents.md RA-DS72…RA-DS74), with real git on both ends: the agent's
 * git runs `git-remote-whombat` for https://github.com/… (the sandbox's `GIT_CONFIG_*`), which reaches the turn's gh
 * service; the runner's own git fetches from a local smart-HTTP server standing in for GitHub (`git http-backend`), which
 * answers only with the connection's token.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withGitConfig } from '@whombat/agent-runtime';
import { GIT_HELPER_PATH, GITHUB_VIA_WHOMBAT } from '@whombat/commands';
import { githubRepo, LINES } from '@whombat/commands/git';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunnerApiError } from './api';
import { GhService } from './gh';
import { GIT_LINES, githubRepoOf, streamRedactor, switchedOn } from './git-relay';

const TOKEN = 'gho_cOnNeCtIoNtOkEn1234567890';
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const hasBackend =
  spawnSync('git', ['http-backend'], { env: { PATH: process.env.PATH ?? '' } }).status !== null;
const root = mkdtempSync(join(tmpdir(), 'wb-git-relay-'));

describe('git’s stderr on its way to the agent', () => {
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const through = (chunks: Buffer[]) => {
    const r = streamRedactor([TOKEN, basic]);
    return Buffer.concat([...chunks.map((c) => r.push(c)), r.end()]);
  };

  it('hides the token and its Basic form split between two chunks at any byte, and keeps every other byte', () => {
    for (const secret of [TOKEN, basic]) {
      const text = Buffer.from(`fatal: café ✓ ${secret} failed\n`);
      const masked = Buffer.from('fatal: café ✓ *** failed\n');
      for (let i = 0; i <= text.length; i++)
        expect(
          through([text.subarray(0, i), text.subarray(i)]).equals(masked),
          `${secret.slice(0, 4)} at ${i}`,
        ).toBe(true);
      // And a byte at a time.
      expect(through([...text].map((b) => Buffer.from([b]))).equals(masked)).toBe(true);
    }
  });

  it('holds back only what could be the start of the token', () => {
    const r = streamRedactor([TOKEN, basic]);
    expect(r.push(Buffer.from('Receiving objects: 100% (3/3), done.\n')).toString()).toBe(
      'Receiving objects: 100% (3/3), done.\n',
    );
    expect(r.push(Buffer.from(`remote: ${TOKEN.slice(0, 6)}`)).toString()).toBe('remote: ');
    expect(r.push(Buffer.from('x\n')).toString()).toBe(`${TOKEN.slice(0, 6)}x\n`);
    expect(r.end().length).toBe(0);
  });
});

describe('which URLs are GitHub repositories, on both ends', () => {
  const table: [string, string | null][] = [
    ['https://github.com/acme/web.git', 'acme/web'],
    ['https://github.com/acme/web', 'acme/web'],
    ['https://github.com/Acme/Web.site/', 'Acme/Web.site'],
    ['https://github.com:443/acme/web.git', 'acme/web'],
    ['https://x-access-token:t@github.com/acme/web.git', null],
    ['https://github.com/acme/web/tree/main', null],
    ['https://github.com/acme', null],
    ['https://github.com/acme/../web', null],
    ['https://github.com/acme/web.git?x=1', null],
    ['http://github.com/acme/web.git', null],
    ['https://gitlab.com/acme/web.git', null],
    ['https://github.com.evil.example/acme/web.git', null],
    ['git@github.com:acme/web.git', null],
  ];
  it.each(table)('%s', (url, repo) => {
    expect(githubRepoOf(url)).toBe(repo);
    expect(githubRepo(url)).toBe(repo);
  });

  it('a repository is the burrow’s one by its name in any case', () => {
    expect(switchedOn(['acme/web', 'acme/api'], 'ACME/Web')).toBe('acme/web');
    expect(switchedOn(['acme/web'], 'acme/website')).toBeNull();
  });
});

/** The stand-in for GitHub: git http-backend behind a check of the Authorization header. */
async function fakeGitHub(projectRoot: string) {
  const seen: { method: string; url: string; authorized: boolean }[] = [];
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === BASIC;
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorized });
    if (!authorized) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
      res.end('no');
      return;
    }
    const u = new URL(req.url ?? '/', 'http://x');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['git-protocol'] ? { HTTP_GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
        ...(req.headers['content-encoding']
          ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }
          : {}),
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    cgi.stdout.on('data', (c: Buffer) => {
      if (started) return void res.write(c);
      head = Buffer.concat([head, c]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      started = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const i = line.indexOf(': ');
        const k = line.slice(0, i);
        const v = line.slice(i + 2);
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { server, seen, base: `http://127.0.0.1:${port}/` };
}

/**
 * A command, without blocking: the gh service it reaches runs in this process. `input` goes to its stdin (then closed).
 */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    // A command that exits without reading its input closes the pipe first (EPIPE): not this test's concern.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
    });
    child.stdin.end(options.input ?? '');
  });
}
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => run('git', args, { cwd, env });

describe.skipIf(!hasBackend)('git through Whombat, end to end (RA-DS72, RA-DS73)', () => {
  let github: Awaited<ReturnType<typeof fakeGitHub>>;
  let server: Server;
  const asked: Record<string, unknown>[] = [];
  let refuse: RunnerApiError | null = null;
  const services: GhService[] = [];
  const bin = join(root, 'bin');
  const work = join(root, 'agent');

  beforeAll(async () => {
    // GitHub's acme/web, with a built site in it.
    const projects = join(root, 'github');
    mkdirSync(join(projects, 'acme'), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(projects, 'acme', 'web.git')]);
    const seed = join(root, 'seed');
    mkdirSync(join(seed, 'dist'), { recursive: true });
    writeFileSync(join(seed, 'README.md'), 'whombat-website\n');
    writeFileSync(join(seed, 'dist', 'index.html'), '<h1>Live</h1>\n');
    const id = ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com'];
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    execFileSync('git', ['-C', seed, 'add', '.']);
    execFileSync('git', ['-C', seed, ...id, 'commit', '-qm', 'site']);
    execFileSync('git', ['-C', seed, 'push', '-q', join(projects, 'acme', 'web.git'), 'main']);
    github = await fakeGitHub(projects);
    server = github.server;
    // The agent's git finds the transport on its PATH, as in the task sandbox (the stand-in's folder first).
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'git-remote-whombat'),
      `#!/bin/sh\nexec '${process.execPath}' '${GIT_HELPER_PATH}' "$@"\n`,
      {
        mode: 0o755,
      },
    );
    mkdirSync(work, { recursive: true });
  });
  afterAll(() => server?.close());
  afterEach(async () => {
    for (const s of services.splice(0)) await s.close();
  });

  /** Not switched on yet, but the burrow's own on GitHub: the server adds it for agents. */
  const REACHABLE = ['acme/new'];

  async function service(repos = ['acme/web']) {
    const s = await GhService.open(
      {
        api: {
          ghAuthorize: async () => {
            throw new Error('no gh here');
          },
          gitCredentials: async (_id, body) => {
            asked.push(body as Record<string, unknown>);
            if (refuse) throw refuse;
            // The server adds one the burrow's GitHub connection works on (agent-repos.md AGR-01); anyone else's is a 404.
            const name = (body as { repo: string }).repo;
            if (!repos.includes(name) && !REACHABLE.includes(name))
              throw new RunnerApiError(404, null, `Repo ${name} not found.`);
            return {
              token: TOKEN,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              remoteUrl: `${github.base}${(body as { repo: string }).repo}.git`,
            };
          },
        },
        log: () => {},
        tmpRoot: join(root, 'tmp'),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        gitRemoteBase: github.base,
      },
      { dispatchId: 'dsp_git', lease: { runnerId: 'rnr_x', attempt: 2 }, repos },
      mkdtempSync(join(root, 'turn-')),
    );
    services.push(s);
    return s;
  }

  /** The agent's shell: the runner's own git settings (credential helpers off), then the transport's. */
  const shell = (socket: string | null): NodeJS.ProcessEnv =>
    withGitConfig(
      {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: work,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...(socket ? { WHOMBAT_GH_SOCKET: socket } : {}),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
      },
      GITHUB_VIA_WHOMBAT,
    );

  it('clones, fetches and lists a switched-on repository with the connection’s token, which the agent never holds', async () => {
    const s = await service();
    asked.length = 0;
    const env = shell(s.socket);
    const clone = await git(work, ['clone', 'https://github.com/acme/web.git', 'site'], env);
    expect(clone.stderr).not.toContain(TOKEN);
    expect(clone.status).toBe(0);
    expect(readFileSync(join(work, 'site', 'dist', 'index.html'), 'utf8')).toBe('<h1>Live</h1>\n');
    // The URL people know stays the repository's; fetches go through Whombat, a push wouldn't.
    const site = join(work, 'site');
    expect((await git(site, ['config', 'remote.origin.url'], env)).stdout.trim()).toBe(
      'https://github.com/acme/web.git',
    );
    expect((await git(site, ['remote', 'get-url', 'origin'], env)).stdout.trim()).toBe(
      'whombat::https://github.com/acme/web.git',
    );
    expect((await git(site, ['remote', 'get-url', '--push', 'origin'], env)).stdout.trim()).toBe(
      'https://github.com/acme/web.git',
    );
    expect((await git(site, ['fetch', 'origin'], env)).status).toBe(0);
    expect((await git(site, ['pull', '--ff-only'], env)).status).toBe(0);
    const listed = await git(work, ['ls-remote', 'https://github.com/Acme/Web'], env);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/\trefs\/heads\/main\n/);
    expect(
      (await git(work, ['clone', '-q', '--depth', '1', 'https://github.com/acme/web', 'shallow'], env))
        .status,
    ).toBe(0);
    // One fetch credential for the turn, asked like a run checkout's fetch.
    expect(asked).toEqual([
      { repo: 'acme/web', branch: 'HEAD', operation: 'fetch', runnerId: 'rnr_x', attempt: 2 },
    ]);
    // GitHub only ever saw the token, and only reads.
    expect(github.seen.length).toBeGreaterThan(0);
    expect(github.seen.every((r) => r.authorized)).toBe(true);
    expect(
      github.seen.every((r) =>
        /\/acme\/web\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/.test(r.url),
      ),
    ).toBe(true);
    // Nothing the agent can read holds it: not the clones, not their config.
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const f of files(work))
      if (statSync(f).size < 1_000_000) expect(readFileSync(f, 'latin1')).not.toContain(TOKEN);
  });

  it('never pushes: a push keeps the plain URL, and one sent to the transport anyway is refused in words', async () => {
    const s = await service();
    const env = shell(s.socket);
    const site = join(work, 'push-site');
    expect(
      (await git(work, ['clone', '-q', 'https://github.com/acme/web.git', 'push-site'], env)).status,
    ).toBe(0);
    writeFileSync(join(site, 'README.md'), 'changed\n');
    await git(
      site,
      ['-c', 'user.name=Dusty', '-c', 'user.email=dusty@example.com', 'commit', '-qam', 'change'],
      env,
    );
    const before = github.seen.length;
    asked.length = 0;
    const pushed = await git(site, ['push', 'whombat::https://github.com/acme/web.git', 'HEAD:main'], env);
    expect(pushed.status).toBe(128);
    expect(pushed.stderr).toContain(LINES.push);
    // Whombat was never asked for a push credential (the transport's probe reuses the turn's fetch credential).
    expect(asked.every((a) => a.operation === 'fetch')).toBe(true);
    expect(github.seen.slice(before).some((r) => r.url.includes('receive-pack'))).toBe(false);
  });

  it('a session asks for nothing but git-upload-pack, and a URL off GitHub is refused', async () => {
    const s = await service();
    const probe = (url: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const c = connect(s.socket);
        let buf = '';
        c.on('connect', () => c.write(`${JSON.stringify({ v: 1, git: 'probe', url })}\n`));
        c.on('data', (d) => {
          buf += d.toString();
        });
        c.on('error', reject);
        c.on('close', () => resolve(JSON.parse(buf) as Record<string, unknown>));
      });
    expect(await probe('https://gitlab.com/acme/web.git')).toEqual({
      ok: false,
      error: GIT_LINES.notGitHub('https://gitlab.com/acme/web.git'),
    });
    expect(await probe('https://github.com/acme/web.git')).toEqual({
      ok: true,
      via: 'whombat',
      repo: 'acme/web',
    });
    // Not switched on yet but the burrow's own: asked for all the same, and the server adds it (agent-repos.md AGR-01).
    expect(await probe('https://github.com/acme/new')).toEqual({
      ok: true,
      via: 'whombat',
      repo: 'acme/new',
    });
    expect(await probe('https://github.com/torvalds/linux')).toEqual({
      ok: true,
      via: 'direct',
      note: GIT_LINES.notSwitchedOn('torvalds/linux'),
    });
    // The agent's git refuses a host other than GitHub before it asks anything.
    const env = shell(s.socket);
    const off = await git(
      work,
      [
        '-c',
        'url.whombat::https://example.com/.insteadOf=https://example.com/',
        'ls-remote',
        'https://example.com/x.git',
      ],
      env,
    );
    expect(off.status).toBe(128);
    expect(off.stderr).toContain(LINES.notGitHub('https://example.com/x.git'));
  });

  it('when Whombat can’t fetch it, git goes its own way and then says why (a public repository still comes)', async () => {
    // A stand-in for git's own https transport: what it was asked, and a failure like a private repository's.
    const fake = join(root, 'fake-git');
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(fake, 'git'),
      `#!/bin/sh\necho "own transport: $*" >&2\necho "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2\nexit 128\n`,
      { mode: 0o755 },
    );
    const s = await service();
    const helper = (url: string, socket: string | null) =>
      run(process.execPath, [GIT_HELPER_PATH, 'origin', url], {
        env: { PATH: `${fake}:/usr/bin:/bin`, ...(socket ? { WHOMBAT_GH_SOCKET: socket } : {}) },
        input: 'capabilities\n',
      });
    const other = await helper('https://github.com/acme/private.git', s.socket);
    expect(other.status).toBe(128);
    expect(other.stderr).toBe(
      [
        'own transport: remote-https origin https://github.com/acme/private.git',
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        `whombat: ${GIT_LINES.notSwitchedOn('acme/private')}`,
        '',
      ].join('\n'),
    );
    // Nobody connected GitHub: the server's own sentence, after git's own try.
    refuse = new RunnerApiError(
      409,
      {},
      'Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it).',
    );
    try {
      const unconnected = await helper('https://github.com/acme/web.git', s.socket);
      expect(unconnected.stderr).toContain(
        'whombat: Nobody has connected GitHub on this Whombat yet. Connect it once in Settings → Connections → GitHub (every agent then uses it).',
      );
    } finally {
      refuse = null;
    }
    // A turn without GitHub (no service), or a job after its turn: git's own transport, with nothing added.
    const without = await helper('https://github.com/acme/web.git', join(root, 'gone.sock'));
    expect(without.stderr).toBe(
      [
        'own transport: remote-https origin https://github.com/acme/web.git',
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        '',
      ].join('\n'),
    );
  });
});
