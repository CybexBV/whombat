/**
 * The `server` card (docs/decisions/vault-simplify.md VLT-42, CT-1660…CT-1662): the assistant asks to sign in to a
 * server, new or one that refused its key, and the person answers on the card in one of three ways, never in the chat.
 *
 * - **Asking** (`askServerCard`): the address checked as the Vault checks a server's (VT-S06), the key picked as
 *   `vault_add_server` picks it (`entry`, else the person's only key, else a new “Servers” key when they sign in), the
 *   user given or the key's servers' usual one, else root. Nothing is dialled yet.
 * - **`key_once`**: when the assistant's key already opens it, that is all (`signed_in`, the password unused); else
 *   Whombat signs in once with the password, adds the key's `authorized_keys` line (SI-09's command), signs in again with
 *   the key (`key_added`) and forgets the password.
 * - **`keep_password`**: the password signs in and is kept sealed with that server (`password_saved`); the commands sign
 *   in with it through their askpass helper.
 * - **`own_key`**: the pasted key is opened with its passphrase (used once, never kept), signs in, and is saved as a
 *   Server key entry of its own covering the server (`key_imported`).
 *
 * The host key is trusted on first contact (VS-10): a server another pin of the person's names at that address must
 * show it, else nothing is sent (`host_key_changed`). A try that doesn't sign in is a field error in core's words while
 * tries are left; the third closes the card `refused`. The commit is signed by the person; a password or key reaches it
 * sealed (as `vault_save`'s does, VS-S04) and is opened inside it. Never logged.
 */
