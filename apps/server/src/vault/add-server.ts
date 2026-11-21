/**
 * `vault_add_server` (docs/decisions/vault-self-serve.md VS-09…VS-11; contracts 0.112.0 CT-781): the agent adds a
 * server to one of the person's SSH keys and signs in to it, so its commands reach it from the next turn's keys
 * (hermes-engine.md HE-43).
 *
 * - **Which key**: `entry`; else their only SSH key; with none a new ed25519 key “Servers” is made (as SI-09) in the
 *   commit that adds the server; with several, `blocked` naming them. A key the person switched off for the assistant —
 *   or left at the old “Ask me first” — is refused with how to switch it back on (`keyTurns`).
 * - **Where**: `address` is a host or IP with `:port` (22 by default), checked by the SSH destination rule (VT-S06, LN);
 *   `username` given, else the one the key's servers share, else `root`.
 * - **Who it is** (VS-10): the host key it shows is taken when no server of the person's at that host and port pins one,
 *   else it must be one of theirs (`host_key_changed`: nothing added, nothing sent).
 * - **The key on it**: the key signs in (`signed_in`) or is refused (`key_refused`, with the line for the person to add);
 *   the server is added either way. The tool takes no password (vault-simplify.md VLT-43: its `password` is ignored): a
 *   refused key is the agent's cue to ask with a `server` card (`vault_ask`, `ask-server.ts`), which puts the key on
 *   with a password the person types there and never in the chat.
 * - **Its name**: `name`, else the server's own `hostname -s` (cleaned to the name pattern), else the address with dots
 *   as dashes; `-2`, `-3` … when taken. The same host, port and user already there answers `already`.
 *
 * One commit signed by the assistant (`vault.add_server`): the key (when new, with the assistant's key, VS-01), the server
 * with its pin and check, the assistant's key covering it (All servers, or its list gains it), `vault.entry.changed`.
 */
import {
  newId,
  parseVaultSshAddress,
  VAULT_FAILURE_TEXT,
  VAULT_LIMIT_MESSAGES,
  VAULT_SSH_FIELD_TEXT,
  VAULT_SSH_SERVERS_MAX,
  type VaultAddServerInput,
  type VaultAddServerOutput,
  VaultAuth,
  VaultEntryId,
  VaultPort,
  VaultSshHostKey,
  type VaultSshKeyAuth,
  vaultSshAuthorizedKeysLine,
  vaultSshCheckStatus,
  vaultSshCheckSummary,
  vaultSshServerTarget,
  vaultUnheldAskLine,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Client } from 'ssh2';
import { z } from 'zod';
import { rememberTurnSecret } from '../agent-commands/secrets';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, vaultEntries, vaultSshServers } from '../db/schema/index';
import { ApiError, forbidden } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { shortName } from '../read/principals';
import type { Services } from '../services';
import {
  emitEntryEvent,
  forgetHeldSecretsAfter,
  giveOwnAssistantKey,
  insertEntry,
  publishVaultUpdated,
  vaultError,
} from './commands';
import { blankSecret, blocked, type OwnTurn, ownTurn, personWrote, SELF_SERVE_TEXT } from './self-serve';
import { SshFailure, sshCloseGraceMs, sshDestination, sshExec } from './ssh';
import { entryChanged, nameTaken } from './ssh-commands';
import { generateSshKey, type SshKeyForms, sshKeyForms } from './ssh-keys';
import { openSshSignIn } from './ssh-signin';
import {
  agentKeyFor,
  serverRows,
  type VaultEntryRow,
  vaultPins,
  vaultSecretAad,
  vaultServerPasswordAad,
} from './store';
import { failed, keyTurns, whereOf } from './uses';

type AddInput = z.output<typeof VaultAddServerInput>;
type Failed = Extract<VaultAddServerOutput, { status: 'failed' }>;

/** The new key's name and description when the person has none (as Sign in once's, SI-09). */
export const SERVERS_KEY = {
  name: 'Servers',
  description: 'Signs Whombat in to the servers it added.',
} as const;

/** What the answers say (plain, to the agent). */
export const ADD_SERVER_TEXT = {
  notSsh: (name: string) => `That isn’t one of ${name}’s SSH keys.`,
  several: (name: string, keys: readonly string[]) =>
    `${name} has several SSH keys: ${keys.map((k) => `“${k}”`).join(', ')}. Say which one with entry.`,
} as const;

