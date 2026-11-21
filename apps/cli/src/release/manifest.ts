/**
 * A release directory and its `manifest.json` (docs/decisions/bp-distribution.md BP-F01): every file with its
 * sha256, size and mode, every symlink with its target. `pnpm bundle:runtime` writes it (the appliance keeps it as
 * `share/whombat/release-manifest.json`); `verifyRelease` checks an unpacked bundle against it (nothing missing,
 * changed or extra).
 */
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { type ReleaseFile, ReleaseManifest } from '@whombat/core';
import { isRegularFile, TarGzWriter } from './tar';

export const MANIFEST = 'manifest.json';
export const SUMS = 'SHA256SUMS';

/**
 * The only symlinks a release has (docs/decisions/bp-distribution.md BP-F12): the embedded Postgres' shared
 * library version links (`pg-symlinks.json`: `libpq.so.5 -> libpq.so.5.17`, …), each naming a file in the same
 * directory. `path` is relative to the release root.
 */
export const RELEASE_LINK_DIR = /^node_modules\/@embedded-postgres\/linux-(?:x64|arm64)\/native\/lib\/[^/]+$/;
const LINK_TARGET = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function releaseLinkAllowed(path: string, target: string): boolean {
  return RELEASE_LINK_DIR.test(path) && LINK_TARGET.test(target) && target !== basename(path);
}

/** `releaseLinkAllowed` for a release archive, whose entries sit under `whombat-<version>-linux-<arch>/`. */
export function releaseArchiveLink(path: string, target: string): boolean {
  const slash = path.indexOf('/');
  return slash > 0 && releaseLinkAllowed(path.slice(slash + 1), target);
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

export interface TreeEntry {
  /** Relative, `/`-separated. */
  path: string;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
  target?: string;
}

/**
 * Everything under `root`, sorted by path (byte order, so every build lists them the same way). Only regular
 * files, directories and symlinks; anything else is an error.
 */
export function scanTree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink())
        out.push({ path, type: 'symlink', mode: 0o777, size: 0, target: readlinkSync(abs) });
      else if (st.isDirectory()) {
        out.push({ path, type: 'directory', mode: 0o755, size: 0 });
        walk(abs, path);
      } else if (st.isFile())
        out.push({ path, type: 'file', mode: st.mode & 0o111 ? 0o755 : 0o644, size: st.size });
      else throw new Error(`${abs}: not a file, directory or symlink`);
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The `files` of a manifest for the release in `root` (manifest.json itself left out). */
export async function releaseFiles(root: string): Promise<Record<string, ReleaseFile>> {
  const files: Record<string, ReleaseFile> = {};
  for (const e of scanTree(root)) {
    if (e.path === MANIFEST) continue;
    if (e.type === 'symlink') files[e.path] = { type: 'symlink', target: e.target as string };
    else if (e.type === 'file')
      files[e.path] = {
        type: 'file',
        sha256: await hashFile(join(root, e.path)),
        size: e.size,
        mode: e.mode,
      };
  }
  return files;
}

