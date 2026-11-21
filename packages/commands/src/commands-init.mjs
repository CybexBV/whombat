// `commands-init.mjs <config> <command> <args…>` (docs/decisions/one-person.md OP-17, OP-S110): the payload of a task
// sandbox whose Hermes runs commands — an outsiders' turn, a Feedback assessment. It starts the turn's own commands'
// holder (`commands-host.mjs`), then the command (Hermes) with the holder's pid in its environment and this process's
// stdio, and ends the holder when the command ends, with the command's status. With `own` it serves the runner's own
// commands (the assessment's Chromium) in the commands' wrapper on that socket.
//
// Configuration (the first argument, JSON): `{holder: {bwrap, args}, wrapper: {nsenter, bwrap, cgroup}, own}`.
// Plain JavaScript with built-in modules only: it runs on the sandbox's pinned Node, and never touches its own stdin or
// stdout (an inherited descriptor keeps its blocking mode: managed-sandbox.md MSB-19).
import { spawn } from 'node:child_process';
import { chmodSync, rmSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { serveOwn, startHolder } from './commands-host.mjs';

const log = (line) => {
  try {
    writeSync(2, `commands-init: ${String(line).slice(0, 2000)}\n`);
  } catch {}
};

const [raw, command, ...args] = process.argv.slice(2);
const config = JSON.parse(raw ?? '{}');
if (!command) {
  log('usage: commands-init.mjs <config> <command> [args…]');
  process.exit(2);
}

let holder;
try {
  holder = await startHolder({ ...config.holder, log });
} catch (err) {
  log(err.message);
  process.exit(125);
}
const ctx = { holder: holder.pid, ...config.wrapper };

let own = null;
if (config.own) {
  own = createServer((conn) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > 1024 * 1024) conn.destroy();
        return;
      }
      conn.off('data', onData);
      let request;
      try {
        request = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch {
        conn.end(`${JSON.stringify({ ok: false, error: 'not JSON' })}\n`);
        return;
      }
      if (request?.op === 'own') serveOwn(conn, buf.subarray(nl + 1), request, ctx);
      else conn.end(`${JSON.stringify({ ok: false, error: 'unknown request' })}\n`);
    };
    conn.on('data', onData);
    conn.on('error', () => {});
  });
  try {
    rmSync(config.own, { force: true });
    await new Promise((resolve, reject) => {
      own.once('error', reject);
      own.listen(config.own, resolve);
    });
    chmodSync(config.own, 0o600);
  } catch (err) {
    log(`couldn’t serve the runner at ${config.own} (${err.code ?? err.message})`);
    own = null;
  }
}

const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, WHOMBAT_COMMANDS_HOLDER: String(holder.pid) },
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {}
  });
holder.child.once('exit', () => log('the commands’ holder ended'));
child.on('error', (err) => {
  log(`${command} couldn’t start (${err.code ?? err.message})`);
  holder.child.kill('SIGKILL');
  process.exit(127);
});
child.on('exit', (code, signal) => {
  own?.close();
  try {
    holder.child.kill('SIGTERM');
  } catch {}
  process.exit(typeof code === 'number' ? code : 128 + (signal === 'SIGKILL' ? 9 : 15));
});
