/**
 * The person's provider credential homes (docs/decisions/one-person.md OP-09; MA-10, MA-12, managed-providers.md
 * PV-03): one per provider, `WHOMBAT_CREDENTIALS_ROOT/<provider>` (`claude`, `codex`, `github`), holding the person's
 * own sign-in or the API key they added. Each is a private directory (0700, owned by the appliance user, never a link)
 * that only the provider's own sign-in writes its login into (Claude Code's `config/`, gh's `hosts.yml`) — or, for an
 * Anthropic or OpenAI API key, a 0600 `api-key` file. A ChatGPT sign-in's login is Hermes's own, in the person's Hermes
 * profile (hermes-native.md HN-03): its home holds only the record. Next to it Whombat keeps `whombat-credential.json`:
 * which mode, when, the recorded expiry and the last run's signal. Never a secret in it.
 *
 * A run gets exactly its provider's home (`credentialEnv`); nothing here ever looks at the host user's own logins
 * (`~/.codex`, `~/.claude`, gh's keyring) or the runner's environment.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { privateDir } from '../host';
import { CLAUDE_BUNDLE } from './bundles';
import type { RecordedSignal } from './states';
import { type CredentialProvider, isAuthMode, type RunSignalState } from './types';

export const META_FILE = 'whombat-credential.json';
/** The API key of a Claude or Codex `api_key` home (0600). */
export const CLAUDE_KEY_FILE = 'api-key';
/**
 * CLAUDE_CONFIG_DIR inside a Claude home: the CLI's sessions and settings — and, for a subscription, its own login
 * (`claude auth login` writes it there; the sign-in console runs the CLI with this directory) — never the operator's
 * `~/.claude`.
 */
export const CLAUDE_CONFIG_SUBDIR = 'config';
/** HOME for gh inside a GitHub home (gh's git-credential setup, if it ever writes one, lands here). */
export const GH_HOME_SUBDIR = 'home';

export class CredentialHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialHomeError';
  }
}

/** `<root>/<provider>`, the person's home for it. Pure (no filesystem access). */
export function credentialHomePath(root: string, provider: CredentialProvider): string {
  if (!isAbsolute(root)) throw new CredentialHomeError('WHOMBAT_CREDENTIALS_ROOT must be an absolute path.');
  if (!['claude', 'codex', 'github'].includes(provider))
    throw new CredentialHomeError(`Not a provider: ${provider}.`);
  return join(root, provider);
}

/** The credentials root, created private: staging homes are made in it, beside the homes. */
export async function ensureCredentialsRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return privateDir(root);
}

/** Creates (or checks) the root and the provider's home, each private (0700). */
export async function ensureCredentialHome(root: string, provider: CredentialProvider): Promise<string> {
  const home = credentialHomePath(root, provider);
  await ensureCredentialsRoot(root);
  await privateDir(home);
  return home;
}

