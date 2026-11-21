/**
 * Rooms for tests: a branch room (a pull request's) without its pull request, and a person's Chat with the agent.
 * Nobody joins or leaves a conversation: every one of the burrow is the person's with the agent.
 */
import { newId } from '@whombat/core';
import { conversations } from '../db/schema/index';
import { publishConversation } from '../domain/members';
import { ensurePersonalDm } from '../domain/personal-dm';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';

/** A branch room, the one kind of conversation besides the person's own rooms with the agent. */
export async function makeRoom(services: Services, burrowId: string, title: string): Promise<string> {
  const id = newId('conversation');
  await services.pipeline.transact(burrowId, async (session) => {
    await session.tx.insert(conversations).values({
      id,
      burrowId,
      kind: 'branch',
      slug: title,
      title,
      createdAt: services.clock(),
    });
    await publishConversation(session, id, null);
  });
  return id;
}

/** A person's chat with an agent (made when missing), as `ensurePersonalDm` makes it. */
export async function chatWith(
  services: Services,
  burrowId: string,
  agentId: string,
  personId: string,
): Promise<string> {
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const [agent, person] = await Promise.all([
      loadPrincipalRow(session.tx, agentId),
      loadPrincipalRow(session.tx, personId),
    ]);
    if (!agent || !person) throw new Error('chatWith: unknown principal');
    return ensurePersonalDm(
      Object.assign(session, { burrow: { id: burrowId }, now: services.clock() }),
      agent,
      person,
    );
  });
  return result;
}
