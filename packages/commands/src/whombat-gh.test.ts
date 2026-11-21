import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRequest, exchange, INPUT_MAX_BYTES, inputsOf } from './whombat-gh.mjs';

const STANDIN = fileURLToPath(new URL('./whombat-gh.mjs', import.meta.url));

describe('what a gh command reads (AGH-08)', () => {
  it('gh api: --input and the @file values of -F/--field, never -f', () => {
    expect(inputsOf(['api', 'repos/{owner}/{repo}/issues', '--input', 'issue.json'])).toEqual({
      paths: ['issue.json'],
      stdin: false,
    });
    expect(
      inputsOf([
        'api',
        '-X',
        'PATCH',
        'repos/a/b/issues/1',
        '-F',
        'body=@body.md',
        '--field=title=@t.txt',
        '-Flabels=@l.json',
        '-f',
        'raw=@not-a-file',
        '-F',
        'n=3',
        '--input=in.json',
      ]),
    ).toEqual({ paths: ['body.md', 't.txt', 'l.json', 'in.json'], stdin: false });
    expect(inputsOf(['api', 'x', '-F', 'body=@-'])).toEqual({ paths: [], stdin: true });
    expect(inputsOf(['api', 'x', '--input', '-'])).toEqual({ paths: [], stdin: true });
  });

  it('pr, issue and release: -F/--body-file, attached or not, once each', () => {
    expect(inputsOf(['pr', 'create', '-t', 'T', '-F', 'body.md'])).toEqual({
      paths: ['body.md'],
      stdin: false,
    });
    expect(inputsOf(['issue', 'comment', '12', '--body-file=c.md', '-Fc.md', '-F=d.md'])).toEqual({
      paths: ['c.md', 'd.md'],
      stdin: false,
    });
    expect(inputsOf(['pr', 'review', '--approve', '--body-file', '-'])).toEqual({ paths: [], stdin: true });
  });

  it('other commands read nothing, and nothing after --', () => {
    expect(inputsOf(['workflow', 'run', 'ci.yml', '-F', 'x=@f'])).toEqual({ paths: [], stdin: false });
    expect(inputsOf(['pr', 'view', '-F', 'x'])).toEqual({ paths: ['x'], stdin: false });
    expect(inputsOf(['issue', 'create', '--', '-F', 'x'])).toEqual({ paths: [], stdin: false });
    expect(inputsOf(['pr', 'create', '-F'])).toEqual({ paths: [], stdin: false });
  });
});

describe('the request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-gh-'));
  writeFileSync(join(dir, 'body.md'), 'Hello **there**');

  it('reads the files relative to the working directory, and stdin only when the command reads it', async () => {
    let asked = 0;
    const readStdin = async () => {
      asked++;
      return Buffer.from('from stdin');
    };
    const r = await buildRequest(['issue', 'comment', '3', '-F', 'body.md'], { cwd: dir, readStdin });
    expect(r).toEqual({
      args: ['issue', 'comment', '3', '-F', 'body.md'],
      files: [{ path: 'body.md', base64: Buffer.from('Hello **there**').toString('base64') }],
      stdin: null,
    });
    expect(asked).toBe(0);
    const s = await buildRequest(['api', 'x', '--input', '-'], { cwd: dir, readStdin });
    expect(s.stdin).toBe(Buffer.from('from stdin').toString('base64'));
    expect(asked).toBe(1);
  });

  it('refuses more than 8 files, more than 1 MiB, a missing file and too many words, before sending', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ['-F', `k${i}=@body.md${i}`]).flat();
    await expect(buildRequest(['api', 'x', ...nine], { cwd: dir })).rejects.toThrow(
      'reads 9 files; through Whombat gh reads at most 8',
    );
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(INPUT_MAX_BYTES + 1));
    await expect(buildRequest(['pr', 'comment', '-F', 'big.bin'], { cwd: dir })).rejects.toThrow(
      'more than 1 MiB',
    );
    await expect(
      buildRequest(['api', 'x', '-F', 'a=@body.md', '--input', '-'], {
        cwd: dir,
        readStdin: async () => Buffer.alloc(INPUT_MAX_BYTES),
      }),
    ).rejects.toThrow('more than 1 MiB');
    await expect(buildRequest(['pr', 'comment', '-F', 'nope.md'], { cwd: dir })).rejects.toThrow(
      'open nope.md: no such file or directory',
    );
    await expect(
      buildRequest(
        Array.from({ length: 201 }, () => 'x'),
        { cwd: dir },
      ),
    ).rejects.toThrow('too long to send through Whombat');
  });
});

