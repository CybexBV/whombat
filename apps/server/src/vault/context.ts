/**
 * The Vault in a turn (docs/decisions/vault.md VT-33; hermes-engine.md HE-43): `DispatchContext.vault` (the entries
 * switched on for the agent, as this turn may use them, and the Vault's own tools the agent has in the person's turns),
 * the tools `/mcp` lists, and the session fingerprint's `vault` part. Never a secret; `secret` entries are never listed
 * here. The Vault is the person's (one-person.md OP-01): search answers and outsiders' turns (a Feedback assessment, a
 * tracker customer's report, OP-17) never use it; every other turn — the person's — carries it, also when nothing is
 * switched on (VT-G01), with the entries that are off (`unheld`, VT-G02). An entry switched on reaches the person's turns
 * only (OP-S60).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  defaultVaultEnvName,
  parseVaultUrl,
  VAULT_SELF_SERVE_TOOL_NAMES,
  VAULT_UNHELD_MAX,
  type VaultAuth,
  type VaultDispatchContext,
  type VaultSshServer,
  vaultKeyCoveredServers,
  vaultKeyEnvNames,
  vaultSshServerTarget,
} from '@whombat/core';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { siteOf } from '../browser/sites';
import type { Db, Tx } from '../db/client';
import { dispatches, vaultEntries } from '../db/schema/index';
import { servedVaultTools } from '../mcp/served';
import { loadPrincipalRow } from '../read/principals';
import { dispatchPerson } from '../runtime/person';
import { onForAgent, serverRows, toServer, type VaultSshServerRow } from './store';

type DispatchBits = Pick<
  typeof dispatches.$inferSelect,
  | 'id'
  | 'burrowId'
  | 'trigger'
  | 'mode'
  | 'search'
  | 'onBehalfOfAccountId'
  | 'state'
  | 'runId'
  | 'conversationId'
  | 'threadRootId'
>;

/** A dispatch that never uses the Vault: a search answer (VT-22) or a Feedback assessment (FB-D). */
export function vaultless(d: Pick<DispatchBits, 'trigger' | 'mode' | 'search'>): boolean {
  return d.trigger === 'feedback' || d.trigger === 'search' || d.mode === 'answer' || d.search !== null;
}

/** Whether a turn may use the person's Vault: theirs (`dispatchPerson`), not one of `vaultless`'s (OP-17, OP-S60). */
export async function vaultTurn(
  db: Db | Tx,
  d: Pick<DispatchBits, 'burrowId' | 'trigger' | 'mode' | 'search' | 'onBehalfOfAccountId'>,
): Promise<boolean> {
  return !vaultless(d) && (await dispatchPerson(db, d)) !== null;
}

interface HeldEntry {
  entry: typeof vaultEntries.$inferSelect;
  /** An `http` key's variable in the commands (AC-31). */
  envName: string | null;
  /** An `ssh` entry: the servers the key covers, by name (VT-S07, VT-S12). */
  servers: VaultSshServerRow[];
  /** An `ssh` entry's key: the servers it lists, null for All servers. */
  keyServers: string[] | null;
}

/** The entries switched on for the agent (never `secret`), with covered servers. */
async function heldEntries(db: Db | Tx, agentId: string): Promise<HeldEntry[]> {
  const rows = (
    await db
      .select({ entry: vaultEntries })
      .from(vaultEntries)
      .where(and(onForAgent(agentId), ne(vaultEntries.kind, 'secret')))
      .orderBy(asc(vaultEntries.name), asc(vaultEntries.id))
  ).map(({ entry }) => ({
    entry,
    envName: entry.kind === 'http' ? entry.envName : null,
    keyServers: entry.kind === 'ssh' ? (entry.agentServers ?? null) : null,
  }));
  if (!rows.length) return [];
  const servers = await serverRows(
    db,
    rows.filter((r) => r.entry.kind === 'ssh').map((r) => r.entry.id),
  );
  return rows.map((r) => ({
    entry: r.entry,
    envName: r.envName,
    keyServers: r.keyServers,
    servers:
      r.entry.kind === 'ssh'
        ? vaultKeyCoveredServers(
            { servers: r.keyServers },
            servers.filter((s) => s.entryId === r.entry.id),
          )
        : [],
  }));
}

interface UnheldEntry {
  entry: typeof vaultEntries.$inferSelect;
  /** An `ssh` entry: all of its servers. */
  servers: VaultSshServerRow[];
}

/**
 * The entries switched off for the agent (VT-G02): kinds `http`, `mcp`, `login`, `ssh` (never `secret`), by name, at
 * most `VAULT_UNHELD_MAX`; none for one of Whombat's own signers (OA-17).
 */
async function unheldEntries(
  db: Db | Tx,
  agentId: string,
  dispatch: Pick<DispatchBits, 'burrowId'>,
): Promise<UnheldEntry[]> {
  const agent = await loadPrincipalRow(db, agentId);
  if (agent?.kind !== 'agent') return [];
  const rows = await db
    .select({ entry: vaultEntries })
    .from(vaultEntries)
    .where(
      and(
        eq(vaultEntries.burrowId, dispatch.burrowId),
        ne(vaultEntries.kind, 'secret'),
        isNull(vaultEntries.agentOnAt),
      ),
    )
    .orderBy(asc(vaultEntries.name), asc(vaultEntries.id))
    .limit(VAULT_UNHELD_MAX);
  if (!rows.length) return [];
  const servers = await serverRows(
    db,
    rows.filter((r) => r.entry.kind === 'ssh').map((r) => r.entry.id),
  );
  return rows.map((r) => ({
    entry: r.entry,
    servers: servers.filter((s) => s.entryId === r.entry.id),
  }));
}

