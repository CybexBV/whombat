/**
 * The person the screen pairs with (docs/decisions/desk-display.md DK-02, DK-17, DK-20; desk-display-server.md DK-S17,
 * DK-S30; one-person.md OP-S77): the person, in a burrow where they have their Chat with the agent.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export interface DeskTarget {
  /** The person's principal. */
  id: string;
  burrowId: string;
}

/**
 * Every burrow where the person has their Chat with the agent, with their principal there, oldest burrow first
 * (desk-found.md DF-02, DF-03: where the automatic scans look and the agent's message goes).
 */
export async function personPlaces(db: Db): Promise<Map<string, string>> {
  return new Map((await readPersonPlaces(db)).map((p) => [p.burrowId, p.id]));
}

/**
 * The same person selection as `thePerson`, with the account, agent and default Chat that `personalPlace` needs.
 * Choose the person before checking for their Chat: another person's Chat cannot stand in for a missing one.
 * Read only the identities needed for pairing and discovery, in one statement rather than hydrating each place.
 */
async function readPersonPlaces(db: Db) {
  return db.execute<{ burrowId: string; id: string; accountId: string }>(sql`
    select b.id as "burrowId", p.id, p.account_id as "accountId"
      from burrows b
      cross join lateral (
        select p.id, p.account_id
          from principals p
         where p.burrow_id = b.id and p.kind = 'person' and p.system is null
         order by case
           when p.account_id = nullif((select claimed_by_account_id from appliance_state where id = 1), '') then 0
           when p.account_id is not null then 1
           else 2 end,
           p.position, p.created_at, p.id
         limit 1
      ) p
     where p.account_id is not null and p.account_id <> ''
       and exists (
         select 1 from principals a join conversations c on c.dm_agent_id = a.id and c.dm_person_id = p.id
          where a.burrow_id = b.id and a.kind = 'agent' and c.kind = 'dm' and c.task_key is null
       )
     order by b.created_at, b.id`);
}

/**
 * The person for the screen (DK-17): where they have their Chat, `preferBurrowId` first; only `accountId`'s when
 * given (the account that typed the letters). Null: nobody to pair with yet.
 */
export async function deskTarget(
  db: Db,
  options: { accountId?: string; preferBurrowId?: string } = {},
): Promise<DeskTarget | null> {
  const places = await readPersonPlaces(db);
  const eligible = (p: (typeof places)[number]) => !options.accountId || p.accountId === options.accountId;
  const found =
    places.find((p) => p.burrowId === options.preferBurrowId && eligible(p)) ?? places.find(eligible);
  return found ? { id: found.id, burrowId: found.burrowId } : null;
}
