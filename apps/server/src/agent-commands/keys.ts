/**
 * The keys a turn holds (`runner.turnKeys`, docs/decisions/one-person.md OP-07, OP-S60, OP-S109):
 * the only place a key's value is unsealed. They reach the agent's commands through each command's wrapper.
 *
 * Which keys (hermes-engine.md HE-43): the agent's keys switched on (`can`), in the person's turns only —
 * nothing in an outsiders' turn (one-person.md OP-17, OP-S60). There are no passes: a key still at the old Ask level
 * counts as off. MCP entries go to Hermes, never to the commands.
 *
 * What lands where (AC-31):
 * - an SSH key: its private key at `ssh/<entry key>`, one `Host <server name> <host>` block per covered server whose host
 *   key the person trusted (HostName, Port, User, IdentityFile, IdentitiesOnly, StrictHostKeyChecking yes,
 *   UserKnownHostsFile), and `known_hosts` with those host keys; an untrusted server gets no block; a server with a
 *   kept password (vault-simplify.md VLT-42) also gets a `HostKeyAlias` (`wbpw1.invalid`, …), password sign-in after the key and
 *   its password in `askpass/<alias>` for the commands' askpass helper;
 * - every other entry: environment variables (`<NAME>`, or `<NAME>_USERNAME` and `<NAME>_PASSWORD`).
 *
 * `entries` name them. Each delivered entry is recorded as a use in the Vault's RECENT USE, once per turn
 * (`vaultTurnUseWhat`, signed `vault.used`, neutral text, VT-51).
 */
