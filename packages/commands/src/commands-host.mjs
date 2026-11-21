// What a sandbox that runs the agent's commands does for them (docs/decisions/one-person.md OP-07, OP-S105, OP-S108):
// `pod-init.mjs` in a person's pod and `commands-init.mjs` in an outsiders' task sandbox import it.
//
// - `startHolder`: the commands' holder, a bubblewrap sandbox of its own (the runner's arguments) whose network, pid and
//   mount namespaces every command joins; its payload is `commands-net.mjs`. Resolves with its pid once it serves.
// - `runInWrapper`: one process in a command's wrapper — `nsenter` into the holder's namespaces, then the command's own
//   bubblewrap — in a cgroup of its own under the sandbox's commands' cgroup (`c-<id>`), its OOM score raised so the
//   kernel takes a command before Hermes. The agent's commands come this way through `whombat-command.mjs`; Whombat's
//   own (the browser's Chromium) through `serveOwn`, never through the guard.
// - `killCgroup`: the whole command, whatever it forked or detached.
//
// Plain JavaScript with built-in modules only: it runs on the sandbox's pinned Node.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A command's OOM score (memory-pool.md MP-02): before Hermes (the pod's -500) when the pod runs out of memory. */
export const COMMAND_OOM_SCORE_ADJ = 500;

/**
 * The shell that puts the command in its cgroup before it runs anything (`sh -c <this> <cgroup> <argv…>`): it joins —
 * or fails without running anything — raises its OOM score (best effort), takes umask 0007 (what it writes in the
 * agent's home and the workspaces stays writable for the container engine's group: `docker run -v`, I-3), then execs.
 */
export const JOIN_SCRIPT = `if [ -n "$0" ]; then echo $$ > "$0/cgroup.procs" || { echo "whombat: the command couldn't get a cgroup of its own, so it didn't run" >&2; exit 125; }; fi; echo ${COMMAND_OOM_SCORE_ADJ} > /proc/self/oom_score_adj 2>/dev/null; umask 0007; exec "$@"`;

/** A fresh name for a command's cgroup. */
export function cgroupId(prefix = 'c') {
  return `${prefix}-${process.pid}-${randomBytes(6).toString('hex')}`;
}

/** Makes `<root>/<id>` (or nothing without a root); returns its path or null. */
export function makeCgroup(root, id) {
  if (!root) return null;
  const dir = join(root, id);
  mkdirSync(dir);
  return dir;
}

/** Kills everything in a command's cgroup (`cgroup.kill`, the whole subtree). */
export function killCgroup(dir) {
  if (!dir) return;
  try {
    writeFileSync(join(dir, 'cgroup.kill'), '1');
  } catch {}
}

/** Whether a cgroup still holds a process. */
export function populated(dir) {
  try {
    return /^populated 1$/m.test(readFileSync(join(dir, 'cgroup.events'), 'utf8'));
  } catch {
    return false;
  }
}

/** Removes a command's cgroup once it is empty, and every other empty one beside it (a background job's, ended). */
export function tidyCgroups(root, own) {
  if (!root) return;
  const names = own ? [own] : [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true }))
      if (e.isDirectory() && /^[cw]-/.test(e.name) && e.name !== own) names.push(e.name);
  } catch {}
  for (const name of names) {
    const dir = join(root, name);
    if (populated(dir)) continue;
    try {
      rmdirSync(dir);
    } catch {}
  }
}

/** The argv that runs `argv` in a command's wrapper (after `JOIN_SCRIPT`'s `sh -c`). */
export function wrapperArgv(ctx, bwrapArgs, argv) {
  return [
    ctx.nsenter,
    '-t',
    String(ctx.holder),
    '-U',
    '-n',
    '-p',
    '-m',
    '--preserve-credentials',
    '--',
    ctx.bwrap,
    ...bwrapArgs,
    '--',
    ...argv,
  ];
}

