/**
 * The Vault's tools and an `mcp` entry's own tools (docs/decisions/vault.md VT-44; since 0.125 without `vault_request`,
 * the SSH relay, `request_vault_key` or bridged `vt_*` tools, CT-1242): the tools the agent runs a person's Vault with,
 * an entry's stable key, and an MCP server's tools hashed so a changed tool is a new one.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '../audit/canonical.js';
import { sha256Hex } from '../audit/crypto.js';
import { VAULT_TOOL_DESCRIPTION_MAX, VAULT_TOOLS_MAX, type VaultTool } from './schemas.js';

/**
 * The tools the agent runs a person's Vault with in their turn (0.112.0, CT-782; Whombat vault-self-serve.md VS-04,
 * VS-09): `vault_save` saves a login or token it was sent, `vault_add_server` adds a server to an SSH key. Their activity
 * rows are the Vault's (`isVaultActivityTool`, VS-14): the input holds a secret or a password.
 */
export const VAULT_SELF_SERVE_TOOL_NAMES = ['vault_save', 'vault_add_server'] as const;

/** Hermes's tool that fills a saved login into a page (its credential vault, CT-1240): a Vault row too. */
export const HERMES_VAULT_TOOL = 'browser_vault';

/**
 * An entry's key: 8 lowercase letters derived from its id (sha256 of `whombat-vault-entry-key:<id>`, each of the
 * first 8 bytes mod 26). Deterministic, so the key survives restarts; it names no entry. It names the entry's files on
 * the agent's commands (`ssh/<key>`) and its MCP server in Hermes's list.
 */
export function vaultEntryKey(entryId: string): string {
  const digest = sha256(utf8ToBytes(`whombat-vault-entry-key:${entryId}`));
  let key = '';
  for (let i = 0; i < 8; i++) key += String.fromCharCode(97 + ((digest[i] as number) % 26));
  return key;
}

/**
 * Whether an activity row's tool is the Vault's, whatever the runner prefixed it with (`whombat.vault_save`,
 * `mcp__whombat__vault_add_server`): `vault_save`, `vault_add_server` and Hermes's `browser_vault`. Such rows are
 * neutral, read “Used a private Vault entry” and carry no object or evidence (VT-53), and no input is kept (VT-D07).
 */
export function isVaultActivityTool(tool: string): boolean {
  const bare = tool.replace(/^whombat\./, '').replace(/^mcp__whombat__/, '');
  return bare === HERMES_VAULT_TOOL || (VAULT_SELF_SERVE_TOOL_NAMES as readonly string[]).includes(bare);
}

/** Line breaks and tabs become spaces; other control characters and bidirectional overrides are removed. */
export function cleanVaultToolText(text: string, max = VAULT_TOOL_DESCRIPTION_MAX): string {
  const cleaned = text
    .replace(/[\t\n\r\u2028\u2029]+/g, ' ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/** A tool as the server's `tools/list` gave it. */
export interface RemoteVaultTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** sha256 of the tool's canonical definition (name, title, description, schemas, annotations). */
export function vaultToolHash(tool: RemoteVaultTool): string {
  return sha256Hex(
    canonicalJson({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }),
  );
}

/**
 * The stored tools after a check (VT-44), in the server's order, at most `VAULT_TOOLS_MAX`: on the first check every
 * tool is on; later, a tool whose hash is unchanged keeps its switch and badge, and a new or changed tool is off with
 * “New” (a changed tool never inherits “on”). Tools the server no longer lists go. A duplicate name keeps its first.
 */
export function mergeVaultTools(
  stored: readonly Pick<VaultTool, 'name' | 'hash' | 'enabled' | 'isNew'>[],
  listed: readonly RemoteVaultTool[],
  firstCheck: boolean,
): { tools: VaultTool[]; ignored: number } {
  const seen = new Set<string>();
  const unique = listed.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
  const kept = unique.slice(0, VAULT_TOOLS_MAX);
  const tools = kept.map((t): VaultTool => {
    const hash = vaultToolHash(t);
    const before = stored.find((s) => s.name === t.name && s.hash === hash);
    const enabled = firstCheck ? true : (before?.enabled ?? false);
    const isNew = firstCheck ? false : before ? before.isNew : true;
    return {
      name: t.name,
      description: cleanVaultToolText(t.description ?? ''),
      enabled,
      isNew,
      hash,
    };
  });
  return { tools, ignored: unique.length - kept.length };
}