export function readManifest(root: string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  } catch (err) {
    throw new ReleaseProblem(`${root} has no readable ${MANIFEST} (${(err as Error).message})`);
  }
  const parsed = ReleaseManifest.safeParse(raw);
  if (!parsed.success)
    throw new ReleaseProblem(
      `${join(root, MANIFEST)} isn’t a Whombat release manifest: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

export class ReleaseProblem extends Error {
  override name = 'ReleaseProblem';
}

/** The link at `rel` names a regular file (not another link) that resolves inside `root`. */
function linkToFileInside(root: string, rel: string): boolean {
  try {
    const direct = join(root, dirname(rel), readlinkSync(join(root, rel)));
    if (lstatSync(direct).isSymbolicLink()) return false;
    const real = realpathSync.native(join(root, rel));
    return real.startsWith(`${realpathSync.native(root)}${sep}`) && isRegularFile(real);
  } catch {
    return false;
  }
}

/**
 * Checks the release in `root` against its manifest: every listed file present with its sha256, size and
 * mode, every symlink with its target, nothing else. Resolves with the manifest; throws `ReleaseProblem`
 * listing (up to ten) differences.
 */
export async function verifyRelease(root: string): Promise<ReleaseManifest> {
  const manifest = readManifest(root);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of scanTree(root)) {
    if (e.path === MANIFEST || e.type === 'directory') continue;
    seen.add(e.path);
    const want = manifest.files[e.path];
    if (!want) {
      problems.push(`${e.path}: not in the manifest`);
      continue;
    }
    if (want.type === 'symlink') {
      if (e.type !== 'symlink' || e.target !== want.target)
        problems.push(`${e.path}: not the link it should be`);
      else if (!releaseLinkAllowed(e.path, e.target) || !linkToFileInside(root, e.path))
        problems.push(`${e.path}: a link a release doesn’t have`);
      continue;
    }
    if (e.type !== 'file') {
      problems.push(`${e.path}: should be a file`);
      continue;
    }
    if (e.size !== want.size || e.mode !== want.mode) {
      problems.push(`${e.path}: size or mode differs`);
      continue;
    }
    if ((await hashFile(join(root, e.path))) !== want.sha256)
      problems.push(`${e.path}: contents differ (sha256)`);
  }
  for (const path of Object.keys(manifest.files)) if (!seen.has(path)) problems.push(`${path}: missing`);
  if (problems.length)
    throw new ReleaseProblem(
      `The release in ${root} doesn’t match its manifest (${problems.length} problem${problems.length > 1 ? 's' : ''}):\n  ${problems
        .slice(0, 10)
        .join('\n  ')}`,
    );
  return manifest;
}

/**
 * Packs the release in `root` as `<top>/…` into `out`: entries sorted, every time `mtime`, owner 0, modes
 * normalized — the same bytes for the same tree (BP-F01).
 */
export async function writeReleaseArchive(
  root: string,
  out: string,
  top: string,
  mtime: number,
): Promise<void> {
  const tar = new TarGzWriter(out, { mtime, level: 9 }, 0o644);
  try {
    await tar.directory(top);
    for (const e of scanTree(root)) {
      const path = `${top}/${e.path}`;
      if (e.type === 'directory') await tar.directory(path);
      else if (e.type === 'symlink') await tar.symlink(path, e.target as string);
      else await tar.file(path, join(root, e.path), e.mode);
    }
    await tar.finish();
  } catch (err) {
    tar.abort();
    throw err;
  }
}

/* SHA256SUMS ------------------------------------------------------------------------------------------ */

/** `sha256sum` format: `<hash>  <name>` per line. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(m[2] as string, m[1] as string);
  }
  return out;
}

export function formatSums(sums: Map<string, string>): string {
  return `${[...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, hash]) => `${hash}  ${name}`)
    .join('\n')}\n`;
}

/**
 * Checks `file` against the SHA256SUMS next to it. `missing`: no SHA256SUMS there, or the file isn't listed.
 */
export async function checkSums(
  file: string,
): Promise<'ok' | 'missing' | { expected: string; actual: string }> {
  let text: string;
  try {
    text = readFileSync(join(dirname(file), SUMS), 'utf8');
  } catch {
    return 'missing';
  }
  const expected = parseSums(text).get(basename(file));
  if (!expected) return 'missing';
  const actual = await hashFile(file);
  return actual === expected ? 'ok' : { expected, actual };
}

/* Versions ------------------------------------------------------------------------------------------- */

/** Compares two release versions (`1.2.3`, `1.2.3-rc.1`): negative when a < b. Pre-releases sort first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map((n) => Number(n)), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether Node `version` (e.g. `24.18.0`) satisfies a range of the form `>=24` / `>=24.1`. */
export function nodeSatisfies(range: string, version: string): boolean {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!m) return false;
  const want = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const have = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (have[i] ?? 0) - (want[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}
