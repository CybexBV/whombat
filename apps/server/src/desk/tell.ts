/**
 * The assistant tells its person something in their chat (the DM Chat lives in), as the disk alerts do
 * (`managed/host-disk-alerts.ts`): the power (DK-10) and five wrong PINs on the screen (DK-04).
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import { messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { agentContext, personalPlace } from '../guides/place';
import { iso } from '../lib/time';
import { afterClear } from '../read/messages';
import { toActor } from '../read/principals';
import type { Services } from '../services';

export interface TellOptions {
  /**
   * Says nothing when the assistant said exactly these words in this DM this recently. Only remote help's visit line
   * asks for it, and its words are the same in every language today; a caller whose words follow the person's
   * language must give each language's words the same key before it relies on this.
   */
  unlessSaidWithinMs?: number | null;
}

/**
 * Posts `text` from the person's assistant in their DM, notifying them. False when they have no assistant here; true
 * when it was said, or said already within `unlessSaidWithinMs`.
 */
export async function tellPerson(
  services: Services,
  burrowId: string,
  personId: string,
  text: string,
  options: TellOptions = {},
): Promise<boolean> {
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const where = await personalPlace(session.tx, burrowId, personId);
    if (!where) return false;
    const now = services.clock();
    if (options.unlessSaidWithinMs) {
      const [said] = await session.tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, where.dm.id),
            eq(messages.authorId, where.agent.id),
            eq(messages.text, text),
            isNull(messages.deletedAt),
            gt(messages.createdAt, new Date(now.getTime() - options.unlessSaidWithinMs)),
            afterClear(where.dm.roomClearedAt),
          ),
        )
        .limit(1);
      if (said) return true;
    }
    const ctx = applyContext(session, {
      burrow: where.burrow,
      actor: toActor(where.agent),
      now,
      at: iso(now),
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    await postMessage(agentContext(ctx, where.agent), {
      conversation: where.dm,
      text,
      dispatch: false,
      notifyDmPerson: true,
    });
    return true;
  });
  return result;
}