/**
 * Spawns `argv` in a command's wrapper: `ctx` is `{holder, nsenter, bwrap, cgroup}` (the cgroup root, or null), `spec`
 * the runner's `{bwrap, env}`, `stdio` the child's stdio (extra entries are the key files' pipes). Returns the child and
 * its cgroup's path.
 */
export function runInWrapper(ctx, spec, argv, stdio, id = cgroupId()) {
  const cgroup = makeCgroup(ctx.cgroup, id);
  const child = spawn('/bin/sh', ['-c', JOIN_SCRIPT, cgroup ?? '', ...wrapperArgv(ctx, spec.bwrap, argv)], {
    env: spec.env,
    stdio,
  });
  return { child, cgroup, id };
}

/**
 * Starts the holder: `bwrap <args>` with its info on fd 3 (the sandbox's child, in this pid namespace); resolves once
 * its payload says `ready`. `onExit` hears when it ends.
 */
export function startHolder({ bwrap, args, onExit, log = () => {}, startMs = 20_000 }) {
  const child = spawn(bwrap, ['--info-fd', '3', ...args], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let info = '';
    let out = '';
    let pid = null;
    let ready = false;
    let settled = false;
    const tail = [];
    const timer = setTimeout(() => fail(new Error('the commands’ holder didn’t start in time')), startMs);
    timer.unref?.();
    const done = () => {
      if (settled || pid === null || !ready) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid, child });
    };
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(err);
    }
    child.stdio[3].on('data', (c) => {
      info += c.toString('utf8');
      const m = /"child-pid"\s*:\s*(\d+)/.exec(info);
      if (m) {
        pid = Number(m[1]);
        done();
      }
    });
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      if (out.includes('ready\n')) {
        ready = true;
        done();
      }
    });
    child.stderr.on('data', (c) => {
      for (const line of c.toString('utf8').split('\n'))
        if (line.trim()) {
          tail.push(line.trim().slice(0, 300));
          if (tail.length > 5) tail.shift();
          log(`holder: ${line.trim().slice(0, 500)}`);
        }
    });
    child.on('error', (err) => fail(err));
    child.once('exit', (code, signal) => {
      fail(new Error(`the commands’ holder exited (${code ?? signal}) ${tail.join(' ')}`.trim()));
      onExit?.(code, signal);
    });
  });
}

/**
 * Whombat's own command in a command's wrapper (`{"op":"own","bwrap":[…],"env":{…},"argv":[…]}`, from the runner
 * only): answers `{"ok":true}`, then the connection is the process's stdin and its stdout and stderr together; closing
 * the connection ends it (its cgroup), its end closes the connection.
 */
export function serveOwn(conn, rest, request, ctx) {
  if (!Array.isArray(request?.argv) || !request.argv.length || !Array.isArray(request?.bwrap)) {
    conn.end(`${JSON.stringify({ ok: false, error: 'not a command' })}\n`);
    return;
  }
  let run;
  try {
    run = runInWrapper(
      ctx,
      { bwrap: request.bwrap, env: request.env ?? {} },
      request.argv,
      ['pipe', 'pipe', 'pipe'],
      cgroupId('w'),
    );
  } catch (err) {
    conn.end(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    return;
  }
  const { child, cgroup, id } = run;
  conn.write(`${JSON.stringify({ ok: true })}\n`);
  if (rest.length) child.stdin.write(rest);
  conn.pipe(child.stdin);
  child.stdout.pipe(conn, { end: false });
  child.stderr.pipe(conn, { end: false });
  child.stdin.on('error', () => {});
  conn.on('error', () => {});
  const end = () => {
    killCgroup(cgroup);
    try {
      child.kill('SIGKILL');
    } catch {}
  };
  conn.once('close', end);
  child.once('exit', () => {
    killCgroup(cgroup);
    setTimeout(() => {
      conn.end();
      tidyCgroups(ctx.cgroup, id);
    }, 200).unref?.();
  });
}