/** A fake gh service: one JSON line in, the answer `reply` gives out. */
async function fakeService(path: string, reply: (req: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket: Socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      requests.push(req);
      const out = reply(req);
      if (out === null) socket.destroy();
      else socket.end(`${JSON.stringify(out)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { requests, close: () => server.close() };
}

function runGh(args: string[], cwd: string, env: Record<string, string>, input?: string) {
  const child = spawn(process.execPath, [STANDIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString();
  });
  child.stdin.end(input ?? '');
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    child.on('close', (code) => resolve({ code, out, err })),
  );
}

describe('whombat-gh', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('sends the words, files and stdin, prints the answer and exits with its status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-gh-'));
    writeFileSync(join(dir, 'c.md'), 'a comment');
    const sock = join(dir, 'gh.sock');
    const svc = await fakeService(sock, () => ({
      exitCode: 4,
      stdout: b64('out ✓\n'),
      stderr: b64('warn\n'),
    }));
    const r = await runGh(
      ['api', 'repos/a/b/issues/1/comments', '-F', 'body=@c.md', '--input', '-'],
      dir,
      {
        WHOMBAT_GH_SOCKET: sock,
      },
      'piped',
    );
    expect(r).toEqual({ code: 4, out: 'out ✓\n', err: 'warn\n' });
    expect(svc.requests).toEqual([
      {
        args: ['api', 'repos/a/b/issues/1/comments', '-F', 'body=@c.md', '--input', '-'],
        files: [{ path: 'c.md', base64: b64('a comment') }],
        stdin: b64('piped'),
      },
    ]);
    svc.close();
  });

  it('reaches a socket whose path is longer than a unix socket allows', async () => {
    let dir = mkdtempSync(join(tmpdir(), 'wb-gh-'));
    while (dir.length < 110) dir = join(dir, 'a-rather-long-folder-name');
    mkdirSync(dir, { recursive: true });
    const short = mkdtempSync(join(tmpdir(), 'wb-ghs-'));
    // Bound through a short link to the long folder, the way the runner does.
    symlinkSync(dir, join(short, 'd'));
    const svc = await fakeService(join(short, 'd', 'gh.sock'), () => ({
      exitCode: 0,
      stdout: b64('ok'),
      stderr: '',
    }));
    const r = await runGh(['pr', 'list'], tmpdir(), { WHOMBAT_GH_SOCKET: join(dir, 'gh.sock') });
    expect(r).toEqual({ code: 0, out: 'ok', err: '' });
    svc.close();
  });

  it('gh auth token answers here, empty and failing, without asking the service (Hermes asks it every session)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-gh-'));
    const sock = join(dir, 'gh.sock');
    const svc = await fakeService(sock, () => ({ exitCode: 0, stdout: b64('tok'), stderr: '' }));
    const r = await runGh(['auth', 'token', '--hostname', 'github.com'], dir, { WHOMBAT_GH_SOCKET: sock });
    expect(r).toEqual({ code: 1, out: '', err: '' });
    expect(svc.requests).toEqual([]);
    svc.close();
  });

  it('a refusal and an unreachable or silent service are one line and exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-gh-'));
    const refused = await runGh(['pr', 'comment', '1', '-F', 'missing.md'], dir, {
      WHOMBAT_GH_SOCKET: join(dir, 'none.sock'),
    });
    expect(refused).toEqual({ code: 1, out: '', err: 'open missing.md: no such file or directory\n' });
    const gone = await runGh(['pr', 'list'], dir, { WHOMBAT_GH_SOCKET: join(dir, 'none.sock') });
    expect(gone.code).toBe(1);
    expect(gone.err).toBe('gh: couldn’t reach Whombat (ENOENT); this turn may be over.\n');
    // Outside a turn with GitHub there is no socket: nothing is tried.
    expect(await exchange({ args: ['pr', 'list'], files: [], stdin: null }, {})).toEqual({
      error: expect.stringContaining('only in a turn that has GitHub'),
    });
    const sock = join(dir, 'gh.sock');
    const svc = await fakeService(sock, () => null);
    const silent = await runGh(['pr', 'list'], dir, { WHOMBAT_GH_SOCKET: sock });
    expect(silent).toEqual({
      code: 1,
      out: '',
      err: 'gh: the connection to Whombat closed before gh answered.\n',
    });
    svc.close();
  });
});
