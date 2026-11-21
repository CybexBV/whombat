// How the commands' helpers (the stand-in gh, git's GitHub transport, `whombat`) ask the runner: one JSON line out on a
// unix socket, one JSON line back. Each helper says in its own words what went wrong, so the failures are its callbacks.
//
// Plain JavaScript with built-in modules only: it runs on the commands' Node, beside the helpers that import it.
import { connect } from 'node:net';
import { basename, dirname } from 'node:path';

/** The longest unix socket path `connect` takes as it is; a longer one is reached from its directory. */
const SOCKET_PATH_MAX = 100;

/**
 * `connect`'s options for the unix socket at `path`. A unix socket's path has at most 107 bytes: a longer one is reached
 * from its own directory, which becomes this process's working directory.
 */
export function socketTarget(path) {
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX) {
    try {
      process.chdir(dirname(path));
    } catch {}
    return { path: `./${basename(path)}` };
  }
  return { path };
}

/**
 * Sends `request` as one JSON line and resolves with `{reply}`, the first JSON line back. It never rejects: a failure
 * resolves with what the helper's callback makes of it — `refused(err)` when it couldn't connect, `broken(err)` for an
 * error once connected, `unreadable()` for an answer that isn't JSON, `closed(connected)` for a connection that ended
 * first, and `timeout()` when no answer came within `timeoutMs` (no limit without it).
 */
export function askLine(target, request, on, timeoutMs) {
  return new Promise((resolvePromise) => {
    const socket = connect(target);
    const chunks = [];
    let connected = false;
    let answered = false;
    let timer;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    // A runner that doesn't answer mustn't hold the command up.
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(on.timeout()), timeoutMs);
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (c) => {
      const nl = c.indexOf(10);
      if (nl < 0) {
        chunks.push(c);
        return;
      }
      chunks.push(c.subarray(0, nl));
      let reply;
      try {
        reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(on.unreadable());
        return;
      }
      finish({ reply });
    });
    socket.on('error', (err) => finish(connected ? on.broken(err) : on.refused(err)));
    socket.on('close', () => finish(on.closed(connected)));
  });
}
