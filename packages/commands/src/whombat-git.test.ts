/**
 * `git-remote-whombat` on its own (docs/decisions/resourceful-agents.md RA-DS72, RA-DS73): the remote-helper protocol it
 * speaks with git, against a stand-in for the runner's service. The whole way, with real git on both ends, is
 * apps/runner/src/git-relay.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFrame, FRAME, FrameReader, LINES, main } from './whombat-git.mjs';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** The runner's service standing in: answers a probe `whombat`, and plays `session` for a fetch. */
async function service(session?: (socket: Socket, frames: { type: number; payload: Buffer }[]) => void) {
  const path = join(mkdtempSync(join(tmpdir(), 'wb-git-')), 'gh.sock');
  const heard: { line: Record<string, unknown>; frames: { type: number; payload: Buffer }[] }[] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let request: Record<string, unknown> | null = null;
    const reader = new FrameReader();
    const frames: { type: number; payload: Buffer }[] = [];
    socket.on('data', (c: Buffer) => {
      if (request) {
        frames.push(...reader.push(c));
        session?.(socket, frames);
        return;
      }
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      request = JSON.parse(buf.subarray(0, nl).toString()) as Record<string, unknown>;
      heard.push({ line: request, frames });
      if (request.git === 'probe')
        socket.end(`${JSON.stringify({ ok: true, via: 'whombat', repo: 'acme/web' })}\n`);
      else {
        frames.push(...reader.push(buf.subarray(nl + 1)));
        session?.(socket, frames);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  servers.push(server);
  return { path, heard };
}

/** The helper with git's side as streams: what git wrote, and what came back. */
function helper(path: string, input: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => {
    out += d.toString();
  });
  stderr.on('data', (d) => {
    err += d.toString();
  });
  const done = main(
    ['origin', 'https://github.com/acme/web.git'],
    { WHOMBAT_GH_SOCKET: path },
    {
      stdin,
      stdout,
      stderr,
    },
  );
  stdin.write(input);
  return { stdin, done, out: () => out, err: () => err };
}

describe('git-remote-whombat', () => {
  it('offers the fetch git asks for and refuses a push, an archive and protocol v0 in one line each', async () => {
    const svc = await service();
    const cases: [string, string][] = [
      ['capabilities\nlist for-push\n', LINES.push],
      ['capabilities\npush refs/heads/main:refs/heads/main\n', LINES.push],
      ['capabilities\nlist\n', LINES.version],
      ['capabilities\nstateless-connect git-upload-archive\n', LINES.archive],
      ['capabilities\nconnect git-upload-pack\n', LINES.unknown('connect git-upload-pack')],
    ];
    for (const [input, line] of cases) {
      const h = helper(svc.path, input);
      expect(await h.done).toBe(128);
      expect(h.out()).toBe('stateless-connect\npush\n\n');
      expect(h.err()).toBe(`${line}\n`);
    }
    // A blank line, or git closing the stream: done.
    const h = helper(svc.path, 'capabilities\n\n');
    expect(await h.done).toBe(0);
  });

  it('relays a fetch: git’s requests out as frames, the runner’s answers back, its exit status as the helper’s', async () => {
    const svc = await service((socket, frames) => {
      // The runner's git answers once git's request and its end have arrived.
      if (!frames.some((f) => f.type === FRAME.eof)) return;
      socket.write(encodeFrame(FRAME.stdout, '\n000eversion 2\n0000'));
      socket.write(encodeFrame(FRAME.stderr, 'remote: counting\n'));
      socket.end(encodeFrame(FRAME.exit, JSON.stringify({ code: 0, signal: null })));
    });
    const h = helper(svc.path, 'capabilities\nstateless-connect git-upload-pack\n');
    h.stdin.write('0014command=ls-refs\n0000');
    h.stdin.end();
    expect(await h.done).toBe(0);
    expect(h.out()).toBe('stateless-connect\npush\n\n\n000eversion 2\n0000');
    expect(h.err()).toBe('remote: counting\n');
    expect(svc.heard.map((x) => x.line)).toEqual([
      { v: 1, git: 'probe', url: 'https://github.com/acme/web.git' },
      { v: 1, git: 'upload-pack', url: 'https://github.com/acme/web.git' },
    ]);
    const sent = svc.heard[1]?.frames ?? [];
    expect(Buffer.concat(sent.filter((f) => f.type === FRAME.stdin).map((f) => f.payload)).toString()).toBe(
      '0014command=ls-refs\n0000',
    );
    expect(sent.at(-1)?.type).toBe(FRAME.eof);
  });

  it('a connection that ends without an exit status is an error git sees', async () => {
    const svc = await service((socket) => socket.destroy());
    const h = helper(svc.path, 'capabilities\nstateless-connect git-upload-pack\n0000');
    expect(await h.done).toBe(128);
    expect(h.err()).toBe(`${LINES.closed}\n`);
  });

  it('a URL that isn’t a GitHub repository is refused before anything is asked', async () => {
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', (d) => {
      err += d.toString();
    });
    expect(await main(['origin', 'https://gitlab.com/acme/web.git'], {}, { stderr })).toBe(128);
    expect(err).toBe(`${LINES.notGitHub('https://gitlab.com/acme/web.git')}\n`);
    expect(await main(['origin'], {}, { stderr })).toBe(2);
  });

  it('frames round-trip, a large payload split', () => {
    const big = Buffer.alloc(600 * 1024, 7);
    const reader = new FrameReader();
    const frames = reader.push(Buffer.concat([encodeFrame(FRAME.stdout, big), encodeFrame(FRAME.eof)]));
    expect(frames.map((f) => f.type)).toEqual([FRAME.stdout, FRAME.stdout, FRAME.stdout, FRAME.eof]);
    expect(Buffer.concat(frames.slice(0, 3).map((f) => f.payload)).equals(big)).toBe(true);
  });
});