import {
  defaultVaultEnvName,
  type TurnKeys,
  VAULT_ASKPASS_DIR,
  VAULT_KEYS_DIR,
  type VaultAuth,
  vaultCredential,
  vaultKeyCoveredServers,
  vaultKeyDeliverable,
  vaultKeyEnvNames,
  vaultSshFingerprintOfBlob,
  vaultTurnUseWhat,
  withCredentialQuery,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { dispatches, vaultEntries, vaultSshServers, vaultUses } from '../db/schema/index';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import type { Services } from '../services';
import { vaultTurn } from '../vault/context';
import { openSsh, SshFailure } from '../vault/ssh';
import { firstContact, targetOf } from '../vault/ssh-check';
import { trustVaultSshFirstContact } from '../vault/ssh-commands';
import {
  onForAgent,
  serverRows,
  toolRows,
  type VaultEntryRow,
  type VaultSshServerRow,
  vaultSecretAad,
  vaultServerPasswordAad,
} from '../vault/store';
import { recordUse } from '../vault/uses';

const EMPTY: TurnKeys = { files: [], env: [], mcpServers: [], entries: [] };

/**
 * With a kept password in the turn, every other host loses keyboard-interactive sign-in (vault-simplify.md VLT-42): its
 * prompts are text a server writes and would reach the askpass helper, so a host could copy a kept server's prompt and be
 * handed its password. ssh takes the first value it finds, so this block comes last.
 */
const ANY_HOST_NO_KBD = ['Host *', '  KbdInteractiveAuthentication no'].join('\n');

/** How long a turn's keys wait for first contact with new servers (`meetNewServers`). */
const MEET_WAIT_MS = 5_000;

/** A delivered entry: the row, its key's variable and the servers its key covers. */
export interface DeliveredEntry {
  entry: VaultEntryRow;
  envName: string | null;
  servers: string[] | null;
}

/**
 * The keys this turn holds (AC-30, HE-43, CT-1240, CT-1241): the person's, switched on — an API's or an SSH key's for its
 * commands, an MCP server's in Hermes's tools (`mcp`). Nothing for a turn that never uses the Vault (`vaultTurn`: a
 * search answer, an outsiders' turn). A website login is the browser's (`DispatchContext.logins`).
 */
export async function deliveredEntries(
  services: Services,
  dispatch: DispatchRow,
  kinds: 'commands' | 'mcp' = 'commands',
): Promise<DeliveredEntry[]> {
  if (!(await vaultTurn(services.db, dispatch))) return [];
  const db = services.db;
  const rows = await db
    .select({ entry: vaultEntries })
    .from(vaultEntries)
    .where(and(onForAgent(dispatch.agentId), eq(vaultEntries.burrowId, dispatch.burrowId)));
  const out: DeliveredEntry[] = [];
  for (const { entry } of rows) {
    const fits = kinds === 'mcp' ? entry.kind === 'mcp' : vaultKeyDeliverable(entry);
    if (!fits || (entry.sealed === null && (entry.auth as VaultAuth | null)?.type !== 'none')) continue;
    out.push({
      entry,
      envName: entry.kind === 'http' ? (entry.envName ?? defaultVaultEnvName(entry.name)) : null,
      servers: entry.kind === 'ssh' ? (entry.agentServers ?? null) : null,
    });
  }
  return out.sort((a, b) => a.entry.name.localeCompare(b.entry.name) || a.entry.id.localeCompare(b.entry.id));
}

/** An SSH host pattern or value as `ssh_config` reads it (no spaces, quotes or control characters can come in). */
const sshToken = (s: string) => s.replace(/[\s"#\\]/g, '');

/** `known_hosts`' host field: `host`, or `[host]:port` off port 22. */
function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Whether the person trusts the server's host key now (pinned, and no other key seen since, VT-S05). */
const trusted = (s: VaultSshServerRow) => !!s.hostKeyFingerprint && !s.seenHostKeyFingerprint;

/**
 * The trusted host key's wire blob: the one kept on the row when it still matches the pin, else read from the server
 * now (and kept, only when its fingerprint is the pinned one). Null when it can't be had: the server gets no block.
 */
export async function trustedHostKeyBlob(
  services: Services,
  entry: VaultEntryRow,
  server: VaultSshServerRow,
): Promise<Buffer | null> {
  if (!trusted(server)) return null;
  const kept = server.hostKeyBlob ? Buffer.from(server.hostKeyBlob, 'base64') : null;
  if (kept && vaultSshFingerprintOfBlob(kept) === server.hostKeyFingerprint) return kept;
  let blob: Buffer | null = null;
  try {
    const opened = await openSsh(
      services,
      { ...targetOf(entry, server), pinned: null },
      { privateKey: null },
    );
    opened.client.end();
    blob = opened.hostKeyBlob;
  } catch (err) {
    blob = err instanceof SshFailure ? err.hostKeyBlob : null;
  }
  if (!blob || vaultSshFingerprintOfBlob(blob) !== server.hostKeyFingerprint) return null;
  const base64 = blob.toString('base64');
  // Bookkeeping, like a dispatch's lease: a cache of what the signed pin already says, checked on every use.
  await services.pipeline.transactAccount((tx) =>
    tx
      .update(vaultSshServers)
      .set({ hostKeyBlob: base64 })
      .where(
        and(
          eq(vaultSshServers.id, server.id),
          eq(vaultSshServers.hostKeyFingerprint, server.hostKeyFingerprint as string),
        ),
      ),
  );
  return blob;
}

/** A server's kept password, opened for the turn's keys; null when it has none (or it doesn't open). */
function keptPassword(services: Services, server: VaultSshServerRow): string | null {
  if (!server.passwordSealed) return null;
  try {
    return services.custody.open(vaultServerPasswordAad(server.entryId, server.id), server.passwordSealed);
  } catch {
    return null;
  }
}

/** Builds the turn's `TurnKeys` from the delivered entries (unsealing each value here, and only here). */
export async function buildTurnKeys(
  services: Services,
  delivered: readonly DeliveredEntry[],
): Promise<TurnKeys> {
  if (!delivered.length) return EMPTY;
  const files: TurnKeys['files'] = [];
  const env: TurnKeys['env'] = [];
  const hostBlocks: string[] = [];
  const knownHosts: string[] = [];
  const patterns = new Set<string>();
  const envNames = new Set<string>();
  let aliases = 0;
  const servers = await serverRows(
    services.db,
    delivered.filter((d) => d.entry.kind === 'ssh').map((d) => d.entry.id),
  );
  for (const d of delivered) {
    const { entry } = d;
    const value = services.custody.open(vaultSecretAad(entry.id), entry.sealed as string);
    if (entry.kind === 'ssh') {
      const path = `ssh/${entry.toolKey}`;
      files.push({
        path,
        mode: '600',
        base64: Buffer.from(value.endsWith('\n') ? value : `${value}\n`).toString('base64'),
      });
      const covered = vaultKeyCoveredServers(
        { servers: d.servers },
        servers.filter((s) => s.entryId === entry.id),
      );
      for (const server of covered) {
        const blob = await trustedHostKeyBlob(services, entry, server);
        if (!blob) continue;
        // `ssh` matches Host patterns as written: a name with capitals also answers to its lowercase form (VT-D61).
        const name = sshToken(server.name);
        const names = [...new Set([name, name.toLowerCase(), sshToken(server.host)])].filter(
          (n) => n && !patterns.has(n),
        );
        if (!names.length) continue;
        for (const n of names) patterns.add(n);
        // A kept password (vault-simplify.md VLT-42): ssh signs in with it through the askpass helper, which knows the
        // server by its alias in ssh's own prompt; the key is tried first, keyboard-interactive never. The alias ends in
        // `.invalid`, a name that never resolves, so `ssh root@<alias>` can't reach some other host that answers to it.
        const password = keptPassword(services, server);
        const alias = password !== null ? `wbpw${++aliases}.invalid` : null;
        hostBlocks.push(
          [
            `Host ${names.join(' ')}`,
            `  HostName ${sshToken(server.host)}`,
            `  Port ${server.port}`,
            `  User ${sshToken(server.username)}`,
            `  IdentityFile ${VAULT_KEYS_DIR}/${path}`,
            '  IdentitiesOnly yes',
            '  StrictHostKeyChecking yes',
            `  UserKnownHostsFile ${VAULT_KEYS_DIR}/known_hosts`,
            ...(alias
              ? [
                  `  HostKeyAlias ${alias}`,
                  '  PreferredAuthentications publickey,password',
                  '  KbdInteractiveAuthentication no',
                  '  NumberOfPasswordPrompts 1',
                ]
              : []),
          ].join('\n'),
        );
        const algorithm = server.hostKeyAlgorithm ?? 'ssh-ed25519';
        knownHosts.push(
          `${alias ?? knownHostsName(server.host, server.port)} ${algorithm} ${blob.toString('base64')}`,
        );
        if (alias && password !== null)
          files.push({
            path: `${VAULT_ASKPASS_DIR}/${alias}`,
            mode: '600',
            base64: Buffer.from(JSON.stringify({ user: server.username, password })).toString('base64'),
          });
      }
      continue;
    }
    const auth = entry.auth as VaultAuth | null;
    const names = vaultKeyEnvNames(d.envName ?? defaultVaultEnvName(entry.name), {
      kind: entry.kind,
      auth,
    });
    const username = auth && 'username' in auth && typeof auth.username === 'string' ? auth.username : '';
    const values = names.length === 2 ? [username, value] : [value];
    names.forEach((name, i) => {
      // Two keys may not choose the same variable: the first (by entry name) keeps it.
      if (envNames.has(name)) return;
      envNames.add(name);
      env.push({ name, value: values[i] ?? '' });
    });
  }
  if (hostBlocks.length) {
    files.push({
      path: 'ssh_config',
      mode: '600',
      base64: Buffer.from(
        `# Whombat: SSH keys for this turn, wiped when it ends.\n\n${[...hostBlocks, ...(aliases ? [ANY_HOST_NO_KBD] : [])].join('\n\n')}\n`,
      ).toString('base64'),
    });
    files.push({
      path: 'known_hosts',
      mode: '600',
      base64: Buffer.from(`${knownHosts.join('\n')}\n`).toString('base64'),
    });
  }
  return {
    files,
    env,
    mcpServers: [],
    entries: delivered.map((d) => ({ entryId: d.entry.id, name: d.entry.name })),
  };
}

/** Records each delivered entry as a use in the Vault's RECENT USE, once per turn (VT-52, CT-1244). */
async function recordDeliveries(
  services: Services,
  dispatch: DispatchRow,
  delivered: readonly DeliveredEntry[],
  what: string,
): Promise<void> {
  if (!delivered.length) return;
  const done = await services.db
    .select({ entryId: vaultUses.entryId })
    .from(vaultUses)
    .where(
      and(
        eq(vaultUses.dispatchId, dispatch.id),
        eq(vaultUses.what, what),
        inArray(
          vaultUses.entryId,
          delivered.map((d) => d.entry.id),
        ),
      ),
    );
  const recorded = new Set(done.map((r) => r.entryId));
  for (const d of delivered) {
    if (recorded.has(d.entry.id)) continue;
    await recordUse(
      services,
      { agentId: dispatch.agentId, burrowId: dispatch.burrowId, onBehalfOf: {} },
      {
        entryId: d.entry.id,
        dispatchId: dispatch.id,
        what,
        outcome: 'done',
        status: null,
        ms: 0,
        bytes: null,
      },
    );
  }
}

/**
 * First contact with the covered servers nobody met yet (vault-self-serve.md VS-10, as an agent's first use was when the
 * server connected for it): the key each shows is trusted, signed by the agent, unless another of the person's servers at
 * that address pins another; a server that doesn't answer stays without a pin. Only trusted servers get a block on the
 * commands (`buildTurnKeys`), so this is how a server the person added without a Check becomes reachable there.
 */
async function meetNewServers(
  services: Services,
  dispatch: DispatchRow,
  delivered: readonly DeliveredEntry[],
): Promise<void> {
  const ssh = delivered.filter((d) => d.entry.kind === 'ssh');
  if (!ssh.length) return;
  const servers = await serverRows(
    services.db,
    ssh.map((d) => d.entry.id),
  );
  const meet = async (entry: VaultEntryRow, server: VaultSshServerRow) => {
    try {
      const met = await firstContact(services, entry, server);
      if (!('trust' in met)) return;
      await services.pipeline.commit(
        trustVaultSshFirstContact,
        {
          entryId: entry.id,
          serverId: server.id,
          at: { host: server.host, port: server.port },
          hostKey: met.trust,
        },
        { burrowId: dispatch.burrowId, actorId: dispatch.agentId },
      );
    } catch (err) {
      // Unreachable now, or not an SSH server: it gets no block this turn.
      services.log.info({ err: err instanceof Error ? err.name : 'error' }, 'could not meet an SSH server');
    }
  };
  await Promise.all(
    ssh.flatMap((d) =>
      vaultKeyCoveredServers(
        { servers: d.servers },
        servers.filter((s) => s.entryId === d.entry.id),
      )
        .filter((server) => !server.hostKeyFingerprint && !server.seenHostKeyFingerprint)
        .map((server) => meet(d.entry, server)),
    ),
  );
}

/** `runner.turnKeys` for a live dispatch (the route checked the runner and its lease). */
export async function turnKeysFor(services: Services, dispatch: DispatchRow): Promise<TurnKeys> {
  const [row] = await services.db.select().from(dispatches).where(eq(dispatches.id, dispatch.id));
  const live = row ?? dispatch;
  const delivered = await deliveredEntries(services, live);
  // A server that doesn't answer never holds the turn up for long: what is met later counts from the next turn.
  await Promise.race([
    meetNewServers(services, live, delivered),
    new Promise((resolve) => setTimeout(resolve, MEET_WAIT_MS).unref?.()),
  ]);
  const keys = await buildTurnKeys(services, delivered);
  const mcp = await deliveredEntries(services, live, 'mcp');
  const servers = await mcpServersOf(services, mcp);
  const agent = await loadPrincipalRow(services.db, live.agentId);
  const agentName = agent ? shortName(agent) : 'the agent';
  await recordDeliveries(services, live, delivered, vaultTurnUseWhat('http', agentName));
  await recordDeliveries(services, live, mcp, vaultTurnUseWhat('mcp', agentName));
  return {
    ...keys,
    mcpServers: servers,
    entries: [...keys.entries, ...mcp.map((d) => ({ entryId: d.entry.id, name: d.entry.name }))],
  };
}

/**
 * An `mcp` entry switched on for the agent, as Hermes's MCP server for this turn only (CT-1241): `vault_<entry key>`,
 * the server's address (with the credential's query when it signs in that way), the headers that sign in, and the tools
 * the person left on. The value is unsealed here and goes nowhere a later turn reads.
 */
async function mcpServersOf(
  services: Services,
  delivered: readonly DeliveredEntry[],
): Promise<TurnKeys['mcpServers']> {
  const out: TurnKeys['mcpServers'] = [];
  for (const { entry } of delivered.slice(0, 16)) {
    if (!entry.url) continue;
    const auth = entry.auth as VaultAuth | null;
    const secret =
      entry.sealed === null ? null : services.custody.open(vaultSecretAad(entry.id), entry.sealed as string);
    const credential = auth && secret !== null && auth.type !== 'none' ? vaultCredential(auth, secret) : null;
    const tools = (await toolRows(services.db, entry.id)).filter((t) => t.enabled).map((t) => t.name);
    if (!tools.length) continue;
    out.push({
      name: `vault_${entry.toolKey}`,
      url: withCredentialQuery(entry.url, credential?.query ?? null),
      headers: Object.entries(credential?.headers ?? {})
        .slice(0, 4)
        .map(([name, value]) => ({ name, value })),
      tools: tools.slice(0, 64),
    });
  }
  return out;
}
