// `whombat-command <argv…>` (docs/decisions/one-person.md OP-07, OP-S107): the prefix of Hermes's terminal environment
// (`whombat_hermes/terminal.py`'s `exec_prefix`), so every command Hermes runs — the agent's, its file tools', its
// background processes', execute_code's — comes through here, inside the pod beside Hermes.
//
// 1. It asks the runner (`WHOMBAT_COMMANDS_SOCKET`): the Hermes session (`WHOMBAT_TURN_SESSION`), the argv. The runner's
//    guard reads it; a consequential command waits here for a person's answer, the runner's line on stderr meanwhile. The
//    answer is the command's wrapper (bubblewrap's arguments: what of the turn the command sees), its whole environment
//    and the turn's key files, or a refusal (a line and an exit status).
// 2. It runs the command: in a cgroup of its own (`WHOMBAT_COMMANDS_CGROUP/c-<id>`), `nsenter` into the commands' holder
//    (`WHOMBAT_COMMANDS_HOLDER`: its network, pid and mount namespaces, never Hermes's), then bubblewrap with the
//    runner's arguments; the key files are pipes it reads onto a tmpfs. Its stdin, stdout and stderr are this process's.
// 3. SIGTERM, SIGINT or SIGHUP end the whole command (its cgroup). It tells the runner how it ended, prints what the
//    runner says to that (the same failure again, HC-02) and exits with the command's status (128 + n for a signal).
//
// Plain JavaScript with built-in modules only: it runs on the sandbox's pinned Node.
import { connect } from 'node:net';
import { cgroupId, killCgroup, runInWrapper, tidyCgroups } from './commands-host.mjs';

/** The exit status of a command that didn't run because the runner couldn't be asked (no key, AC-41's 126). */
export const EXIT_UNASKED = 126;
const LINE_MAX = 1024 * 1024;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function say(line) {
  process.stderr.write(`${line}\n`);
}

/** Reads JSON lines from `socket`, one `onLine` each, until `onLine` returns true or the socket ends. */
function lines(socket, onLine) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error('the runner’s answer couldn’t be read'));
          return;
        }
        if (onLine(message)) {
          finish(null, message);
          return;
        }
        nl = buf.indexOf('\n');
      }
      if (buf.length > LINE_MAX) finish(new Error('the runner’s answer was too long'));
    };
    const onEnd = () => finish(null, null);
    const onError = (err) => finish(err);
    function finish(err, value) {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
      if (err) reject(err);
      else resolve(value);
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onError);
  });
}

export async function main(argv, env = process.env) {
  if (!argv.length) {
    say('usage: whombat-command <command> [args…]');
    return 2;
  }
  const holder = Number(env.WHOMBAT_COMMANDS_HOLDER);
  if (!env.WHOMBAT_COMMANDS_SOCKET || !Number.isInteger(holder) || holder < 1) {
    say('whombat: commands can’t run here (the commands’ holder isn’t there), so this one didn’t run.');
    return EXIT_UNASKED;
  }
  const socket = connect(env.WHOMBAT_COMMANDS_SOCKET);
  socket.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  } catch (err) {
    say(`whombat: couldn’t ask whether this may run (${err.code ?? err.message}); it didn’t run.`);
    return EXIT_UNASKED;
  }
  socket.write(
    `${JSON.stringify({
      v: 1,
      session: env.WHOMBAT_TURN_SESSION?.trim() || null,
      cwd: process.cwd(),
      argv,
      tty: Boolean(process.stdin.isTTY),
    })}\n`,
  );
  let answer;
  try {
    answer = await lines(socket, (m) => {
      if (typeof m?.say === 'string') {
        say(m.say);
        return false;
      }
      return true;
    });
  } catch (err) {
    say(`whombat: couldn’t ask whether this may run (${err.message}); it didn’t run.`);
    socket.destroy();
    return EXIT_UNASKED;
  }
  if (!answer?.run) {
    socket.destroy();
    if (answer?.refuse) {
      say(answer.refuse.line);
      return answer.refuse.code;
    }
    say('whombat: the runner didn’t say whether this may run; it didn’t run.');
    return EXIT_UNASKED;
  }
  const spec = answer.run;
  const keys = Array.isArray(spec.keys) ? spec.keys : [];
  const ctx = {
    holder,
    nsenter: env.WHOMBAT_COMMANDS_NSENTER || 'nsenter',
    bwrap: env.WHOMBAT_COMMANDS_BWRAP || 'bwrap',
    cgroup: env.WHOMBAT_COMMANDS_CGROUP || null,
  };
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(env.WHOMBAT_COMMAND_ID ?? '')
    ? `c-${env.WHOMBAT_COMMAND_ID}`
    : cgroupId();
  let run;
  try {
    run = runInWrapper(ctx, spec, argv, ['inherit', 'inherit', 'inherit', ...keys.map(() => 'pipe')], id);
  } catch (err) {
    socket.destroy();
    say(`whombat: the command couldn’t start (${err.code ?? err.message}), so it didn’t run.`);
    return EXIT_UNASKED;
  }
  const { child, cgroup } = run;
  keys.forEach((k, i) => {
    const pipe = child.stdio[3 + i];
    pipe.on('error', () => {});
    pipe.end(Buffer.from(k.base64, 'base64'));
  });
  let signalled = null;
  for (const [name, n] of Object.entries(SIGNALS))
    process.on(name, () => {
      signalled ??= n;
      killCgroup(cgroup);
      try {
        child.kill('SIGKILL');
      } catch {}
    });
  const status = await new Promise((resolve) => {
    child.once('error', () => resolve(EXIT_UNASKED));
    child.once('exit', (code, signal) => {
      if (signalled !== null) resolve(128 + signalled);
      else if (typeof code === 'number') resolve(code);
      else resolve(128 + (signal === 'SIGKILL' ? 9 : (SIGNALS[signal] ?? 1)));
    });
  });
  // What it left in the foreground is done; a background job it started keeps its cgroup (Hermes stops it).
  tidyCgroups(ctx.cgroup, id);
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify({ exit: status })}\n`);
    const timer = setTimeout(() => socket.destroy(), 2000);
    timer.unref?.();
    await lines(socket, (m) => {
      if (typeof m?.say === 'string') say(m.say);
      return false;
    }).catch(() => {});
    clearTimeout(timer);
    socket.destroy();
  }
  return status;
}

const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invoked) process.exit(await main(process.argv.slice(2)));