/** Whether the home exists (as a real directory; a link counts as absent and is never followed). */
export async function credentialHomeExists(home: string): Promise<boolean> {
  const info = await lstat(home).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

/** Most entries `homeLinkProblem` looks at; a home with more is refused (a CLI keeps a few hundred at most). */
const LINK_SCAN_MAX_ENTRIES = 20_000;

/**
 * Why a home must not be handed to a CLI running outside any sandbox (SUB-41, review CON-2), or null: a symbolic
 * link anywhere in it, or a file with more than one hard link. A turn may write in a home (a Claude `config/`); a link
 * planted there would make the CLI, run as the runner's user, read or rewrite a file outside it. Every entry is
 * lstat'ed, nothing is followed or opened.
 */
export async function homeLinkProblem(home: string): Promise<string | null> {
  const top = await lstat(home).catch(() => null);
  if (!top) return null;
  if (top.isSymbolicLink() || !top.isDirectory()) return `${home} is not a directory.`;
  const pending = [home];
  let seen = 0;
  while (pending.length) {
    const dir = pending.pop() as string;
    const names = await readdir(dir).catch(() => null);
    if (!names) return `${dir} can’t be read.`;
    for (const name of names) {
      if (++seen > LINK_SCAN_MAX_ENTRIES) return `${home} holds too many files.`;
      const path = join(dir, name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) return `${path} is a link.`;
      if (info.isDirectory()) pending.push(path);
      else if (info.nlink > 1) return `${path} has another name (a hard link).`;
    }
  }
  return null;
}

/** What Whombat records next to a sign-in (no secrets). */
export interface CredentialMeta {
  v: 1;
  provider: CredentialProvider;
  authMode: string;
  createdAt: string;
  /** When the sign-in stops working (access tokens: required). */
  expiresAt: string | null;
  /** `valid`: a free check accepted it; `unverified`: not verified until first use. */
  verified: 'valid' | 'unverified';
  verifiedAt: string | null;
  /** The person confirmed they created this token (Codex access tokens, E-X3). */
  creatorAttested: boolean;
  /** GitHub: the login the sign-in belongs to, when gh said. */
  login: string | null;
  /** The last run's signal about this sign-in, until it clears. */
  signal: RecordedSignal | null;
}

export async function readCredentialMeta(home: string): Promise<CredentialMeta | null> {
  const text = await readFile(join(home, META_FILE), 'utf8').catch(() => null);
  if (!text) return null;
  try {
    const meta = JSON.parse(text) as CredentialMeta;
    if (meta?.v !== 1 || !isAuthMode(meta.provider, meta.authMode)) return null;
    // The contract's fields only (an earlier record's owner fields are left out); a missing one reads as its default.
    return {
      v: 1,
      provider: meta.provider,
      authMode: meta.authMode,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt ?? null,
      verified: meta.verified === 'valid' ? 'valid' : 'unverified',
      verifiedAt: meta.verifiedAt ?? null,
      creatorAttested: meta.creatorAttested === true,
      login: typeof meta.login === 'string' ? meta.login : null,
      signal: meta.signal ?? null,
    };
  } catch {
    return null;
  }
}

/** Writes a private file atomically (a reader never sees it half written). */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

export async function writeCredentialMeta(home: string, meta: CredentialMeta): Promise<void> {
  await writePrivateFile(join(home, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Records what a run learned about the sign-in (quota, revoked, expired, outage), or clears it after a good run.
 * Quota and outage carry `until`; the others hold until the next sign-in or good run.
 */
export async function recordRunSignal(
  home: string,
  signal: { state: RunSignalState; until?: string | null } | null,
  now: Date = new Date(),
): Promise<void> {
  const meta = await readCredentialMeta(home);
  if (!meta) return;
  const next: RecordedSignal | null = signal
    ? { state: signal.state, at: now.toISOString(), until: signal.until ?? null }
    : null;
  if (JSON.stringify(meta.signal) === JSON.stringify(next)) return;
  await writeCredentialMeta(home, { ...meta, signal: next });
}

/** The Claude Code config directory of a Claude home (`CLAUDE_CONFIG_DIR`): the CLI's own login, sessions, settings. */
export function claudeConfigDir(home: string): string {
  return join(home, CLAUDE_CONFIG_SUBDIR);
}

/**
 * The environment a managed turn's provider gets from the person's home — and nothing from the runner's own
 * environment or the operator's logins (PV-04). No secret rides in it (the managed sandbox passes none, MSB-18):
 * Claude Code runs with `CLAUDE_CONFIG_DIR` = the home's `config/` — for `subscription_cli` its own login lives (and is
 * refreshed) there, written by `claude auth login` in the CLI's own flow, and Whombat never opens it (SUB-03); for
 * `api_key` it reads the key file through its `apiKeyHelper` (`claudeManagedSettings`). Codex needs nothing here: an
 * API key is read by Hermes's loop from the home's key file (`key_cmd`), and a ChatGPT login is Hermes's own, in the
 * person's profile (HN-03; a turn without it asks for a new sign-in). Throws when the home has no usable sign-in; a
 * subscription whose login is gone shows up as the turn's `authentication_failed` (→ `auth_revoked`).
 */
export async function credentialEnv(
  home: string,
  provider: 'claude' | 'codex',
  authMode: string,
): Promise<Record<string, string>> {
  if (provider === 'codex') {
    if (authMode === 'api_key') {
      const key = await stat(join(home, CLAUDE_KEY_FILE)).catch(() => null);
      if (!key?.isFile()) throw new CredentialHomeError('No OpenAI API key in this credential home.');
    } else if (authMode !== 'chatgpt' && authMode !== 'access_token')
      throw new CredentialHomeError(`Codex ${authMode} has no sign-in here.`);
    return {};
  }
  if (authMode === 'api_key') {
    const key = (await readFile(join(home, CLAUDE_KEY_FILE), 'utf8').catch(() => '')).trim();
    if (!key) throw new CredentialHomeError('No Anthropic API key in this credential home.');
  } else if (authMode !== 'subscription_cli')
    throw new CredentialHomeError(`Claude ${authMode} has no sign-in on a managed appliance.`);
  const config = claudeConfigDir(home);
  // Only the directory: its contents are the CLI's (a subscription's `.credentials.json`), never read here.
  await mkdir(config, { recursive: true, mode: 0o700 });
  const info = await lstat(config);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CredentialHomeError('The Claude config directory of this credential home is not a directory.');
  return { CLAUDE_CONFIG_DIR: config, ...CLAUDE_BUNDLE.selfUpdate.env };
}

/** A POSIX shell single-quoted string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Claude Code's flag settings (`--settings`) for a managed turn: updates are refused (`env.DISABLE_UPDATES`); for an
 * API key the documented `apiKeyHelper` reads the person's key from their home (verified with 2.1.283: the stream's
 * `system:init` says `apiKeySource: apiKeyHelper`, offline). A subscription needs nothing here: the CLI uses the
 * login in its `CLAUDE_CONFIG_DIR`.
 */
export function claudeManagedSettings(
  home: string,
  authMode = 'api_key',
): { apiKeyHelper?: string; env: Record<string, string> } {
  return {
    ...(authMode === 'api_key' ? { apiKeyHelper: `cat ${shellQuote(join(home, CLAUDE_KEY_FILE))}` } : {}),
    env: { ...(CLAUDE_BUNDLE.selfUpdate.config.env as Record<string, string>) },
  };
}
