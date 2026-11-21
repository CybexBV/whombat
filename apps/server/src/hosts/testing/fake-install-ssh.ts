/**
 * An in-process SSH server for “Add a server by signing in once” (server-signin-server.md SI-S11): ssh2's own `Server`
 * on 127.0.0.1, reached through `useVaultNetForTests` like the Vault's SSH fake. It signs people in with a password
 * (`password`, or `keyboard-interactive` when `passwordMethod` is off) or a public key in their `authorized`, and fakes
 * the few commands the install job runs: `id -u && uname -s`, on a Mac its version and who is at the screen
 * (`MAC_FACTS_COMMAND`), `sudo -n true`, `sudo -k -S -p '' true`, `mktemp`,
 * `cat > <file>`, the installer (`sh <file> --token - --control <level>`, as root, through `sudo -n` or `sudo -S`), `rm
 * -f <file>`, the SI-09 key command and `hostname -s` (vault-self-serve.md VS-09). A key line's options (`restrict …`)
 * are read past, as sshd does. The installer itself is the test's (`installer`): it gets the token and the
 * level from stdin and the command line as the real `install.sh` does, and answers what it prints.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import ssh2, { type Connection, type ServerChannel } from 'ssh2';
import { sshKeyPair } from '../../test/ssh-keys';
import { KEEP_KEY_COMMAND, MAC_FACTS_COMMAND } from '../install';

const { Server, utils } = ssh2;

export interface FakeInstallUser {
  /** Null: no password sign-in. */
  password: string | null;
  uid: number;
  /** How sudo treats them: no password, their password (or `sudoPassword`), not allowed, or no sudo at all. */
  sudo: 'nopasswd' | 'password' | 'refused' | 'missing';
  sudoPassword?: string;
  /** OpenSSH public key lines (`ssh-ed25519 AAAA…`): their `~/.ssh/authorized_keys`. */
  authorized: string[];
}

/** One run of the installer as the job started it. */
export interface FakeInstallRun {
  user: string;
  way: 'root' | 'sudo' | 'sudo_password';
  token: string;
  /** The level on the command line; empty when it had none (a repoint). */
  control: string;
  script: string;
}

export interface FakeInstallAnswer {
  stdout: string;
  stderr?: string;
  code: number;
}

export interface FakeInstallSsh {
  port: number;
  users: Map<string, FakeInstallUser>;
  /** What `uname -s` prints (`Darwin` for a Mac). */
  kernel: string;
  /** On a Mac: what `sw_vers -productVersion` prints and who `stat -f %Su /dev/console` says is at the screen. */
  macVersion: string;
  consoleUser: string;
  /** What `hostname -s` prints (vault-self-serve.md VS-09); null: no such command. */
  hostname: string | null;
  /** Offer the `password` method (off: only `keyboard-interactive` takes a password). */
  passwordMethod: boolean;
  files: Map<string, string>;
  /** Commands run, in order, and the stdin each got. */
  commands: { command: string; stdin: string; user: string }[];
  /** Sign-ins tried: user and method. */
  tries: { user: string; method: string }[];
  runs: FakeInstallRun[];
  installer: (run: FakeInstallRun) => Promise<FakeInstallAnswer> | FakeInstallAnswer;
  hostKey(): { algorithm: string; fingerprint: string };
  rotateHostKey(): Promise<void>;
  close(): Promise<void>;
}

function fingerprintOf(publicLine: string): { algorithm: string; fingerprint: string } {
  const parsed = utils.parseKey(publicLine);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new Error('bad host key');
  return {
    algorithm: key.type,
    fingerprint: `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`,
  };
}

// `--control` is optional: a repoint leaves the agent's own lock as it is (backup-file.md BF-S36).
const INSTALL =
  /^(?:(sudo -n )|(sudo -k -S -p '' ))?sh (\/tmp\/tmp\.[A-Za-z0-9]+) --token -(?: --control (\w+))?$/;

/** An `authorized_keys` line's key (`ssh-ed25519 AAAA…`), past its options (`restrict`) and without its comment. */
function keyOfLine(line: string): string {
  const parts = line.trim().split(/\s+/);
  const at = parts.findIndex((p) => /^(ssh-|ecdsa-|sk-)/.test(p));
  return at < 0 ? '' : parts.slice(at, at + 2).join(' ');
}

