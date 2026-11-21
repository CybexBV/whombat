// The payload of a person's pod (Whombat hermes-native.md HN-W01, HN-W02, HN-W11): it runs in the pod's bubblewrap
// stage 2 for as long as the pod lives and does three things.
//
// 1. Runs Hermes's own gateway (`hermes gateway run --quiet`), the one process that serves all of the person's
//    sessions, and starts it again after a crash (a short backoff; after three quick exits in a row it leaves it to the
//    next `hermes acp`, which starts a gateway itself when none is there).
// 2. Keeps a spare `hermes acp` started, its imports done, so a turn never waits for Python to start: a turn's viewer
//    must be started inside the pod, the only place that reaches the gateway's loopback port.
// 3. Serves the runner on a unix socket in the pod's run directory (`socket`), one JSON line per request:
//    - `{"op":"acp","cwd":"/abs"}`: checks the turn's working directory is there (the pod has the agent's home and the
//      workspaces at their own paths, one-person.md OP-S109), hands over a spare and answers `{"ok":true,"pid":N}`;
//      from then on the connection is that process's stdin and stdout. Closing the connection ends the process; the
//      process ending closes the connection.
//    - `{"op":"status"}`: the gateway's and the spares' state.
//    - `{"op":"stop"}`: everything ends gracefully, then this process exits.
//    - `{"op":"own","bwrap":[…],"env":{…},"argv":[…]}`: Whombat's own command (the person's Chromium) in a command's
//      wrapper, beside the agent's commands (one-person.md OP-S113); the connection is its stdin and output.
// 4. With `commands` (one-person.md OP-07, OP-S105), first of all it starts the commands' holder (`commands-host.mjs`),
//    whose network, pid and mount namespaces every command joins; Hermes's processes get its pid
//    (`WHOMBAT_COMMANDS_HOLDER`). The holder ending ends the pod: the next turn starts a new one.
//
// Its configuration is the first argument (JSON, no secret: the pod's environment is the processes' environment). It
// prints one line on stdout once it serves (`{"ready":true}`); its logs go to stderr. Plain JavaScript with built-in
// modules only: it runs on the pinned Node, inside the sandbox.
import { spawn } from 'node:child_process';
import { chmodSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, normalize } from 'node:path';

const config = JSON.parse(process.argv[2] ?? '{}');
/** The commands' wrapper (`{holder, nsenter, bwrap, cgroup}`) once the holder runs; null without commands. */
let wrapper = null;
const BACKOFF = config.backoffMs ?? [500, 2000, 5000, 15000, 30000];
const KILL_GRACE_MS = config.killGraceMs ?? 3000;
const QUICK_MS = config.quickMs ?? 60_000;
const SPARES = Math.max(0, Math.min(4, config.spares ?? 1));
const LINE_MAX = 64 * 1024;

let stopping = false;
const log = (line) => process.stderr.write(`pod: ${String(line).slice(0, 2000)}\n`);

/** A child's output as lines in this process's log, each with where it came from. */
function relay(stream, label) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line) process.stderr.write(`${label}: ${line.slice(0, 2000)}\n`);
      nl = buf.indexOf('\n');
    }
    if (buf.length > LINE_MAX) buf = '';
  });
  stream.on('error', () => {});
}

/** Starts a child in its own process group (what it starts ends with it). */
function start(args, label) {
  const child = spawn(config.hermes, args, {
    cwd: config.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  relay(child.stderr, `${label} ${child.pid ?? '?'}`);
  child.on('error', (err) => log(`${label} couldn’t start (${err.code ?? err.message})`));
  return child;
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

function signalGroup(child, sig) {
  if (!child.pid || !alive(child)) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {}
  }
}

/** SIGTERM to the child's group, SIGKILL after the grace; resolves once it is gone. */
function end(child) {
  if (!alive(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      // What the group left behind goes too.
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      resolve();
    });
    try {
      child.stdin.end();
    } catch {}
    signalGroup(child, 'SIGTERM');
  });
}

// --- 1. The gateway -------------------------------------------------------------------------------------------------

const gateway = { child: null, starts: 0, quick: 0, gaveUp: false };

function startGateway() {
  if (!config.gateway || stopping) return;
  const began = Date.now();
  gateway.starts += 1;
  const child = start(config.gateway, 'gateway');
  child.stdout.setEncoding('utf8');
  relay(child.stdout, `gateway ${child.pid ?? '?'}`);
  gateway.child = child;
  child.once('exit', (code, signal) => {
    if (gateway.child === child) gateway.child = null;
    if (stopping) return;
    gateway.quick = Date.now() - began < QUICK_MS ? gateway.quick + 1 : 0;
    if (gateway.quick >= 3) {
      gateway.gaveUp = true;
      log(`the gateway exited (${code ?? signal}) three times in a row; the next turn starts one`);
      return;
    }
    const wait = BACKOFF[Math.min(gateway.quick, BACKOFF.length - 1)];
    log(`the gateway exited (${code ?? signal}); starting it again in ${wait} ms`);
    setTimeout(startGateway, wait).unref();
  });
}

// --- 2. Spare viewers -----------------------------------------------------------------------------------------------

