// Build and pack every publishable package into dist-release/contracts/<version>/ with SHA256SUMS (MA-02), for the
// repositories that consume the contracts as release tarballs (control, the relay, the appliance).
//
//   pnpm contracts:release                 # from a clean tree; runs `pnpm check`, builds, packs, smoke-tests
//   pnpm contracts:release --skip-check    # skip biome/typecheck/tests (the smoke test still runs)
//   pnpm contracts:release --skip-smoke    # skip installing the tarballs into a scratch consumer
//   pnpm contracts:release --rebuild       # this commit's packages under their version although its tag is on the
//                                          # commit that was released: to compare with that release, never to vendor
//                                          # (the full validation of a box release rebuilds the contracts it ships with)
//
// Every artifact is built twice and must be byte-identical (CT-54); otherwise the release is removed and refused.
// The output directory is immutable: an existing dist-release/contracts/<version>/ is never overwritten.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishablePackages, repoRoot } from './lib/packages.ts';

const args = new Set(process.argv.slice(2));
const run = (cmd: string, argv: string[], cwd = repoRoot) =>
  execFileSync(cmd, argv, { cwd, stdio: 'inherit', env: process.env });
const capture = (cmd: string, argv: string[], cwd = repoRoot) =>
  execFileSync(cmd, argv, { cwd, encoding: 'utf8' }).trim();

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

const dirty = capture('git', ['status', '--porcelain']);
if (dirty) fail(`the working tree is not clean:\n${dirty}`);

const packages = publishablePackages();
if (packages.length === 0) fail('no publishable packages');
const versions = new Set(packages.map((p) => p.version));
if (versions.size !== 1)
  fail(`packages disagree on the version: ${packages.map((p) => `${p.name}@${p.version}`)}`);
const [version] = [...versions] as [string];

const commit = capture('git', ['rev-parse', 'HEAD']);
const tag = `contracts-v${version}`;
let tagCommit: string | undefined;
try {
  tagCommit = capture('git', ['rev-parse', `${tag}^{commit}`]);
} catch {
  tagCommit = undefined;
}
// A rebuild builds the commit a box release ships beside the release that was published from the tag's commit.
const rebuild = args.has('--rebuild') && tagCommit !== undefined && tagCommit !== commit;
if (tagCommit && tagCommit !== commit && !rebuild)
  fail(`${tag} points at ${tagCommit}, not HEAD ${commit} (--rebuild builds this commit to compare with it)`);

const outDir = join(repoRoot, 'dist-release', 'contracts', version);
if (existsSync(outDir)) fail(`${outDir} already exists; releases are immutable (bump the version)`);

if (!args.has('--skip-check')) run('pnpm', ['check']);

/**
 * Reproducible archives (CT-54): `git archive` of a tree object (never a commit: no pax header with the commit id),
 * entries in git tree order (sorted), every mtime `ARCHIVE_MTIME`, uid/gid 0, modes 0644/0755 (`tar.umask=0022`),
 * gzip from git's internal compressor without a timestamp. Anyone can rebuild the Go tarball from its unpacked files:
 * `git init -q && git add -A && git -c tar.umask=0022 archive --format=tar.gz --mtime=@499162500
 * --prefix=whombat-contracts-go/ $(git write-tree)` (docs/contracts/publishing.md).
 */
const ARCHIVE_MTIME = 499_162_500; // 1985-10-26T08:15:00Z, the fixed time pnpm pack also uses
const archiveTrees: Record<string, string> = {};
// The cross-language parts live under contracts/; the archives hold them under their own names, as before the move.
if (existsSync(join(repoRoot, 'contracts', 'go', 'go.mod')))
  archiveTrees.go = capture('git', ['rev-parse', 'HEAD:contracts/go']);
const neutral = ['schema', 'vectors'].filter((d) => existsSync(join(repoRoot, 'contracts', d)));
if (neutral.length > 0) {
  // A tree holding exactly `schema/` and `vectors/` (an unreferenced object; the working tree is untouched).
  const entries = neutral
    .map((d) => `040000 tree ${capture('git', ['rev-parse', `HEAD:contracts/${d}`])}\t${d}\n`)
    .join('');
  archiveTrees.schema = execFileSync('git', ['mktree'], {
    cwd: repoRoot,
    input: entries,
    encoding: 'utf8',
  }).trim();
}

function archive(tree: string, prefix: string, out: string) {
  run('git', [
    '-c',
    'tar.umask=0022',
    '-c',
    'tar.tar.gz.command=git archive gzip',
    'archive',
    '--format=tar.gz',
    `--mtime=@${ARCHIVE_MTIME}`,
    `--prefix=${prefix}`,
    '-o',
    out,
    tree,
  ]);
}

