import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installLinkSignature, parseRange } from './static-server.ts';

const SERVER = join(import.meta.dirname, 'static-server.ts');
const KEY_HEX = 'a1'.repeat(32);
const KEY = Buffer.from(KEY_HEX, 'hex');
const ISO = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const now = () => Math.floor(Date.now() / 1000);

function tree(): { dir: string; keyFile: string; outside: string } {
  const base = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'static-server-'));
  const dir = join(base, 'updates');
  mkdirSync(join(dir, 'metadata'), { recursive: true });
  mkdirSync(join(dir, 'install', '0.1.0'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'metadata', 'timestamp.json'), '{"signed":{}}');
  writeFileSync(join(dir, '.lock'), '');
  mkdirSync(join(dir, 'keys'));
  writeFileSync(join(dir, 'keys', 'root-0.json'), '{"private":"x"}');
  writeFileSync(join(dir, 'state.json'), '{}');
  mkdirSync(join(dir, 'targets', 'control'), { recursive: true });
  writeFileSync(join(dir, 'targets', 'control', 'assignment-keys.json'), '{}');
  writeFileSync(join(dir, 'install', '0.1.0', 'whombat.iso'), ISO);
  writeFileSync(join(dir, 'install', '0.1.0', 'SHA256SUMS'), 'abc  whombat.iso\n');
  writeFileSync(join(base, 'secret.txt'), 'outside the root');
  symlinkSync(join(dir, 'install', '0.1.0', 'whombat.iso'), join(dir, 'public', 'iso-link'));
  symlinkSync(join(base, 'secret.txt'), join(dir, 'public', 'escape'));
  const keyFile = join(base, 'install-link');
  writeFileSync(join(base, 'install-link'), `${KEY_HEX}\n`, { mode: 0o600 });
  return { dir, keyFile, outside: base };
}

async function start(
  dir: string,
  env: Record<string, string>,
): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [SERVER, dir, '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 10_000);
    const on = (d: Buffer) => {
      out += d.toString();
      const m = /on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m?.[1]) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    };
    child.stdout?.on('data', on);
    child.stderr?.on('data', on);
  });
  return { child, port };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A raw request: the path is sent exactly as given (fetch would normalize dot segments). */
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const link = (path: string, exp: number, key = KEY) =>
  `${path}?exp=${exp}&sig=${installLinkSignature(key, path, exp)}`;
const ISO_PATH = '/install/0.1.0/whombat.iso';

