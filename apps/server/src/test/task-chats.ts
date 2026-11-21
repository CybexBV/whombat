/**
 * A task chat from before Chat (one-whombat.md ONE-06): nothing makes them any more (`start_chat` posts in the person's
 * Chat, one-agent.md OA-S48), but the ones there are keep their rules — renamed, archived and titled once, listed on
 * Home. The fixture makes one as those builds did: the person's own `dm` with the agent under a task key, titled after
 * the agent, its chat title from the first message, which the person posts (waking the agent there).
 */
import { and, eq } from 'drizzle-orm';
import { clipTitle } from '../chats/title';
import { sendMessage } from '../commands/messages';
import { conversations, principals } from '../db/schema/index';
import type { Services } from '../services';

let made = 0;

export async function taskChatWith(
  services: Services,
  burrowId: string,
  agentId: string,
  personId: string,
  text: string,
): Promise<string> {
  const [agent] = await services.db
    .select()
    .from(principals)
    .where(and(eq(principals.id, agentId), eq(principals.burrowId, burrowId)));
  const [person] = await services.db
    .select()
    .from(principals)
    .where(and(eq(principals.id, personId), eq(principals.burrowId, burrowId)));
  if (!agent || !person) throw new Error('taskChatWith: unknown principal');
  made += 1;
  const taskKey = `tsk_fixture${made}`;
  const id = `cnv_task-${personId.slice(4)}-${made}`;
  await services.db.insert(conversations).values({
    id,
    burrowId,
    kind: 'dm',
    slug: `${agent.handle}--${person.handle}--${taskKey}`,
    title: agent.name,
    dmAgentId: agent.id,
    dmPersonId: person.id,
    taskKey,
    chatTitle: clipTitle(text),
    createdAt: services.clock(),
  });
  const sent = await services.pipeline.commit(
    sendMessage,
    { conversationId: id, text },
    { burrowId, actorId: person.id },
  );
  if (sent.status !== 'ok') throw new Error(`taskChatWith: ${sent.status}`);
  await services.background.settle();
  return id;
}
