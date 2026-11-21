/**
 * Signing in to a server once, for “Add a server” (docs/decisions/server-signin.md SI-02…SI-05; server-signin-server.md
 * SI-S02, SI-S03): the same destination rule, dialling and SHA-1-free algorithms as the Vault's connections
 * (`ssh.ts`), but with a password (ssh2's `password`, then `keyboard-interactive` answering every prompt with it) or a
 * Vault key, and OpenSSH's `accept-new` for the host key: a server the person's Vault knows with a trusted key must
 * show one of those keys — else nothing is sent — and any other server's key is taken as it is and reported.
 *
 * The password lives in the auth handler's closure only while ssh2 signs in; nothing here logs, throws or returns it.
 */
import type { VaultSshHostKey } from '@whombat/core';
import ssh2, {
  type AnyAuthMethod,
  type Client,
  type ConnectConfig,
  type KeyboardInteractiveAuthMethod,
  type PasswordAuthMethod,
  type PublicKeyAuthMethod,
} from 'ssh2';
import type { Services } from '../services';
import { VAULT_SSH_KEEPALIVE_MS } from './limits';
import { clientKey, dial, hostKeyOf, SSH_ALGORITHMS, SshFailure, sshDeadlineMs, sshDestination } from './ssh';

const { Client: SshClient } = ssh2;

export interface SignInTarget {
  /** The host as typed and checked (`parseVaultSshHost`'s canonical form). */
  host: string;
  port: number;
  username: string;
}

export type SignInAuth = { password: string } | { privateKey: string };

export interface SignedIn {
  client: Client;
  hostKey: VaultSshHostKey;
  /** First contact (no trusted key for this host and port): the key was taken as shown (SI-04). */
  hostKeyNew: boolean;
}

/** ssh2's auth methods for a password: `password`, then `keyboard-interactive` with the password for every prompt. */
function passwordMethods(username: string, password: string): AnyAuthMethod[] {
  const plain: PasswordAuthMethod = { type: 'password', username, password };
  const interactive: KeyboardInteractiveAuthMethod = {
    type: 'keyboard-interactive',
    username,
    prompt: (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password)),
  };
  return [plain, interactive];
}

/**
 * Opens one connection and signs in. Throws `SshFailure`: `not_allowed` (the destination rule's reason), `unreachable`,
 * `timeout`, `bad_answer`, `host_key_changed` (with the key it showed; nothing was sent), `rejected` (the user name,
 * password or key wasn't taken).
 */
export async function openSshSignIn(
  services: Services,
  target: SignInTarget,
  auth: SignInAuth,
  options: { pins: readonly VaultSshHostKey[]; deadlineMs?: number },
): Promise<SignedIn> {
  const deadlineMs = options.deadlineMs ?? sshDeadlineMs(services);
  const started = Date.now();
  const { problem, addresses } = await sshDestination(services, target.host, target.port, 'save');
  if (problem) throw new SshFailure('not_allowed', problem.message);
  const address = addresses[0];
  if (!address) throw new SshFailure('unreachable');
  const methods: AnyAuthMethod[] =
    'password' in auth
      ? passwordMethods(target.username, auth.password)
      : [
          {
            type: 'publickey',
            username: target.username,
            key: clientKey(auth.privateKey),
          } as PublicKeyAuthMethod,
        ];
  const pinned = new Set(options.pins.map((p) => p.fingerprint));
  const socket = await dial(services, address, target.port, deadlineMs);
  const left = Math.max(1, deadlineMs - (Date.now() - started));
  const client = new SshClient();
  let shown: VaultSshHostKey | null = null;
  let refusedKey = false;
  // The methods the server says it takes, once it refused one: a password card tells “doesn't take passwords” apart.
  let offered: string[] | null = null;
  const queue = [...methods];
  const authHandler = (
    left: string[] | null,
    _partial: boolean | null,
    next: (m: AnyAuthMethod | false) => void,
  ) => {
    if (left) offered = [...left];
    for (let m = queue.shift(); m; m = queue.shift()) if (!left || left.includes(m.type)) return next(m);
    return next(false);
  };
  const refused = () => {
    const failure = new SshFailure('rejected', 'rejected', shown);
    failure.offered = offered;
    return failure;
  };
  return new Promise<SignedIn>((resolve, reject) => {
    let settled = false;
    const finish = (err: SshFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        client.end();
        socket.destroy();
        reject(err);
      } else resolve({ client, hostKey: shown as VaultSshHostKey, hostKeyNew: pinned.size === 0 });
    };
    const timer = setTimeout(() => finish(new SshFailure('timeout')), left);
    client.on('ready', () => finish(null));
    client.on('error', (err: Error & { level?: string }) => {
      if (settled) return;
      if (refusedKey) return finish(new SshFailure('host_key_changed', 'host key', shown));
      if (err.level === 'client-authentication' || /authentication methods failed/i.test(err.message))
        return finish(refused());
      if (err.level === 'client-timeout') return finish(new SshFailure('timeout'));
      if (err.level === 'client-socket' || err.level === 'client-dns')
        return finish(new SshFailure('unreachable'));
      finish(shown ? refused() : new SshFailure('bad_answer'));
    });
    client.on('close', () =>
      finish(
        refusedKey
          ? new SshFailure('host_key_changed', 'host key', shown)
          : shown
            ? refused()
            : new SshFailure('unreachable'),
      ),
    );
    const verifier = (blob: Buffer): boolean => {
      shown = hostKeyOf(blob);
      // accept-new (SI-04): no trusted key here, take it; a trusted one must match before anything is sent.
      if (pinned.size === 0 || pinned.has(shown.fingerprint)) return true;
      refusedKey = true;
      return false;
    };
    client.connect({
      sock: socket,
      username: target.username,
      hostVerifier: verifier as ConnectConfig['hostVerifier'],
      authHandler: authHandler as ConnectConfig['authHandler'],
      algorithms: SSH_ALGORITHMS as unknown as ConnectConfig['algorithms'],
      readyTimeout: left,
      keepaliveInterval: VAULT_SSH_KEEPALIVE_MS,
      keepaliveCountMax: 3,
      ident: 'Whombat',
    });
  });
}
