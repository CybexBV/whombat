/**
 * What `vault_save` and `vault_add_server` share (docs/decisions/vault-self-serve.md VS-04, VS-05, VS-07, VS-11): whose
 * turn it is, whether a secret is in a message the person wrote here, and blanking it where it was.
 *
 * - **Whose turn** (`ownTurn`): the agent's turn for the person, never an outsiders' (one-person.md OP-17); every room of
 *   the person's is theirs alone (OP-S72). A refusal is `blocked` with a signed `vault.refused` (Blocked, the neutral
 *   text, ids only), as every Vault refusal.
 * - **Only what the person wrote** (`personWrote`, VS-05): the secret appears, exactly, in a message the person wrote in
 *   the turn's conversation in the last 7 days, not deleted.
 * - **Blanked** (`blankSecret`, VS-07): every message of that conversation by the person or the assistant from the
 *   anchor's 7 days holding the secret has it replaced by `VAULT_BLANKED`, gains a `vaultSaved` line (when there is one
 *   to say) and is sent as `message.updated`; `editedAt` stays. Its notifications, search document, link previews holding it, summaries covering it and the provider sessions
 *   that saw it follow (as an edit's do).
 */
import {
  MESSAGE_VAULT_SAVES_MAX,
  type MessageVaultSave,
  topics,
  VAULT_BLANKED,
  type VaultToolRefusal,
  vaultAuditText,
} from '@whombat/core';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, messages } from '../db/schema/index';
import { forgetStaleContext, refreshMessageNotifications } from '../domain/message-edits';
import { indexMessage } from '../domain/search-index';
import { forbidden } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadMessages } from '../read/messages';
import { loadPrincipalRow, type PrincipalRow, shortName } from '../read/principals';
import { personOfAccount, whereOf } from './uses';

/** How far back a secret is looked for in the person's messages (VS-05). */
export const SAVE_ANCHOR_DAYS = 7;

/** The words the tools answer with (plain, to the agent; `{name}` the person's first name). */
export const SELF_SERVE_TEXT = {
  notOwn: 'Only the person’s assistant can do that, in a turn for them.',
  notWritten: (name: string) => `That isn’t in a message from ${name} here.`,
} as const;

type Blocked = Extract<VaultToolRefusal, { status: 'blocked' }>;

/** A refusal of a self-serve tool (VS-04, VS-09): a signed `vault.refused`, neutral, ids only. */
export const selfServeRefused = defineCommand({
  name: 'vault.self_serve_refused',
  schema: z.object({ dispatchId: z.string(), tool: z.enum(['vault_save', 'vault_add_server', 'vault_ask']) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents use Vault entries.');
    const [dispatch] = await tx
      .select({ conversationId: dispatches.conversationId })
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.agentId, ctx.actor.id)));
    const event = await ctx.emit({
      type: 'vault.refused',
      kind: 'Blocked',
      text: vaultAuditText('refused'),
      where: dispatch ? await whereOf(tx, dispatch.conversationId) : null,
      payload: { dispatchId: input.dispatchId, tool: input.tool },
    });
    return { eventId: event.id };
  },
});

/** A `blocked` answer with its signed event. */
export async function blocked(
  ctx: ToolContext,
  tool: 'vault_save' | 'vault_add_server' | 'vault_ask',
  message: string,
): Promise<Blocked> {
  const res = await ctx.services.pipeline.commit(
    selfServeRefused,
    { dispatchId: ctx.dispatch.id, tool },
    { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
  );
  if (res.status !== 'ok') throw forbidden('That can’t be decided now.');
  return { status: 'blocked', eventId: res.result.eventId, message };
}

export interface OwnTurn {
  agent: PrincipalRow;
  person: PrincipalRow;
  /** The person's first name, as the answers say it. */
  name: string;
  conversation: ConversationRow;
}

/** The agent's turn for the person (VS-04, VS-09; OP-17), or null. */
export async function ownTurn(db: Db | Tx, ctx: Pick<ToolContext, 'agentId' | 'burrowId' | 'dispatch'>) {
  const agent = await loadPrincipalRow(db, ctx.agentId);
  if (agent?.kind !== 'agent') return null;
  const person = await personOfAccount(db, ctx.burrowId, ctx.dispatch.onBehalfOfAccountId);
  if (!person) return null;
  const conversation = await loadConversationRow(db, ctx.dispatch.conversationId);
  if (!conversation) return null;
  const turn: OwnTurn = {
    agent,
    person,
    name: shortName(person),
    conversation,
  };
  return turn;
}

/** The start of the anchor's window (VS-05), which blanking keeps to as well. */
export function anchorSince(now: Date): Date {
  return new Date(now.getTime() - SAVE_ANCHOR_DAYS * 86_400_000);
}

/** Whether `secret` is, exactly, in a message the person wrote in this conversation lately, not deleted (VS-05). */
export async function personWrote(
  db: Db | Tx,
  conversationId: string,
  personId: string,
  secret: string,
  now: Date,
): Promise<boolean> {
  const since = anchorSince(now);
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.authorId, personId),
        isNull(messages.deletedAt),
        gt(messages.createdAt, since),
        sql`strpos(${messages.text}, ${secret}) > 0`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Blanks a secret in the conversation's messages by these authors (VS-07, VS-11), in the caller's commit: the text with
 * `VAULT_BLANKED` for every occurrence, link previews whose address held it dropped, `save` added to `vaultSaved` (the
 * last `MESSAGE_VAULT_SAVES_MAX`), `message.updated` to the room; then what an edit does for the old words. Returns
 * the ids of the messages that changed (the signed Vault event names them; no event of their own).
 */
export async function blankSecret(
  ctx: ApplyContext,
  args: {
    conversationId: string;
    authorIds: readonly string[];
    secret: string;
    /** The line under each message; null: blanked without one (a server's password that put no key on, VS-S17). */
    save: MessageVaultSave | null;
  },
): Promise<string[]> {
  const rows = await ctx.tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, args.conversationId),
        inArray(messages.authorId, [...args.authorIds]),
        isNull(messages.deletedAt),
        // The anchor's window (VS-05): a short secret never rewrites an old message that happens to hold its text.
        gt(messages.createdAt, anchorSince(ctx.now)),
        sql`strpos(${messages.text}, ${args.secret}) > 0`,
      ),
    )
    .for('update');
  if (!rows.length) return [];
  const changed: (typeof rows)[number][] = [];
  for (const row of rows) {
    const text = row.text.split(args.secret).join(VAULT_BLANKED);
    const previews = (row.previews ?? []).filter((p) => !p.url.includes(args.secret));
    const vaultSaved = args.save
      ? [...(row.vaultSaved ?? []), args.save].slice(-MESSAGE_VAULT_SAVES_MAX)
      : row.vaultSaved;
    const [updated] = await ctx.tx
      .update(messages)
      .set({ text, previews: previews.length ? previews : null, vaultSaved })
      .where(eq(messages.id, row.id))
      .returning();
    if (!updated) continue;
    changed.push(updated);
    await refreshMessageNotifications(ctx.tx, row.id, text);
    await forgetStaleContext(ctx, {
      conversationId: row.conversationId,
      createdAt: row.createdAt,
    });
  }
  for (const message of await loadMessages(ctx.tx, changed, null))
    ctx.publish(topics.conversation(message.conversationId), { type: 'message.updated', message });
  const db = ctx.services.db;
  const ids = [...new Set(changed.flatMap((r) => [r.id, ...(r.threadRootId ? [r.threadRootId] : [])]))];
  ctx.after(async () => {
    for (const id of ids) await indexMessage(db, id);
  });
  return changed.map((r) => r.id);
}