/**
 * Whether agents can reach a server now, as the turn is told (`ready`, vault-self-serve.md VS-10): every server but one
 * whose host key changed — pinned and since showing another key, or met showing another key than the person trusts at
 * that address. A server without a pin is trusted on first contact, so it is ready (core's `vaultSshServerReady`
 * still reads it as waiting for the person, VT-S05).
 */
export function sshServerUsable(server: Pick<VaultSshServer, 'hostKey' | 'seenHostKey' | 'check'>): boolean {
  return !(
    server.seenHostKey !== null &&
    (server.hostKey !== null || server.check.outcome === 'host_key_changed')
  );
}

/** An unheld entry as the turn is told (VT-G02): name, description and a login's site. */
function toUnheld({ entry }: UnheldEntry): VaultDispatchContext['unheld'][number] {
  const kind = entry.kind === 'mcp' || entry.kind === 'login' || entry.kind === 'ssh' ? entry.kind : 'http';
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kind,
    site: kind === 'login' && entry.url ? (siteOf(entry.url)?.slice(0, 253) ?? null) : null,
  };
}

/** The base URL `vault_request` paths are relative to (`https://api.example.com/v1`). */
function baseUrlOf(url: string | null): string | null {
  if (!url) return null;
  const parsed = parseVaultUrl(url);
  return parsed.ok ? `${parsed.url.origin}${parsed.url.basePath}` : null;
}

/**
 * `DispatchContext.vault`: null for a turn that never uses the Vault (`vaultTurn`); otherwise the entries switched on
 * for the agent (possibly none, VT-G01) and the ones switched off (VT-G02).
 */
export async function vaultContextFor(
  db: Db | Tx,
  agentId: string,
  dispatch: DispatchBits,
  /** A turn with commands (one-person.md OP-S109): each `http` entry names its variables there. */
  options: { commands?: boolean } = {},
): Promise<VaultDispatchContext | null> {
  if (!(await vaultTurn(db, dispatch))) return null;
  const held = await heldEntries(db, agentId);
  const unheld = (await unheldEntries(db, agentId, dispatch)).map(toUnheld);
  // Each entry as it reaches the agent now — an `http` key as variables for its commands, an `ssh` key with its
  // servers, a login in Hermes's credential vault, an MCP server.
  const entries: VaultDispatchContext['entries'] = held.map(({ entry, servers, ...key }) => {
    const kind = entry.kind === 'mcp' || entry.kind === 'login' || entry.kind === 'ssh' ? entry.kind : 'http';
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind,
      // `http`: what paths are relative to; `login`: its sign-in page (VT-D30); `mcp`: the server.
      url: kind === 'http' ? baseUrlOf(entry.url) : kind === 'ssh' ? null : entry.url,
      envNames:
        kind === 'http' && options.commands
          ? vaultKeyEnvNames(key.envName ?? defaultVaultEnvName(entry.name), {
              kind: entry.kind,
              auth: entry.auth as VaultAuth | null,
            })
          : [],
      // An SSH key's covered servers (VT-S12), `user@host:port` and whether agents can reach each now.
      ...(kind === 'ssh'
        ? {
            servers: servers.map((row) => {
              const server = toServer(row);
              return {
                name: server.name,
                target: vaultSshServerTarget(server) ?? server.name,
                ready: sshServerUsable(server),
              };
            }),
          }
        : {}),
      // An MCP server's name in Hermes's list this turn (CT-1241).
      ...(kind === 'mcp' ? { mcpServer: `vault_${entry.toolKey}` } : {}),
    };
  });
  return { entries, unheld };
}

/**
 * Whether the turn is the agent's for the person (VS-04, VS-12), not an outsiders' one (OP-17). The person's Vault is
 * what such a turn may use and save to.
 */
export async function ownAssistantTurn(
  db: Db | Tx,
  agentId: string,
  dispatch: Pick<DispatchBits, 'burrowId' | 'onBehalfOfAccountId'>,
): Promise<boolean> {
  if (!(await dispatchPerson(db, dispatch))) return false;
  const agent = await loadPrincipalRow(db, agentId);
  return agent?.kind === 'agent';
}

/** The Vault tools `/mcp` lists for this agent in this dispatch: the self-serve tools, in the person's turns. */
export async function vaultToolList(
  db: Db | Tx,
  agentId: string,
  dispatchId: string | undefined,
): Promise<Tool[]> {
  if (!dispatchId) return [];
  const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!dispatch || dispatch.agentId !== agentId) return [];
  // In the person's turn the agent saves what it is sent and adds servers to their SSH key (vault-self-serve.md VS-12).
  if (vaultless(dispatch)) return [];
  return (await ownAssistantTurn(db, agentId, dispatch)) ? servedVaultTools(VAULT_SELF_SERVE_TOOL_NAMES) : [];
}