describe('update repository static server (IN-15, PI-06)', () => {
  let t: ReturnType<typeof tree>;
  let server: { child: ChildProcess; port: number };
  let keyless: { child: ChildProcess; port: number };
  let credentials: { child: ChildProcess; port: number };

  beforeAll(async () => {
    t = tree();
    server = await start(t.dir, { WHOMBAT_INSTALL_LINK_KEY_FILE: t.keyFile });
    keyless = await start(t.dir, {});
    // systemd LoadCredential: $CREDENTIALS_DIRECTORY/install-link
    credentials = await start(t.dir, { CREDENTIALS_DIRECTORY: t.outside });
  });
  afterAll(() => {
    for (const s of [server, keyless, credentials]) s?.child.kill();
  });

  it('serves repository files with ranges and HEAD, never dot files', async () => {
    const ts = await get(server.port, '/metadata/timestamp.json');
    expect(ts.status).toBe(200);
    expect(ts.headers['content-type']).toBe('application/json');
    expect(ts.headers['accept-ranges']).toBe('bytes');
    expect(ts.body.toString()).toBe('{"signed":{}}');
    const part = await get(server.port, '/metadata/timestamp.json', { range: 'bytes=2-7' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-7/13');
    expect(part.body.toString()).toBe('signed');
    const head = await get(server.port, '/metadata/timestamp.json', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('13');
    expect(head.body.length).toBe(0);
    expect((await get(server.port, '/.lock')).status).toBe(404);
    expect((await get(server.port, '/targets/control/assignment-keys.json')).status).toBe(200);
    // The development repository's signing keys and state sit next to the public tree (PI-13).
    expect((await get(server.port, '/keys/root-0.json')).status).toBe(404);
    expect((await get(server.port, '/state.json')).status).toBe(404);
    expect((await get(server.port, '/metadata/../keys/root-0.json')).status).toBe(404);
    expect((await get(server.port, '/metadata/missing.json')).status).toBe(404);
    expect((await get(server.port, '/metadata')).status).toBe(404);
    expect((await get(server.port, '/metadata/timestamp.json', {}, 'POST')).status).toBe(405);
  });

  it('serves a valid install link, with ranges', async () => {
    const r = await get(server.port, link(ISO_PATH, now() + 3600));
    expect(r.status).toBe(200);
    expect(r.body.equals(ISO)).toBe(true);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers['content-disposition']).toBe('attachment; filename="whombat.iso"');
    expect(r.headers['content-type']).toBe('application/x-iso9660-image');
    const sums = await get(server.port, link('/install/0.1.0/SHA256SUMS', now() + 60));
    expect(sums.status).toBe(200);
    expect(sums.headers['content-type']).toBe('text/plain; charset=utf-8');

    const url = link(ISO_PATH, now() + 3600);
    const mid = await get(server.port, url, { range: 'bytes=1000-1999' });
    expect(mid.status).toBe(206);
    expect(mid.headers['content-range']).toBe('bytes 1000-1999/5000');
    expect(mid.body.equals(ISO.subarray(1000, 2000))).toBe(true);
    const tail = await get(server.port, url, { range: 'bytes=4990-' });
    expect(tail.body.equals(ISO.subarray(4990))).toBe(true);
    const suffix = await get(server.port, url, { range: 'bytes=-10' });
    expect(suffix.headers['content-range']).toBe('bytes 4990-4999/5000');
    const bad = await get(server.port, url, { range: 'bytes=6000-' });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */5000');
    // A resumed download whose file changed gets the whole file (If-Range with a stale ETag).
    const stale = await get(server.port, url, { range: 'bytes=0-9', 'if-range': '"stale"' });
    expect(stale.status).toBe(200);
    const fresh = await get(server.port, url, { range: 'bytes=0-9', 'if-range': String(r.headers.etag) });
    expect(fresh.status).toBe(206);
  });

  it('answers 410 for a valid link that expired', async () => {
    const r = await get(server.port, link(ISO_PATH, now() - 5));
    expect(r.status).toBe(410);
    expect(r.body.length).toBe(0);
  });

  it('answers 404 for tampered, missing or foreign signatures', async () => {
    const exp = now() + 3600;
    const good = link(ISO_PATH, exp);
    const sig = installLinkSignature(KEY, ISO_PATH, exp);
    const cases = [
      ISO_PATH,
      `${ISO_PATH}?exp=${exp}`,
      `${ISO_PATH}?sig=${sig}`,
      `${ISO_PATH}?exp=${exp + 1}&sig=${sig}`,
      `${ISO_PATH}?exp=${exp}&sig=${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`,
      `${ISO_PATH}?exp=${exp}&sig=${sig.toUpperCase()}`,
      `${ISO_PATH}?exp=${exp}&sig=${sig}&x=1`,
      `${ISO_PATH}?exp=${exp}&exp=${exp}&sig=${sig}`,
      `/install/0.1.0/SHA256SUMS?exp=${exp}&sig=${sig}`,
      `/install/0.2.0/whombat.iso?exp=${exp}&sig=${sig}`,
      link(ISO_PATH, exp, Buffer.from('b2'.repeat(32), 'hex')),
      link('/install/0.1.0/missing.iso', exp),
      '/install/',
      '/install',
      '/install/0.1.0/',
    ];
    for (const path of cases) {
      const r = await get(server.port, path);
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect((await get(server.port, good)).status).toBe(200);
  });

  it('answers 404 under /install without a key, and reads the key from a systemd credential', async () => {
    expect((await get(keyless.port, link(ISO_PATH, now() + 3600))).status).toBe(404);
    expect((await get(keyless.port, link(ISO_PATH, now() - 5))).status).toBe(404);
    expect((await get(credentials.port, link(ISO_PATH, now() + 3600))).status).toBe(200);
  });

  it('refuses path traversal and encoded or symlinked ways into /install', async () => {
    const exp = now() + 3600;
    const sig = installLinkSignature(KEY, ISO_PATH, exp);
    const q = `?exp=${exp}&sig=${sig}`;
    const cases = [
      `/install/../install/0.1.0/whombat.iso${q}`,
      `/install/./0.1.0/whombat.iso${q}`,
      `/metadata/../install/0.1.0/whombat.iso`,
      `/metadata/../install/0.1.0/whombat.iso${q}`,
      `/%69nstall/0.1.0/whombat.iso${q}`,
      `/install/0.1.0/whombat%2eiso${q}`,
      `/install%2f0.1.0%2fwhombat.iso${q}`,
      '/public/iso-link',
      `/public/iso-link${q}`,
      '/public/escape',
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/metadata/%00',
      '/%E0%A4%A',
      `//install/0.1.0/whombat.iso${q}`,
    ];
    for (const path of cases) {
      const r = await get(server.port, path);
      expect([path, r.status]).toEqual([path, 404]);
      expect(r.body.length).toBe(0);
    }
  });

  it('prints install links that the server accepts', async () => {
    const exp = now() + 600;
    const out = execFileSync(
      process.execPath,
      [SERVER, 'install-link', '--key-file', t.keyFile, '--path', ISO_PATH, '--expires', String(exp)],
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe(link(ISO_PATH, exp));
    expect((await get(server.port, out)).status).toBe(200);
    expect(() =>
      execFileSync(
        process.execPath,
        [SERVER, 'install-link', '--key-file', t.keyFile, '--path', '/metadata/x', '--expires', '1'],
        {
          stdio: 'pipe',
        },
      ),
    ).toThrow();
  });

  it('parses single byte ranges and ignores the rest', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-4', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,3-4', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
  });
});
