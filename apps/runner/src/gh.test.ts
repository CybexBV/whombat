/**
 * The runner's gh service (docs/decisions/agent-gh.md AGH-03, AGH-08, AGH-10, AGH-15) against a fake runner API and a
 * fake `gh` that reports its words, working directory, environment and stdin.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GH_STANDIN_PATH } from '@whombat/commands';
import * as standin from '@whombat/commands/gh';
import {
  GH_ARG_MAX,
  GH_ARGS_MAX,
  GH_FILES_MAX,
  GH_INPUT_MAX_BYTES,
  type GhAuthorizeBody,
  type GhAuthorizeReply,
} from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerApiError } from './api';
import {
  GH_EXIT_TIMED_OUT,
  GH_STDOUT_MAX,
  GH_TURN_OVER,
  GH_UNAVAILABLE,
  GhService,
  type GhServiceDeps,
  ghContextOf,
  rewriteArgs,
} from './gh';
import { testContext } from './test-context';

const TOKEN = 'gho_sEcReTtOkEn1234567890';
const root = mkdtempSync(join(tmpdir(), 'wb-gh-svc-'));
const fakeJs = join(root, 'fake-gh.mjs');
writeFileSync(
  fakeJs,
  `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'sleep') setInterval(() => {}, 1000);
else if (args[0] === 'flood') {
  process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 97));
  process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 98));
} else {
  let stdin = '';
  try { stdin = readFileSync(0, 'utf8'); } catch {}
  const files = {};
  for (const a of args) {
    const m = /(?:^|=@?)(\\/.*\\/f\\d+)$/.exec(a);
    if (m) files[a] = readFileSync(m[1], 'utf8');
  }
  const keep = ['PATH', 'HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED', 'NO_COLOR', 'GH_PAGER', 'LANG', 'PLANTED_SECRET', 'HTTPS_PROXY'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k)));
  const tokenSha = createHash('sha256').update(process.env.GH_TOKEN ?? '').digest('hex');
  console.log(JSON.stringify({ args, cwd: process.cwd(), env, envKeys: Object.keys(process.env).sort(), stdin, files, tokenSha }));
  console.error('token in an error: ' + process.env.GH_TOKEN);
  process.exit(args.includes('--fail') ? 3 : 0);
}
`,
);
const fakeGh = join(root, 'gh');
writeFileSync(fakeGh, `#!/bin/sh\nexec '${process.execPath}' '${fakeJs}' "$@"\n`, { mode: 0o755 });

type Authorize = (dispatchId: string, body: GhAuthorizeBody) => Promise<GhAuthorizeReply>;

const open: GhService[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

async function service(authorize: Authorize, extra: Partial<GhServiceDeps> = {}, folder?: string) {
  const calls: { dispatchId: string; body: GhAuthorizeBody }[] = [];
  const s = await GhService.open(
    {
      api: {
        ghAuthorize: async (dispatchId, body) => {
          calls.push({ dispatchId, body: body as GhAuthorizeBody });
          return authorize(dispatchId, body as GhAuthorizeBody);
        },
      },
      log: () => {},
      tmpRoot: join(root, 'tmp'),
      ghBin: fakeGh,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        PLANTED_SECRET: 'nope',
        HTTPS_PROXY: 'http://proxy:3128',
      },
      ...extra,
    },
    { dispatchId: 'dsp_gh', lease: { runnerId: 'rnr_x', attempt: 2 } },
    folder ?? mkdtempSync(join(root, 'turn-')),
  );
  open.push(s);
  return { s, calls };
}

/** One request line to the service, its reply decoded. */
function ask(socket: string, req: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    let buf = '';
    c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => {
      buf += d.toString();
    });
    c.on('error', reject);
    c.on('close', () => {
      if (!buf) return reject(new Error('no reply'));
      const r = JSON.parse(buf) as { exitCode: number; stdout: string; stderr: string };
      resolve({
        exitCode: r.exitCode,
        stdout: Buffer.from(r.stdout, 'base64').toString(),
        stderr: Buffer.from(r.stderr, 'base64').toString(),
      });
    });
  });
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const run = (args: string[], repo: string | null = 'acme/web'): GhAuthorizeReply => ({
  outcome: 'run',
  args,
  repo,
  token: TOKEN,
  expiresAt: '2026-10-03T12:00:00.000Z',
});

