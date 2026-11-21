/**
 * SSH connections of the Vault's `ssh` entries (docs/decisions/vault.md VT-S01, VT-S05, VT-S06, VT-S08…VT-S10;
 * VT-D45…VT-D50). Whombat's server connects; nothing SSH-related reaches a runner or a sandbox.
 *
 * - **Where**: the server's host is resolved once (the Vault's resolver, `useVaultNetForTests` in tests), every address
 *   is checked with core's `vaultSshDestinationProblem` (public addresses on `WHOMBAT_VAULT_SSH_PORTS`, home-network
 *   addresses on a listed network and port, never loopback, link-local or metadata) against the list as it is now,
 *   and the socket dials the first checked address itself: ssh2 never resolves anything.
 * - **Who**: the host key the server shows is compared with the pinned fingerprint before anything is sent; a server
 *   without a pin, or with another key, is never signed in to (the caller learns which key it showed). The client
 *   key is signed with SHA-2 only, and the transport offers ssh2's defaults without SHA-1.
 * - **How long**: connect + sign-in within 30 s, keepalive every 15 s.
 * - **Exec** (the person's checks, `vault_add_server`, Servers' installs) without a PTY, environment or forwarding; stdout
 *   and stderr keep their last 256 KB each; a timeout closes the channel. Everything that comes back is checked whole
 *   for the private key (`holdsSshKey`) before it is cut; the caller withholds a hit. The agent's own SSH runs in its
 *   commands with the key they get in the person's turns (hermes-engine.md HE-43): the server relays nothing.
 */
import { isIP, connect as netConnect, type Socket } from 'node:net';
import {
  parseVaultSshHost,
  parseVaultSshPorts,
  VAULT_SSH_CONNECT_DEADLINE_MS,
  type VaultSshDestinationProblem,
  type VaultSshHostKey,
  vaultSshDestinationProblem,
  vaultSshFingerprintOfBlob,
} from '@whombat/core';
import ssh2, { type Client, type ClientChannel, type ConnectConfig, type PublicKeyAuthMethod } from 'ssh2';
import type { Services } from '../services';
import { VAULT_SSH_KEEPALIVE_MS } from './limits';
import { vaultNetOf } from './net';
import { startTail } from './scrub';
import { holdsSshKey, type SshKeyForms } from './ssh-keys';
import { destinationReach } from './store';

const { Client: SshClient, utils } = ssh2;

/* Where (VT-S06) ------------------------------------------------------------------------------------ */

/** The ports public servers may be reached on (`WHOMBAT_VAULT_SSH_PORTS`, default 22). */
export function sshPorts(services: Pick<Services, 'config'>): number[] {
  return parseVaultSshPorts(services.config.WHOMBAT_VAULT_SSH_PORTS) ?? [22];
}

/** The addresses a server's host resolves to now ([] when it doesn't; an IP host is its own address). */
export async function resolveSshHost(services: Services, host: string): Promise<string[]> {
  const parsed = parseVaultSshHost(host);
  if (!parsed) return [];
  if (parsed.hostKind !== 'name') return [parsed.host];
  try {
    return (await vaultNetOf(services).resolve(parsed.host)).map((a) => a.address);
  } catch {
    return [];
  }
}

/** Why a server may not be connected to now, or null; `addresses` are the ones checked (dial one of them). */
export async function sshDestination(
  services: Services,
  host: string,
  port: number,
  at: 'save' | 'call',
): Promise<{ problem: VaultSshDestinationProblem | null; addresses: string[] }> {
  const [addresses, reach] = await Promise.all([resolveSshHost(services, host), destinationReach(services)]);
  const problem = vaultSshDestinationProblem({
    host,
    port,
    resolved: addresses,
    ...reach,
    sshPorts: sshPorts(services),
    at,
  });
  return { problem, addresses };
}

/* Failures ------------------------------------------------------------------------------------------ */

/** How a connection failed, in our words (`VAULT_FAILURES`, VT-S10): never the server's. */
export type SshFailureReason =
  | 'timeout'
  | 'unreachable'
  | 'not_allowed'
  | 'rejected'
  | 'bad_answer'
  | 'host_key_unconfirmed'
  | 'host_key_changed'
  | 'busy';

export class SshFailure extends Error {
  constructor(
    readonly reason: SshFailureReason,
    message: string = reason,
    /** The host key the server showed, when it showed one. */
    readonly hostKey: VaultSshHostKey | null = null,
    /** That key's wire blob (for the commands' `known_hosts`, one-person.md OP-S109). */
    readonly hostKeyBlob: Buffer | null = null,
  ) {
    super(message);
    this.name = 'SshFailure';
  }

