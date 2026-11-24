/**
 * `pnpm bundle:runtime [--arch x64|arm64] [--out <dir>] [--version <v>]` (MR-37, NX-20): the managed appliance's
 * runtime bundle, as an archive and unpacked in the output directory (default `dist/`), for the appliance's Nix package
 * (hermes-engine.md HE-48: the appliance's is the only runtime shape) —
 *
 * ```
 * dist/whombat-runtime-<version>-linux-<arch>.tar.gz            the bundle (below), reproducible
 * dist/whombat-runtime-<version>-linux-<arch>.manifest.json     its manifest, also inside as manifest.json
 * dist/SHA256SUMS                                               sha256 of every archive and manifest in dist/
 * dist/SHA256SUMS.sig                                           with --sign-key <file>: its Ed25519 signature (BP-F20)
 * dist/whombat-runtime-<version>-linux-<arch>/                  the bundle, unpacked:
 *   bin/whombat                 the CLI (sh): node app/cli.mjs; the helper runs `schema-check` / `migrate` with it
 *   bin/whombat-server  bin/whombat-runner  bin/whombat-agent-net   the units' entry points (sh): node app/<name>.mjs
 *   app/cli.mjs server.mjs runner.mjs image-worker.mjs shots-worker.mjs onepassword-worker.mjs agent-net.mjs   esbuild
 *                               bundles (platform node, target node24, ESM)
 *   app/shim.mjs …              files the bundles open next to themselves (APP_FILES)
 *   migrations/                 the SQL migrations, their journal and compat.json
 *   node_modules/node-pty       what can't be bundled: the sign-in console's PTY with its native addon, and
 *   node_modules/@1password/…   1Password's SDK with its WASM core (the 1Password worker loads it)
 *   THIRD-PARTY-NOTICES.txt  LICENSE  manifest.json
 * ```
 *
 * The same commit gives the same bytes: pinned esbuild, sorted archive entries, every time set to
 * SOURCE_DATE_EPOCH (default: the commit's time), owner 0, normalized modes, no absolute paths of the build machine
 * (checked). `--verify-reproducible` builds twice and compares.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  formatSums,
  hashFile,
  MANIFEST,
  parseSums,
  releaseFiles,
  SUMS,
  SUMS_SIG,
  scanTree,
  signSums,
  writeReleaseArchive,
} from '@whombat/cli/release';
import { type ReleaseArch, ReleaseManifest, ReleaseVersion } from '@whombat/core';
import { readMigrations, schemaVersion } from '@whombat/server/host';
import * as esbuild from 'esbuild';
import { noticesText, packageDirOf } from './notices';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const MIGRATIONS_SRC = join(REPO_ROOT, 'apps', 'server', 'src', 'db', 'migrations');

/** Claude Code's npm platform packages (packages/agent-runtime providers/drift.ts resolves them): never bundled. */
const CLAUDE_CODE = '@anthropic-ai/claude-code';
/**
 * The sign-in console's PTY (SUB-20, MR-72): a native addon that finds itself relative to its own files, so it is
 * shipped as a package in node_modules, never bundled (bundled, every entry point failed at start).
 */
const NODE_PTY = 'node-pty';
/**
 * 1Password's SDK (docs/decisions/onepassword-sync.md OPW-30): CommonJS whose core reads its WASM file from beside
 * itself (`readFileSync(join(__dirname, 'core_bg.wasm'))`), so both packages are shipped in node_modules as they are,
 * never bundled. Only the 1Password worker loads them.
 */
