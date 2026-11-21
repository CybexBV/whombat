// `commands-net.mjs`: the agent's commands' network (docs/decisions/one-person.md OP-07, OP-S105, OP-S106; interface I-4).
// It runs as the holder's payload, a long-lived bubblewrap sandbox of its own inside the pod (or an outsiders' task
// sandbox) with its own network and pid namespaces: every command joins them (`nsenter -U -n -p -m`), so what one
// command serves on 127.0.0.1 the next reaches, and a background job lives on in the holder's pid namespace after its
// command ended, until it is stopped or the holder (the pod) ends.
//
// There is no other way out: `127.0.0.1:<port>` here is bridged to the commands' proxy (`proxy`, a unix socket), which
// lets through what the wall allows; `127.0.0.1:20000…20099` (the agent's services, containers on this host, OP-19) are
// tunnelled through the same proxy to this host's loopback; `inbound` is the runner's way in (one line `<port>`, then the
// connection is piped to `127.0.0.1:<port>` here: the browser's DevTools, a preview).
//
// Configuration: the first argument, JSON `{proxy, inbound, port, services: [first, last] | null}`. Prints `ready` once
// it listens. Plain JavaScript with built-in modules only: it runs on the sandbox's pinned Node.
import { rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';

const config = JSON.parse(process.argv[2] ?? '{}');

function pipeBoth(a, b) {
  a.pipe(b);
  b.pipe(a);
  const done = () => {
    a.destroy();
    b.destroy();
  };
  for (const s of [a, b]) {
    s.on('error', done);
    s.on('close', done);
  }
}

function listen(server, where) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(where, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** A tunnel to `127.0.0.1:<port>` of this host through the proxy (`CONNECT`): the agent's services. */
function service(port) {
  return createServer((client) => {
    client.on('error', () => {});
    client.pause();
    const up = connect(config.proxy);
    up.on('error', () => client.destroy());
    up.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16 * 1024) up.destroy();
        return;
      }
      up.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, head.indexOf('\r\n')).toString('latin1'))) {
        client.destroy();
        up.destroy();
        return;
      }
      const rest = head.subarray(end + 4);
      if (rest.length) client.write(rest);
      pipeBoth(client, up);
      client.resume();
    };
    up.on('data', onData);
  });
}

try {
  const proxy = createServer((client) => pipeBoth(client, connect(config.proxy)));
  await listen(proxy, { host: '127.0.0.1', port: config.port });
  if (Array.isArray(config.services))
    for (let p = config.services[0]; p <= config.services[1]; p++) {
      const s = service(p);
      s.on('error', () => {});
      await listen(s, { host: '127.0.0.1', port: p }).catch(() => {});
    }
  if (config.inbound) {
    try {
      rmSync(config.inbound, { force: true });
    } catch {}
    const inbound = createServer((socket) => {
      socket.on('error', () => {});
      let head = '';
      const onData = (chunk) => {
        head += chunk.toString('latin1');
        const nl = head.indexOf('\n');
        if (nl < 0) {
          if (head.length > 16) socket.destroy();
          return;
        }
        socket.off('data', onData);
        const target = Number(head.slice(0, nl));
        if (!Number.isInteger(target) || target < 1 || target > 65535) return socket.destroy();
        const rest = Buffer.from(head.slice(nl + 1), 'latin1');
        const upstream = connect({ host: '127.0.0.1', port: target });
        if (rest.length) upstream.write(rest);
        pipeBoth(socket, upstream);
      };
      socket.on('data', onData);
    });
    inbound.on('error', () => {});
    await listen(inbound, config.inbound);
  }
} catch (err) {
  process.stderr.write(`commands-net: ${err.message}\n`);
  process.exit(1);
}
process.stdout.write('ready\n');
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