/** Builds every artifact into `dir`: the packed packages, the Go module, and the schema + vectors archive. */
function buildArtifacts(dir: string): string[] {
  // Only the contracts packages, each from an empty dist/.
  for (const pkg of packages) rmSync(join(pkg.dir, 'dist'), { recursive: true, force: true });
  run('pnpm', [...packages.flatMap((p) => ['--filter', p.name]), 'run', 'build']);
  mkdirSync(dir, { recursive: true });
  for (const pkg of packages) run('pnpm', ['pack', '--pack-destination', dir], pkg.dir);
  // The Go module and the language-neutral artifacts (JSON Schema, conformance vectors) for non-TS consumers.
  const extras: string[] = [];
  if (archiveTrees.go) {
    const file = `whombat-contracts-go-${version}.tar.gz`;
    archive(archiveTrees.go, 'whombat-contracts-go/', join(dir, file));
    extras.push(file);
  }
  if (archiveTrees.schema) {
    const file = `whombat-contracts-schema-${version}.tar.gz`;
    archive(archiveTrees.schema, `whombat-contracts-${version}/`, join(dir, file));
    extras.push(file);
  }
  return extras;
}

const extras = buildArtifacts(outDir);
const files = readdirSync(outDir)
  .filter((f) => f.endsWith('.tgz') || f.endsWith('.tar.gz'))
  .sort();
const expected = [...packages.map((p) => p.tarball), ...extras].sort();
if (JSON.stringify(files) !== JSON.stringify(expected))
  fail(`unexpected pack output ${files} (want ${expected})`);

// Build everything a second time from scratch and require identical bytes (reproducible artifacts, CT-54).
const again = mkdtempSync(join(tmpdir(), `whombat-contracts-${version}-`));
try {
  buildArtifacts(again);
  const differs = files.filter((f) => {
    const other = join(again, f);
    return !existsSync(other) || !readFileSync(join(outDir, f)).equals(readFileSync(other));
  });
  if (differs.length > 0) {
    rmSync(outDir, { recursive: true, force: true });
    fail(`artifacts are not reproducible (a second build differs): ${differs.join(', ')}`);
  }
} finally {
  rmSync(again, { recursive: true, force: true });
}
console.log(`release: ${files.length} artifacts rebuilt byte-identically`);
// Nothing the repository must never hold again is in what goes out (scripts/scan-artifacts.sh with the maintainers'
// guard list, which a release requires).
process.env.WHOMBAT_GUARDS_REQUIRED = '1';
run('bash', [join(repoRoot, 'scripts/scan-artifacts.sh'), ...files.map((f) => join(outDir, f))]);

const sums = files.map((f) => {
  const hex = createHash('sha256')
    .update(readFileSync(join(outDir, f)))
    .digest('hex');
  return { file: f, sha256: hex };
});
writeFileSync(join(outDir, 'SHA256SUMS'), sums.map((s) => `${s.sha256}  ${s.file}\n`).join(''));
writeFileSync(
  join(outDir, 'RELEASE.json'),
  `${JSON.stringify(
    {
      version,
      tag,
      commit,
      // Not the release: this commit built under the version of the release at `rebuildOf`.
      ...(rebuild ? { rebuildOf: tagCommit } : {}),
      packages: packages.map((p) => ({ name: p.name, file: p.tarball, subpaths: p.subpaths })),
      files: sums,
      reproducible: { archiveMtime: ARCHIVE_MTIME, trees: archiveTrees },
    },
    null,
    2,
  )}\n`,
);

if (!args.has('--skip-smoke')) run('pnpm', ['exec', 'tsx', 'contracts/scripts/smoke-consumer.ts', outDir]);

if (rebuild) {
  console.log(
    `\nRebuilt ${version} from ${commit} in ${outDir}: to compare with the release at ${tagCommit} (${tag}), not to vendor`,
  );
  process.exit(0);
}

const vendor = `vendor/whombat-contracts/${version}`;
console.log(`
Released ${version} from ${commit}${tagCommit ? ` (${tag})` : ` (tag it: git tag -a ${tag} -m "contracts ${version}")`}
Artifacts: ${outDir}

Consumer install (see docs/contracts/publishing.md; copy from this repository's ${outDir}):
  mkdir -p ${vendor} && cp ${outDir}/* ${vendor}/
  (cd ${vendor} && sha256sum -c SHA256SUMS)

  package.json dependencies (only the packages you use):
${packages.map((p) => `    "${p.name}": "file:${vendor}/${p.tarball}",`).join('\n')}

  pnpm-workspace.yaml (so transitive @whombat/* dependencies resolve to the same tarballs):
    overrides:
${packages.map((p) => `      '${p.name}': 'file:${vendor}/${p.tarball}'`).join('\n')}
`);
