// The init of a managed task's outer sandbox (docs/decisions/managed-sandbox.md MSB-03, MSB-07). It runs in
// bubblewrap's stage 1 — the task's own network namespace, as uid 0 of a user namespace that maps only the
// runner's uid (its capabilities count only inside that namespace) — and does two things before it starts
// the payload:
//
// 1. Bridges the runner's per-task unix sockets into the namespace as loopback services: the egress proxy
//    (`127.0.0.1:<proxyPort>`), the Whombat MCP endpoint (`127.0.0.1:<mcpPort>`), when the turn goes through the
//    burrow's AI gateway the runner's gateway forwarder (`<gatewayPort>`), when the turn has a browser the runner's
//    CDP relay to the agent's Chromium (`<browserPort>`), and a DNS resolver on
//    `127.0.0.1:53` (UDP) that answers A / AAAA through the runner's policy (`dns.sock`). There is no other
//    way out: the namespace has only loopback.
// 2. Starts the payload through bubblewrap's stage 2 — its own user and pid namespace, no capabilities,
//    `no_new_privs`, the seccomp filter (fd 3), the mounts the runner decided — which never sees the sockets.
//
// It exits with the payload's status. Plain JavaScript on purpose: it runs on the pinned Node with nothing else.
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { openSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));

function bridge(port, socketPath) {
  const server = createServer((client) => {
    const upstream = connect(socketPath);
    client.pipe(upstream);
    upstream.pipe(client);
    const done = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', done);
    upstream.on('error', done);
    client.on('close', done);
    upstream.on('close', done);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => resolve(server));
  });
}

// --- DNS: one question per packet, A / AAAA through the runner, everything else NOTIMP. ---
function parseQuestion(msg) {
  if (msg.length < 12) return null;
  const qd = msg.readUInt16BE(4);
  if (qd !== 1) return null;
  let i = 12;
  const labels = [];
  for (;;) {
    if (i >= msg.length) return null;
    const len = msg[i];
    if (len === 0) {
      i += 1;
      break;
    }
    if (len > 63 || i + 1 + len > msg.length) return null;
    labels.push(msg.subarray(i + 1, i + 1 + len).toString('latin1'));
    i += 1 + len;
  }
  if (i + 4 > msg.length) return null;
  return { name: labels.join('.'), qtype: msg.readUInt16BE(i), qclass: msg.readUInt16BE(i + 2), end: i + 4 };
}

function answerPacket(msg, q, rcode, addresses) {
  const question = msg.subarray(12, q.end);
  const answers = [];
  for (const a of addresses) {
    const v6 = a.includes(':');
    const rdata = Buffer.alloc(v6 ? 16 : 4);
    if (v6) {
      const [head, tail] = a.split('::');
      const h = head ? head.split(':') : [];
      const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
      const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
      groups.forEach((g, k) => {
        rdata.writeUInt16BE(Number.parseInt(g, 16), k * 2);
      });
    } else
      a.split('.').forEach((o, k) => {
        rdata[k] = Number(o);
      });
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(v6 ? 28 : 1, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(30, 6);
    rr.writeUInt16BE(rdata.length, 10);
    answers.push(rr, rdata);
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msg.readUInt16BE(0), 0);
  const rd = msg[2] & 0x01;
  header[2] = 0x80 | rd; // QR, RD copied
  header[3] = 0x80 | (rcode & 0x0f); // RA, rcode
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(addresses.length, 6);
  return Buffer.concat([header, question, ...answers]);
}

const RCODE = { ok: 0, nxdomain: 3, refused: 5 };

function askRunner(type, name) {
  return new Promise((resolve) => {
    const socket = connect(config.dnsSocket);
    let buf = '';
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${type} ${name}\n`));
    socket.on('data', (d) => {
      buf += d;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({ rcode: 'refused', addresses: [] });
      }
    });
    socket.on('error', () => {});
  });
}

function dnsServer() {
  const udp = createSocket('udp4');
  udp.on('message', async (msg, rinfo) => {
    const q = parseQuestion(msg);
    if (!q) return;
    let reply;
    if (q.qclass !== 1 || (q.qtype !== 1 && q.qtype !== 28)) reply = answerPacket(msg, q, 4, []);
    else {
      const res = await askRunner(q.qtype === 1 ? 'A' : 'AAAA', q.name);
      const rcode = RCODE[res.rcode] ?? 5;
      reply = answerPacket(msg, q, rcode, rcode === 0 ? res.addresses.slice(0, 16) : []);
    }
    udp.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(53, '127.0.0.1', () => resolve(udp));
  });
}

try {
  await bridge(config.proxyPort, config.proxySocket);
  if (config.mcpSocket) await bridge(config.mcpPort, config.mcpSocket);
  // The AI gateway (Whombat ai-gateway.md AIG-08): the CLI's model requests reach the runner's forwarder here.
  if (config.gatewaySocket) await bridge(config.gatewayPort, config.gatewaySocket);
  // The browser (Whombat hermes-engine.md HE-42): Hermes's CDP client reaches the runner's relay here.
  if (config.browserSocket) await bridge(config.browserPort, config.browserSocket);
  await dnsServer();
} catch (err) {
  process.stderr.write(`whombat sandbox: could not start the network bridges (${err.message})\n`);
  process.exit(125);
}

// The payload gets pipes of its own, relayed here, never this process's stdio: Node switches its own stdio to
// non-blocking, and inherited descriptors share that mode. A payload that doesn't retry EAGAIN (Codex's
// app-server) then loses its stdout on the first burst the runner doesn't read at once, and the turn hangs.
const seccomp = openSync(config.seccompFile, 'r');
const child = spawn(config.bwrap, config.stage2, {
  stdio: ['pipe', 'pipe', 'pipe', seccomp],
  env: config.env,
});
for (const stream of [process.stdin, process.stdout, process.stderr, child.stdin])
  stream.on('error', () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (err) => {
  process.stderr.write(`whombat sandbox: could not start the payload (${err.message})\n`);
  process.exit(126);
});
// `close`, not `exit`: the payload's last output is relayed and flushed before this process goes.
child.on('close', async (code, signal) => {
  const flushed = (stream) => new Promise((resolve) => stream.write('', () => resolve()));
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code ?? (signal ? 128 + 9 : 1));
});
