/**
 * An in-process SSH server for the Vault's SSH tests (docs/decisions/vault.md VT-S05…VT-S11, VT-80…VT-82): ssh2's own
 * `Server` on 127.0.0.1, reached only through `useVaultNetForTests` (a virtual home-network address dialled at
 * 127.0.0.1). It signs in public keys from `authorized` (signature checked), runs a few fake commands on `exec`, keeps
 * an in-memory file system for SFTP, can change its host key, and records what clients asked for (PTYs, environment,
 * forwarding: never expected).
 *
 * Commands: `echo <text>`, `exit <n>`, `fail` (stderr + exit 1), `stdin` (echoes stdin), `sleep <s>`, `hold` (until
 * the channel closes), `stubborn` (never closes a channel again on this connection, even when the client closes it),
 * `big <bytes>`, `say` (prints `say`), `whoami`.
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import ssh2, { type Connection, type ServerChannel, type SFTPWrapper } from 'ssh2';
import { sshKeyPair } from '../../test/ssh-keys';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

export interface FakeSsh {
  port: number;
  /** OpenSSH public key lines (`ssh-ed25519 AAAA…`) that may sign in. */
  authorized: Set<string>;
  /** What `say` prints (a test puts an echo of the key here). */
  say: string;
  /**
   * A path whose SFTP `STAT` is answered with bytes that aren't an SFTP packet (as a `~/.bashrc` that prints from a
   * background job would), and no answer.
   */
  sftpGarbageAt: string | null;
  /** Leaves new session channels unanswered (neither opened nor refused). */
  ignoreSessions: boolean;
  /** Files by absolute path; folders are paths in `dirs`. */
  files: Map<string, Buffer>;
  modes: Map<string, number>;
  dirs: Set<string>;
  /** Commands run, in order. */
  commands: string[];
  /** Users signed in as. */
  users: string[];
  /** Anything a client asked for that Whombat never should (pty, env, x11, agent, forwarding, shell). */
  asked: string[];
  /** Connections open now. */
  open: number;
  /** Connections made. */
  connections: number;
  hostKey(): { algorithm: string; fingerprint: string };
  /** Shows another host key from now on (`type`: ed25519 by default). */
  rotateHostKey(type?: 'ed25519' | 'ecdsa' | 'rsa'): Promise<void>;
  close(): Promise<void>;
}

function makeHostKey(type: 'ed25519' | 'ecdsa' | 'rsa' = 'ed25519') {
  const pair =
    type === 'rsa'
      ? sshKeyPair('rsa', { bits: 2048 })
      : type === 'ecdsa'
        ? sshKeyPair('ecdsa', { bits: 256 })
        : sshKeyPair('ed25519');
  return pair;
}

function fingerprintOf(publicLine: string): { algorithm: string; fingerprint: string } {
  const parsed = utils.parseKey(publicLine);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new Error('bad host key');
  const blob = key.getPublicSSH();
  return {
    algorithm: key.type,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  };
}

function lineOf(algo: string, data: Buffer): string {
  return `${algo} ${data.toString('base64')}`;
}

export async function fakeSsh(): Promise<FakeSsh> {
  let host = makeHostKey();
  const fake = {
    authorized: new Set<string>(),
    say: 'nothing to say',
    sftpGarbageAt: null,
    ignoreSessions: false,
    files: new Map<string, Buffer>(),
    modes: new Map<string, number>(),
    dirs: new Set<string>(['/', '/srv', '/srv/app', '/home', '/home/deploy']),
    commands: [] as string[],
    users: [] as string[],
    asked: [] as string[],
    open: 0,
    connections: 0,
  } as FakeSsh;
  const clients = new Set<Connection>();
  const makeServer = () =>
    new Server({ hostKeys: [host.private] }, (client) => {
      // Answers at once rather than after Nagle's waits (the Vault's dial does the same under the test seam, TS-S02).
      (client as unknown as { setNoDelay(on: boolean): void }).setNoDelay(true); // ssh2 has it, its types don't
      clients.add(client);
      fake.open++;
      fake.connections++;
      client.on('close', () => {
        clients.delete(client);
        fake.open--;
      });
      client.on('error', () => undefined);
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
        const line = lineOf(ctx.key.algo, ctx.key.data);
        if (!fake.authorized.has(line)) return ctx.reject(['publickey']);
        if (!ctx.signature || !ctx.blob) return ctx.accept();
        const parsed = utils.parseKey(line);
        const key = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!key || key instanceof Error) return ctx.reject();
        if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
        fake.users.push(ctx.username);
        ctx.accept();
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          if (fake.ignoreSessions) return;
          const session = accept();
          for (const ev of ['pty', 'env', 'x11', 'auth-agent', 'shell', 'subsystem-other'] as const)
            session.on(ev as never, (_accept?: () => void, reject?: () => void) => {
              fake.asked.push(ev);
              reject?.();
            });
          session.on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec();
            fake.commands.push(info.command);
            runCommand(fake, info.command, stream);
          });
          session.on('sftp', (acceptSftp) => serveSftp(fake, acceptSftp()));
        });
      });
      client.on('tcpip', (_accept, reject) => {
        fake.asked.push('tcpip');
        reject();
      });
      client.on('request', (_accept, reject, name) => {
        fake.asked.push(String(name));
        reject?.();
      });
    });
  let server = makeServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.hostKey = () => fingerprintOf(host.public);
  fake.rotateHostKey = async (type) => {
    host = makeHostKey(type);
    // A new listener on the same port with the new key (ssh2 reads host keys when the server is made).
    for (const c of clients) c.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = makeServer();
    await new Promise<void>((resolve) => server.listen(fake.port, '127.0.0.1', resolve));
  };
  fake.close = async () => {
    for (const c of clients) c.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}