  /** A sign-in refused (`rejected`): the methods the server said it takes, when it said (a password card reads it). */
  offered: readonly string[] | null = null;
}

/** A host key blob as the person compares it: its algorithm and `SHA256:` fingerprint. */
export function hostKeyOf(blob: Buffer): VaultSshHostKey {
  const n = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const algorithm = blob.subarray(4, 4 + Math.min(n, 64)).toString('latin1') || 'unknown';
  return { algorithm, fingerprint: vaultSshFingerprintOfBlob(blob) };
}

/* Algorithms (VT-S09) ------------------------------------------------------------------------------- */

/**
 * ssh2's defaults without SHA-1 (VT-S09): no `ssh-rsa` or `ssh-dss` host keys, no SHA-1 key exchange, no `hmac-sha1`,
 * no compression. Every name is one ssh2 supports in pure JS (a unit test holds them to ssh2's own lists).
 */
export const SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group15-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group17-sha512',
    'diffie-hellman-group18-sha512',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
    'chacha20-poly1305@openssh.com',
  ],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
  compress: ['none'],
} as const;

/**
 * The client key, parsed, signing with SHA-2 only: an RSA key never signs `ssh-rsa` (SHA-1) — against a server that
 * offers nothing else, the sign-in fails as “The server refused the key.”.
 */
export function clientKey(privateKey: string) {
  const parsed = utils.parseKey(privateKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new SshFailure('rejected');
  const sign = key.sign.bind(key);
  (key as { sign: typeof key.sign }).sign = (data: Buffer, algo?: string) =>
    algo === 'sha1' ? new Error('SHA-1 signatures are off') : sign(data, algo);
  return key;
}

/* One connection ------------------------------------------------------------------------------------ */

export interface SshServerTarget {
  entryId: string;
  serverId: string;
  host: string;
  port: number;
  username: string;
  /** The trusted host key; null: nothing is signed in to (a check only reads the key). */
  pinned: VaultSshHostKey | null;
}

export interface OpenOptions {
  /** Sign in with this key (OpenSSH text); null: read the host key and stop. */
  privateKey: string | null;
  deadlineMs?: number;
}

export interface OpenedConnection {
  client: Client;
  hostKey: VaultSshHostKey;
  /** The host key's wire blob. */
  hostKeyBlob: Buffer | null;
}

/** Dials one checked address (mapped by the test seam), within the deadline. */
export function dial(services: Services, address: string, port: number, deadlineMs: number): Promise<Socket> {
  const net = vaultNetOf(services);
  const host = net.dialAddress ? net.dialAddress(address) : address;
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port, family: isIP(host) || undefined });
    if (net.noDelay) socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SshFailure('timeout'));
    }, deadlineMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new SshFailure('unreachable'));
    });
  });
}

/** The connect + sign-in deadline (30 s; tests shorten it through the Vault's network seam). */
export function sshDeadlineMs(services: Services): number {
  return vaultNetOf(services).deadlineMs ?? VAULT_SSH_CONNECT_DEADLINE_MS;
}

/** How long a channel closed at its timeout may take to close (`SSH_CLOSE_GRACE_MS`; tests shorten it, TS-S03). */
export function sshCloseGraceMs(services: Services): number {
  return vaultNetOf(services).closeGraceMs ?? SSH_CLOSE_GRACE_MS;
}

/**
 * Opens one connection: destination checked on the addresses it dials, host key read and compared with the pin, then
 * (with a key and a matching pin) signed in. Throws `SshFailure`: `not_allowed` (the destination, with core's message),
 * `host_key_unconfirmed` / `host_key_changed` (with the key it showed), `rejected`, `timeout`, `unreachable`,
 * `bad_answer`. With `privateKey: null` it answers the host key once the server showed it (and closes).
 */
