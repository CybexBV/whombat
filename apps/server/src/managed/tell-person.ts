/**
 * A word from the box to the person in their Chat, from their assistant, as the disk alerts are (box-status.md BS-09;
 * one-person.md OP-S74): in the person's DM with their assistant, through the commit pipeline, with a notification.
 */
import { asc } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import { burrows } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { thePerson } from '../domain/the-person';
import { agentContext, personalPlace } from '../guides/place';
import { iso } from '../lib/time';
import { type PrincipalRow, toActor } from '../read/principals';
import type { Services } from '../services';

/** Posts `text` in the person's DM with their assistant. False when they have none. */
export async function postInPersonalChat(
  services: Services,
  burrowId: string,
  person: PrincipalRow,
  text: string,
): Promise<boolean> {
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const where = await personalPlace(session.tx, burrowId, person.id);
    if (!where) return false;
    const now = services.clock();
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

/** Tells the box's person `text`, once per account; the number told. Nothing while the box is paused for maintenance. */
export async function tellThePerson(services: Services, text: string): Promise<number> {
  if (services.maintenance.paused) return 0;
  const told = new Set<string>();
  const rows = await services.db
    .select({ id: burrows.id })
    .from(burrows)
    .orderBy(asc(burrows.createdAt), asc(burrows.id));
  for (const { id } of rows) {
    const person = await thePerson(services.db, id);
    if (!person?.accountId || told.has(person.accountId)) continue;
    try {
      if (await postInPersonalChat(services, id, person, text)) told.add(person.accountId);
    } catch (err) {
      services.log.warn({ err: String(err), burrowId: id }, 'a word for the person was not posted');
    }
  }
  return told.size;
}
