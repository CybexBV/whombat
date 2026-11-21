/**
 * The installed AI client a turn runs (SUB-09, contracts 0.9.0 CT-72…CT-74): which Claude Code executable (DirectSDK's
 * model client), and on a managed appliance the digest it must have. Claude Code is the only one: ChatGPT runs on
 * Hermes's own loop with nothing installed (hermes-native.md HN-04, HN-A01); a Codex entry the manager still lists is
 * never resolved.
 *
 * - An operator-pinned executable (`WHOMBAT_CLAUDE_PATH` in the runner's own environment) wins: the host manages that
 *   client (`client.host_managed` for installs).
 * - Managed: the manager installs the clients and pushes their status to the runtime (`ClientsPushRequest`, admin
 *   socket); the server keeps the latest as `LocalClientsStatus` in `WHOMBAT_CLIENTS_FILE`, which the runner reads here.
 *   The runner runs exactly `installed.executable.path` — only if its realpath is inside the manager's install root
 *   (`WHOMBAT_CLIENTS_ROOT`) and out of the server's reach (SUB-45) — and checks its sha256 (the bundle's pin replaces
 *   the image's, CT-73). A provider the file doesn't list as installed refuses the turn (`client.not_installed`); a
 *   file that can't be read or parsed refuses it too (`client.status_unreadable`, SUB-46), never falling back.
 * - No clients file (development, tests): `providerExecutable`, the pinned Claude Code installed with Whombat, else
 *   the host's CLI on PATH (PV-01).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { LocalClientsStatus } from '@whombat/control-contracts/local';
import { providerExecutable } from './drift';

/** The AI clients this Whombat installs and runs: Claude Code alone (HN-04, HN-A01). */
export type ClientName = 'claude';

/**
 * The runtime's adapter level per client (`ClientAdapterLevel`, CT-73): how this build drives it. The manager picks
 * bundles tested with it; raise it when the way Whombat drives Claude Code changes in a way older tested bundles don't
 * cover. The latest tested job reads it from here (`appliance/release-tools/clients/bump-pins.mjs`).
 */
export const CLIENT_ADAPTER_LEVELS: Readonly<Record<ClientName, number>> = { claude: 1 };

/** The environment variable an operator pins a client's executable with. */
export const CLIENT_PATH_ENV: Readonly<Record<ClientName, 'WHOMBAT_CLAUDE_PATH'>> = {
  claude: 'WHOMBAT_CLAUDE_PATH',
};

export const CLIENT_NAMES: Record<ClientName, string> = { claude: 'Claude Code' };

/** Where a managed appliance's manager installs the clients (`WHOMBAT_CLIENTS_ROOT`'s default, SUB-45). */
export const DEFAULT_MANAGED_CLIENTS_ROOT = '/persist/whombat/clients';

export type ClientResolution =
  /**
   * Run this executable (sha256: the digest it must have, managed bundles only). A bundle's `path` is its realpath,
   * checked by `checkClientPath`; `missing`: the file the status names isn't there (the drift check says so,
   * `provider_missing`).
   */
  | {
      ok: true;
      source: 'pinned' | 'bundle';
      path: string;
      sha256: string | null;
      version: string | null;
      missing?: true;
    }
  /** Nothing installed by Whombat and no file says so: the provider's own default lookup. */
  | { ok: true; source: 'default'; path: null; sha256: null; version: null }
  | {
      ok: false;
      code: 'client.not_installed' | 'client.untrusted' | 'client.status_unreadable';
      message: string;
    };

export interface ClientResolverOptions {
  /** The runner's environment as it started (an operator's pins are read from it, never from a later change). */
  env: NodeJS.ProcessEnv;
  /** `WHOMBAT_CLIENTS_FILE` (managed): the manager's client status as the server last received it. */
  clientsFile?: string | undefined;
  /**
   * `WHOMBAT_CLIENTS_ROOT` (managed; default `/persist/whombat/clients`): where the manager installs clients. A bundle
   * the clients file names runs only if its realpath is inside it (SUB-45, review CLI-1); without one, none runs.
   */
  clientsRoot?: string | undefined;
}