export async function openSsh(
  services: Services,
  target: SshServerTarget,
  options: OpenOptions,
): Promise<OpenedConnection> {
  const deadlineMs = options.deadlineMs ?? sshDeadlineMs(services);
  const started = Date.now();
  const { problem, addresses } = await sshDestination(services, target.host, target.port, 'call');
  if (problem) throw new SshFailure('not_allowed', problem.message);
  const address = addresses[0];
  if (!address) throw new SshFailure('unreachable');
  const key = options.privateKey === null ? null : clientKey(options.privateKey);
  const socket = await dial(services, address, target.port, deadlineMs);
  const left = Math.max(1, deadlineMs - (Date.now() - started));
  const client = new SshClient();
  let shown: VaultSshHostKey | null = null;
  let shownBlob: Buffer | null = null;
  return new Promise<OpenedConnection>((resolve, reject) => {
    let settled = false;
    const finish = (err: SshFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        client.end();
        socket.destroy();
        reject(err);
      } else resolve({ client, hostKey: shown as VaultSshHostKey, hostKeyBlob: shownBlob });
    };
    const timer = setTimeout(() => finish(new SshFailure('timeout')), left);
    client.on('ready', () => finish(null));
    client.on('error', (err: Error & { level?: string }) => {
      if (settled) return;
      if (shown && !key)
        return finish(new SshFailure('host_key_unconfirmed', 'host key read', shown, shownBlob));
      if (shown && (!target.pinned || shown.fingerprint !== target.pinned.fingerprint))
        return finish(
          new SshFailure(target.pinned ? 'host_key_changed' : 'host_key_unconfirmed', 'host key', shown),
        );
      if (err.level === 'client-authentication' || /authentication methods failed/i.test(err.message))
        return finish(new SshFailure('rejected'));
      if (err.level === 'client-timeout') return finish(new SshFailure('timeout'));
      if (err.level === 'client-socket' || err.level === 'client-dns')
        return finish(new SshFailure('unreachable'));
      // A handshake that found no algorithm in common, a version line that isn't SSH, a broken packet.
      finish(new SshFailure(shown ? 'rejected' : 'bad_answer'));
    });
    client.on('close', () => finish(new SshFailure(shown ? 'rejected' : 'unreachable')));
    const verifier = (blob: Buffer): boolean => {
      shown = hostKeyOf(blob);
      shownBlob = Buffer.from(blob);
      // Read the key and stop: no pin, a probe, or another key than the pinned one.
      if (!key || !target.pinned) return false;
      return shown.fingerprint === target.pinned.fingerprint;
    };
    client.connect({
      sock: socket,
      username: target.username,
      hostVerifier: verifier as ConnectConfig['hostVerifier'],
      ...(key
        ? { authHandler: [{ type: 'publickey', username: target.username, key } as PublicKeyAuthMethod] }
        : {}),
      algorithms: SSH_ALGORITHMS as unknown as ConnectConfig['algorithms'],
      readyTimeout: left,
      keepaliveInterval: VAULT_SSH_KEEPALIVE_MS,
      keepaliveCountMax: 3,
      ident: 'Whombat_Vault',
    });
  });
}

/* Exec (VT-S08) ------------------------------------------------------------------------------------- */

/**
 * The last `max` bytes of a stream, checked whole as it arrives: every chunk is looked at together with the bytes
 * before it (enough for the longest form, whitespace and all), so a form split across chunks is still seen.
 */
export class CheckedTail {
  #tail = Buffer.alloc(0);
  #window = Buffer.alloc(0);
  total = 0;
  hit = false;

