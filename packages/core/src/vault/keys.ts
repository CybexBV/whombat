/**
 * Vault keys for the agent's commands (Whombat agent-computer.md AC-30, AC-31; contracts 0.36.0, CT-223; since 3.0 on
 * the person's Whombat through each command's wrapper, Whombat one-person.md OP-07, CT-1532): which entries reach the
 * commands, and the environment variables a value lands in.
 */
import type { VaultAuthType, VaultEntryKind } from './schemas.js';

/** An environment variable's name as the person chooses it: `^[A-Z_][A-Z0-9_]{0,63}$`. */
export const VAULT_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Names a key's variable may never take: the shell's own, the dynamic loader's, the locale's and Whombat's. */
export const VAULT_ENV_NAMES_RESERVED: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'TERM',
  'LANG',
  'TMPDIR',
  'SSH_AUTH_SOCK',
];

/** Prefixes a key's variable may never start with. */
export const VAULT_ENV_PREFIXES_RESERVED: readonly string[] = ['LD_', 'LC_', 'WHOMBAT_'];

/** Why `name` can't be a key's environment variable, as the form shows it, or null. */
export function vaultEnvNameProblem(name: string): string | null {
  if (!VAULT_ENV_NAME_PATTERN.test(name))
    return 'Use capital letters, digits and _ (not first a digit), at most 64.';
  if (VAULT_ENV_NAMES_RESERVED.includes(name) || VAULT_ENV_PREFIXES_RESERVED.some((p) => name.startsWith(p)))
    return `${name} is used by Whombat itself. Choose another name.`;
  return null;
}

/**
 * The name a key's variable gets unless the person chooses one (AC-31), from the entry's name: “Cloudflare API
 * token” → `CLOUDFLARE_API_TOKEN`, “GitHub · deploy” → `GITHUB_DEPLOY`. Letters are upper-cased (accents dropped), other
 * characters become `_`; a name starting with a digit or reserved (`PATH`, `WHOMBAT_…`) gets `VAULT_` in front, and one
 * with nothing left is `VAULT_SECRET`.
 */
export function defaultVaultEnvName(entryName: string): string {
  const base = entryName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
  if (!base) return 'VAULT_SECRET';
  if (vaultEnvNameProblem(base) === null) return base;
  const prefixed = `VAULT_${base}`.slice(0, 64).replace(/_+$/, '');
  return vaultEnvNameProblem(prefixed) === null ? prefixed : 'VAULT_SECRET';
}

/**
 * Whether an entry switched on for the agent reaches its commands in the person's turns (AC-31; since 0.125, CT-1240;
 * `vaultComputerDeliverable` until 3.0): an `http` entry's value in environment variables and an `ssh` entry's key as a
 * file. A `login` goes to Hermes's credential vault instead (`DispatchContext.logins`), an `mcp` entry to Hermes's MCP
 * servers (`TurnKeys.mcpServers`); a `secret` entry is used by nothing.
 */
export function vaultKeyDeliverable(entry: { kind: VaultEntryKind }): boolean {
  return entry.kind === 'http' || entry.kind === 'ssh';
}

/**
 * The variables an `http` entry's value sets for the agent's commands (AC-31; `vaultComputerEnvNames` until 3.0):
 * `<NAME>` for a token, header or query value; `<NAME>_USERNAME` and `<NAME>_PASSWORD` for basic auth. None for the
 * other kinds.
 */
export function vaultKeyEnvNames(
  envName: string,
  entry: { kind: VaultEntryKind; auth: { type: VaultAuthType } | null },
): string[] {
  if (entry.kind !== 'http') return [];
  if (entry.auth?.type === 'basic') return [`${envName}_USERNAME`, `${envName}_PASSWORD`];
  return [envName];
}

/**
 * The folder that holds a turn's keys inside each command's wrapper (a tmpfs, gone with the command, OP-07, AC-30;
 * `VAULT_COMPUTER_KEYS_DIR` until 3.0).
 */
export const VAULT_KEYS_DIR = '/run/whombat/keys';
/**
 * The folder of the keys tmpfs holding the servers' kept passwords (3.14; Whombat vault-simplify.md VLT-42): one file
 * per server's `HostKeyAlias` (`wbpw1.invalid`, …), `{"user","password"}`, read by the commands' askpass helper.
 */
export const VAULT_ASKPASS_DIR = 'askpass';
