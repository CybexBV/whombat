/**
 * `share_link` (docs/decisions/share-links.md): the assistant asks to share a thread of the person's Chat by link. It
 * always becomes a card; on the person's yes `share_create` runs again and the link is made (`publishForAssistant`).
 */
import type { ShareLinkInput, ShareLinkOutput } from '@whombat/core';
import { SHARE_DEFAULT_EXPIRY } from '@whombat/core/share';
import { eq } from 'drizzle-orm';
import { messages } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { ownTurn } from '../vault/self-serve';
import { createShare } from './commands';
import { SHARE_WORDS, sharePortOf } from './publish';

const fail = (reason: 'not_here' | 'not_found' | 'unavailable', message: string): ShareLinkOutput => ({
  status: 'failed',
  reason,
  message,
});

export async function shareLinkTool(ctx: ToolContext, input: ShareLinkInput): Promise<ShareLinkOutput> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn || turn.conversation.dmPersonId !== turn.person.id)
    return fail('not_here', 'Only a thread of the person’s own Chat can be shared, in a turn for them.');
  if (!sharePortOf(services)) return fail('unavailable', SHARE_WORDS.noCloud);
  let rootId = input.thread ?? ctx.dispatch.threadRootId ?? null;
  if (!rootId && ctx.dispatch.messageId) {
    const [m] = await services.db
      .select({ id: messages.id, threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, ctx.dispatch.messageId));
    rootId = m ? (m.threadRootId ?? m.id) : null;
  }
  if (!rootId) return fail('not_found', 'Name the thread to share (its first message).');
  try {
    const res = await services.pipeline.commit(
      createShare,
      {
        rootId,
        ...(input.from ? { fromMessageId: input.from } : {}),
        pictures: input.pictures ?? true,
        expiry: input.expiry ?? SHARE_DEFAULT_EXPIRY,
        personId: turn.person.id,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (res.status === 'pending_approval')
      return { status: 'pending_approval', approvalId: res.approvalId, message: res.message };
    return fail('unavailable', res.status === 'blocked' ? res.message : 'The link wasn’t made.');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'not_found')
      return fail('not_found', 'That thread isn’t in the person’s Chat.');
    throw err;
  }
}