describe('the gh service', () => {
  it('relays Whombat’s own answer, with the lease added to the request', async () => {
    const { s, calls } = await service(async () => ({
      outcome: 'done',
      exitCode: 125,
      stdout: '',
      stderr: 'I asked John on a card in this thread (approval #4).\n',
    }));
    const r = await ask(s.socket, { args: ['pr', 'merge', '12'], files: [], stdin: null });
    expect(r).toEqual({
      exitCode: 125,
      stdout: '',
      stderr: 'I asked John on a card in this thread (approval #4).\n',
    });
    expect(calls).toEqual([
      {
        dispatchId: 'dsp_gh',
        body: { args: ['pr', 'merge', '12'], files: [], stdin: null, runnerId: 'rnr_x', attempt: 2 },
      },
    ]);
  });

  it('runs gh outside with the token only in its environment, the files written again and the run dir removed', async () => {
    const { s } = await service(async () =>
      run([
        'api',
        'repos/{owner}/{repo}/issues/1/comments',
        '-F',
        'body=@@whombat-file:0',
        '--input',
        '@whombat-file:1',
        '--body-file=@whombat-file:0',
        '-',
      ]),
    );
    const r = await ask(s.socket, {
      args: ['api', 'x'],
      files: [
        { path: 'c.md', base64: b64('a comment') },
        { path: 'in.json', base64: b64('{"a":1}') },
      ],
      stdin: b64('from stdin'),
    });
    expect(r.exitCode).toBe(0);
    const seen = JSON.parse(r.stdout) as {
      args: string[];
      cwd: string;
      env: Record<string, string>;
      envKeys: string[];
      stdin: string;
      files: Record<string, string>;
      tokenSha: string;
    };
    const dir = seen.cwd;
    expect(seen.args).toEqual([
      'api',
      'repos/{owner}/{repo}/issues/1/comments',
      '-F',
      `body=@${dir}/f0`,
      '--input',
      `${dir}/f1`,
      `--body-file=${dir}/f0`,
      '-',
    ]);
    expect(Object.values(seen.files)).toEqual(['a comment', '{"a":1}', 'a comment']);
    expect(seen.stdin).toBe('from stdin');
    expect(seen.env).toMatchObject({
      HOME: dir,
      GH_CONFIG_DIR: `${dir}/.gh`,
      // In its environment (printed, it is replaced).
      GH_TOKEN: '***',
      GH_HOST: 'github.com',
      GH_REPO: 'acme/web',
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
      GH_PAGER: 'cat',
      LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
    });
    expect(seen.tokenSha).toBe(createHash('sha256').update(TOKEN).digest('hex'));
    expect(seen.env.PLANTED_SECRET).toBeUndefined();
    expect(seen.envKeys).toEqual(
      [
        'CLICOLOR',
        'GH_CONFIG_DIR',
        'GH_HOST',
        'GH_NO_UPDATE_NOTIFIER',
        'GH_PAGER',
        'GH_PROMPT_DISABLED',
        'GH_REPO',
        'GH_SPINNER_DISABLED',
        'GH_TOKEN',
        'HOME',
        'HTTPS_PROXY',
        'LANG',
        'NO_COLOR',
        'PAGER',
        'PATH',
        'PWD',
      ].filter((k) => k !== 'PWD' || seen.envKeys.includes('PWD')),
    );
    // gh's output never carries the token, and the run directory is gone.
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.stdout).toContain('"GH_TOKEN":"***"');
    expect(r.stderr).toBe('token in an error: ***\n');
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(join(root, 'tmp', 'gh-runs'))).toEqual([]);
  });

  it('no repo: no GH_REPO; no stdin: none piped; gh’s exit status passes through', async () => {
    const { s } = await service(async () => run(['--version', '--fail'], null));
    const r = await ask(s.socket, { args: ['--version'], files: [], stdin: null });
    expect(r.exitCode).toBe(3);
    const seen = JSON.parse(r.stdout) as { env: Record<string, string>; stdin: string };
    expect(seen.env.GH_REPO).toBeUndefined();
    expect(seen.stdin).toBe('');
  });

  it('keeps at most 8 MiB of stdout and 1 MiB of stderr, and says it cut them', async () => {
    const { s } = await service(async () => run(['flood']));
    const r = await ask(s.socket, { args: ['run', 'view', '--log'], files: [], stdin: null });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith('a'.repeat(1000))).toBe(true);
    expect(r.stdout).toContain('[Whombat cut gh’s output here: it keeps at most 8 MiB.]');
    expect(r.stdout.length).toBeLessThan(GH_STDOUT_MAX + 200);
    expect(r.stderr).toContain('[Whombat cut gh’s errors here: it keeps at most 1 MiB.]');
  }, 20_000);

  it('stops a gh that runs too long: exit 124 and a line', async () => {
    const { s } = await service(async () => run(['sleep']), { timeoutMs: 300 });
    const r = await ask(s.socket, { args: ['run', 'watch'], files: [], stdin: null });
    expect(r.exitCode).toBe(GH_EXIT_TIMED_OUT);
    expect(r.stderr).toContain('it took longer than 0 seconds, so Whombat stopped it.');
  });

  it('the server’s errors are one line and exit 1 (AGH-15)', async () => {
    const cases: [unknown, string][] = [
      [new RunnerApiError(409, null, 'lease lost'), `gh: ${GH_TURN_OVER}\n`],
      [
        new RunnerApiError(404, null, 'Route POST:/internal/runner/dispatches/x/gh not found'),
        `gh: ${GH_UNAVAILABLE}\n`,
      ],
      [
        new RunnerApiError(400, null, 'GitHub isn’t connected to this burrow.'),
        'gh: GitHub isn’t connected to this burrow.\n',
      ],
    ];
    for (const [err, line] of cases) {
      const { s } = await service(async () => {
        throw err;
      });
      expect(await ask(s.socket, { args: ['pr', 'list'], files: [], stdin: null })).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: line,
      });
    }
  });

  it('refuses what it can’t read and a run that names a file the command didn’t send', async () => {
    const { s, calls } = await service(async () => run(['api', '--input', '@whombat-file:3']));
    expect((await ask(s.socket, { args: 'pr list' })).stderr).toBe(
      'gh: Whombat couldn’t read this command.\n',
    );
    expect(calls).toHaveLength(0);
    const r = await ask(s.socket, {
      args: ['api', 'x', '--input', 'a'],
      files: [{ path: 'a', base64: b64('1') }],
      stdin: null,
    });
    expect(r).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: Whombat’s answer named a file the command didn’t send.\n',
    });
  });

  it('a 0600 socket in the turn’s folder; close removes it and stops a running gh', async () => {
    const { s } = await service(async () => run(['sleep']));
    expect(statSync(s.socket).mode & 0o777).toBe(0o600);
    const pending = ask(s.socket, { args: ['run', 'watch'], files: [], stdin: null }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    const runs = join(root, 'tmp', 'gh-runs');
    expect(readdirSync(runs)).toHaveLength(1);
    await s.close();
    expect(await pending).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(runs)).toEqual([]);
    expect(existsSync(s.socket)).toBe(false);
  });

  it('the stand-in reaches it through WHOMBAT_GH_SOCKET', async () => {
    const turn = join(root, 'shared');
    mkdirSync(turn, { recursive: true });
    const { s } = await service(async (_id, body) => run([...body.args, '--fail']), {}, turn);
    expect(s.socket).toBe(join(turn, 'gh.sock'));
    const work = mkdtempSync(join(root, 'work-'));
    writeFileSync(join(work, 'body.md'), 'the body');
    const child = spawn(process.execPath, [GH_STANDIN_PATH, 'issue', 'comment', '3', '-F', 'body.md'], {
      cwd: work,
      env: { PATH: process.env.PATH ?? '', WHOMBAT_GH_SOCKET: s.socket },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const code = await new Promise((r) => child.on('close', r));
    expect(code).toBe(3);
    expect(JSON.parse(out).args).toEqual(['issue', 'comment', '3', '-F', 'body.md', '--fail']);
    await s.close();
    expect(existsSync(join(turn, 'gh.sock'))).toBe(false);
  });
});