export async function fakeInstallSsh(): Promise<FakeInstallSsh> {
  let host = sshKeyPair('ed25519');
  const fake = {
    users: new Map<string, FakeInstallUser>(),
    kernel: 'Linux',
    macVersion: '27.2.1',
    consoleUser: 'root',
    hostname: null,
    passwordMethod: true,
    files: new Map<string, string>(),
    commands: [],
    tries: [],
    runs: [],
    installer: () => ({ stdout: 'whombat-agent: other-whombat\n', code: 3 }),
  } as unknown as FakeInstallSsh;
  const clients = new Set<Connection>();
  const makeServer = () =>
    new Server({ hostKeys: [host.private] }, (client) => {
      // Answers at once rather than after Nagle's waits (the Vault's dial does the same under the test seam, TS-S02).
      (client as unknown as { setNoDelay(on: boolean): void }).setNoDelay(true); // ssh2 has it, its types don't
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('error', () => undefined);
      let who = '';
      client.on('authentication', (ctx) => {
        const user = fake.users.get(ctx.username);
        fake.tries.push({ user: ctx.username, method: ctx.method });
        const methods = [
          ...(fake.passwordMethod ? (['password'] as const) : []),
          'keyboard-interactive' as const,
          'publickey' as const,
        ];
        if (ctx.method === 'password' && fake.passwordMethod) {
          if (user?.password && ctx.password === user.password) {
            who = ctx.username;
            return ctx.accept();
          }
          return ctx.reject([...methods]);
        }
        if (ctx.method === 'keyboard-interactive') {
          ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
            if (user?.password && answers[0] === user.password) {
              who = ctx.username;
              ctx.accept();
            } else ctx.reject([...methods]);
          });
          return;
        }
        if (ctx.method === 'publickey') {
          const line = `${ctx.key.algo} ${ctx.key.data.toString('base64')}`;
          if (!user?.authorized.some((a) => keyOfLine(a) === line)) return ctx.reject([...methods]);
          if (!ctx.signature || !ctx.blob) return ctx.accept();
          const parsed = utils.parseKey(line);
          const key = Array.isArray(parsed) ? parsed[0] : parsed;
          if (!key || key instanceof Error || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)
            return ctx.reject();
          who = ctx.username;
          return ctx.accept();
        }
        ctx.reject([...methods]);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec();
            let stdin = '';
            stream.on('data', (d: Buffer) => {
              stdin += d.toString('utf8');
            });
            stream.on('end', () => {
              fake.commands.push({ command: info.command, stdin, user: who });
              void run(fake, who, info.command, stdin, stream);
            });
          });
        });
      });
    });
  let server = makeServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.hostKey = () => fingerprintOf(host.public);
  fake.rotateHostKey = async () => {
    host = sshKeyPair('ed25519');
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

async function run(
  fake: FakeInstallSsh,
  who: string,
  command: string,
  stdin: string,
  stream: ServerChannel,
): Promise<void> {
  const user = fake.users.get(who);
  const finish = (code: number, out = '', err = '') => {
    if (out) stream.write(out);
    if (err) stream.stderr.write(err);
    stream.exit(code);
    stream.end();
  };
  if (!user) return finish(1, '', 'no such user\n');
  const sudoWith = (given: string) => {
    if (user.sudo === 'missing') return { code: 127, err: 'sh: 1: sudo: not found\n' };
    if (user.sudo === 'nopasswd') return { code: 0, err: '' };
    if (given !== (user.sudoPassword ?? user.password))
      return {
        code: 1,
        err: 'Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n',
      };
    if (user.sudo === 'refused') return { code: 1, err: `${who} is not in the sudoers file.\n` };
    return { code: 0, err: '' };
  };
  if (command === 'id -u && uname -s') return finish(0, `${user.uid}\n${fake.kernel}\n`);
  if (command === MAC_FACTS_COMMAND)
    return fake.kernel === 'Darwin'
      ? finish(0, `${fake.macVersion}\n${fake.consoleUser}\n`)
      : finish(127, '', 'sh: 1: sw_vers: not found\nstat: illegal option -- f\n');
  if (command === 'hostname -s' && fake.hostname !== null) return finish(0, `${fake.hostname}\n`);
  if (command === 'sudo -n true') {
    if (user.sudo === 'missing') return finish(127, '', 'sh: 1: sudo: not found\n');
    if (user.sudo === 'nopasswd') return finish(0);
    return finish(1, '', 'sudo: a password is required\n');
  }
  if (command === "sudo -k -S -p '' true") {
    const s = sudoWith(stdin.split('\n')[0] ?? '');
    return finish(s.code, '', s.err);
  }
  if (command === 'mktemp') {
    const path = `/tmp/tmp.${randomBytes(5).toString('hex')}`;
    fake.files.set(path, '');
    return finish(0, `${path}\n`);
  }
  if (command.startsWith('cat > ')) {
    fake.files.set(command.slice(6), stdin);
    return finish(0);
  }
  if (command.startsWith('rm -f ')) {
    fake.files.delete(command.slice(6));
    return finish(0);
  }
  if (command === KEEP_KEY_COMMAND) {
    const line = stdin.split('\n')[0]?.trim() ?? '';
    if (line && !user.authorized.includes(line)) user.authorized.push(line);
    return finish(0);
  }
  const m = INSTALL.exec(command);
  if (m) {
    const way = m[1] ? 'sudo' : m[2] ? 'sudo_password' : 'root';
    const lines = stdin.split('\n');
    if (way === 'root' && user.uid !== 0) return finish(1, '', 'install.sh: run as root\n');
    if (way === 'sudo' && user.sudo !== 'nopasswd') return finish(1, '', 'sudo: a password is required\n');
    if (way === 'sudo_password') {
      const s = sudoWith(lines.shift() ?? '');
      if (s.code !== 0) return finish(s.code, '', s.err);
    }
    const script = fake.files.get(m[3] as string);
    if (script === undefined) return finish(127, '', `sh: 0: cannot open ${m[3]}: No such file\n`);
    const r: FakeInstallRun = { user: who, way, token: lines[0] ?? '', control: m[4] ?? '', script };
    fake.runs.push(r);
    try {
      const answer = await fake.installer(r);
      return finish(answer.code, answer.stdout, answer.stderr ?? '');
    } catch (err) {
      return finish(1, '', `install.sh: ${err instanceof Error ? err.message : 'failed'}\n`);
    }
  }
  finish(127, '', `${command.split(' ')[0]}: command not found\n`);
}