  constructor(
    private readonly max: number,
    private readonly forms: SshKeyForms,
  ) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    const overlap = 2 * this.forms.longest + 256;
    const window = Buffer.concat([this.#window, chunk]);
    if (!this.hit && holdsSshKey(window.toString('utf8'), this.forms)) this.hit = true;
    this.#window = window.subarray(Math.max(0, window.length - overlap));
    const keep = this.max + this.forms.longest;
    const tail = Buffer.concat([this.#tail, chunk]);
    this.#tail = tail.subarray(Math.max(0, tail.length - keep));
  }

  /**
   * The kept text: the last `max` bytes, without a leading part that ends a form; `cut` when more came. What is kept is
   * checked whole once more (VT-D57): a form spread wider than the overlap (whitespace after every character, tiny
   * chunks) is seen in the text that would be returned.
   */
  text(): { text: string; cut: boolean } {
    if (!this.hit && holdsSshKey(this.#tail.toString('utf8'), this.forms)) this.hit = true;
    const cut = this.total > this.max;
    const bytes = this.#tail.subarray(Math.max(0, this.#tail.length - this.max));
    let text = bytes.toString('utf8');
    if (cut) {
      // A character split by the cut decodes as U+FFFD: drop it.
      if (text.startsWith('�')) text = text.slice(1);
      text = dropFormHead(text, this.forms);
    }
    return { text, cut };
  }
}

const reverse = (s: string) => [...s].reverse().join('');

/**
 * The shortest part of a form a cut edge drops (VT-D59). The edges of what is returned are only ever coincidences:
 * a read takes more than the longest form on both sides and `exec` checks its whole stream, so a form a cut goes
 * through has already withheld the answer. Dropping every one- to seven-character coincidence lost characters from a
 * third of all partial reads (`B=` read as `=`); eight base64 characters can't match by chance.
 */
export const SSH_FORM_EDGE_MIN = 8;

/** A text without a leading part that is the end of a form (the mirror of a cut's tail, VT-D20). */
export function dropFormHead(text: string, forms: SshKeyForms): string {
  const reversed = reverse(text);
  const head = [...forms.forms, ...forms.aligned].reduce(
    (n, f) => Math.max(n, startTail(reversed, reverse(f))),
    0,
  );
  return head >= SSH_FORM_EDGE_MIN ? text.slice(head) : text;
}

export interface ExecOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutCut: boolean;
  stderrCut: boolean;
  timedOut: boolean;
  /** Bytes that came on both streams. */
  bytes: number;
  /** The output held the key: withhold it all. */
  withheld: boolean;
}

/** How long a channel may take to close after Whombat closed it at a timeout before its connection is dropped. */
export const SSH_CLOSE_GRACE_MS = 5_000;

/**
 * One `exec` channel (no PTY, no environment), stdin sent and closed, stopped at `timeoutMs`. Bounded even against a
 * server that doesn't play along (VT-D56): a channel that isn't opened within `openMs` fails `timeout`, and one that
 * doesn't close within `graceMs` (default `SSH_CLOSE_GRACE_MS`) of its timeout answers what came so far — either way the connection is
 * ended (the pool forgets it), so neither the call, its slot nor the channel waits forever.
 */
export function sshExec(
  client: Client,
  input: {
    command: string;
    stdin?: string | undefined;
    timeoutMs: number;
    maxOutput: number;
    openMs: number;
    graceMs?: number;
    /**
     * Each chunk of stdout as it comes, before the channel ends. It is the server's raw output: only a caller that
     * picks out words it knows already (a program's fixed progress lines) may show any of it.
     */
    onStdout?: (chunk: Buffer) => void;
  },
  forms: SshKeyForms,
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    const opening = setTimeout(() => {
      if (opened || settled) return;
      settled = true;
      client.end();
      reject(new SshFailure('timeout'));
    }, input.openMs);
    client.exec(input.command, {}, (err, stream: ClientChannel) => {
      opened = true;
      clearTimeout(opening);
      if (settled) {
        stream?.close();
        return;
      }
      if (err) {
        settled = true;
        return reject(new SshFailure('unreachable'));
      }
      const out = new CheckedTail(input.maxOutput, forms);
      const errs = new CheckedTail(input.maxOutput, forms);
      let exitCode: number | null = null;
      let signal: string | null = null;
      let timedOut = false;
      let grace: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stream.signal('KILL');
        } catch {
          // Not every server takes signals; closing the channel ends it either way.
        }
        stream.close();
        // A server that never confirms the close: answer anyway and drop the connection.
        grace = setTimeout(() => {
          finish();
          client.end();
        }, input.graceMs ?? SSH_CLOSE_GRACE_MS);
      }, input.timeoutMs);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        const o = out.text();
        const e = errs.text();
        resolve({
          exitCode: timedOut ? null : exitCode,
          signal: timedOut ? null : signal,
          stdout: o.text,
          stderr: e.text,
          stdoutCut: o.cut,
          stderrCut: e.cut,
          timedOut,
          bytes: out.total + errs.total,
          withheld: out.hit || errs.hit,
        });
      };
      stream.on('data', (chunk: Buffer) => {
        out.push(chunk);
        try {
          input.onStdout?.(chunk);
        } catch {
          // What a caller does with progress never ends the command.
        }
      });
      stream.stderr.on('data', (chunk: Buffer) => errs.push(chunk));
      stream.on('exit', (code: number | null, sig?: string) => {
        if (typeof code === 'number') exitCode = Math.max(0, Math.min(255, code));
        if (typeof sig === 'string') signal = sig.replace(/^SIG/, '').slice(0, 32);
      });
      stream.on('close', finish);
      stream.on('error', () => undefined);
      // Nothing is forwarded, and stdin ends so a command reading it doesn't wait for more.
      if (input.stdin !== undefined && input.stdin !== '') stream.end(input.stdin);
      else stream.end();
    });
  });
}