describe('placeholders (AGH-08)', () => {
  it('turns @whombat-file:N into the written files, and refuses an index the command didn’t send', () => {
    expect(
      rewriteArgs(
        [
          '@whombat-file:0',
          'body=@@whombat-file:1',
          '--input=@whombat-file:0',
          '-F@whombat-file:1',
          '-',
          'x@whombat-file:0',
        ],
        '/r',
        2,
      ),
    ).toEqual(['/r/f0', 'body=@/r/f1', '--input=/r/f0', '-F/r/f1', '-', 'x@whombat-file:0']);
    expect(rewriteArgs(['@whombat-file:2'], '/r', 2)).toBeNull();
  });
});

describe('which turns have gh (AGH-12)', () => {
  const gh = { repos: ['acme/web'], defaultRepo: 'acme/web' };
  it('the server’s gh, never an assessment, an answer or a read-only checkout', () => {
    expect(ghContextOf(testContext({ gh }))).toEqual(gh);
    expect(ghContextOf(testContext({ gh: null }))).toBeNull();
    // Connected without a switched-on repository yet: one is added the first time it is named (agent-repos.md AGR-02).
    expect(ghContextOf(testContext({ gh: { repos: [], defaultRepo: null } }))).toEqual({
      repos: [],
      defaultRepo: null,
    });
    const ctx = testContext({ gh });
    expect(ghContextOf({ ...ctx, dispatch: { ...ctx.dispatch, trigger: 'feedback' } })).toBeNull();
    expect(ghContextOf({ ...ctx, dispatch: { ...ctx.dispatch, mode: 'answer' } })).toBeNull();
  });

  it('the stand-in checks the contracts’ limits', () => {
    expect([standin.ARGS_MAX, standin.ARG_MAX, standin.FILES_MAX, standin.INPUT_MAX_BYTES]).toEqual([
      GH_ARGS_MAX,
      GH_ARG_MAX,
      GH_FILES_MAX,
      GH_INPUT_MAX_BYTES,
    ]);
  });
});