/** A server's own host name (`hostname -s`) as a server name, or null: lower case, the name pattern, ≤ 36. */
export function serverNameOf(hostname: string): string | null {
  const name = hostname
    .trim()
    .split(/\s/)[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 36)
    .replace(/[._-]+$/, '');
  return name ? name : null;
}

/** The address as a server name (VS-09): dots and colons as dashes (`192-168-1-20`). */
export function addressName(host: string): string {
  return serverNameOf(host.replace(/[.:]/g, '-')) ?? 'server';
}

/** How an SSH failure answers (our words, never the server's). */
export function failureOf(err: unknown): Failed {
  if (!(err instanceof SshFailure)) return failed('unreachable', VAULT_FAILURE_TEXT.unreachable);
  switch (err.reason) {
    case 'not_allowed':
      return failed('not_allowed', err.message);
    case 'bad_answer':
      return failed('rejected', 'It answered, but not as an SSH server.');
    case 'busy':
      return failed('busy', VAULT_FAILURE_TEXT.busy);
    case 'host_key_unconfirmed':
      return failed('host_key_changed', VAULT_FAILURE_TEXT.host_key_changed);
    default:
      return failed(err.reason, VAULT_FAILURE_TEXT[err.reason]);
  }
}

/** Runs `hostname -s` on a signed-in connection; null when it doesn't answer one. */
export async function hostnameOn(
  services: Services,
  client: Client,
  forms: SshKeyForms,
): Promise<string | null> {
  const out = await sshExec(
    client,
    {
      command: 'hostname -s',
      timeoutMs: 10_000,
      maxOutput: 4096,
      openMs: 10_000,
      graceMs: sshCloseGraceMs(services),
    },
    forms,
  ).catch(() => null);
  if (!out || out.withheld || out.exitCode !== 0) return null;
  return serverNameOf(out.stdout);
}

/** The person's SSH keys in this burrow, by name. */
export async function sshKeysOf(db: Db | Tx, burrowId: string, ownerId: string): Promise<VaultEntryRow[]> {
  return db
    .select()
    .from(vaultEntries)
    .where(
      and(
        eq(vaultEntries.burrowId, burrowId),
        eq(vaultEntries.ownerId, ownerId),
        eq(vaultEntries.kind, 'ssh'),
      ),
    )
    .orderBy(sql`lower(${vaultEntries.name})`, vaultEntries.id);
}

/** A server as a commit adds it to a key: where, who it is, whether the key signed in. */
export interface PutServer {
  name: string;
  host: string;
  port: number;
  username: string;
  hostKey: z.output<typeof VaultSshHostKey>;
  signedIn: boolean;
  /** A password the commands sign in with (“Keep the password”, vault-simplify.md VLT-42), in the clear inside the commit. */
  password?: string | undefined;
}

/**
 * Adds a server to an SSH key in the caller's commit (or updates the same host, port and user there): pinned on first
 * contact, its check what this sign-in found, a kept password sealed with it, and the agent's switch covering it (All
 * servers already does, a list gains it). The caller has checked the pins; `vault.entry.changed` and `vault.updated` are
 * its own.
 */
