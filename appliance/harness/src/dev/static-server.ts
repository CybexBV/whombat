/**
 * Serves a directory read-only over HTTP on loopback: the dev TUF repository's metadata and targets for the real
 * manager (IN-15) and the DEV instance's private ISO links. This is the development copy of the update service's
 * server: the production one (`whombat-updates` on the Hetzner host, HZ-15) is closed and lives in control's repository
 * (`src/updates/static-server.ts`, Whombat hermes-engine.md HE-63), where `deploy.sh updates` ships it from. Keep the
 * two in step.
 *
 *   node static-server.ts <dir> <port>
 *   node static-server.ts install-link --key-file F --path /install/<version>/<file> --expires <unix seconds>
 *
 * GET and HEAD, single byte ranges (`Range: bytes=…`, `If-Range`), dot files never served. Only `metadata/`,
 * `targets/` and `clients/` are public; `keys/`, `state.json` and anything else next to them answer 404.
 *
 * `/install/<version>/<file>` (the private ISO link, PI-06) is served only with `?exp=<unix>&sig=<hex>`, where sig is
 * HMAC-SHA256 over `whombat-install-link-v1\n<path>\n<exp>` keyed with the 32-byte key whose hex is in the key file:
 * `$WHOMBAT_INSTALL_LINK_KEY_FILE`, else `$CREDENTIALS_DIRECTORY/install-link` (systemd `LoadCredential=`). A valid
 * link past `exp` answers 410; everything else under `/install/` (no key, no or bad signature, other shapes,
 * encoded or dot segments, a missing file) answers 404. `install-link` prints `<path>?exp=…&sig=…`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, type Stats, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';

const LINK_CONTEXT = 'whombat-install-link-v1';
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._+-]{0,127}';
const INSTALL_PATH = new RegExp(`^/install/${SEGMENT}/${SEGMENT}$`);
/** The top-level directories served to anyone; everything else answers 404. */
const PUBLIC_DIRS = ['metadata', 'targets', 'clients'];

export function installLinkSignature(key: Buffer, path: string, exp: number): string {
  return createHmac('sha256', key).update(`${LINK_CONTEXT}\n${path}\n${exp}`).digest('hex');
}

