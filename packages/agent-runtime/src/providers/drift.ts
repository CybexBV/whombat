/**
 * Version drift (docs/decisions/managed-providers.md PV-01): is the provider runtime on this appliance the pinned
 * one? `compareToBundle` is pure; `inspectInstalled` reads the executable (realpath, sha256, `--version`) without
 * a model call, a login or network access. Any difference — another version, another binary with the same version
 * string, a missing binary — is `version_drift`, and a managed appliance runs no turn on it.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { providerPins } from '../access/managed/versions';
import { CLAUDE_BUNDLE, type PinnedBinary, type ProviderBundle } from './bundles';

export interface InstalledRuntime {
  /** Resolved executable path, or null when it isn't there. */
  path: string | null;
  /** What `--version` printed (first line, trimmed), or null. */
  versionOutput: string | null;
  /** sha256 of the executable, or null. */
  sha256: string | null;
}

export type DriftResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing' | 'version' | 'digest' | 'unpinned_platform';
      explanation: string;
      expected: { version: string; sha256: string | null };
      found: { version: string | null; sha256: string | null };
    };

export function currentPlatform(): PinnedBinary['platform'] | null {
  const key = `${process.platform}-${process.arch}`;
  return key === 'linux-x64' || key === 'linux-arm64' ? key : null;
}

/** Compares what is installed with the pinned bundle for a platform. */
export function compareToBundle(
  bundle: ProviderBundle,
  installed: InstalledRuntime,
  platform: PinnedBinary['platform'] | null,
): DriftResult {
  const pin = bundle.binaries.find((b) => b.platform === platform) ?? null;
  const expected = { version: bundle.versionOutput, sha256: pin?.binarySha256 ?? null };
  const found = { version: installed.versionOutput, sha256: installed.sha256 };
  const name = 'Claude Code';
  if (!pin)
    return {
      ok: false,
      reason: 'unpinned_platform',
      explanation: `${name} isn’t pinned for this platform, so a managed appliance doesn’t run it.`,
      expected,
      found,
    };
  if (!installed.path || !installed.versionOutput)
    return {
      ok: false,
      reason: 'missing',
      explanation: `${name} ${bundle.version} isn’t installed where the appliance expects it. Wait for the update to finish, or ask your Whombat support contact.`,
      expected,
      found,
    };
  if (installed.versionOutput.trim() !== bundle.versionOutput)
    return {
      ok: false,
      reason: 'version',
      explanation: `${name} is ${installed.versionOutput.trim()}, but this release of Whombat runs ${bundle.version}. Runs wait until the versions match again.`,
      expected,
      found,
    };
  if (pin.binarySha256 && installed.sha256 !== pin.binarySha256)
    return {
      ok: false,
      reason: 'digest',
      explanation: `${name} ${bundle.version} on this appliance isn’t the published binary (its checksum differs). Runs wait until it is restored.`,
      expected,
      found,
    };
  return { ok: true };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Reads the installed executable: resolves `command` (absolute path, or a name on `PATH`), hashes it and asks it for
 * `--version` with an empty environment (no login, no network needed for either CLI).
 */
export async function inspectInstalled(
  command: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<InstalledRuntime> {
  const env = options.env ?? process.env;
  const candidates = command.includes('/')
    ? [command]
    : (env.PATH ?? '')
        .split(':')
        .filter((d) => d.startsWith('/'))
        .map((d) => `${d}/${command}`);
  let path: string | null = null;
  for (const c of candidates) {
    path = await realpath(c).catch(() => null);
    if (path) break;
  }
  if (!path) return { path: null, versionOutput: null, sha256: null };
  const [sha256, versionOutput] = await Promise.all([
    sha256File(path).catch(() => null),
    new Promise<string | null>((resolve) => {
      execFile(
        path as string,
        ['--version'],
        { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, timeout: options.timeoutMs ?? 10_000 },
        (err, stdout) => resolve(err ? null : (String(stdout).split('\n')[0]?.trim() ?? null)),
      );
    }),
  ]);
  return { path, versionOutput, sha256 };
}

/**
 * The pinned Claude Code binary installed with Whombat: the official native build from npm
 * (`@anthropic-ai/claude-code-linux-x64|arm64`, the same bytes as Anthropic's release bucket; `pnpm-lock.yaml` pins
 * its integrity), or null when this platform's package isn't installed.
 */
export function bundledClaudeBinary(
  platform: PinnedBinary['platform'] | null = currentPlatform(),
): string | null {
  if (!platform) return null;
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-code-${platform}/claude`);
  } catch {
    return null;
  }
}

/** The pinned client installed with Whombat (`bundledClaudeBinary`), or null. ChatGPT has none (HN-04). */
export function bundledClientBinary(_provider: 'claude'): string | null {
  return bundledClaudeBinary();
}

/**
 * Where Claude Code's executable is on this machine: `WHOMBAT_CLAUDE_PATH` when set; else its pinned binary installed
 * with Whombat (`bundledClaudeBinary`), else `claude` on PATH. Claude Code is the only client: ChatGPT runs on
 * Hermes's own loop (HN-04, HN-A01).
 */
export function providerExecutable(_provider: 'claude', env: NodeJS.ProcessEnv = process.env): string {
  return env.WHOMBAT_CLAUDE_PATH?.trim() || bundledClaudeBinary() || 'claude';
}

/** The drift check of Claude Code on this machine. */
export async function checkProviderDrift(
  provider: 'claude',
  env: NodeJS.ProcessEnv = process.env,
): Promise<DriftResult> {
  const bundle = CLAUDE_BUNDLE;
  const platform = currentPlatform();
  // The release's pins (`WHOMBAT_PROVIDER_PINS`, MSB-15) must name the version this build is pinned to: a release
  // that says otherwise runs nothing (fail closed) rather than trusting either side.
  const pinned = providerPins(env.WHOMBAT_PROVIDER_PINS)[provider];
  if (pinned && pinned !== bundle.version)
    return {
      ok: false,
      reason: 'version',
      explanation: `This release pins Claude Code ${pinned}, but this Whombat build runs ${bundle.version}. Runs wait until they agree.`,
      expected: { version: bundle.versionOutput, sha256: null },
      found: { version: pinned, sha256: null },
    };
  const installed = await inspectInstalled(providerExecutable(provider, env), { env });
  return compareToBundle(bundle, installed, platform);
}

/**
 * `available()` of a managed provider: the pinned runtime is installed (version and digest), nothing about logins.
 * `missing` when it isn't there, `error` for another version or binary.
 */
export async function managedAvailability(
  provider: 'claude',
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; version: string } | { ok: false; reason: string; kind: 'missing' | 'error' }> {
  const drift = await checkProviderDrift(provider, env);
  if (drift.ok) return { ok: true, version: CLAUDE_BUNDLE.versionOutput };
  return { ok: false, reason: drift.explanation, kind: drift.reason === 'missing' ? 'missing' : 'error' };
}
