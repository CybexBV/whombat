import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkSums,
  compareVersions,
  formatSums,
  nodeSatisfies,
  parseSums,
  ReleaseProblem,
  releaseArchiveLink,
  releaseFiles,
  releaseLinkAllowed,
  scanTree,
  verifyRelease,
  writeReleaseArchive,
} from './manifest';
import {
  extractTarGz,
  headerBlocks,
  safeEntryPath,
  symlinkStaysInside,
  TarGzWriter,
  UnsafeArchiveError,
} from './tar';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whombat-release-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Where a release keeps its only links: the embedded Postgres' library directory (BP-F12). */
const LIB = 'node_modules/@embedded-postgres/linux-x64/native/lib';

/** A small release tree: a launcher, a nested file with a long path, a library and its version link. */
function tree(root: string): void {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'whombat'), '#!/bin/sh\necho hi\n');
  chmodSync(join(root, 'bin', 'whombat'), 0o755);
  const deep = join(
    root,
    'node_modules',
    '@scope',
    'a-rather-long-package-name',
    'lib',
    'with',
    'many',
    'levels',
  );
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, `${'x'.repeat(80)}.js`), 'export {};\n');
  mkdirSync(join(root, LIB), { recursive: true });
  writeFileSync(join(root, LIB, 'libpq.so.5.17'), Buffer.alloc(3000, 7));
  symlinkSync('libpq.so.5.17', join(root, LIB, 'libpq.so.5'));
  writeFileSync(join(root, 'empty'), '');
}

/** A raw (uncompressed) archive with one entry, for the refusal tests. */
function rawArchive(entry: Parameters<typeof headerBlocks>[0], data = Buffer.alloc(0)): string {
  const pad = data.length % 512 ? Buffer.alloc(512 - (data.length % 512)) : Buffer.alloc(0);
  const file = join(dir, `evil-${Math.random().toString(36).slice(2)}.tar.gz`);
  writeFileSync(file, gzipSync(Buffer.concat([...headerBlocks(entry), data, pad, Buffer.alloc(1024)])));
  return file;
}

