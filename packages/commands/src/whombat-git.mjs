// `git-remote-whombat` (docs/decisions/resourceful-agents.md RA-DS72…RA-DS74): git's transport for https://github.com/…
// in an agent's shell in a managed turn. Git runs it for every GitHub URL it fetches from
// (`url."whombat::https://github.com/".insteadOf`, set for every command; a push keeps the plain
// URL, `pushInsteadOf`). It holds no token. For a repository switched on for agents it asks the runner's per-turn gh
// service — the socket the stand-in gh uses — which fetches from GitHub as the burrow's GitHub connection, the token only
// in the environment of the runner's own `git remote-https`, and relays git's protocol both ways. Anything else (a public
// repository, a turn without GitHub, a job after its turn) goes to git's own https transport, as it would without this.
// Read-only: it speaks `stateless-connect git-upload-pack` (protocol version 2) and refuses a push.
//
// Plain JavaScript with built-in modules and its neighbours only: it runs on the commands' Node, from their folder bound
// read-only into their wrapper.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FRAME, FrameDecoder } from './frames.mjs';
import { askLine, socketTarget } from './line-client.mjs';

// A session's frames are the relay's codec, the one the runner speaks (`[type u8][length u32 BE][payload]`).
export { encodeFrame, FRAME, FrameDecoder as FrameReader };

/** What git sees on stderr (one line each). */
export const LINES = Object.freeze({
  notGitHub: (url) =>
    `whombat: Whombat’s git transport is for GitHub repositories (https://github.com/owner/name); ${url} isn’t one.`,
  push: 'whombat: a push to GitHub doesn’t go through Whombat’s git transport. Commit in a run’s checkout (start_run): Whombat pushes your branch after the turn and before open_pull_request opens a pull request.',
  version:
    'whombat: Whombat fetches from GitHub with git’s protocol version 2: unset protocol.version (or set it to 2) and try again.',
  archive:
    'whombat: GitHub doesn’t serve git archive --remote: clone the repository and run git archive there.',
  unknown: (what) => `whombat: git asked for “${what}”, which Whombat’s GitHub transport doesn’t do.`,
  closed: 'whombat: the connection to Whombat closed before git finished; this turn may be over.',
  usage: 'whombat: git runs this itself for GitHub URLs (git-remote-whombat <remote> <url>).',
});

/** `owner/name` of a GitHub repository URL as git hands it over (`https://github.com/owner/name[.git]`), or null. */
export function githubRepo(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
  if (u.username || u.password || (u.port && u.port !== '443') || u.search || u.hash) return null;
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  const ok = (s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..';
  return ok(owner) && ok(name) ? `${owner}/${name}` : null;
}

/** Where the gh service is: `$WHOMBAT_GH_SOCKET` (AGH-16, AGH-17), or null outside a turn with GitHub. */
function target(env) {
  const path = env.WHOMBAT_GH_SOCKET;
  // A long path changes this process's directory: the transport git falls back to is started in git's own (`delegate`).
  return path ? socketTarget(path) : null;
}

/** How long a probe waits for its answer (the runner may ask the server once): then git goes its own way. */
const PROBE_WAIT_MS = 30_000;

/** One JSON line out, one JSON line back: `{reply}`, `{error}` once connected, or `{refused}` when it couldn't connect. */
function ask(request, options) {
  return askLine(
    options,
    request,
    {
      refused: (err) => ({ refused: err }),
      broken: (err) => ({ error: err.code ?? 'error' }),
      unreadable: () => ({ error: 'unreadable' }),
      closed: () => ({ error: 'closed' }),
      // A runner that doesn't answer mustn't hold git up.
      timeout: () => ({ error: 'timeout' }),
    },
    PROBE_WAIT_MS,
  );
}

/**
 * Whether the runner fetches this repository (`{via: 'whombat', target}`) or git's own transport does
 * (`{via: 'direct', note}`), or a refusal (`{error}`). A runner that doesn't answer, an older one that doesn't know the
 * question, a turn that is over: direct, as without this helper.
 */
export async function probe(url, env = process.env) {
  const t = target(env);
  if (!t) return { via: 'direct', note: null };
  const r = await ask({ v: 1, git: 'probe', url }, t);
  if (r.refused) return { via: 'direct', note: null };
  const reply = r.reply;
  if (reply?.ok === true && reply.via === 'whombat') return { via: 'whombat', target: t };
  if (reply?.ok === false && typeof reply.error === 'string') return { error: reply.error };
  return { via: 'direct', note: typeof reply?.note === 'string' ? reply.note : null };
}

/** git's own https transport, in git's own directory, with what git sent it; a note after it when it failed. */
function delegate(remote, url, note, io) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['remote-https', remote, url], { cwd: io.cwd, stdio: 'inherit', env: io.env });
    child.on('error', (err) => {
      io.stderr.write(`whombat: git’s https transport couldn’t start (${err.code ?? err.message}).\n`);
      resolvePromise(128);
    });
    child.on('exit', (code) => {
      if (code !== 0 && note) io.stderr.write(`whombat: ${note}\n`);
      resolvePromise(code ?? 128);
    });
  });
}