const spares = [];
const live = new Set();
let spareFailures = 0;
let spareTimer = null;

function fillSpares() {
  if (stopping || spareTimer) return;
  while (spares.length < SPARES) {
    const born = Date.now();
    const child = start(config.acp, 'acp');
    spares.push(child);
    child.once('exit', (code, signal) => {
      const at = spares.indexOf(child);
      if (at < 0 || stopping) return;
      // A spare that died before any turn took it: another one, after a pause when they keep dying.
      spares.splice(at, 1);
      spareFailures = Date.now() - born < QUICK_MS ? spareFailures + 1 : 0;
      const wait = BACKOFF[Math.min(spareFailures, BACKOFF.length - 1)];
      log(`a spare hermes acp exited (${code ?? signal}); another in ${wait} ms`);
      spareTimer = setTimeout(() => {
        spareTimer = null;
        fillSpares();
      }, wait);
      spareTimer.unref();
    });
  }
}

/** A spare, or a fresh process when none is ready (the turn then pays Hermes's start). */
function takeSpare() {
  while (spares.length) {
    const child = spares.shift();
    if (alive(child)) return child;
  }
  return start(config.acp, 'acp');
}

// --- 3. The runner's socket -----------------------------------------------------------------------------------------

/** Whether the turn's working directory is there as Hermes needs it; else why not. */
function folder(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || normalize(cwd) !== cwd) return 'not an absolute path';
  try {
    return statSync(cwd).isDirectory() ? null : 'not a directory';
  } catch (err) {
    return `not there (${err.code ?? err.message})`;
  }
}

function status() {
  return {
    ok: true,
    gateway: config.gateway
      ? { up: Boolean(gateway.child && alive(gateway.child)), starts: gateway.starts, gaveUp: gateway.gaveUp }
      : null,
    spares: spares.filter(alive).length,
    viewers: live.size,
  };
}

function handOver(conn, cwd, rest) {
  const why = folder(cwd);
  if (why) {
    conn.end(`${JSON.stringify({ ok: false, error: `the turn’s folder: ${why}` })}\n`);
    return;
  }
  const child = takeSpare();
  live.add(child);
  fillSpares();
  conn.write(`${JSON.stringify({ ok: true, pid: child.pid ?? null })}\n`);
  if (rest.length) child.stdin.write(rest);
  conn.pipe(child.stdin);
  child.stdout.pipe(conn);
  conn.on('error', () => {});
  // The runner hung up: the turn's viewer ends (its sessions stay in the gateway).
  conn.once('close', () => {
    void end(child);
  });
  child.once('exit', () => {
    live.delete(child);
    // Its last output first (`pipe` ends the connection when stdout ends).
    setTimeout(() => conn.destroy(), 1000).unref();
  });
}

const server = createServer((conn) => {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > LINE_MAX) conn.destroy();
      return;
    }
    conn.off('data', onData);
    conn.pause();
    let request;
    try {
      request = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    } catch {
      conn.end(`${JSON.stringify({ ok: false, error: 'not JSON' })}\n`);
      return;
    }
    const rest = buf.subarray(nl + 1);
    if (stopping) conn.end(`${JSON.stringify({ ok: false, error: 'the pod is stopping' })}\n`);
    else if (request?.op === 'acp') handOver(conn, request.cwd, rest);
    else if (request?.op === 'status') conn.end(`${JSON.stringify(status())}\n`);
    else if (request?.op === 'own' && wrapper) commandsHost.serveOwn(conn, rest, request, wrapper);
    else if (request?.op === 'stop') {
      conn.end(`${JSON.stringify({ ok: true })}\n`);
      void shutdown(0);
    } else conn.end(`${JSON.stringify({ ok: false, error: 'unknown request' })}\n`);
  };
  conn.on('data', onData);
  conn.on('error', () => {});
});

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (spareTimer) clearTimeout(spareTimer);
  server.close();
  const children = [...spares.splice(0), ...live, ...(gateway.child ? [gateway.child] : [])];
  await Promise.all(children.map(end));
  try {
    rmSync(config.socket, { force: true });
  } catch {}
  process.exit(code);
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => void shutdown(0));
process.stdout.on('error', () => {});

try {
  rmSync(config.socket, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socket, resolve);
  });
  chmodSync(config.socket, 0o600);
} catch (err) {
  log(`couldn’t serve the runner at ${config.socket} (${err.code ?? err.message})`);
  process.exit(125);
}
let commandsHost = null;
if (config.commands) {
  try {
    commandsHost = await import(config.commands.host);
    const holder = await commandsHost.startHolder({
      ...config.commands.holder,
      log,
      onExit: (code, signal) => {
        if (stopping) return;
        log(`the commands’ holder exited (${code ?? signal}); the pod ends`);
        void shutdown(1);
      },
    });
    wrapper = { holder: holder.pid, ...config.commands.wrapper };
    process.env.WHOMBAT_COMMANDS_HOLDER = String(holder.pid);
  } catch (err) {
    log(`the commands’ holder couldn’t start (${err.message})`);
    process.exit(124);
  }
}
startGateway();
fillSpares();
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
