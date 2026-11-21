/**
 * The runner's side of the server's sign-in socket (review I-1; docs/decisions/managed-runtime.md MR-34). Node can't
 * read a unix socket peer's credentials, so the runner checks the file system instead, before every request: the
 * path is a socket, its directory is no symlink and not writable by group or others, and the socket belongs to the
 * directory's owner (optionally a configured uid). Then only that user (or root) can have created it — the server,
 * never another local process — and the runner token and the secrets it relays go nowhere else.
 */
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { requestUnixHttp } from '@whombat/node-io/http';

export class SignInSocketUntrusted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInSocketUntrusted';
  }
}

/** Throws unless `path` is a socket its directory's owner created in a directory nobody else may write. */
export function verifySignInSocket(path: string, expectedUid?: number): void {
  let dir: ReturnType<typeof lstatSync>;
  let sock: ReturnType<typeof lstatSync>;
  try {
    dir = lstatSync(dirname(path));
    sock = lstatSync(path);
  } catch (err) {
    throw new SignInSocketUntrusted(`sign-in socket missing: ${(err as Error).message}`);
  }
  if (!dir.isDirectory())
    throw new SignInSocketUntrusted('the sign-in socket’s directory is not a directory');
  if ((dir.mode & 0o022) !== 0)
    throw new SignInSocketUntrusted('the sign-in socket’s directory is writable by others');
  if (!sock.isSocket()) throw new SignInSocketUntrusted('the sign-in socket is not a socket');
  if (sock.uid !== dir.uid)
    throw new SignInSocketUntrusted('the sign-in socket does not belong to its directory’s owner');
  if (expectedUid !== undefined && sock.uid !== expectedUid)
    throw new SignInSocketUntrusted('the sign-in socket does not belong to the server’s user');
}

/** A `fetch` for the sign-in routes over the verified socket (POST with a JSON body; what `SignInWorker` needs). */
export function signInSocketFetch(path: string, expectedUid?: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    verifySignInSocket(path, expectedUid);
    const url = new URL(String(input));
    const response = await requestUnixHttp({
      socketPath: path,
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal,
      // Poll batches can include account lists; leave ample room while bounding a broken server's answer.
      maxResponseBytes: 16 * 1024 * 1024,
    });
    return new Response(response.body, { status: response.status || 500 });
  }) as typeof fetch;
}
