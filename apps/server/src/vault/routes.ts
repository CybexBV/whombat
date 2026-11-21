/**
 * REST for the Vault (`api.vault.*`, `api.vaultNetworks.*`; docs/decisions/vault.md). Thin adapters: reads are the
 * person's entries (an unknown one is a plain 404), writes go through the Vault commands, and a new
 * address is checked against the destination rule before it is saved (VT-13, `address_not_allowed`). The managed
 * dispatcher runs these same handlers over a session (secret ops: `vault.create`, `vault.setSecret`).
 */

import type { AnyEndpoint } from '@whombat/core';
import {
  api,
  newId,
  parseVaultSshHost,
  VAULT_ENTRIES_MAX,
  VAULT_ERROR_MESSAGES,
  VAULT_SSH_FIELD_TEXT,
} from '@whombat/core';
import { notFound, unauthorized } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, route } from '../routes/define';
import { runCheck } from './check';
import {
  createVaultEntry,
  fieldError,
  giveVaultKey,
  recordVaultCheck,
  removeVaultEntry,
  setVaultKeyEnvName,
  setVaultSecret,
  setVaultTool,
  takeVaultKey,
  updateVaultEntry,
  vaultError,
} from './commands';
import { destinationProblem } from './net';
import { addNetwork, networksResponse, removeNetwork } from './networks';
import { sshDestination } from './ssh';
import { checkFirstContact, mismatchResult, pinOf, readHostKey, runSshCheck } from './ssh-check';
import {
  addVaultSshServer,
  createVaultSshEntry,
  recordVaultSshCheck,
  removeVaultSshServer,
  replaceVaultSshKey,
  setVaultKeyServers,
  trustVaultSshHostKey,
  updateVaultSshServer,
} from './ssh-commands';
import { generateSshKey, importSshKey, rememberPassphrase, type SshKeyResult } from './ssh-keys';
import { entriesOf, entryDetail, entryViews, ownEntry, serverRow, usesOf, type VaultEntryRow } from './store';
import { setVaultTotp } from './totp';

type Ctx = Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>;

/** Refuses an address the destination rule doesn't allow now (VT-13), with the reason and what to add. */
async function checkDestination(ctx: Ctx, url: string): Promise<void> {
  const problem = await destinationProblem(ctx.services, url, 'save');
  if (problem)
    throw vaultError(
      'address_not_allowed',
      { problem: problem.code, ...(problem.suggestion ? { suggestion: problem.suggestion } : {}) },
      problem.message,
    );
}

/** A server's host and port refused by the SSH destination rule (VT-S06), with the reason and what to add. */
async function checkSshDestination(ctx: Ctx, host: string, port: number): Promise<void> {
  const { problem } = await sshDestination(ctx.services, host, port, 'save');
  if (problem)
    throw vaultError(
      'address_not_allowed',
      { problem: problem.code, ...(problem.suggestion ? { suggestion: problem.suggestion } : {}) },
      problem.message,
    );
}

/** A server's host as stored (`parseVaultSshHost`'s canonical form); the body schema already refused anything else. */
function canonicalHost(host: string): string {
  const parsed = parseVaultSshHost(host);
  if (!parsed) throw fieldError({ host: [VAULT_SSH_FIELD_TEXT.host] });
  return parsed.host;
}

/** An import that couldn't be opened, as the field error the form shows (`prefix`: `sshKey.` at create). */
function keyProblem(result: Extract<SshKeyResult, { ok: false }>, prefix = ''): never {
  throw fieldError({ [`${prefix}${result.field}`]: [result.message] }, result.message);
}

/** The caller's own `ssh` entry, or 404 / `wrong_kind`. */
async function ownSsh(ctx: Ctx, entryId: string): Promise<VaultEntryRow> {
  const row = await ownEntry(ctx.services.db, ctx.access.burrow.id, ctx.access.principal.id, entryId);
  if (row.kind !== 'ssh') throw vaultError('wrong_kind', {}, VAULT_ERROR_MESSAGES.wrong_kind);
  return row;
}

async function ownSshServer(ctx: Ctx, entry: VaultEntryRow, serverId: string) {
  const server = await serverRow(ctx.services.db, entry.id, serverId);
  if (!server) throw notFound('Server');
  return server;
}