export const ONEPASSWORD_SDK = ['@1password/sdk', '@1password/sdk-core'] as const;
export const ENTRIES = {
  cli: 'apps/cli/src/bin.ts',
  server: 'apps/server/src/index.ts',
  runner: 'apps/runner/src/index.ts',
  /** The feedback screenshot worker the server starts next to it (apps/server/src/feedback/image-pool.ts). */
  'image-worker': 'apps/server/src/feedback/image-worker.ts',
  /** The council's picture worker the server starts next to it (apps/server/src/council/shots-pool.ts). */
  'shots-worker': 'apps/server/src/council/shots-worker.ts',
  /** The 1Password worker the server starts as a process of its own (apps/server/src/vault/onepassword/pool.ts). */
  'onepassword-worker': 'apps/server/src/vault/onepassword/worker.ts',
  /** The commands' network (docs/decisions/one-person.md OP-S106): `whombat-agent-net`, under its own uid. */
  'agent-net': 'apps/agent-net/src/index.ts',
} as const;
/**
 * Files a bundle opens next to itself (`new URL('./<name>', import.meta.url)`), shipped as they are in `app/` (MR-77):
 * the managed sandbox's stage-1 shim, which the runner starts with Node inside the sandbox (built-in modules only).
 */
export const APP_FILES = {
  'shim.mjs': 'packages/agent-runtime/src/access/managed/shim.mjs',
  // A person's pod's payload (hermes-native.md HN-W01): Hermes's gateway, a spare `hermes acp`, the runner's socket.
  'pod-init.mjs': 'packages/agent-runtime/src/access/managed/pod-init.mjs',
  // The agent's commands (one-person.md OP-07): Hermes's terminal environment's launcher, the holder and its network,
  // a task sandbox's init; and the helpers every command has (the stand-in gh, git's GitHub transport, `whombat`,
  // `whombat-connect`, `whombat-askpass`). Every one runs on the sandbox's Node; commands see this folder read-only.
  'whombat-command.mjs': 'packages/commands/src/whombat-command.mjs',
  'commands-host.mjs': 'packages/commands/src/commands-host.mjs',
  'commands-init.mjs': 'packages/commands/src/commands-init.mjs',
  'commands-net.mjs': 'packages/commands/src/commands-net.mjs',
  'whombat-gh.mjs': 'packages/commands/src/whombat-gh.mjs',
  'whombat-git.mjs': 'packages/commands/src/whombat-git.mjs',
  'whombat-helper.mjs': 'packages/commands/src/whombat-helper.mjs',
  'whombat-connect.mjs': 'packages/commands/src/whombat-connect.mjs',
  'whombat-askpass.mjs': 'packages/commands/src/whombat-askpass.mjs',
  // What the helpers import from beside them: the git relay's frames and the one-line request to the runner.
  'frames.mjs': 'packages/commands/src/frames.mjs',
  'line-client.mjs': 'packages/commands/src/line-client.mjs',
  // Whombat's MCP tools for Hermes (hermes-engine.md HE-S28): the stdio bridge Hermes starts in the task sandbox.
  'mcp-bridge.mjs': 'packages/agent-runtime/src/hermes/mcp-bridge.mjs',
} as const;

/** Copies APP_FILES into `<app>` (the bundles' directory), 0644. */
export function copyAppFiles(app: string): void {
  for (const [name, src] of Object.entries(APP_FILES)) {
    copyFileSync(join(REPO_ROOT, src), join(app, name));
    chmodSync(join(app, name), 0o644);
  }
}

/**
 * First lines of every bundle: `require` for the CommonJS inside, the bundle's own file and directory for CommonJS that
 * reads `__filename` / `__dirname` at load (ssh2's agent module, vault.md VT-D42: free references are defined to these,
 * a module's own `__dirname` is left alone), and `WHOMBAT_APP_DIR` = the bundle it is in (server and runner find
 * migrations and no repository `.env` through it). No skills of Whombat's own: the agent's are Hermes's
 * (hermes-skills.md HSK-01).
 */