/** What a turn needs to say when its client isn't installed. */
export function clientNotInstalledText(provider: ClientName): string {
  return `${CLIENT_NAMES[provider]} isn’t installed on this Whombat yet, so I can’t work on it. You can install it in Settings → AI.`;
}

function untrustedText(provider: ClientName, detail: string): string {
  return `The ${CLIENT_NAMES[provider]} this Whombat was told to run isn’t one its client installer put in place (${detail}), so I can’t work on it.`;
}

function unreadableText(provider: ClientName): string {
  return `This Whombat can’t read which ${CLIENT_NAMES[provider]} is installed right now, so I can’t work on it. Try again in a moment.`;
}

/**
 * The clients file: its status and who wrote it (the server, whose uid may own nothing on a client's path),
 * `missing` (not written yet: the image's runtime, SUB-25) or `unreadable` (a read error, not JSON, not the contract's
 * shape — refused, never a fallback: SUB-46, review CLI-4).
 */
type ClientsFileRead =
  | { kind: 'status'; status: LocalClientsStatus; writerUid: number }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

function parseClientsText(text: string, writerUid: number): ClientsFileRead {
  try {
    const parsed = LocalClientsStatus.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'status', status: parsed.data, writerUid } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

const readFailure = (err: unknown): ClientsFileRead =>
  (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };

async function readClientsFile(path: string): Promise<ClientsFileRead> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return parseClientsText(text, info.uid);
  } catch (err) {
    return readFailure(err);
  }
}

function readClientsFileSync(path: string): ClientsFileRead {
  try {
    return parseClientsText(readFileSync(path, 'utf8'), statSync(path).uid);
  } catch (err) {
    return readFailure(err);
  }
}

export type ClientPathCheck = { ok: true; real: string } | { ok: false; missing: boolean; problem: string };

const refused = (problem: string, missing = false): ClientPathCheck => ({ ok: false, missing, problem });

/**
 * Whether a client executable may run (SUB-45, review CLI-1): its realpath is a regular file inside the realpath of
 * `root`, and neither it nor any directory above it (up to `/`) can be changed by anyone but root, the root's owner
 * (the manager) or this process's user: each is owned by one of them — never by `untrustedUid` (the server, which
 * writes the clients file) — and none is writable by group or others, unless it lies below a directory nobody else
 * can enter or is a root-owned sticky directory (`/tmp`, where nobody renames another's entry). Only `realpath` follows
 * anything; the rest is lstat.
 */
export function checkClientPath(
  path: string,
  root: string | undefined,
  untrustedUid?: number,
): ClientPathCheck {
  if (!root || !isAbsolute(root)) return refused('no client install root is set');
  if (!isAbsolute(path)) return refused('not a full path');
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return refused('the client install root isn’t there');
  }
  try {
    real = realpathSync(path);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return refused(missing ? 'it isn’t there' : 'it can’t be looked at', missing);
  }
  if (!real.startsWith(realRoot === '/' ? '/' : `${realRoot}${sep}`))
    return refused('it isn’t in the client install root');
  const me = process.getuid?.() ?? -1;
  const trusted = new Set([0, me]);
  try {
    trusted.add(lstatSync(realRoot).uid);
  } catch {
    return refused('the client install root can’t be looked at');
  }
  const forbidden = untrustedUid !== undefined && untrustedUid !== me ? untrustedUid : null;
  const parts = real.split(sep).filter(Boolean);
  let current = '/';
  let enclosed = false;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) current = join(current, parts[i - 1] as string);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch {
      return refused(`${current} changed while it was checked`);
    }
    const last = i === parts.length;
    if (info.isSymbolicLink()) return refused(`${current} is a link`);
    if (last ? !info.isFile() : !info.isDirectory())
      return refused(`${current} isn’t a ${last ? 'file' : 'directory'}`);
    if (info.uid === forbidden || !trusted.has(info.uid))
      return refused(`${current} belongs to another user`);
    const stickyRootDir = !last && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!enclosed && (info.mode & 0o022) !== 0 && !stickyRootDir)
      return refused(`${current} can be changed by other users`);
    // Below a directory only its (trusted) owner can enter, nobody else reaches anything to change.
    if (!last && (info.mode & 0o011) === 0) enclosed = true;
  }
  return { ok: true, real };
}

