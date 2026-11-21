/**
 * The AI clients this runner's turns run (SUB-09, CT-72…CT-74; `@whombat/agent-runtime/providers` `resolveClient`):
 * before a Claude turn the runner resolves the installed Claude Code (DirectSDK's model client) and points the provider
 * at it (`WHOMBAT_CLAUDE_PATH` in this process, which the provider and the drift check read), unless the operator pinned
 * one in the runner's environment. A managed bundle's executable is checked against the digest the manager installed it
 * with — that pin replaces the image's (`drift`). A client that should be installed and isn't refuses the turn
 * (`client.not_installed`). With neither an install nor a pin, the pinned client installed with Whombat
 * (`bundledClientBinary`, development's node_modules) is set from the start. Claude Code is the only client: ChatGPT
 * runs on Hermes alone (hermes-native.md HN-04, HN-A01), and a Codex entry the manager still lists is never resolved.
 *
 * Whether a provider is ready at all (the claims and the heartbeat's `ProviderCheck`) comes from the same place
 * (`availability`, SUB-49): with a clients file, the installed client — its version, its path (SUB-45) and its digest —
 * and the image's pins only without one.
 */
import { statSync } from 'node:fs';
import type { Availability } from '@whombat/agent-runtime';
import {
  bundledClientBinary,
  CLIENT_NAMES,
  CLIENT_PATH_ENV,
  type ClientName,
  type ClientResolution,
  checkClientPath,
  DEFAULT_MANAGED_CLIENTS_ROOT,
  type DriftResult,
  fileSha256,
  resolveClient,
} from '@whombat/agent-runtime/providers';
import type { RunnerConfig } from './config';

export interface RunnerClientsOptions {
  /** The runner's environment as it started (operator pins). */
  env: NodeJS.ProcessEnv;
  /** `WHOMBAT_CLIENTS_FILE`. */
  clientsFile?: string | undefined;
  /** `WHOMBAT_CLIENTS_ROOT`: a bundle runs only from inside it (SUB-45). */
  clientsRoot?: string | undefined;
  /** Where the resolved path is set for the providers (default `process.env`). */
  target?: NodeJS.ProcessEnv;
}

/**
 * Where this runner looks for installed clients: the clients file and the manager's install root
 * (`WHOMBAT_CLIENTS_ROOT`, default `/persist/whombat/clients`).
 */
export function clientResolverOptions(
  config: Pick<RunnerConfig, 'WHOMBAT_CLIENTS_FILE' | 'WHOMBAT_CLIENTS_ROOT'>,
  env: NodeJS.ProcessEnv,
): Omit<RunnerClientsOptions, 'target'> {
  return {
    env: { ...env },
    ...(config.WHOMBAT_CLIENTS_FILE ? { clientsFile: config.WHOMBAT_CLIENTS_FILE } : {}),
    clientsRoot: config.WHOMBAT_CLIENTS_ROOT || DEFAULT_MANAGED_CLIENTS_ROOT,
  };
}

/** An installed client's version as its `--version` prints it (`ProviderCheck.version`: `2.1.283 (Claude Code)`). */
export function clientVersionLine(_provider: ClientName, version: string | null): string {
  return `${version ?? 'installed'} (Claude Code)`;
}

export class RunnerClients {
  private readonly last = new Map<ClientName, ClientResolution>();
  private readonly target: NodeJS.ProcessEnv;

  constructor(private readonly options: RunnerClientsOptions) {
    this.target = options.target ?? process.env;
    // Until a turn's `prepare`: the operator's pin, else the pinned client installed with Whombat (the providers'
    // readiness and sandbox checks run before any turn).
    for (const provider of Object.keys(CLIENT_NAMES) as ClientName[]) {
      const key = CLIENT_PATH_ENV[provider];
      const bundled = options.env[key] === undefined ? bundledClientBinary(provider) : null;
      if (bundled && this.target[key] === undefined) this.target[key] = bundled;
    }
  }

  /** Resolves the provider's client for the next turn and points the provider at it; a refusal when missing. */
  async prepare(provider: ClientName): Promise<ClientResolution> {
    const r = await resolveClient(provider, this.options);
    this.last.set(provider, r);
    const key = CLIENT_PATH_ENV[provider];
    // A missing bundle's path is never handed on (the drift check refuses the turn); nor is anything refused.
    if (r.ok && r.path && !r.missing) this.target[key] = r.path;
    else {
      // Nothing installed by Whombat: the operator's pin, unchanged, else the pinned client installed with Whombat,
      // else the provider's own default. A refusal hands nothing new on.
      const original = this.options.env[key];
      const bundled =
        original === undefined && r.ok && r.source === 'default' ? bundledClientBinary(provider) : null;
      if (bundled) this.target[key] = bundled;
      else if (original === undefined) delete this.target[key];
      else this.target[key] = original;
    }
    return r;
  }

