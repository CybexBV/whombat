/**
 * `pnpm hermes:install`: the pinned Hermes Agent for development (docs/decisions/hermes-engine.md HE-10, HE-28).
 *
 * A uv environment at the pin in `$XDG_CACHE_HOME/whombat/hermes/venv-<version>` (default `~/.cache/…`): Python 3.14,
 * Hermes with its `acp`, `mcp` and `anthropic` extras (the last for the Anthropic client a turn on a person's key or
 * the AI gateway uses, HE-S297), and our plugin (`packages/hermes-whombat`) installed editable when it is there.
 * Hermes runs from a clone in the cache at the pinned commit — taken from `WHOMBAT_HERMES_SRC` (a checkout you
 * have) without the network, else from GitHub — without source patches;
 * it is installed editable from there (it refuses to build wheels outside Nix), its dependencies as its own `uv.lock`
 * pins them. The runner finds the environment by itself (`hermesBin`); `WHOMBAT_HERMES_BIN` overrides it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_PIN, hermesDevVenv } from '../packages/agent-runtime/src/hermes/profile';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const venv = hermesDevVenv();
const cache = dirname(venv);

function run(command: string, args: string[], options: { quiet?: boolean } = {}): string {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'],
  });
  if (r.error) throw new Error(`${command} couldn’t start: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${r.status})${r.stderr ? `: ${r.stderr}` : ''}`);
  return r.stdout.trim();
}

function step(what: string) {
  console.log(`hermes:install · ${what}`);
}

try {
  run('uv', ['--version'], { quiet: true });
} catch {
  console.error('hermes:install · uv is needed (https://docs.astral.sh/uv/); install it and run this again.');
  process.exit(1);
}

mkdirSync(cache, { recursive: true, mode: 0o700 });
// The source Hermes runs from: a clone in the cache, at the pin, unmodified — never someone's own checkout, which
// a patch would change (`WHOMBAT_HERMES_SRC` is only where the clone comes from, without the network).
const src = join(cache, `src-${HERMES_PIN.version}-unpatched`);
if (!existsSync(join(src, '.git'))) {
  const from = process.env.WHOMBAT_HERMES_SRC?.trim();
  step(`cloning Hermes Agent ${HERMES_PIN.tag} into ${src}${from ? ` from ${from}` : ''}`);
  if (from) {
    run('git', ['clone', '--quiet', '--shared', '--no-checkout', resolve(from), src]);
    run('git', ['-C', src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', HERMES_PIN.commit]);
  } else
    run('git', [
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      HERMES_PIN.tag,
      'https://github.com/NousResearch/hermes-agent',
      src,
    ]);
}
const head = run('git', ['-C', src, 'rev-parse', 'HEAD'], { quiet: true });
if (head !== HERMES_PIN.commit) {
  console.error(
    `hermes:install · ${src} is at ${head.slice(0, 12)}, not the pinned ${HERMES_PIN.commit.slice(0, 12)}.`,
  );
  process.exit(1);
}
// Refuse source changes rather than silently retaining a retired runtime patch.
if (run('git', ['-C', src, 'status', '--porcelain', '--untracked-files=no'], { quiet: true }))
  throw new Error(`Hermes source at ${src} has tracked changes; an unmodified pinned checkout is required.`);
const plugin = join(repo, 'packages', 'hermes-whombat');

const python = join(venv, 'bin', 'python');
if (!existsSync(python)) {
  step(`making ${venv} (Python 3.14)`);
  run('uv', ['venv', '--quiet', '--python', '3.14', venv]);
}
// Hermes's own lock, with its overrides (`uv pip install <src>` alone resolves differently and fails on Pillow).
step('installing Hermes with its acp, mcp and anthropic extras, as its lock pins them');
const requirements = join(cache, `requirements-${HERMES_PIN.version}.txt`);
run('uv', [
  'export',
  '--quiet',
  '--project',
  src,
  '--frozen',
  '--no-dev',
  '--extra',
  'acp',
  '--extra',
  'mcp',
  '--extra',
  'anthropic',
  '--no-hashes',
  '--no-emit-project',
  '--output-file',
  requirements,
]);
run('uv', ['pip', 'install', '--quiet', '--python', python, '--no-deps', '-r', requirements]);
// Hermes builds no wheels outside Nix (its setup refuses them): editable, from the source kept in the cache.
run('uv', ['pip', 'install', '--quiet', '--python', python, '--no-deps', '-e', src]);
step(
  'installing our plugin (packages/hermes-whombat, Whombat and the pinned Nous DirectSDK provider), editable',
);
run('uv', ['pip', 'install', '--quiet', '--python', python, '-e', plugin]);
// agent-browser: the plugin's browser tools drive the agent's Chromium through it (hermes-engine.md HE-S300; one-person.md
// OP-S113). The native binary of the version Whombat pins (`packages/hermes-whombat/agent-browser.json`, as the
// appliance's image does), checked against its sha256, as `<venv>/bin/agent-browser`, which the runner puts on Hermes's
// PATH. Never a Chromium download.
const agentBrowser = join(venv, 'bin', 'agent-browser');
const pinFile = join(plugin, 'agent-browser.json');
const pinned = JSON.parse(readFileSync(pinFile, 'utf8')) as {
  version: string;
  artifacts: { any: { url: string; sha256: string } };
};
const have = existsSync(agentBrowser)
  ? spawnSync(agentBrowser, ['--version'], { encoding: 'utf8' }).stdout.trim()
  : '';
if (!have.includes(pinned.version)) {
  step(`installing agent-browser ${pinned.version} (the browser tools) into ${agentBrowser}`);
  const res = await fetch(pinned.artifacts.any.url);
  if (!res.ok) throw new Error(`agent-browser: ${pinned.artifacts.any.url} answered ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const sum = createHash('sha256').update(tgz).digest('hex');
  if (sum !== pinned.artifacts.any.sha256)
    throw new Error(`agent-browser: the download's sha256 is ${sum}, not ${pinned.artifacts.any.sha256}`);
  const tmp = mkdtempSync(join(cache, 'agent-browser-'));
  try {
    writeFileSync(join(tmp, 'agent-browser.tgz'), tgz);
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const member = `package/bin/agent-browser-linux-${arch}`;
    run('tar', ['-xzf', join(tmp, 'agent-browser.tgz'), '-C', tmp, member]);
    copyFileSync(join(tmp, member), agentBrowser);
    chmodSync(agentBrowser, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const bin = join(venv, 'bin', 'hermes');
const check = run(bin, ['acp', '--check'], { quiet: true });
step(`${check} · ${bin}`);
console.log(
  `\nThe runner finds it there; to run another one, set WHOMBAT_HERMES_BIN. Profiles: $WHOMBAT_HOME/hermes.`,
);