async function detailOf(ctx: Ctx, entryId: string) {
  const row = await ownEntry(ctx.services.db, ctx.access.burrow.id, ctx.access.principal.id, entryId);
  return entryDetail(ctx.services.db, row);
}

async function writeAnswer(ctx: Ctx, result: { entryId: string; eventId: string | null }) {
  return { entry: await detailOf(ctx, result.entryId), eventId: result.eventId };
}

function accountOf(ctx: Pick<HandlerContext<AnyEndpoint>, 'auth'>) {
  if (!ctx.auth.account) throw unauthorized();
  return ctx.auth.account;
}

export const vaultRoutes = [
  route(api.vault.list, async (ctx) => {
    const { services, access } = ctx;
    const rows = await entriesOf(services.db, access.burrow.id, access.principal.id);
    return {
      entries: await entryViews(services.db, rows),
      canAdd: rows.length < VAULT_ENTRIES_MAX,
    };
  }),

  route(api.vault.get, async (ctx) => {
    const row = await ownEntry(
      ctx.services.db,
      ctx.access.burrow.id,
      ctx.access.principal.id,
      ctx.params.entryId,
    );
    return { entry: await entryDetail(ctx.services.db, row) };
  }),

  route(api.vault.create, async (ctx) => {
    // An SSH key (VT-S02, VT-S03): its key is made or opened here, with the entry's id it will carry; the pasted text
    // and its passphrase never reach a command. It has no address of its own: its servers come later.
    if (ctx.body.kind === 'ssh') {
      const source = ctx.body.sshKey;
      if (!source) throw fieldError({ sshKey: ['Choose “Generate a new key” or “Use my own key”.'] });
      const entryId = newId('vaultEntry');
      const made: SshKeyResult =
        source.mode === 'generate'
          ? { ok: true, key: generateSshKey(entryId) }
          : importSshKey(entryId, source.privateKey, source.passphrase);
      if (!made.ok) keyProblem(made, 'sshKey.');
      const result = await commitAs(ctx, createVaultSshEntry, {
        entryId,
        name: ctx.body.name,
        description: ctx.body.description,
        privateKey: made.key.privateKey,
        auth: made.key.auth,
      });
      if (source.mode === 'import') rememberPassphrase(entryId, source.passphrase);
      return writeAnswer(ctx, result);
    }
    if (ctx.body.kind !== 'secret' && ctx.body.url) await checkDestination(ctx, ctx.body.url);
    return writeAnswer(ctx, await commitAs(ctx, createVaultEntry, ctx.body));
  }),

  route(api.vault.update, async (ctx) => {
    const row = await ownEntry(
      ctx.services.db,
      ctx.access.burrow.id,
      ctx.access.principal.id,
      ctx.params.entryId,
    );
    if (row.kind !== 'secret' && ctx.body.url !== undefined && ctx.body.url !== row.url)
      await checkDestination(ctx, ctx.body.url);
    return writeAnswer(
      ctx,
      await commitAs(ctx, updateVaultEntry, { entryId: ctx.params.entryId, changes: ctx.body }),
    );
  }),

  route(api.vault.setSecret, async (ctx) =>
    writeAnswer(
      ctx,
      await commitAs(ctx, setVaultSecret, {
        entryId: ctx.params.entryId,
        value: ctx.body.value,
        ...(ctx.body.username !== undefined ? { username: ctx.body.username } : {}),
      }),
    ),
  ),

  route(api.vault.setTotp, async (ctx) =>
    writeAnswer(ctx, await commitAs(ctx, setVaultTotp, { entryId: ctx.params.entryId, totp: ctx.body.totp })),
  ),

  route(api.vault.remove, async (ctx) => {
    const { eventId } = await commitAs(ctx, removeVaultEntry, { entryId: ctx.params.entryId });
    return { ok: true as const, eventId };
  }),

  route(api.vault.check, async (ctx) => {
    const row = await ownEntry(
      ctx.services.db,
      ctx.access.burrow.id,
      ctx.access.principal.id,
      ctx.params.entryId,
    );
    if (row.kind === 'secret') throw vaultError('wrong_kind', {}, 'This secret has nothing to check.');
    // An SSH key's servers are checked one by one (VT-S05).
    if (row.kind === 'ssh') throw vaultError('wrong_kind', {}, 'Check each server of an SSH key.');
    // A website login is checked by Test sign-in in the browser (VT-D31).
    if (row.kind === 'login') throw vaultError('wrong_kind', {}, 'Use Test sign-in to check a login.');
    const run = await runCheck(ctx.services, row);
    await commitAs(ctx, recordVaultCheck, {
      entryId: row.id,
      result: run.result,
      tools: run.tools,
      beyond: run.beyond,
    });
    return { entry: await detailOf(ctx, row.id), result: run.result };
  }),

  route(api.vault.setTool, async (ctx) =>
    writeAnswer(
      ctx,
      await commitAs(ctx, setVaultTool, {
        entryId: ctx.params.entryId,
        tool: ctx.params.tool,
        enabled: ctx.body.enabled,
      }),
    ),
  ),

  route(api.vault.giveKey, async (ctx) =>
    writeAnswer(
      ctx,
      await commitAs(ctx, giveVaultKey, {
        entryId: ctx.params.entryId,
        ...(ctx.body.servers !== undefined ? { servers: ctx.body.servers } : {}),
        ...(ctx.body.envName !== undefined ? { envName: ctx.body.envName } : {}),
      }),
    ),
  ),

  /* SSH keys (VT-S03…VT-S07) --------------------------------------------------------------------------- */

  route(api.vault.generateSshKey, async (ctx) => {
    const row = await ownSsh(ctx, ctx.params.entryId);
    const key = generateSshKey(row.id);
    const result = await commitAs(ctx, replaceVaultSshKey, { entryId: row.id, ...key });
    rememberPassphrase(row.id, undefined);
    return writeAnswer(ctx, result);
  }),

  route(api.vault.replaceSshKey, async (ctx) => {
    const row = await ownSsh(ctx, ctx.params.entryId);
    const made = importSshKey(row.id, ctx.body.privateKey, ctx.body.passphrase);
    if (!made.ok) keyProblem(made);
    const result = await commitAs(ctx, replaceVaultSshKey, { entryId: row.id, ...made.key });
    rememberPassphrase(row.id, ctx.body.passphrase);
    return writeAnswer(ctx, result);
  }),

  route(api.vault.addSshServer, async (ctx) => {
    const row = await ownSsh(ctx, ctx.params.entryId);
    const host = canonicalHost(ctx.body.host);
    await checkSshDestination(ctx, host, ctx.body.port);
    const result = await commitAs(ctx, addVaultSshServer, {
      entryId: row.id,
      name: ctx.body.name,
      host,
      port: ctx.body.port,
      username: ctx.body.username,
      ...(ctx.body.production !== undefined ? { production: ctx.body.production } : {}),
    });
    return { ...(await writeAnswer(ctx, result)), serverId: result.serverId };
  }),

  route(api.vault.updateSshServer, async (ctx) => {
    const row = await ownSsh(ctx, ctx.params.entryId);
    const server = await ownSshServer(ctx, row, ctx.params.serverId);
    const host = ctx.body.host !== undefined ? canonicalHost(ctx.body.host) : server.host;
    const port = ctx.body.port ?? server.port;
    if (host !== server.host || port !== server.port) await checkSshDestination(ctx, host, port);
    const result = await commitAs(ctx, updateVaultSshServer, {
      entryId: row.id,
      serverId: server.id,
      changes: {
        ...(ctx.body.name !== undefined ? { name: ctx.body.name } : {}),
        ...(ctx.body.host !== undefined ? { host } : {}),
        ...(ctx.body.port !== undefined ? { port } : {}),
        ...(ctx.body.username !== undefined ? { username: ctx.body.username } : {}),
        ...(ctx.body.production !== undefined ? { production: ctx.body.production } : {}),
      },
    });
    return { ...(await writeAnswer(ctx, result)), serverId: result.serverId };
  }),

  route(api.vault.removeSshServer, async (ctx) =>
    writeAnswer(
      ctx,
      await commitAs(ctx, removeVaultSshServer, {
        entryId: ctx.params.entryId,
        serverId: ctx.params.serverId,
      }),
    ),
  ),

  // Check (VT-S05): signs nothing, except the trust of first contact; the result is the server's check.
  route(api.vault.checkSshServer, async (ctx) => {
    const row = await ownSsh(ctx, ctx.params.entryId);
    let server = await ownSshServer(ctx, row, ctx.params.serverId);
    const at = { host: server.host, port: server.port };
    let eventId: string | null = null;
    // A server without a pin trusts the key it shows (vault-self-serve.md VS-10), unless another of the person's
    // servers at that address pins another; then it signs in as any Check does.
    if (!pinOf(server)) {
      const met = await checkFirstContact(ctx.services, row, server);
      if ('failed' in met) {
        await commitAs(ctx, recordVaultSshCheck, {
          entryId: row.id,
          serverId: server.id,
          at,
          result: met.failed,
        });
        return { entry: await detailOf(ctx, row.id), result: met.failed, eventId: null };
      }
      const trusted = await commitAs(ctx, trustVaultSshHostKey, {
        entryId: row.id,
        serverId: server.id,
        at,
        hostKey: met.trust,
      });
      eventId = trusted.eventId;
      server = (await serverRow(ctx.services.db, row.id, server.id)) ?? server;
    }
    const result = await runSshCheck(ctx.services, row, server);
    await commitAs(ctx, recordVaultSshCheck, { entryId: row.id, serverId: server.id, at, result });
    return { entry: await detailOf(ctx, row.id), result, eventId };
  }),

  // Trust this server (VT-S05): the key is read again and trusted only when it is still the one the person saw; then
  // it signs in once, as a Check does.
  route(api.vault.trustSshHostKey, async (ctx) => {
    const row = await ownSsh(ctx, ctx.params.entryId);
    const server = await ownSshServer(ctx, row, ctx.params.serverId);
    const at = { host: server.host, port: server.port };
    const read = await readHostKey(ctx.services, row, server);
    if ('failed' in read) {
      await commitAs(ctx, recordVaultSshCheck, {
        entryId: row.id,
        serverId: server.id,
        at,
        result: read.failed,
      });
      return { entry: await detailOf(ctx, row.id), result: read.failed, eventId: null };
    }
    if (read.hostKey.fingerprint !== ctx.body.fingerprint) {
      await commitAs(ctx, recordVaultSshCheck, {
        entryId: row.id,
        serverId: server.id,
        at,
        result: mismatchResult(ctx.services, server, read.hostKey),
      });
      throw vaultError('host_key_mismatch', { hostKey: read.hostKey });
    }
    const trusted = await commitAs(ctx, trustVaultSshHostKey, {
      entryId: row.id,
      serverId: server.id,
      at,
      hostKey: read.hostKey,
    });
    const pinnedServer = (await serverRow(ctx.services.db, row.id, server.id)) ?? server;
    const result = await runSshCheck(ctx.services, row, pinnedServer);
    await commitAs(ctx, recordVaultSshCheck, { entryId: row.id, serverId: server.id, at, result });
    return { entry: await detailOf(ctx, row.id), result, eventId: trusted.eventId };
  }),

  route(api.vault.setKeyServers, async (ctx) =>
    writeAnswer(
      ctx,
      await commitAs(ctx, setVaultKeyServers, {
        entryId: ctx.params.entryId,
        servers: ctx.body.servers,
      }),
    ),
  ),

  route(api.vault.setKeyEnvName, async (ctx) =>
    writeAnswer(
      ctx,
      await commitAs(ctx, setVaultKeyEnvName, { entryId: ctx.params.entryId, envName: ctx.body.envName }),
    ),
  ),

  route(api.vault.takeKey, async (ctx) =>
    writeAnswer(ctx, await commitAs(ctx, takeVaultKey, { entryId: ctx.params.entryId })),
  ),

  route(api.vault.uses, async (ctx) => {
    const row = await ownEntry(
      ctx.services.db,
      ctx.access.burrow.id,
      ctx.access.principal.id,
      ctx.params.entryId,
    );
    return usesOf(ctx.services.db, row.id, { limit: ctx.query.limit, before: ctx.query.before });
  }),

  route(api.vaultNetworks.list, async (ctx) => networksResponse(ctx.services)),

  route(api.vaultNetworks.add, async (ctx) => {
    const account = accountOf(ctx);
    await addNetwork(ctx.services, account.id, ctx.body);
    return networksResponse(ctx.services);
  }),

  route(api.vaultNetworks.remove, async (ctx) => {
    await removeNetwork(ctx.services, ctx.params.networkId);
    return networksResponse(ctx.services);
  }),
];