function runCommand(fake: FakeSsh, command: string, stream: ServerChannel): void {
  const [name, ...rest] = command.split(' ');
  const arg = rest.join(' ');
  let stdin = '';
  let closed = false;
  stream.on('data', (d: Buffer) => {
    stdin += d.toString('utf8');
  });
  stream.on('close', () => {
    closed = true;
  });
  const finish = (code: number) => {
    if (closed) return;
    stream.exit(code);
    stream.end();
  };
  switch (name) {
    case 'echo':
      stream.write(`${arg}\n`);
      finish(0);
      return;
    case 'exit':
      finish(Number(arg));
      return;
    case 'fail':
      stream.stderr.write('it went wrong\n');
      finish(1);
      return;
    case 'whoami':
      stream.write(`${fake.users.at(-1) ?? ''}\n`);
      finish(0);
      return;
    case 'say':
      stream.write(fake.say);
      finish(0);
      return;
    case 'stdin':
      stream.on('end', () => {
        stream.write(stdin);
        finish(0);
      });
      return;
    case 'sleep': {
      const timer = setTimeout(() => finish(0), Number(arg) * 1000);
      stream.on('close', () => clearTimeout(timer));
      return;
    }
    case 'hold':
      stream.write('holding\n');
      return;
    case 'stubborn': {
      // A server that ignores CHANNEL_CLOSE: ssh2 answers a client's close through the connection's protocol.
      const conn = stream as unknown as { _client: { _protocol: { channelClose(id: number): void } } };
      conn._client._protocol.channelClose = () => undefined;
      stream.write('not closing\n');
      return;
    }
    case 'big': {
      const n = Number(arg);
      const chunk = Buffer.alloc(64 * 1024, 'x');
      let sent = 0;
      while (sent < n) {
        const part = chunk.subarray(0, Math.min(chunk.length, n - sent));
        stream.write(part);
        sent += part.length;
      }
      stream.write('THE END');
      finish(0);
      return;
    }
    default:
      stream.stderr.write(`${name}: command not found\n`);
      finish(127);
      return;
  }
}

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function serveSftp(fake: FakeSsh, sftp: SFTPWrapper): void {
  const handles = new Map<number, { path: string; append: boolean }>();
  let next = 1;
  const handleOf = (buf: Buffer) => handles.get(buf.readUInt32BE(0));
  const attrsOf = (path: string) => {
    if (fake.dirs.has(path)) return { mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
    const file = fake.files.get(path);
    if (!file) return null;
    return {
      mode: S_IFREG | (fake.modes.get(path) ?? 0o644),
      uid: 0,
      gid: 0,
      size: file.length,
      atime: 0,
      mtime: 0,
    };
  };
  const abs = (p: string) => (p.startsWith('/') ? p : `/home/deploy/${p}`);
  sftp.on('OPEN', (reqid, filename, flags, attrs) => {
    const path = abs(filename);
    const mode = utils.sftp.flagsToString(flags) ?? 'r';
    if (fake.dirs.has(path)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (path.startsWith('/root')) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (mode.startsWith('r') && !fake.files.has(path)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (!mode.startsWith('r')) {
      if (!fake.files.has(path) || mode.startsWith('w')) {
        if (!fake.files.has(path) && attrs?.mode !== undefined) fake.modes.set(path, attrs.mode & 0o777);
        fake.files.set(
          path,
          mode.startsWith('a') ? (fake.files.get(path) ?? Buffer.alloc(0)) : Buffer.alloc(0),
        );
      }
    }
    const id = next++;
    handles.set(id, { path, append: mode.startsWith('a') });
    const h = Buffer.alloc(4);
    h.writeUInt32BE(id);
    sftp.handle(reqid, h);
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = handleOf(handle);
    const file = h ? fake.files.get(h.path) : undefined;
    if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (offset >= file.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, file.subarray(offset, Math.min(file.length, offset + length)));
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = handleOf(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const file = fake.files.get(h.path) ?? Buffer.alloc(0);
    const out = Buffer.alloc(Math.max(file.length, offset + data.length));
    file.copy(out);
    data.copy(out, offset);
    fake.files.set(h.path, out);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const h = handleOf(handle);
    if (h) handles.delete(handle.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  const stat = (reqid: number, path: string) => {
    if (fake.sftpGarbageAt !== null && abs(path) === fake.sftpGarbageAt) {
      // Raw bytes on the channel, outside SFTP's framing: “hell” reads as a 1.7 GB packet length.
      const raw = sftp as unknown as {
        _protocol: { channelData(id: number, data: Buffer): void };
        outgoing: { id: number };
      };
      raw._protocol.channelData(raw.outgoing.id, Buffer.from('hello from .bashrc\n'));
      return;
    }
    const attrs = attrsOf(abs(path));
    if (!attrs) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    sftp.attrs(reqid, attrs);
  };
  sftp.on('MKDIR', (reqid, filename) => {
    const path = abs(filename);
    if (path.startsWith('/root')) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (fake.dirs.has(path) || fake.files.has(path)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fake.dirs.add(path);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);
  sftp.on('FSTAT', (reqid, handle) => {
    const h = handleOf(handle);
    const attrs = h ? attrsOf(h.path) : null;
    if (!attrs) return sftp.status(reqid, STATUS_CODE.FAILURE);
    sftp.attrs(reqid, attrs);
  });
}
