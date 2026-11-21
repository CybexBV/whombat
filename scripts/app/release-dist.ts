/**
 * `pnpm app:release` — the app's build as one checksummed archive (docs/app/publishing.md): the page a box serves on
 * its direct ways (hermes-engine-app.md AP-5327; hermes-engine.md HE-50, direct-connection.md DC-08). The appliance builds the box's page from this repository's source itself; the archive is the same build as
 * a file, for a release record or a check from outside.
 *
 *   dist-release/app/<version>/whombat-app-dist-<version>.tar.gz   web/ (the box's own page)
 *   dist-release/app/<version>/SHA256SUMS                          sha256 of the archive
 *   dist-release/app/<version>/RELEASE.json                        version, commit, contracts, file hashes
 *
 * Deterministic: entries sorted by name, mtime fixed to the commit time, uid/gid 0, fixed modes, gzip without a
 * name or timestamp. Refuses a dirty tree (`--allow-dirty` for local trials, never for a pinned release) and an
 * existing version directory (immutable).
 *
 *   pnpm app:release                  version = apps/web/package.json version
 *   pnpm app:release --version 0.1.1
 *   pnpm app:release --skip-build     package the current apps/web/dist
 *
 * The operator panel is control's, which builds and deploys it. The Feedback widget is built and deployed on its
 * own (`pnpm build:widget`); no box serves it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..', '..');

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${r.status})`);
}

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(relative(dir, full).split('\\').join('/'));
      else throw new Error(`${full}: only regular files and directories are packaged`);
    }
  };
  visit(dir);
  return out.sort();
}

/* A minimal ustar writer: regular files and directories, fixed metadata. ------------------------------ */

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, type: '0' | '5', mtime: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100)
      throw new Error(`path too long for ustar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  buf.write(base, 0, 100, 'utf8');
  buf.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');
  buf.write(octal(0, 8), 116, 'ascii');
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(mtime, 12), 136, 'ascii');
  buf.fill(' ', 148, 156);
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write('root', 265, 32, 'ascii');
  buf.write('root', 297, 32, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

function tar(entries: { name: string; source: string | null }[], mtime: number): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.source === null) {
      parts.push(header(`${e.name}/`, 0, '5', mtime));
      continue;
    }
    const data = readFileSync(e.source);
    parts.push(header(e.name, data.length, '0', mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function main(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'apps/web/package.json'), 'utf8')) as { version: string };
  const version = values.version ?? pkg.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`bad version “${version}”`);
  const dirty = git('status', '--porcelain');
  if (dirty && !values['allow-dirty']) throw new Error(`the working tree is dirty:\n${dirty}`);
  const outRoot = resolve(values.out ?? join(ROOT, 'dist-release', 'app'));
  const outDir = join(outRoot, version);
  if (existsSync(outDir)) throw new Error(`${outDir} exists: releases are immutable`);

  if (!values['skip-build']) {
    // The box's own page: its own origin's direct socket, no control, no fixtures (AP-5322).
    run('pnpm', ['--filter', '@whombat/web', 'build:prod'], {
      VITE_WHOMBAT_TARGET: 'box',
      VITE_FIXTURES: '',
    });
  }
  const web = join(ROOT, 'apps/web/dist');
  if (!existsSync(join(web, 'index.html'))) throw new Error('apps/web/dist/index.html is missing');

  const entries: { name: string; source: string | null }[] = [];
  const addTree = (prefix: string, dir: string) => {
    const dirs = new Set<string>();
    const files = walk(dir);
    for (const f of files) {
      const segments = `${prefix}/${f}`.split('/');
      for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort()) entries.push({ name: d, source: null });
    for (const f of files) entries.push({ name: `${prefix}/${f}`, source: join(dir, f) });
  };
  addTree('web', web);
  // Directories first (sorted), then files (sorted).
  const seen = new Set<string>();
  const ordered = entries.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });

  const commitTime = Number(git('log', '-1', '--format=%ct'));
  const archive = gzipSync(tar(ordered, commitTime), { level: 9 });
  // gzip header: no name, mtime 0, OS "unknown" (Node already writes mtime 0; pin the OS byte too).
  archive[9] = 255;
  const name = `whombat-app-dist-${version}.tar.gz`;
  const hash = sha256(archive);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name), archive);
  writeFileSync(join(outDir, 'SHA256SUMS'), `${hash}  ${name}\n`);
  // Nothing the repository must never hold again is in the archive (scripts/scan-artifacts.sh with the maintainers'
  // guard list, which a release requires).
  execFileSync('bash', [join(ROOT, 'scripts/scan-artifacts.sh'), join(outDir, name)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, WHOMBAT_GUARDS_REQUIRED: '1' },
  });
  const contracts = [
    (JSON.parse(readFileSync(join(ROOT, 'packages/protocol/package.json'), 'utf8')) as { version: string })
      .version,
  ];
  writeFileSync(
    join(outDir, 'RELEASE.json'),
    `${JSON.stringify(
      {
        version,
        commit: git('rev-parse', 'HEAD'),
        dirty: Boolean(dirty),
        contracts,
        target: 'box',
        files: [{ file: name, sha256: hash, bytes: archive.length, entries: ordered.length }],
      },
      null,
      2,
    )}\n`,
  );
  const size = statSync(join(outDir, name)).size;
  process.stdout.write(
    `\n${join(outDir, name)}\n  sha256 ${hash}\n  ${size} bytes, ${ordered.length} entries\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`app:release: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