import {
  GUIDE_VAULT_SERVER_TRIES,
  type GuideCard,
  type GuideVaultAsk,
  type GuideVaultRefusal,
  type GuideVaultServerWay,
  newId,
  parseVaultSshAddress,
  topics,
  VAULT_ASK_FIELDS,
  VAULT_ASK_TEXT,
  VAULT_SSH_FIELD_TEXT,
  type VaultAskInput,
  type VaultAskOutput,
  VaultAuth,
  VaultEntryId,
  VaultPort,
  VaultSshHostKey,
  type VaultSshKeyAuth,
  vaultAskCard,
  vaultAskErrorField,
  vaultAskErrorText,
  vaultAskWay,
  vaultSshAuthorizedKeysLine,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { messages, vaultEntries } from '../db/schema/index';
import { postAskCard } from '../guides/ask';
import type { SavedVault } from '../guides/flows';
import { guideError, type PersonalPlace } from '../guides/place';
import { KEEP_KEY_COMMAND } from '../hosts/install';
import { ApiError, forbidden } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { loadMessages, type MessageRow } from '../read/messages';
import { loadAgentRow, shortName } from '../read/principals';
import type { Services } from '../services';
import {
  addressName,
  hostnameOn,
  pickSshKey,
  putServer,
  SERVERS_KEY,
  sshKeysOf,
  usualUser,
} from './add-server';
import { emitEntryEvent, giveOwnAssistantKey, insertEntry, publishVaultUpdated } from './commands';
import type { OwnTurn } from './self-serve';
import { SshFailure, sshCloseGraceMs, sshDestination, sshExec } from './ssh';
import { entryChanged } from './ssh-commands';
import { generateSshKey, importSshKey, sshKeyForms } from './ssh-keys';
import { openSshSignIn } from './ssh-signin';
import { serverRows, type VaultEntryRow, vaultPins, vaultSecretAad } from './store';
import { failed } from './uses';

type Input = z.output<typeof VaultAskInput>;

/** The AAD a password or private key travels the card's commit under: that card's only, never stored. */
export function cardTransitAad(messageId: string): string {
  return `vault:ask:${messageId}`;
}

/** `vault_ask` kind `server`: the card, after the address, the key and the user are known. */
export async function askServerCard(ctx: ToolContext, turn: OwnTurn, input: Input): Promise<VaultAskOutput> {
  const { services } = ctx;
  const address = parseVaultSshAddress(input.address ?? '');
  if (!address) return failed('invalid_request', VAULT_SSH_FIELD_TEXT.address);
  const { host, port } = address;
  const picked = await pickSshKey(ctx, turn, input.entry);
  if ('status' in picked) return picked as VaultAskOutput;
  const { problem } = await sshDestination(services, host, port, 'save');
  if (problem) return failed('not_allowed', problem.message);
  const servers = picked.entry ? await serverRows(services.db, [picked.entry.id]) : [];
  const username = input.username ?? usualUser(servers);
  const same = servers.find(
    (s) => s.host.toLowerCase() === host.toLowerCase() && s.port === port && s.username === username,
  );
  const ask: GuideVaultAsk = {
    kind: 'server',
    name: input.name ?? same?.name ?? host,
    url: null,
    username,
    description: input.why ?? '',
    entryId: picked.entry?.id ?? null,
    server: { host, port, reason: input.reason ?? 'new', serverId: same?.id ?? null, tries: 0 },
  };
  const messageId = await postAskCard(ctx, vaultAskCard(shortName(turn.agent), ask, input.why ?? null));
  return { status: 'ok', messageId };
}

/** A try that didn't sign in: why, in the card's words (`GuideVaultRefusal`). */
class Refused extends Error {
  constructor(
    readonly refusal: GuideVaultRefusal,
    /** The Vault's own words for a key it can't use (`VAULT_SSH_KEY_PROBLEM_TEXT`), else core's for the refusal. */
    readonly detail: string | null = null,
  ) {
    super(refusal);
  }
}

/** An SSH failure as the card's refusal: the password's, the key's, the address's. */
function refusalOf(err: unknown, auth: 'password' | 'key'): Refused {
  if (err instanceof Refused) return err;
  if (!(err instanceof SshFailure)) return new Refused('unreachable');
  switch (err.reason) {
    case 'not_allowed':
      return new Refused('not_allowed');
    case 'host_key_changed':
    case 'host_key_unconfirmed':
      return new Refused('host_key_changed');
    case 'rejected': {
      if (auth === 'key') return new Refused('key_refused');
      const offered = err.offered;
      const takesPasswords =
        !offered || offered.includes('password') || offered.includes('keyboard-interactive');
      return new Refused(takesPasswords ? 'password_wrong' : 'password_login_off');
    }
    default:
      return new Refused('unreachable');
  }
}

/** What a way found: who the server is, its own name, and what is kept. */
interface Found {
  outcome: 'signed_in' | 'key_added' | 'password_saved' | 'key_imported';
  hostKey: z.output<typeof VaultSshHostKey>;
  hostname: string | null;
}

/** The card's form, answered as the person (VLT-42): signs in one of the three ways, or refuses on its field. */
export async function saveServerAsk(
  services: Services,
  place: PersonalPlace,
  row: MessageRow,
  ask: GuideVaultAsk,
  values: Readonly<Record<string, string>>,
): Promise<SavedVault> {
  const server = ask.server;
  if (!server || !ask.username) throw guideError('invalid_values', 'This card can’t sign in.');
  const way = vaultAskWay(values[VAULT_ASK_FIELDS.way]);
  const password = values[VAULT_ASK_FIELDS.password] ?? '';
  const pasted = values[VAULT_ASK_FIELDS.privateKey] ?? '';
  const passphrase = values[VAULT_ASK_FIELDS.passphrase] || undefined;
  // An empty field is said on it and costs no try.
  if (way === 'own_key' && !pasted.trim())
    throw onField(VAULT_ASK_FIELDS.privateKey, VAULT_ASK_TEXT.empty.privateKey);
  if (way !== 'own_key' && !password) throw onField(VAULT_ASK_FIELDS.password, VAULT_ASK_TEXT.empty.password);
  const person = place.person;
  const where = { host: server.host, port: server.port, username: ask.username };

  // The key it goes with: the card's, else the person's only one, else a new “Servers” key (CT-1660); for `own_key` the
  // pasted key, a new entry of its own.
  const keys = await sshKeysOf(services.db, place.burrow.id, person.id);
  const existing =
    way === 'own_key'
      ? null
      : ((ask.entryId ? keys.find((k) => k.id === ask.entryId) : keys.length === 1 ? keys[0] : null) ?? null);
  const entryId = existing?.id ?? newId('vaultEntry');
  let privateKey: string;
  let auth: VaultSshKeyAuth;
  let found: Found;
  try {
    const { problem } = await sshDestination(services, server.host, server.port, 'save');
    if (problem) throw new Refused('not_allowed');
    if (way === 'own_key') {
      const imported = importSshKey(entryId, pasted, passphrase);
      if (!imported.ok) {
        if (imported.code === 'passphrase_needed')
          throw onField(VAULT_ASK_FIELDS.passphrase, imported.message);
        throw imported.code === 'wrong_passphrase'
          ? new Refused('passphrase_wrong')
          : new Refused('key_invalid', imported.message);
      }
      privateKey = imported.key.privateKey;
      auth = imported.key.auth;
    } else if (existing?.sealed) {
      privateKey = services.custody.open(vaultSecretAad(existing.id), existing.sealed);
      auth = existing.auth as VaultSshKeyAuth;
    } else {
      const made = generateSshKey(entryId);
      privateKey = made.privateKey;
      auth = made.auth;
    }
    const pins = await vaultPins(services.db, place.burrow.id, person.id, server.host, server.port);
    found = await signIn(services, way, {
      where,
      pins,
      privateKey,
      auth,
      entryId,
      password,
      keyFirst: !!existing,
    });
  } catch (err) {
    // The card's own field errors (an empty passphrase) pass as they are.
    if (err instanceof ApiError) throw err;
    return tried(services, place, row, ask, way, refusalOf(err, way === 'own_key' ? 'key' : 'password'));
  }

  // The name the agent gave (or the server's in the Vault), else the server's own short host name, else its address.
  const name = ask.name !== server.host ? ask.name : (found.hostname ?? addressName(server.host));
  const res = await services.pipeline.commit(
    askServerSave,
    {
      messageId: row.id,
      entryId,
      ...(existing
        ? {}
        : {
            create: {
              sealed: services.custody.seal(vaultSecretAad(entryId), privateKey),
              auth,
              name: way === 'own_key' ? name : SERVERS_KEY.name,
              description: way === 'own_key' ? `Your own key for ${name}.` : SERVERS_KEY.description,
            },
          }),
      name,
      host: server.host,
      port: server.port,
      username: ask.username,
      hostKey: found.hostKey,
      ...(way === 'keep_password'
        ? { password: services.custody.seal(cardTransitAad(row.id), password) }
        : {}),
    },
    { burrowId: place.burrow.id, actorId: person.id },
  );
  if (res.status !== 'ok') throw onField(fieldOf(way), 'That can’t be saved now.');
  if (res.result.changed) return tried(services, place, row, ask, way, new Refused('host_key_changed'));
  return { entryId, name: ask.name, outcome: found.outcome, server: res.result.server, wake: true };
}

/** The three ways' sign-ins (VLT-42). Throws `Refused` or an `SshFailure`. */
async function signIn(
  services: Services,
  way: GuideVaultServerWay,
  a: {
    where: { host: string; port: number; username: string };
    pins: z.output<typeof VaultSshHostKey>[];
    privateKey: string;
    auth: VaultSshKeyAuth;
    entryId: string;
    password: string;
    keyFirst: boolean;
  },
): Promise<Found> {
  const forms = sshKeyForms(a.entryId, a.privateKey);
  const withKey = async (pins: typeof a.pins) => {
    const opened = await openSshSignIn(services, a.where, { privateKey: a.privateKey }, { pins });
    try {
      return { hostKey: opened.hostKey, hostname: await hostnameOn(services, opened.client, forms) };
    } finally {
      opened.client.end();
    }
  };
  if (way === 'own_key') {
    try {
      return { outcome: 'key_imported', ...(await withKey(a.pins)) };
    } catch (err) {
      throw refusalOf(err, 'key');
    }
  }
  // The assistant's key may open it already: then the password isn't used at all.
  if (a.keyFirst) {
    try {
      return { outcome: 'signed_in', ...(await withKey(a.pins)) };
    } catch (err) {
      if (!(err instanceof SshFailure && err.reason === 'rejected')) throw err;
    }
  }
  const opened = await openSshSignIn(services, a.where, { password: a.password }, { pins: a.pins }).catch(
    (err: unknown) => {
      throw refusalOf(err, 'password');
    },
  );
  const hostKey = opened.hostKey;
  let hostname: string | null = null;
  let kept = false;
  try {
    hostname = await hostnameOn(services, opened.client, forms);
    if (way === 'key_once') {
      const line = vaultSshAuthorizedKeysLine(a.auth.publicKey, a.entryId);
      const left = await sshExec(
        opened.client,
        {
          command: KEEP_KEY_COMMAND,
          stdin: `${line}\n`,
          timeoutMs: 20_000,
          maxOutput: 64 * 1024,
          openMs: 15_000,
          graceMs: sshCloseGraceMs(services),
        },
        forms,
      ).catch(() => null);
      kept = left?.exitCode === 0;
    }
  } finally {
    opened.client.end();
  }
  if (way === 'keep_password') return { outcome: 'password_saved', hostKey, hostname };
  if (!kept) throw new Refused('key_refused');
  // Signed in again with the key, to be sure it opens the server now.
  try {
    await withKey([hostKey]);
  } catch {
    throw new Refused('key_refused');
  }
  return { outcome: 'key_added', hostKey, hostname };
}

/** The field a way's refusals show on. */
function fieldOf(way: GuideVaultServerWay): string {
  return way === 'own_key' ? VAULT_ASK_FIELDS.privateKey : VAULT_ASK_FIELDS.password;
}

function onField(field: string, message: string) {
  return guideError('invalid_values', message, { [`values.${field}`]: [message] });
}

/**
 * A try that didn't sign in: counted on the card; while tries are left the card stays open and the field says why; the
 * last one closes it `refused` (the agent is woken with the reason, never a value).
 */
async function tried(
  services: Services,
  place: PersonalPlace,
  row: MessageRow,
  ask: GuideVaultAsk,
  way: GuideVaultServerWay,
  refused: Refused,
): Promise<SavedVault> {
  const tries = (ask.server?.tries ?? 0) + 1;
  if (tries >= GUIDE_VAULT_SERVER_TRIES)
    return {
      name: ask.name,
      outcome: 'refused',
      refusal: refused.refusal,
      wake: true,
      ...(ask.entryId ? { entryId: ask.entryId } : {}),
    };
  await services.pipeline.commit(
    askServerTried,
    { messageId: row.id, tries },
    { burrowId: place.burrow.id, actorId: place.person.id },
  );
  const text = refused.detail ?? vaultAskErrorText(refused.refusal, ask.name);
  const field = vaultAskErrorField(refused.refusal, way);
  throw guideError('invalid_values', text, { [`values.${field}`]: [text] });
}

/** A server card's try counted on the stored card (CT-1661 `tries`), sent to the room as the card's update. */
export const askServerTried = defineCommand({
  name: 'vault.ask_server_tried',
  schema: z.object({ messageId: z.string(), tries: z.number().int().min(1).max(GUIDE_VAULT_SERVER_TRIES) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only the person answers this card.');
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.messageId), sql`${messages.card}->>'state' = 'open'`))
      .for('update');
    const card = row?.card?.kind === 'guide' ? (row.card as GuideCard) : null;
    if (!row || !card?.vaultAsk?.server) return { tries: 0 };
    const next: GuideCard = {
      ...card,
      vaultAsk: { ...card.vaultAsk, server: { ...card.vaultAsk.server, tries: input.tries } },
    };
    const [updated] = await tx
      .update(messages)
      .set({ card: next })
      .where(eq(messages.id, row.id))
      .returning();
    const [loaded] = updated ? await loadMessages(tx, [updated], null) : [];
    if (loaded)
      ctx.publish(topics.conversation(row.conversationId), { type: 'message.updated', message: loaded });
    return { tries: input.tries };
  },
});