describe('tar', () => {
  it('round-trips files, modes, empty files, long paths and symlinks', async () => {
    const src = join(dir, 'src');
    tree(src);
    const out = join(dir, 'r.tar.gz');
    await writeReleaseArchive(src, out, 'top', 1_700_000_000);
    const entries = await extractTarGz(out, join(dir, 'x'), { allowLink: releaseArchiveLink });
    const root = join(dir, 'x', 'top');
    expect(readFileSync(join(root, 'bin', 'whombat'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
    expect(lstatSync(join(root, 'bin', 'whombat')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(root, LIB, 'libpq.so.5.17')).mode & 0o777).toBe(0o644);
    expect(readlinkSync(join(root, LIB, 'libpq.so.5'))).toBe('libpq.so.5.17');
    expect(readFileSync(join(root, 'empty'), 'utf8')).toBe('');
    const long = entries.find((e) => e.path.endsWith(`${'x'.repeat(80)}.js`));
    expect(long?.path.length).toBeGreaterThan(100);
    expect(long?.sha256).toBe(createHash('sha256').update('export {};\n').digest('hex'));
    expect(scanTree(root).map((e) => e.path)).toEqual(scanTree(src).map((e) => e.path));
  });

  it('is byte-for-byte reproducible', async () => {
    const src = join(dir, 'src');
    tree(src);
    await writeReleaseArchive(src, join(dir, 'a.tar.gz'), 'top', 1_700_000_000);
    await writeReleaseArchive(src, join(dir, 'b.tar.gz'), 'top', 1_700_000_000);
    expect(readFileSync(join(dir, 'a.tar.gz')).equals(readFileSync(join(dir, 'b.tar.gz')))).toBe(true);
  });

  it('refuses paths outside the destination and links that point out', async () => {
    expect(() => safeEntryPath('/etc/passwd')).toThrow(UnsafeArchiveError);
    expect(() => safeEntryPath('a/../../b')).toThrow(UnsafeArchiveError);
    expect(safeEntryPath('a/b/')).toBe('a/b');
    expect(symlinkStaysInside('a/b', '../c')).toBe(true);
    expect(symlinkStaysInside('a/b', '../../c')).toBe(false);
    expect(symlinkStaysInside('a/b', '/etc')).toBe(false);

    const out = rawArchive(
      { path: '../escape', type: 'file', mode: 0o644, size: 3, mtime: 0 },
      Buffer.from('bad'),
    );
    await expect(extractTarGz(out, join(dir, 'x1'))).rejects.toThrow(/unsafe path/);
    expect(existsSync(join(dir, 'escape'))).toBe(false);

    const link = rawArchive({
      path: 'l',
      type: 'symlink',
      mode: 0o777,
      size: 0,
      mtime: 0,
      linkname: '../../etc',
    });
    await expect(extractTarGz(link, join(dir, 'x2'), { allowLink: () => true })).rejects.toThrow(
      /points outside/,
    );
  });

  it('refuses to write through a symlink it unpacked', async () => {
    const file = join(dir, 'through.tar.gz');
    const w = new TarGzWriter(file, { mtime: 0 });
    await w.symlink('d', '.');
    await w.buffer('d/f', Buffer.from('x'));
    await w.finish();
    await expect(extractTarGz(file, join(dir, 'x'), { allowLink: () => true })).rejects.toThrow(
      /through a link/,
    );
  });

  it('unpacks links only where the kind of archive has them (BP-F12)', async () => {
    const link = (path: string, linkname: string) =>
      rawArchive({ path, type: 'symlink', mode: 0o777, size: 0, mtime: 0, linkname });
    // Backups and support bundles: none at all.
    await expect(extractTarGz(link('a', 'b'), join(dir, 'x1'))).rejects.toThrow(/a link it shouldn’t/);
    // Releases: the Postgres library links, each naming a file beside it.
    expect(releaseLinkAllowed(`${LIB}/libpq.so.5`, 'libpq.so.5.17')).toBe(true);
    expect(releaseLinkAllowed(`${LIB}/libpq.so.5`, '../lib/libpq.so.5.17')).toBe(false);
    expect(releaseLinkAllowed(`${LIB}/libpq.so.5`, '.')).toBe(false);
    expect(releaseLinkAllowed(`${LIB}/libpq.so.5`, 'libpq.so.5')).toBe(false);
    expect(releaseLinkAllowed('app/cli.mjs', 'server.mjs')).toBe(false);
    expect(releaseArchiveLink(`top/${LIB}/libpq.so.5`, 'libpq.so.5.17')).toBe(true);
    expect(releaseArchiveLink(`${LIB}/libpq.so.5`, 'libpq.so.5.17')).toBe(false);
    await expect(
      extractTarGz(link('top/app/x', 'cli.mjs'), join(dir, 'x2'), { allowLink: releaseArchiveLink }),
    ).rejects.toThrow(/a link it shouldn’t/);
  });

  it('notices a truncated archive and a damaged header', async () => {
    const src = join(dir, 'src');
    tree(src);
    await writeReleaseArchive(src, join(dir, 'ok.tar.gz'), 'top', 0);
    const full = readFileSync(join(dir, 'ok.tar.gz'));
    const { gunzipSync } = await import('node:zlib');
    const raw = gunzipSync(full);
    writeFileSync(join(dir, 'cut.tar.gz'), gzipSync(raw.subarray(0, 1536 + 100)));
    const opts = { allowLink: releaseArchiveLink };
    await expect(extractTarGz(join(dir, 'cut.tar.gz'), join(dir, 'x1'), opts)).rejects.toThrow(
      /truncated|ends in the middle/,
    );
    const bad = Buffer.from(raw);
    bad[10] = 0x41; // inside the first header's name: checksum no longer matches
    writeFileSync(join(dir, 'bad.tar.gz'), gzipSync(bad));
    await expect(extractTarGz(join(dir, 'bad.tar.gz'), join(dir, 'x2'), opts)).rejects.toThrow(
      /bad header checksum/,
    );
  });
});

describe('release manifest', () => {
  async function release(): Promise<string> {
    const root = join(dir, 'rel');
    tree(root);
    const manifest = {
      format: 1,
      name: 'whombat',
      version: '1.2.3',
      gitSha: 'a'.repeat(40),
      gitDirty: false,
      buildTime: '2026-09-24T00:00:00.000Z',
      node: '>=24',
      platform: 'linux',
      arch: 'x64',
      postgres: { package: '@embedded-postgres/linux-x64', version: '17.10.0-beta.17', major: 17 },
      claude: { bundled: false },
      schema: { latest: null, migrations: [] },
      files: await releaseFiles(root),
    };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    return root;
  }

  it('verifies an intact release', async () => {
    const root = await release();
    expect((await verifyRelease(root)).version).toBe('1.2.3');
  });

  it('names what changed, went missing or was added', async () => {
    const root = await release();
    appendFileSync(join(root, LIB, 'libpq.so.5.17'), 'x');
    rmSync(join(root, 'empty'));
    writeFileSync(join(root, 'extra.js'), '');
    rmSync(join(root, LIB, 'libpq.so.5'));
    symlinkSync('elsewhere', join(root, LIB, 'libpq.so.5'));
    const err = await verifyRelease(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseProblem);
    const text = (err as Error).message;
    expect(text).toMatch(/libpq\.so\.5\.17: size or mode differs/);
    expect(text).toMatch(/empty: missing/);
    expect(text).toMatch(/extra\.js: not in the manifest/);
    expect(text).toMatch(/libpq\.so\.5: not the link it should be/);
  });

  it('catches the same size with other bytes, and a lost execute bit', async () => {
    const root = await release();
    writeFileSync(join(root, LIB, 'libpq.so.5.17'), Buffer.alloc(3000, 8));
    chmodSync(join(root, 'bin', 'whombat'), 0o644);
    const text = ((await verifyRelease(root).catch((e: unknown) => e)) as Error).message;
    expect(text).toMatch(/libpq\.so\.5\.17: contents differ/);
    expect(text).toMatch(/bin\/whombat: size or mode differs/);
  });

  it('refuses a listed link a release doesn’t have, or one onto another link (BP-F12)', async () => {
    const root = await release();
    // A manifest that lists links outside the Postgres libraries (rewritten along with the tree).
    symlinkSync('whombat', join(root, 'bin', 'wb'));
    symlinkSync('libpq.so.5', join(root, LIB, 'libpq.so'));
    const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    m.files = await releaseFiles(root);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(m));
    const text = ((await verifyRelease(root).catch((e: unknown) => e)) as Error).message;
    expect(text).toMatch(/bin\/wb: a link a release doesn’t have/);
    expect(text).toMatch(/libpq\.so: a link a release doesn’t have/);
    expect(text).not.toMatch(/libpq\.so\.5:/);
  });

  it('SHA256SUMS: parse, format, check', async () => {
    const file = join(dir, 'whombat-1.2.3-linux-x64.tar.gz');
    writeFileSync(file, 'archive');
    const hash = createHash('sha256').update('archive').digest('hex');
    expect(await checkSums(file)).toBe('missing');
    writeFileSync(join(dir, 'SHA256SUMS'), formatSums(new Map([['whombat-1.2.3-linux-x64.tar.gz', hash]])));
    expect(await checkSums(file)).toBe('ok');
    writeFileSync(file, 'changed');
    expect(await checkSums(file)).toMatchObject({ expected: hash });
    expect(parseSums(`${hash} *a.tar.gz\nnot a line\n`)).toEqual(new Map([['a.tar.gz', hash]]));
  });

  it('orders versions, pre-releases first', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('checks the Node range', () => {
    expect(nodeSatisfies('>=24', '24.18.0')).toBe(true);
    expect(nodeSatisfies('>=24', 'v22.3.0')).toBe(false);
    expect(nodeSatisfies('>=24.5', '24.4.9')).toBe(false);
    expect(nodeSatisfies('^24', '24.0.0')).toBe(false);
  });
});