/** The key (32 bytes or more, hex in the file), or null when there is none or it is malformed. */
export function readInstallLinkKey(file: string | undefined): Buffer | null {
  if (!file) return null;
  try {
    const hex = readFileSync(file, 'utf8').trim();
    if (!/^([0-9a-fA-F]{2}){32,}$/.test(hex)) return null;
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}

function keyFile(): string | undefined {
  if (process.env.WHOMBAT_INSTALL_LINK_KEY_FILE) return process.env.WHOMBAT_INSTALL_LINK_KEY_FILE;
  if (process.env.CREDENTIALS_DIRECTORY) return join(process.env.CREDENTIALS_DIRECTORY, 'install-link');
  return undefined;
}

const TYPES: Record<string, string> = {
  json: 'application/json',
  iso: 'application/x-iso9660-image',
  txt: 'text/plain; charset=utf-8',
};

function contentType(name: string): string {
  if (name === 'SHA256SUMS') return 'text/plain; charset=utf-8';
  return TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function end(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': '0', ...headers }).end();
}

type Range = { start: number; end: number } | 'unsatisfiable' | null;

/** A single `bytes=` range; anything else (several ranges, other units, junk) is ignored (a full answer). */
export function parseRange(header: string | undefined, size: number): Range {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || last < start) return 'unsatisfiable';
  return { start, end: last };
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  st: Stats,
  extra: Record<string, string>,
) {
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': contentType(file.split('/').pop() ?? ''),
    etag,
    'last-modified': st.mtime.toUTCString(),
    ...extra,
  };
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, st.size);
  if (range === 'unsatisfiable') {
    end(res, 416, { ...base, 'content-range': `bytes */${st.size}` });
    return;
  }
  const { start, end: last } = range ?? { start: 0, end: st.size - 1 };
  const length = st.size === 0 ? 0 : last - start + 1;
  const headers: Record<string, string> = { ...base, 'content-length': String(length) };
  if (range) headers['content-range'] = `bytes ${start}-${last}/${st.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end: last });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function handler(dir: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
  const root = realpathSync(resolve(dir));
  const installRoot = join(root, 'install');
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      end(res, 405, { allow: 'GET, HEAD' });
      return;
    }
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const rawPath = q < 0 ? url : url.slice(0, q);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      end(res, 404);
      return;
    }
    if (decoded.includes('\0') || !decoded.startsWith('/')) {
      end(res, 404);
      return;
    }
    const path = normalize(decoded);
    const file = join(root, path);
    const real = realOrNull(file);
    const isInstall =
      path === '/install' || path.startsWith('/install/') || (real !== null && within(real, installRoot));
    if (isInstall) {
      serveInstall(req, res, rawPath, q < 0 ? '' : url.slice(q + 1), installRoot, now);
      return;
    }
    // Only what a device fetches is public: the development repository keeps its signing keys and state next to
    // these (`keys/`, `state.json`), and they must never be served (PI-13).
    const top = path.split('/')[1] ?? '';
    const publicRoot = PUBLIC_DIRS.includes(top) ? join(root, top) : null;
    if (
      real === null ||
      publicRoot === null ||
      !within(real, realOrNull(publicRoot) ?? publicRoot) ||
      path.split('/').some((s) => s.startsWith('.'))
    ) {
      end(res, 404);
      return;
    }
    const st = statSync(real);
    if (!st.isFile()) {
      end(res, 404);
      return;
    }
    sendFile(req, res, real, st, {});
  };
}

/** The install file a request may have (PI-06), or the status to answer instead. */
export function checkInstallLink(
  rawPath: string,
  query: string,
  installRoot: string,
  key: Buffer | null,
  now: number,
): { file: string; st: Stats } | { status: 404 | 410 } {
  const notFound = { status: 404 } as const;
  // Only the exact canonical shape is signed: no percent-encoding, no dot segments, no extra parameters.
  if (!INSTALL_PATH.test(rawPath)) return notFound;
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (keys.length !== 2 || params.getAll('exp').length !== 1 || params.getAll('sig').length !== 1) {
    return notFound;
  }
  const exp = params.get('exp') ?? '';
  const sig = params.get('sig') ?? '';
  if (!/^[0-9]{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return notFound;
  if (!key) return notFound;
  const want = Buffer.from(installLinkSignature(key, rawPath, Number(exp)), 'hex');
  if (!timingSafeEqual(want, Buffer.from(sig, 'hex'))) return notFound;
  if (Number(exp) <= now) return { status: 410 };
  const real = realOrNull(join(installRoot, rawPath.slice('/install/'.length)));
  if (real === null || !within(real, installRoot)) return notFound;
  const st = statSync(real);
  if (!st.isFile()) return notFound;
  return { file: real, st };
}

function serveInstall(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  query: string,
  installRoot: string,
  now: () => number,
): void {
  const r = checkInstallLink(rawPath, query, installRoot, readInstallLinkKey(keyFile()), now());
  if ('status' in r) {
    end(res, r.status);
    return;
  }
  const name = rawPath.split('/').pop() ?? 'download';
  sendFile(req, res, r.file, r.st, {
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="${name}"`,
    'x-robots-tag': 'noindex',
  });
}

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  const v = i < 0 ? undefined : args[i + 1];
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

function main(argv: string[]): void {
  if (argv[0] === 'install-link') {
    const args = argv.slice(1);
    const key = readInstallLinkKey(flag(args, '--key-file'));
    const path = flag(args, '--path');
    const exp = Number(flag(args, '--expires'));
    if (!key) throw new Error('no usable key (64 hex characters or more) in the key file');
    if (!INSTALL_PATH.test(path)) throw new Error(`not an install path: ${path}`);
    if (!Number.isSafeInteger(exp) || exp <= 0) throw new Error('--expires must be unix seconds');
    process.stdout.write(`${path}?exp=${exp}&sig=${installLinkSignature(key, path, exp)}\n`);
    return;
  }
  const dir = argv[0] ?? '.';
  const port = Number(argv[1] ?? 0);
  const server = createServer(handler(dir));
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    process.stdout.write(`serving ${resolve(dir)} on 127.0.0.1:${p}\n`);
  });
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`static-server: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