export async function putServer(
  ctx: ApplyContext,
  entry: VaultEntryRow,
  agentId: string,
  s: PutServer,
): Promise<{ serverId: string; name: string; already: boolean }> {
  const tx = ctx.tx;
  const servers = await serverRows(tx, [entry.id]);
  const same = servers.find(
    (r) => r.host.toLowerCase() === s.host.toLowerCase() && r.port === s.port && r.username === s.username,
  );
  const outcome = s.signedIn ? ('reached' as const) : ('rejected' as const);
  const check = {
    checkStatus: vaultSshCheckStatus(outcome),
    checkOutcome: outcome,
    checkSummary: vaultSshCheckSummary(outcome, { username: s.username }).slice(0, 300),
    checkedAt: ctx.now,
  };
  const pin = {
    hostKeyAlgorithm: s.hostKey.algorithm,
    hostKeyFingerprint: s.hostKey.fingerprint,
    hostKeyTrustedAt: ctx.now,
    hostKeyBlob: null,
    seenHostKeyAlgorithm: null,
    seenHostKeyFingerprint: null,
    seenHostKeyAt: null,
  };
  let serverId: string;
  let name: string;
  if (same) {
    serverId = same.id;
    name = same.name;
  } else {
    if (servers.length >= VAULT_SSH_SERVERS_MAX)
      throw vaultError(
        'limit_reached',
        { limit: 'servers', max: VAULT_SSH_SERVERS_MAX },
        VAULT_LIMIT_MESSAGES.servers,
      );
    const base = s.name.slice(0, 36);
    name = base;
    for (let n = 2; await nameTaken(ctx, entry.id, name); n++) name = `${base}-${n}`;
    serverId = newId('vaultSshServer');
  }
  const password =
    s.password !== undefined
      ? {
          passwordSealed: ctx.services.custody.seal(vaultServerPasswordAad(entry.id, serverId), s.password),
          passwordSetAt: ctx.now,
        }
      : {};
  if (same)
    // Already there: pinned now if nobody had (first contact), its check what this sign-in found.
    await tx
      .update(vaultSshServers)
      .set({ ...(same.hostKeyFingerprint ? {} : pin), ...check, ...password, updatedAt: ctx.now })
      .where(eq(vaultSshServers.id, same.id));
  else
    await tx.insert(vaultSshServers).values({
      id: serverId,
      burrowId: ctx.burrow.id,
      entryId: entry.id,
      name,
      host: s.host,
      port: s.port,
      username: s.username,
      production: false,
      ...pin,
      ...check,
      ...password,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  const key = await agentKeyFor(tx, entry, agentId);
  if (key?.servers && !key.servers.includes(serverId))
    await tx
      .update(vaultEntries)
      .set({ agentServers: [...key.servers, serverId] })
      .where(eq(vaultEntries.id, entry.id));
  // What the agent's commands get changed with it (a kept password is scrubbed from what it writes).
  if (s.password !== undefined) forgetHeldSecretsAfter(ctx, agentId);
  return { serverId, name, already: !!same };
}

/** The commit (VS-09, VS-10), signed by the assistant. */
export const addServerForPerson = defineCommand({
  name: 'vault.add_server',
  schema: z.object({
    dispatchId: z.string(),
    entryId: VaultEntryId,
    /** A new “Servers” key: its private half sealed under its entry's AAD, its public sign-in. */
    create: z
      .object({
        sealed: z.string().min(1).max(20_000),
        auth: VaultAuth.refine((a) => a.type === 'ssh_key'),
      })
      .optional(),
    name: z.string().min(1).max(40),
    host: z.string().min(1).max(253),
    port: VaultPort,
    username: z.string().min(1).max(32),
    hostKey: VaultSshHostKey,
    signedIn: z.boolean(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden(SELF_SERVE_TEXT.notOwn);
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!dispatch || dispatch.agentId !== ctx.actor.id) throw forbidden('This dispatch is gone.');
    const turn = await ownTurn(tx, { agentId: ctx.actor.id, burrowId: ctx.burrow.id, dispatch });
    if (!turn) throw forbidden(SELF_SERVE_TEXT.notOwn);
    const { person, agent } = turn;
    const pins = await vaultPins(tx, ctx.burrow.id, person.id, input.host, input.port);
    if (pins.length && !pins.some((p) => p.fingerprint === input.hostKey.fingerprint))
      return { changed: true as const };
    let entry: VaultEntryRow;
    if (input.create) {
      if (!person.accountId) throw forbidden(SELF_SERVE_TEXT.notOwn);
      entry = await insertEntry(
        ctx,
        {
          kind: 'ssh',
          name: SERVERS_KEY.name,
          description: SERVERS_KEY.description,
          auth: input.create.auth,
          secret: ctx.services.custody.open(vaultSecretAad(input.entryId), input.create.sealed),
        } as never,
        { id: input.entryId, owner: { principalId: person.id, accountId: person.accountId } },
      );
      await emitEntryEvent(ctx, 'entry.added', entry);
      await giveOwnAssistantKey(ctx, entry);
    } else {
      const [own] = await tx
        .select()
        .from(vaultEntries)
        .where(and(eq(vaultEntries.id, input.entryId), eq(vaultEntries.ownerId, person.id)));
      if (own?.kind !== 'ssh') throw forbidden(SELF_SERVE_TEXT.notOwn);
      entry = own;
    }
    const put = await putServer(ctx, entry, agent.id, input);
    await entryChanged(ctx, entry);
    publishVaultUpdated(ctx, person.id, entry.id);
    return {
      changed: false as const,
      entryId: entry.id,
      entryName: entry.name,
      serverId: put.serverId,
      server: put.name,
      already: put.already,
    };
  },
});

/** The AAD a password the agent passed anyway travels the blanking commit under: one turn's, never stored. */
export function oncePasswordAad(dispatchId: string): string {
  return `vault:once:${dispatchId}`;
}

/**
 * A server's password the agent passed anyway (VLT-43: the tool ignores it): when it is in the person's own message it
 * is blanked there without a line, as VS-S17 blanked one that put no key on — never used, never kept. Signed by the
 * assistant, a hidden `vault.secret_blanked` naming the messages.
 */
export const blankOncePassword = defineCommand({
  name: 'vault.blank_once',
  schema: z.object({
    dispatchId: z.string(),
    /** The password, sealed under `oncePasswordAad`. */
    once: z.string().min(1).max(8_000),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden(SELF_SERVE_TEXT.notOwn);
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!dispatch || dispatch.agentId !== ctx.actor.id) throw forbidden('This dispatch is gone.');
    const turn = await ownTurn(tx, { agentId: ctx.actor.id, burrowId: ctx.burrow.id, dispatch });
    if (!turn) throw forbidden(SELF_SERVE_TEXT.notOwn);
    const password = ctx.services.custody.open(oncePasswordAad(input.dispatchId), input.once);
    const messageIds = await blankSecret(ctx, {
      conversationId: dispatch.conversationId,
      authorIds: [turn.person.id, turn.agent.id],
      secret: password,
      save: null,
    });
    if (messageIds.length)
      await ctx.emit({
        type: 'vault.secret_blanked',
        kind: 'Vault',
        text: null,
        where: await whereOf(tx, dispatch.conversationId),
        payload: { dispatchId: input.dispatchId, messageIds },
      });
    return { blanked: messageIds.length };
  },
});

/**
 * A password passed anyway leaves the chat: scrubbed from what the assistant writes for the rest of the turn, and blanked
 * where the person wrote it. A failure is logged, never thrown.
 */
async function blankIgnoredPassword(ctx: ToolContext, turn: OwnTurn, password: string): Promise<void> {
  const { services } = ctx;
  rememberTurnSecret(services, turn.agent.id, ctx.dispatch.id, password);
  if (
    !(await personWrote(services.db, ctx.dispatch.conversationId, turn.person.id, password, services.clock()))
  )
    return;
  await services.pipeline
    .commit(
      blankOncePassword,
      {
        dispatchId: ctx.dispatch.id,
        once: services.custody.seal(oncePasswordAad(ctx.dispatch.id), password),
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    )
    .catch((err: unknown) =>
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'vault: a server’s password wasn’t blanked',
      ),
    );
}

/** `vault_add_server` (VS-09, VS-10; VLT-43: its `password` is ignored). */
export async function vaultAddServerTool(ctx: ToolContext, input: AddInput): Promise<VaultAddServerOutput> {
  const { services } = ctx;
  const db = services.db;
  const turn = await ownTurn(db, ctx);
  if (!turn) return blocked(ctx, 'vault_add_server', SELF_SERVE_TEXT.notOwn);
  if (input.password !== undefined) await blankIgnoredPassword(ctx, turn, input.password);
  const { person } = turn;
  const address = parseVaultSshAddress(input.address);
  if (!address) return failed('invalid_request', VAULT_SSH_FIELD_TEXT.address);
  const { host, port } = address;

  // Which key (VS-09).
  const picked = await pickSshKey(ctx, turn, input.entry);
  if ('status' in picked) return picked;
  const entry = picked.entry;
  const target = (username: string) => vaultSshServerTarget({ host, port, username });

  // Where (VT-S06): refused before anything is dialled.
  const { problem } = await sshDestination(services, host, port, 'save');
  if (problem) return failed('not_allowed', problem.message);
  const servers = entry ? await serverRows(db, [entry.id]) : [];
  const username = input.username ?? usualUser(servers);
  const same = servers.find(
    (s) => s.host.toLowerCase() === host.toLowerCase() && s.port === port && s.username === username,
  );
  if (same?.hostKeyFingerprint && entry)
    return {
      status: 'ok',
      entryId: entry.id,
      entryName: entry.name,
      server: same.name,
      target: target(username),
      outcome: 'already',
      publicKey: null,
    };

  // The key: the person's, or a new “Servers” key (kept only with the server, in the same commit).
  const entryId = entry?.id ?? newId('vaultEntry');
  const made = entry ? null : generateSshKey(entryId);
  if (entry && !entry.sealed) return failed('invalid_request', 'That Vault entry has no secret yet.');
  const privateKey =
    made?.privateKey ?? services.custody.open(vaultSecretAad(entryId), (entry as VaultEntryRow).sealed ?? '');
  const auth = (made?.auth ?? entry?.auth) as VaultSshKeyAuth;
  const line = vaultSshAuthorizedKeysLine(auth.publicKey, entryId);
  const forms = sshKeyForms(entryId, privateKey);
  const pins = await vaultPins(db, ctx.burrowId, person.id, host, port);
  const where = { host, port, username };

  // Who it is (VS-10), and whether the key opens it.
  let hostKey: z.output<typeof VaultSshHostKey>;
  let signedIn = false;
  let hostname: string | null = null;
  try {
    const opened = await openSshSignIn(services, where, { privateKey }, { pins });
    hostKey = opened.hostKey;
    signedIn = true;
    try {
      if (input.name === undefined) hostname = await hostnameOn(services, opened.client, forms);
    } finally {
      opened.client.end();
    }
  } catch (err) {
    // Refused the key: the server is still added, trusted, with the line for the person (`key_refused`).
    if (!(err instanceof SshFailure && err.reason === 'rejected' && err.hostKey)) return failureOf(err);
    hostKey = err.hostKey;
  }

  try {
    const res = await services.pipeline.commit(
      addServerForPerson,
      {
        dispatchId: ctx.dispatch.id,
        entryId,
        ...(made
          ? {
              create: {
                sealed: services.custody.seal(vaultSecretAad(entryId), made.privateKey),
                auth: made.auth,
              },
            }
          : {}),
        name: input.name ?? hostname ?? addressName(host),
        host,
        port,
        username,
        hostKey,
        signedIn,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (res.status !== 'ok') return failed('invalid_request', 'That can’t be added now.');
    const result = res.result;
    if (result.changed) return failed('host_key_changed', VAULT_FAILURE_TEXT.host_key_changed);
    const outcome = result.already ? 'already' : signedIn ? 'signed_in' : 'key_refused';
    return {
      status: 'ok',
      entryId: result.entryId,
      entryName: result.entryName,
      server: result.server,
      target: target(username),
      outcome,
      publicKey: outcome === 'key_refused' ? line : null,
    };
  } catch (err) {
    if (err instanceof ApiError) return failed('invalid_request', err.message);
    throw err;
  }
}

/** The user a key's servers share, else root (VS-09). */
export function usualUser(servers: readonly { username: string }[]): string {
  const users = [...new Set(servers.map((s) => s.username))];
  return users.length === 1 ? (users[0] as string) : 'root';
}

/**
 * Which of the person's SSH keys (VS-09): `ref` (an id or its key), else their only one; null when they have none (a new
 * “Servers” key is made). Several without `ref` is `blocked` naming them; a key switched off for the agent is `blocked`
 * with how to switch it back on.
 */
export async function pickSshKey(
  ctx: ToolContext,
  turn: OwnTurn,
  ref: string | undefined,
): Promise<{ entry: VaultEntryRow | null } | Failed | Extract<VaultAddServerOutput, { status: 'blocked' }>> {
  const db = ctx.services.db;
  const keys = await sshKeysOf(db, ctx.burrowId, turn.person.id);
  let entry: VaultEntryRow | null;
  if (ref !== undefined) {
    entry = keys.find((k) => k.id === ref || k.toolKey === ref) ?? null;
    if (!entry) return failed('invalid_request', ADD_SERVER_TEXT.notSsh(turn.name));
  } else {
    if (keys.length > 1)
      return blocked(
        ctx,
        'vault_add_server',
        ADD_SERVER_TEXT.several(
          turn.name,
          keys.map((k) => k.name),
        ),
      );
    entry = keys[0] ?? null;
  }
  // The assistant may use the key now: switched on for it, in its person's turn (hermes-engine.md HE-43).
  if (entry && !keyTurns(await agentKeyFor(db, entry, turn.agent.id), ctx.dispatch))
    return blocked(
      ctx,
      'vault_add_server',
      vaultUnheldAskLine({
        personFirstName: turn.name,
        entryName: entry.name,
        agentName: shortName(turn.agent),
      }),
    );
  return { entry };
}