/**
 * The server card's save (VLT-42), signed by the person: the key (a new “Servers” key, or their own pasted key as a
 * Server key entry, switched on for the assistant, VS-01), the server with its pin, check and kept password, and the
 * assistant's switch covering it.
 */
export const askServerSave = defineCommand({
  name: 'vault.ask_server',
  schema: z.object({
    messageId: z.string(),
    entryId: VaultEntryId,
    create: z
      .object({
        sealed: z.string().min(1).max(20_000),
        auth: VaultAuth.refine((a) => a.type === 'ssh_key'),
        name: z.string().min(1).max(80),
        description: z.string().max(500),
      })
      .optional(),
    name: z.string().min(1).max(40),
    host: z.string().min(1).max(253),
    port: VaultPort,
    username: z.string().min(1).max(32),
    hostKey: VaultSshHostKey,
    /** “Keep the password”: sealed under `cardTransitAad`, opened here and sealed again with the server. */
    password: z.string().min(1).max(8_000).optional(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only the person answers this card.');
    const person = ctx.actor;
    const pins = await vaultPins(tx, ctx.burrow.id, person.id, input.host, input.port);
    if (pins.length && !pins.some((p) => p.fingerprint === input.hostKey.fingerprint))
      return { changed: true as const };
    let entry: VaultEntryRow;
    if (input.create) {
      entry = await insertEntry(
        ctx,
        {
          kind: 'ssh',
          name: input.create.name,
          description: input.create.description,
          auth: input.create.auth,
          secret: ctx.services.custody.open(vaultSecretAad(input.entryId), input.create.sealed),
        } as never,
        { id: input.entryId },
      );
      await emitEntryEvent(ctx, 'entry.added', entry);
      // Switched on for the assistant from the start (VS-01).
      await giveOwnAssistantKey(ctx, entry);
    } else {
      const [own] = await tx
        .select()
        .from(vaultEntries)
        .where(and(eq(vaultEntries.id, input.entryId), eq(vaultEntries.ownerId, person.id)));
      if (own?.kind !== 'ssh') throw forbidden('That key isn’t in your Vault.');
      entry = own;
    }
    // A key that was there keeps its switch as the person left it: the card was asked only while it was on.
    const agent = await loadAgentRow(tx, ctx.burrow.id);
    const put = await putServer(ctx, entry, agent?.id ?? '', {
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      hostKey: input.hostKey,
      signedIn: true,
      ...(input.password
        ? { password: ctx.services.custody.open(cardTransitAad(input.messageId), input.password) }
        : {}),
    });
    await entryChanged(ctx, entry);
    publishVaultUpdated(ctx, person.id, entry.id);
    return { changed: false as const, serverId: put.serverId, server: put.name };
  },
});

export const ASK_SERVER_COMMANDS = [askServerTried, askServerSave];