  /** The client the last `prepare` chose (for logs). */
  resolved(provider: ClientName): ClientResolution | undefined {
    return this.last.get(provider);
  }

  /**
   * The drift check of a provider: a managed bundle against the digest it was installed with; anything else through
   * `fallback` (the image's pinned runtime, PV-01).
   */
  drift<P extends ClientName>(
    fallback: (provider: P) => Promise<DriftResult | null>,
  ): (provider: P) => Promise<DriftResult | null> {
    return async (provider) => {
      const r = this.last.get(provider) ?? (await this.prepare(provider));
      if (!r.ok || r.source !== 'bundle' || !r.sha256) return fallback(provider);
      return bundleDrift(provider, r, this.options.clientsRoot);
    };
  }

  /**
   * Whether a provider is ready, for the claims and the heartbeat (SUB-49): with a clients file, its installed client —
   * resolved afresh (the file read again, the path checked, SUB-45; an unreadable file refuses, SUB-46) and its digest
   * checked — ready with the installed version, else why not (`client.not_installed` → `missing`); the image's pins
   * (`fallback`, the provider's own managed `available()`) only when there is no clients file or the operator pinned the
   * executable. Changes nothing a turn uses (`prepare` does that).
   */
  async availability(provider: ClientName, fallback: () => Promise<Availability>): Promise<Availability> {
    const r = await resolveClient(provider, this.options);
    if (!r.ok)
      return { ok: false, reason: r.message, kind: r.code === 'client.not_installed' ? 'missing' : 'error' };
    if (r.source !== 'bundle' || !r.sha256) return fallback();
    const drift = await bundleDrift(provider, r, this.options.clientsRoot);
    if (drift)
      return { ok: false, reason: drift.explanation, kind: drift.reason === 'missing' ? 'missing' : 'error' };
    return { ok: true, version: clientVersionLine(provider, r.version) };
  }

  /**
   * The clients file's identity (device, inode, size, times; `missing`, or the error), for the registry's `watch`: the
   * manager's server writes a new file and renames it into place, so any change shows (SUB-46, SUB-49).
   */
  stamp(): string | null {
    const file = this.options.clientsFile;
    if (!file) return null;
    try {
      const s = statSync(file);
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch (err) {
      return `unreadable:${(err as NodeJS.ErrnoException).code ?? 'error'}`;
    }
  }

  /** The registry's options that make a managed runner's readiness its installed clients' (SUB-49). */
  registryOptions(): {
    availability: (kind: ClientName, fallback: () => Promise<Availability>) => Promise<Availability>;
    watch: () => string | null;
  } {
    return { availability: (kind, fallback) => this.availability(kind, fallback), watch: () => this.stamp() };
  }
}

/**
 * A resolved bundle against the digest it was installed with, hashed now (null: it matches). The checked realpath
 * again — just before a turn starts it (SUB-45). A path that no longer passes the checks, or a file that changed while
 * it was hashed, counts as a digest that differs.
 */
async function bundleDrift(
  provider: ClientName,
  r: Extract<ClientResolution, { ok: true; path: string }>,
  clientsRoot: string | undefined,
): Promise<Exclude<DriftResult, { ok: true }> | null> {
  const name = CLIENT_NAMES[provider];
  const expected = { version: r.version ?? 'installed', sha256: r.sha256 ?? '' };
  let found: string | null = null;
  if (!r.missing) {
    const still = checkClientPath(r.path, clientsRoot);
    if (still.ok && still.real === r.path) found = await fileSha256(r.path);
    if (!found && !(!still.ok && still.missing))
      return {
        ok: false,
        reason: 'digest',
        explanation: `The installed ${name} changed since it was checked, so no turn runs on it. The appliance reinstalls it.`,
        expected,
        found: { version: null, sha256: null },
      };
  }
  if (found === r.sha256) return null;
  return {
    ok: false,
    reason: found ? 'digest' : 'missing',
    explanation: found
      ? `The installed ${name} isn’t the build Whombat tested (its digest differs), so no turn runs on it. The appliance reinstalls it.`
      : `The installed ${name} is missing on this appliance, so no turn runs on it. The appliance reinstalls it.`,
    expected,
    found: { version: null, sha256: found },
  };
}