const BANNER = [
  "import { createRequire as __wbCreateRequire } from 'node:module';",
  "import { fileURLToPath as __wbFileURLToPath } from 'node:url';",
  "import { dirname as __wbDirname } from 'node:path';",
  'const require = __wbCreateRequire(import.meta.url);',
  'const __wbModuleFile = __wbFileURLToPath(import.meta.url);',
  'const __wbModuleDir = __wbDirname(__wbModuleFile);',
  'process.env.WHOMBAT_APP_DIR = __wbDirname(__wbDirname(__wbFileURLToPath(import.meta.url)));',
].join('\n');

/** esbuild options of one bundle (`app/<name>.mjs`). */
export function bundleOptions(
  entry: string,
  outfile: string,
  build: { version: string; gitSha: string; buildTime: string },
) {
  return {
    absWorkingDir: REPO_ROOT,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    external: [`${CLAUDE_CODE}-*`, NODE_PTY, ...ONEPASSWORD_SDK],
    banner: { js: BANNER },
    define: {
      __WHOMBAT_BUILD__: JSON.stringify(build),
      __filename: '__wbModuleFile',
      __dirname: '__wbModuleDir',
    },
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
  } satisfies esbuild.BuildOptions;
}

export interface BuildOptions {
  arch: ReleaseArch;
  out: string;
  version?: string;
  /** An Ed25519 private key (PEM) to sign SHA256SUMS with (`SHA256SUMS.sig`, BP-F20); unsigned without. */
  signKey?: string;
  log?: (line: string) => void;
}

export interface BuildResult {
  archive: string;
  manifest: ReleaseManifest;
  sha256: string;
  bytes: number;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Copies a file or tree with modes normalized to 0644 / 0755 (0755 when any execute bit is set). */
function copyNormalized(from: string, to: string, skip: (rel: string) => boolean = () => false): void {
  const st = lstatSync(from);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true, mode: 0o755 });
    chmodSync(to, 0o755);
    for (const name of readdirSync(from).sort()) {
      const rel = name;
      if (skip(rel)) continue;
      copyNormalized(join(from, name), join(to, name), (r) => skip(`${rel}/${r}`));
    }
  } else if (st.isSymbolicLink()) {
    throw new Error(`${from}: unexpected symlink`);
  } else if (st.isFile()) {
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    copyFileSync(from, to);
    chmodSync(to, st.mode & 0o111 ? 0o755 : 0o644);
  }
}

