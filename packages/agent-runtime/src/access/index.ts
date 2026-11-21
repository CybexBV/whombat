/**
 * What a turn's environment and its task sandbox are built from (docs/decisions/managed-sandbox.md MSB-01): the
 * provider environment is the allowlist (`support/env.ts`) plus a few settings that keep git from asking or using a
 * helper; the sandbox denies the operator's credentials and Whombat's own directory wherever a mount would show them
 * (`Confinement`). The per-dispatch MCP token (set by the provider) and the agent's commit identity ride along.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, normalize } from 'node:path';
import { isForbiddenEnv, MCP_TOKEN_ENV, type ProviderEnvOptions, providerEnv } from '../support/env';

/**
 * Where a turn's task sandbox draws its lines, as absolute paths (`sandboxTask`). The working directory (`cwd`) is
 * writable when the turn may write; these add to or carve out of that.
 */
export interface Confinement {
  /** Never readable: credentials (`credentialPaths`), Whombat's own directory, other agents' workspaces. */
  denyRead: string[];
  /** Readable even inside a denied path: toolchain settings. */
  allowRead: string[];
  /** Writable besides `cwd`: what a commit writes in the workspace repo (objects, refs, logs, the admin dir). */
  allowWrite: string[];
  /**
   * Read-only even inside a writable path: what code outside the sandbox trusts — the admin dir's `commondir`,
   * `gitdir` and `config.worktree`, the repo's alternates, the worktree's `.git` file.
   */
  denyWrite: string[];
}

/**
 * Where the operator's secrets live under their home, relative to it: stored git and GitHub credentials, the model
 * providers' logins (Claude's `.claude.json` — an API key when it logs in with one — and `.credentials.json`, Codex's
 * `auth.json`), registry tokens, then the directories (the whole config directory: `gh`'s login, git's stored
 * credentials, cloud CLIs, our instance's settings; SSH and GPG keys; cloud and container credentials; password stores)
 * and shell histories (commands typed with a token in them).
 */
const HOME_SECRETS = [
  '.git-credentials',
  '.netrc',
  '.claude.json',
  '.npmrc',
  '.pypirc',
  '.cargo/credentials.toml',
  '.cargo/credentials',
  '.gem/credentials',
  '.vault-token',
  '.pgpass',
  '.my.cnf',
  '.yarnrc',
  '.config',
  '.ssh',
  '.gnupg',
  '.codex',
  '.claude',
  '.aws',
  '.azure',
  '.oci',
  '.kube',
  '.docker',
  '.terraform.d',
  '.password-store',
  '.local/share/keyrings',
  '.mozilla',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.psql_history',
  '.mysql_history',
];

/** Toolchain configuration in the (denied) config directory that an agent's shell needs: mise's shims read it. */
const TOOLCHAIN_CONFIG = ['mise', 'rtx'];

/** Variables that move one of those somewhere else (a colon-separated list for `KUBECONFIG`). */
const SECRET_LOCATIONS = [
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'NPM_CONFIG_USERCONFIG',
  'GNUPGHOME',
  'CLOUDSDK_CONFIG',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
  // People's provider sign-ins (SUB-22), wherever an operator put them (review CON-3).
  'WHOMBAT_CREDENTIALS_ROOT',
];

/**
 * Paths no turn may read, wherever a mount of its sandbox would show them: the operator's credentials (above) and
 * Whombat's own directory (master key, runner token, other agents' workspaces) — also where the runner's environment
 * moved them (`env`: `XDG_CONFIG_HOME`, `CODEX_HOME`, `KUBECONFIG`, …).
 */
export function credentialPaths(options: {
  home?: string;
  whombatHome: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const out = HOME_SECRETS.map((p) => join(home, p));
  for (const key of SECRET_LOCATIONS) {
    for (const value of (env[key] ?? '').split(delimiter)) {
      const path = value.trim();
      if (isAbsolute(path) && path !== '/' && path !== home) out.push(normalize(path));
    }
  }
  out.push(options.whombatHome);
  return [...new Set(out)];
}

/**
 * Re-allowed for reading inside the denied config directories (`~/.config`, `$XDG_CONFIG_HOME`): the toolchain
 * managers' own settings (`mise`, `rtx`), without which their shims — `node`, `pnpm` on many hosts — fail.
 */
export function toolchainConfigPaths(options: { home?: string; env?: NodeJS.ProcessEnv }): string[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const roots = [join(home, '.config'), ...(xdg && isAbsolute(xdg) ? [normalize(xdg)] : [])];
  return [...new Set(roots.flatMap((root) => TOOLCHAIN_CONFIG.map((name) => join(root, name))))].filter((p) =>
    existsSync(p),
  );
}

/**
 * What a turn's environment adds to the allowlist: no git credential helpers and no prompts. Variables of
 * `FORBIDDEN_ENV` are only ever set here, never copied from the host.
 */
export function agentEnvExtras(): Record<string, string> {
  return {
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Command-line level config: resets every helper from system, global and repo config; and no automatic
    // gc / maintenance after a commit (it would pack refs at the workspace repo's top level, which is read-only
    // to the agent).
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
    GIT_CONFIG_KEY_2: 'maintenance.auto',
    GIT_CONFIG_VALUE_2: 'false',
  };
}

/** Commit identity for the agent's own commits: the environment wins over every git config file. */
export function identityEnv(identity: { name: string; email: string } | undefined): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * The git variables the runner sets for an agent: its commit identity, or for its work folder the ceiling that
 * keeps git from finding a repository above it.
 */
const AGENT_GIT_ENV = /^GIT_((AUTHOR|COMMITTER)_(NAME|EMAIL)|CEILING_DIRECTORIES)$/;

export interface AgentEnvOptions extends ProviderEnvOptions {
  /** Base environment (the runner's). */
  env: NodeJS.ProcessEnv;
  /** Set last (the provider's login settings, the commit identity, the MCP token). */
  extra?: Record<string, string | undefined>;
  mcpToken?: string;
}

/**
 * The environment of a provider subprocess and every shell command of its agent: the allowlist plus `agentEnvExtras`,
 * never the runner's token or the server's secrets.
 */
export function agentEnv(options: AgentEnvOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...providerEnv(options.env, {
      ...(options.login ? { login: options.login } : {}),
      ...(options.pass ? { pass: options.pass } : {}),
    }),
    ...agentEnvExtras(),
  };
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) continue;
    // Extras may set the commit identity and login variables, never re-open a forbidden one.
    if (isForbiddenEnv(key) && !AGENT_GIT_ENV.test(key)) continue;
    out[key] = value;
  }
  if (options.mcpToken) out[MCP_TOKEN_ENV] = options.mcpToken;
  return out;
}

export { findBwrap, onPath } from './sandbox';