/**
 * The fetch through the runner (`stateless-connect git-upload-pack`): one connection, a JSON line naming the URL, then
 * frames both ways — git's requests as `stdin` and its end as `eof`; the runner's `git remote-https` answers as
 * `stdout` (the blank line that opens the connection, then the server's answers), its errors as `stderr`, and `exit`.
 */
function session(url, leftover, target, io) {
  return new Promise((resolvePromise) => {
    const { stdin, stdout, stderr } = io;
    const socket = connect(target);
    const reader = new FrameDecoder();
    let exited = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      stdin.pause();
      socket.destroy();
      resolvePromise(code);
    };
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: 1, git: 'upload-pack', url })}\n`);
      if (leftover.length) socket.write(encodeFrame(FRAME.stdin, leftover));
      stdin.on('data', (c) => {
        if (!socket.write(encodeFrame(FRAME.stdin, c))) {
          stdin.pause();
          socket.once('drain', () => stdin.resume());
        }
      });
      stdin.on('end', () => socket.write(encodeFrame(FRAME.eof)));
      stdin.resume();
    });
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        stderr.write(`${LINES.closed}\n`);
        finish(128);
        return;
      }
      for (const f of frames) {
        if (f.type === FRAME.stdout) {
          if (!stdout.write(f.payload)) {
            socket.pause();
            stdout.once('drain', () => socket.resume());
          }
        } else if (f.type === FRAME.stderr) stderr.write(f.payload);
        else if (f.type === FRAME.exit) {
          exited = true;
          let code = 128;
          try {
            const v = JSON.parse(f.payload.toString('utf8'));
            if (Number.isInteger(v.code) && v.code >= 0 && v.code <= 255) code = v.code;
          } catch {}
          // Everything git was sent is written before the helper ends.
          stdout.write('', () => finish(code));
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (exited) return;
      stderr.write(`${LINES.closed}\n`);
      finish(128);
    });
  });
}

/**
 * The remote-helper protocol (gitremote-helpers(7)) until the fetch starts: `capabilities` → `stateless-connect` and
 * `push` (so a push says `list for-push` and is refused in words, not with git's own error), then exactly
 * `stateless-connect git-upload-pack`. Everything else is refused with one line.
 */
function serve(url, target, io) {
  return new Promise((resolvePromise) => {
    const { stdin, stdout, stderr } = io;
    let buf = Buffer.alloc(0);
    let over = false;
    const end = (code, line) => {
      if (over) return;
      over = true;
      stdin.off('data', onData);
      stdin.pause();
      if (line) stderr.write(`${line}\n`);
      resolvePromise(code);
    };
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (let nl = buf.indexOf(10); nl >= 0 && !over; nl = buf.indexOf(10)) {
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (line === 'capabilities') stdout.write('stateless-connect\npush\n\n');
        else if (line === 'stateless-connect git-upload-pack') {
          over = true;
          stdin.off('data', onData);
          stdin.pause();
          session(url, buf, target, io).then(resolvePromise);
          return;
        } else if (line === 'stateless-connect git-upload-archive') end(128, LINES.archive);
        else if (line === 'list for-push' || line.startsWith('push ')) end(128, LINES.push);
        else if (line === 'list' || line.startsWith('list ') || line.startsWith('fetch '))
          end(128, LINES.version);
        else if (line === '') end(0);
        else end(128, LINES.unknown(line.slice(0, 80)));
      }
    };
    stdin.on('data', onData);
    stdin.on('end', () => end(0));
  });
}

/** Writes what is pending, then exits with `code`. */
function exitWith(code) {
  let left = 2;
  const one = () => {
    if (--left === 0) process.exit(code);
  };
  process.stdout.write('', one);
  process.stderr.write('', one);
}

/**
 * The helper: git runs `git-remote-whombat <remote> <url>` (the URL without `whombat::`). Resolves with the exit status.
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  const cwd = process.cwd();
  const stderr = options.stderr ?? process.stderr;
  const [remote, url] = argv;
  if (!remote || !url) {
    stderr.write(`${LINES.usage}\n`);
    return 2;
  }
  if (!githubRepo(url)) {
    stderr.write(`${LINES.notGitHub(url)}\n`);
    return 128;
  }
  const decided = await probe(url, env);
  if (decided.error) {
    stderr.write(`whombat: ${decided.error}\n`);
    return 128;
  }
  if (decided.via !== 'whombat') return delegate(remote, url, decided.note, { cwd, env, stderr });
  return serve(url, decided.target, {
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr,
  });
}

const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {}
if (invoked === self || invoked === realpathSync(self)) exitWith(await main());