/** The directory of an installed package (resolved from `fromPkg`'s dependencies). */
function installedPackageDir(fromPkg: string, name: string): string | null {
  const req = createRequire(join(REPO_ROOT, fromPkg, 'package.json'));
  try {
    let dir = dirname(req.resolve(name));
    while (
      !existsSync(join(dir, 'package.json')) ||
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name
    ) {
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * node-pty for `arch` into `dest`: its package.json, license, JavaScript (no tests or source maps) and the addon
 * `build/Release/pty.node` that `pnpm install` built with node-gyp on this machine. For another arch there is no
 * addon to take: the release is built without it and only its sign-in console fails (it loads node-pty lazily).
 */
function addNodePty(arch: ReleaseArch, dest: string, log: (l: string) => void): void {
  const src = installedPackageDir('packages/agent-runtime', NODE_PTY);
  if (!src) throw new Error(`${NODE_PTY} isn’t installed (pnpm install)`);
  copyNormalized(join(src, 'package.json'), join(dest, 'package.json'));
  copyNormalized(join(src, 'LICENSE'), join(dest, 'LICENSE'));
  copyNormalized(join(src, 'lib'), join(dest, 'lib'), (rel) => /\.(map|test\.js)$/.test(rel));
  if (arch !== process.arch) {
    log(`${NODE_PTY}: no ${arch} addon (this machine builds ${process.arch}); the sign-in console needs one`);
    return;
  }
  const addon = join(src, 'build', 'Release', 'pty.node');
  if (!existsSync(addon))
    throw new Error(
      `${addon} is missing: pnpm install builds it with node-gyp (python3, make, a C++ compiler)`,
    );
  copyNormalized(addon, join(dest, 'build', 'Release', 'pty.node'));
}

/**
 * 1Password's SDK into `nm` (`node_modules`), flat, as `@1password/sdk` resolves `@1password/sdk-core` from there: each
 * package's package.json, readme and files (its JavaScript, type declarations and the core's WASM). The same for every
 * arch: the WASM runs anywhere Node does.
 */
export function addOnePasswordSdk(nm: string): void {
  for (const name of ONEPASSWORD_SDK) {
    const src =
      installedPackageDir('apps/server', name) ??
      (name === '@1password/sdk-core' ? sdkCoreBesideSdk() : null);
    if (!src) throw new Error(`${name} isn’t installed (pnpm install)`);
    copyNormalized(src, join(nm, name), (rel) => rel === 'node_modules' || rel.startsWith('node_modules/'));
  }
}

/** pnpm installs the core beside the SDK, not as one of the server's own dependencies. */
function sdkCoreBesideSdk(): string | null {
  const sdk = installedPackageDir('apps/server', '@1password/sdk');
  if (!sdk) return null;
  const req = createRequire(join(sdk, 'package.json'));
  try {
    return dirname(dirname(req.resolve('@1password/sdk-core')));
  } catch {
    return null;
  }
}

/** Fails the build when a text file of the release names the build machine's paths. */
function assertNoBuildPaths(root: string): void {
  const needles = [REPO_ROOT, process.env.HOME].filter((n): n is string => Boolean(n && n.length > 4));
  const offenders: string[] = [];
  for (const e of scanTree(root)) {
    if (
      e.type !== 'file' ||
      !/\.(m?js|json|html|css|md|txt)$/.test(e.path) ||
      e.path.startsWith('node_modules/')
    )
      continue;
    const text = readFileSync(join(root, e.path), 'utf8');
    if (needles.some((n) => text.includes(n))) offenders.push(e.path);
  }
  if (offenders.length)
    throw new Error(
      `These files name paths of the build machine (not reproducible):\n  ${offenders.join('\n  ')}`,
    );
}

/**
 * The manifest's `postgres` (required by the contract): the PostgreSQL the runtime runs on, the newest major the
 * migrations' compat.json supports (MD-03). Nothing of PostgreSQL is in the bundle: the appliance has its own (NX-18).
 */
export function runtimePostgres(): { package: string; version: string; major: number } {
  const compat = JSON.parse(readFileSync(join(MIGRATIONS_SRC, 'compat.json'), 'utf8')) as {
    postgres?: { majors?: number[] };
  };
  const major = Math.max(...(compat.postgres?.majors ?? []));
  if (!Number.isInteger(major)) throw new Error('compat.json names no PostgreSQL major (postgres.majors)');
  return { package: 'postgresql', version: String(major), major };
}

/**
 * `bin/<name>`: runs `app/<app>.mjs` of the bundle it is in with `$WHOMBAT_NODE`, else `node` on PATH. `exec` keeps
 * the unit's main PID the Node process (its systemd notifications and watchdog are that process's). POSIX sh.
 */
export function launcher(bin: string, app: string): string {
  return `#!/bin/sh
# ${bin}: runs this runtime bundle's app/${app}.mjs with Node.js 24 or newer: $WHOMBAT_NODE when set, else node on PATH.
self=$(readlink -f -- "$0") || exit 1
root=\${self%/bin/${bin}}
node=\${WHOMBAT_NODE:-node}
if ! command -v "$node" >/dev/null 2>&1; then
  echo "${bin}: Node.js 24 or newer is needed, and $node isn’t on PATH." >&2
  exit 127
fi
exec "$node" "$root/app/${app}.mjs" "$@"
`;
}

/** The bundle's `bin/` (NX-20): the CLI and the units' entry points. */
export const LAUNCHERS = {
  whombat: 'cli',
  'whombat-server': 'server',
  'whombat-runner': 'runner',
  'whombat-agent-net': 'agent-net',
} as const;

export async function buildRelease(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => {});
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
    engines: { node: string };
  };
  const version = ReleaseVersion.parse(options.version ?? rootPkg.version);
  const gitSha = git(['rev-parse', 'HEAD']);
  const gitDirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? git(['log', '-1', '--format=%ct']));
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('SOURCE_DATE_EPOCH must be a positive integer');
  const buildTime = new Date(epoch * 1000).toISOString();
  const name = `whombat-runtime-${version}-linux-${options.arch}`;
  const out = resolve(options.out);
  const work = join(out, '.build', name);
  const root = join(work, name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o755 });
  log(
    `building ${name} from ${gitSha.slice(0, 7)}${gitDirty ? ' (uncommitted changes!)' : ''}, SOURCE_DATE_EPOCH=${epoch}`,
  );

  // 1. Bundles.
  const bundled = new Set<string>();
  for (const [app, entry] of Object.entries(ENTRIES)) {
    const result = await esbuild.build(
      bundleOptions(entry, join(root, 'app', `${app}.mjs`), { version, gitSha, buildTime }),
    );
    for (const input of Object.keys(result.metafile.inputs)) {
      const dir = packageDirOf(input);
      if (dir) bundled.add(join(REPO_ROOT, dir));
    }
    chmodSync(join(root, 'app', `${app}.mjs`), 0o644);
  }
  copyAppFiles(join(root, 'app'));
  log(
    `bundled ${Object.keys(ENTRIES)
      .map((app) => `app/${app}.mjs`)
      .join(', ')}; ${Object.keys(APP_FILES)
      .map((f) => `app/${f}`)
      .join(', ')}`,
  );

  // 2. Migrations.
  mkdirSync(join(root, 'migrations', 'meta'), { recursive: true });
  for (const f of readdirSync(MIGRATIONS_SRC)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    copyNormalized(join(MIGRATIONS_SRC, f), join(root, 'migrations', f));
  copyNormalized(
    join(MIGRATIONS_SRC, 'meta', '_journal.json'),
    join(root, 'migrations', 'meta', '_journal.json'),
  );
  // Each migration's compatibility (docs/decisions/managed-db.md MD-03): a release can't migrate without it.
  copyNormalized(join(MIGRATIONS_SRC, 'compat.json'), join(root, 'migrations', 'compat.json'));

  // 3. What can't be bundled.
  const nm = join(root, 'node_modules');
  addNodePty(options.arch, join(nm, NODE_PTY), log);
  addOnePasswordSdk(nm);
  log(`node_modules: ${[NODE_PTY, ...ONEPASSWORD_SDK].join(', ')}`);

  // 4. Entry points, notices.
  mkdirSync(join(root, 'bin'), { mode: 0o755 });
  for (const [bin, app] of Object.entries(LAUNCHERS)) {
    writeFileSync(join(root, 'bin', bin), launcher(bin, app), { mode: 0o755 });
    chmodSync(join(root, 'bin', bin), 0o755);
  }
  for (const license of ['LICENSE', 'LICENSE.md', 'NOTICE'])
    if (existsSync(join(REPO_ROOT, license))) copyNormalized(join(REPO_ROOT, license), join(root, license));
  writeFileSync(
    join(root, 'THIRD-PARTY-NOTICES.txt'),
    noticesText([...[...bundled].sort(), join(nm, NODE_PTY), ...ONEPASSWORD_SDK.map((n) => join(nm, n))]),
  );
  chmodSync(join(root, 'THIRD-PARTY-NOTICES.txt'), 0o644);

  assertNoBuildPaths(root);
  // Nothing the repository must never hold again is in the bundle (scripts/scan-artifacts.sh, the maintainers' guard
  // list; the appliance's release tools require it, a community build skips it).
  execFileSync('bash', [join(REPO_ROOT, 'scripts/scan-artifacts.sh'), root], { stdio: 'inherit' });

  // 5. Manifest, archive, checksums.
  const migrations = readMigrations();
  const manifest = ReleaseManifest.parse({
    format: 1,
    name: 'whombat',
    version,
    gitSha,
    gitDirty,
    buildTime,
    node: rootPkg.engines.node,
    platform: 'linux',
    arch: options.arch,
    postgres: runtimePostgres(),
    claude: { bundled: false },
    schema: {
      latest: schemaVersion(),
      migrations: migrations.map((m) => ({ tag: m.tag, when: m.when, hash: m.hash })),
    },
    files: await releaseFiles(root),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, MANIFEST), manifestText, { mode: 0o644 });
  const archive = join(out, `${name}.tar.gz`);
  const partial = `${archive}.partial`;
  rmSync(partial, { force: true });
  await writeReleaseArchive(root, partial, name, epoch);
  renameSync(partial, archive);
  const manifestCopy = join(out, `${name}.manifest.json`);
  writeFileSync(manifestCopy, manifestText, { mode: 0o644 });
  const sumsFile = join(out, SUMS);
  const sums = existsSync(sumsFile) ? parseSums(readFileSync(sumsFile, 'utf8')) : new Map<string, string>();
  const sha256 = await hashFile(archive);
  sums.set(`${name}.tar.gz`, sha256);
  sums.set(`${name}.manifest.json`, await hashFile(manifestCopy));
  writeFileSync(sumsFile, formatSums(sums));
  // A signature of the SHA256SUMS just written, or none: an older one no longer matches it.
  const sigFile = join(out, SUMS_SIG);
  rmSync(sigFile, { force: true });
  if (options.signKey)
    writeFileSync(sigFile, signSums(readFileSync(sumsFile), readFileSync(options.signKey, 'utf8')), {
      mode: 0o644,
    });
  // Unpacked too, for Nix packaging and inspection: <out>/<name>/{app,bin,migrations,node_modules,…}.
  const tree = join(out, name);
  rmSync(tree, { recursive: true, force: true });
  renameSync(root, tree);
  rmSync(work, { recursive: true, force: true });
  const bytes = lstatSync(archive).size;
  return { archive, manifest, sha256, bytes };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      arch: { type: 'string' },
      out: { type: 'string' },
      version: { type: 'string' },
      'verify-reproducible': { type: 'boolean' },
      'sign-key': { type: 'string' },
    },
  });
  const arch = (values.arch ?? process.arch) as ReleaseArch;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`--arch is x64 or arm64 (got ${arch})`);
  const out = resolve(REPO_ROOT, values.out ?? 'dist');
  const log = (l: string) => process.stdout.write(`[package] ${l}\n`);
  // Relative to where `pnpm bundle:runtime` was typed (pnpm runs this in scripts/package).
  const signKey = values['sign-key']
    ? resolve(process.env.INIT_CWD ?? process.cwd(), values['sign-key'])
    : null;
  const options: BuildOptions = {
    arch,
    out,
    ...(values.version ? { version: values.version } : {}),
    ...(signKey ? { signKey } : {}),
    log,
  };
  const first = await buildRelease(options);
  log(`${first.archive} (${(first.bytes / 1024 ** 2).toFixed(1)} MB) sha256 ${first.sha256}`);
  log(signKey ? `${join(out, SUMS_SIG)}: SHA256SUMS signed with ${signKey}` : 'not signed (no --sign-key)');
  if (first.manifest.gitDirty) log('warning: built from a working tree with uncommitted changes');
  if (values['verify-reproducible']) {
    const again = join(tmpdir(), `whombat-repro-${process.pid}`);
    rmSync(again, { recursive: true, force: true });
    const second = await buildRelease({ ...options, out: again });
    rmSync(again, { recursive: true, force: true });
    if (second.sha256 !== first.sha256) {
      log(`NOT reproducible: a second build has sha256 ${second.sha256}`);
      return 1;
    }
    log('reproducible: a second build has the same sha256');
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`[package] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
