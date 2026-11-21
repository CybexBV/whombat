// `whombat-connect <host> <port>` in a command (docs/decisions/hermes-engine.md HE-S41): a TCP connection through the
// commands' proxy on stdin and stdout, for tools that don't speak to a proxy themselves. The commands' ssh config uses it
// as ssh's `ProxyCommand`, so ssh reaches what the commands' network rules allow.
//
// Plain JavaScript with built-in modules only: it runs on the commands' Node, bound read-only into their wrapper.
import { connect } from 'node:net';

const [host, port] = process.argv.slice(2);
if (!host || !/^\d{1,5}$/.test(port ?? '')) {
  process.stderr.write('usage: whombat-connect <host> <port>\n');
  process.exit(2);
}
const proxyPort = Number(process.env.WHOMBAT_PROXY_PORT || 3128);
const socket = connect({ host: '127.0.0.1', port: proxyPort });
socket.on('error', (err) => {
  process.stderr.write(`whombat-connect: ${err.message}\n`);
  process.exit(1);
});
const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
let head = Buffer.alloc(0);
const onData = (chunk) => {
  head = Buffer.concat([head, chunk]);
  const end = head.indexOf('\r\n\r\n');
  if (end < 0) {
    if (head.length > 16 * 1024) process.exit(1);
    return;
  }
  socket.off('data', onData);
  const status = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
  if (!/^HTTP\/1\.[01] 200/.test(status)) {
    const body = head
      .subarray(end + 4)
      .toString('utf8')
      .trim();
    process.stderr.write(`whombat-connect: ${body || status}\n`);
    process.exit(1);
  }
  const rest = head.subarray(end + 4);
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.on('close', () => process.exit(0));
};
socket.on('data', onData);