/** A clients file's bundle for `provider`, checked (`checkClientPath`). */
function bundleResolution(
  provider: ClientName,
  read: Extract<ClientsFileRead, { kind: 'status' }>,
  root: string | undefined,
): ClientResolution {
  const client = read.status.clients.find((c) => c.provider === provider);
  if (!client?.installed)
    return { ok: false, code: 'client.not_installed', message: clientNotInstalledText(provider) };
  const { path, sha256 } = client.installed.executable;
  const version = client.installed.version;
  const checked = checkClientPath(path, root, read.writerUid);
  if (checked.ok) return { ok: true, source: 'bundle', path: checked.real, sha256, version };
  // Not there: the drift check reports it (the appliance reinstalls it); nothing ever runs from that path.
  if (checked.missing && root) return { ok: true, source: 'bundle', path, sha256, version, missing: true };
  return { ok: false, code: 'client.untrusted', message: untrustedText(provider, checked.problem) };
}

/** Which executable a turn of `provider` runs (see the module comment for the order). */
export async function resolveClient(
  provider: ClientName,
  options: ClientResolverOptions,
): Promise<ClientResolution> {
  const pinned = options.env[CLIENT_PATH_ENV[provider]]?.trim();
  if (pinned) return { ok: true, source: 'pinned', path: pinned, sha256: null, version: null };
  if (options.clientsFile) {
    const read = await readClientsFile(options.clientsFile);
    if (read.kind === 'status') return bundleResolution(provider, read, options.clientsRoot);
    if (read.kind === 'unreadable')
      return { ok: false, code: 'client.status_unreadable', message: unreadableText(provider) };
  }
  return { ok: true, source: 'default', path: null, sha256: null, version: null };
}

/**
 * The executable a sign-in (the Claude console) runs, synchronously: the resolved client's realpath
 * after the same checks a turn's gets — inside its root, out of the server's reach and, for a manager's bundle, with
 * the digest it was installed with (SUB-45) — or the provider's own default when Whombat installed none; null when it
 * should be installed and isn't, or may not run.
 */
export function clientCommandSync(provider: ClientName, options: ClientResolverOptions): string | null {
  const pinned = options.env[CLIENT_PATH_ENV[provider]]?.trim();
  if (pinned) return pinned;
  if (options.clientsFile) {
    const read = readClientsFileSync(options.clientsFile);
    if (read.kind === 'unreadable') return null;
    if (read.kind === 'status') {
      const r = bundleResolution(provider, read, options.clientsRoot);
      if (!r.ok || r.source !== 'bundle' || r.missing || !r.sha256) return null;
      return fileSha256Sync(r.path) === r.sha256 ? r.path : null;
    }
  }
  return providerExecutable(provider, options.env);
}

/** What a cached digest is keyed by: any change to the file (its ctime can't be set back) invalidates it. */
interface FileKey {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
const hashes = new Map<string, FileKey & { sha256: string }>();

const sameFile = (a: FileKey, b: FileKey) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

const keyOf = (info: FileKey): FileKey => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});

/**
 * sha256 of a file, cached by path, device, inode, size, modification and change time (a client binary is large;
 * turns are many). A file that changed while it was read has none. Callers hash a checked realpath just before it
 * runs (SUB-45).
 */
export async function fileSha256(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const hit = hashes.get(path);
  if (hit && sameFile(hit, info)) return hit.sha256;
  const sha256 = await new Promise<string | null>((resolve) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', () => resolve(null));
  });
  const after = await stat(path).catch(() => null);
  if (!sha256 || !after || !sameFile(info, after)) return null;
  hashes.set(path, { ...keyOf(info), sha256 });
  return sha256;
}

/** `fileSha256` for the synchronous sign-in path (same cache); hashed through one descriptor. */
export function fileSha256Sync(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) return null;
    const hit = hashes.get(path);
    if (hit && sameFile(hit, info)) return hit.sha256;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
    if (!sameFile(info, fstatSync(fd))) return null;
    const sha256 = hash.digest('hex');
    hashes.set(path, { ...keyOf(info), sha256 });
    return sha256;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
