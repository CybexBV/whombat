/**
 * Pairing and discovery need Postgres here: test the claimed-person ordering and the real default-Chat joins,
 * including historical people, and count SQL statements. No server, full seed or external services are needed.
 */
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import * as schema from '../db/schema/index';
import { applianceState, burrows, conversations, principals } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { personalPlace } from '../guides/place';
import { useTestDb } from '../test/db';
import { deskTarget, personPlaces } from './person';

const t = useTestDb();
const now = new Date('2026-10-01T12:00:00Z');

async function person(
  burrowId: string,
  id: string,
  accountId: string | null,
  position = 0,
  system: string | null = null,
) {
  await t.db.insert(principals).values({
    burrowId,
    id,
    accountId,
    position,
    system,
    kind: 'person',
    name: id,
    handle: id,
    publicKey: 'key',
    fingerprint: 'fingerprint',
    secretKeyEnc: 'sealed',
    createdAt: now,
  });
}

async function chat(burrowId: string, personId: string, taskKey: string | null = null) {
  await t.db.insert(conversations).values({
    id: `cnv_${personId}`,
    burrowId,
    kind: 'dm',
    slug: personId,
    title: 'Chat',
    dmPersonId: personId,
    dmAgentId: `agent_${burrowId}`,
    taskKey,
  });
}

/** The existing domain lookups remain the authority for the full place. */
async function domainPlaces(db: Db) {
  const rows = await db.select().from(burrows).orderBy(asc(burrows.createdAt), asc(burrows.id));
  const out = new Map<string, string>();
  for (const row of rows) {
    const selected = await thePerson(db, row.id);
    if (selected && (await personalPlace(db, row.id, selected.id))) out.set(row.id, selected.id);
  }
  return out;
}

beforeAll(async () => {
  const ids = ['empty', 'no_account', 'blank_account', 'no_agent', 'task', 'no_chat', 'ready_a', 'ready_b'];
  await t.db.insert(burrows).values(ids.map((id) => ({ id, name: id, slug: id, createdAt: now })));
  await t.db.insert(principals).values(
    ids
      .filter((id) => id !== 'no_agent')
      .map((id) => ({
        id: `agent_${id}`,
        burrowId: id,
        kind: 'agent' as const,
        name: 'Dusty',
        handle: 'dusty',
        publicKey: 'key',
        fingerprint: 'fingerprint',
        secretKeyEnc: 'sealed',
      })),
  );
  for (const [burrow, account] of [
    ['no_account', null],
    ['blank_account', ''],
    ['no_agent', 'acc_owner'],
    ['task', 'acc_owner'],
    ['no_chat', 'acc_owner'],
    ['ready_a', 'acc_owner'],
    ['ready_b', 'acc_owner'],
  ] as const) {
    await person(burrow, `person_${burrow}`, account, 10);
    if (burrow !== 'no_chat') await chat(burrow, `person_${burrow}`, burrow === 'task' ? 'a-task' : null);
  }
  // Historical people and a signer's person-shaped row cannot displace the claimer.
  await person('ready_a', 'person_history', null, -10);
  await person('ready_a', 'person_first', 'acc_first', 0);
  await chat('ready_a', 'person_first');
  await person('ready_b', 'person_system', 'acc_system', -10, 'automation');
  await chat('ready_b', 'person_system');
  // A different person's ready Chat cannot stand in for the chosen person's missing Chat.
  await person('no_chat', 'person_other', 'acc_other', 0);
  await chat('no_chat', 'person_other');
  await t.db.insert(applianceState).values({ id: 1, claimedByAccountId: 'acc_owner' });
});

describe('desk pairing and discovery identities', () => {
  it('keeps the claimed person, a complete default Chat, and oldest-burrow order in one read', async () => {
    let queries = 0;
    const db = drizzle(t.sql, { schema, logger: { logQuery: () => queries++ } });
    const places = await personPlaces(db);
    expect(queries).toBe(1);
    expect([...places]).toEqual([
      ['ready_a', 'person_ready_a'],
      ['ready_b', 'person_ready_b'],
    ]);
    expect(places).toEqual(await domainPlaces(t.db));
  });

  it('honors account and preferred burrow without re-reading each person', async () => {
    let queries = 0;
    const db = drizzle(t.sql, { schema, logger: { logQuery: () => queries++ } });
    expect(await deskTarget(db, { accountId: 'acc_owner', preferBurrowId: 'ready_b' })).toEqual({
      id: 'person_ready_b',
      burrowId: 'ready_b',
    });
    expect(queries).toBe(1);
    expect(await deskTarget(t.db, { preferBurrowId: 'no_chat' })).toEqual({
      id: 'person_ready_a',
      burrowId: 'ready_a',
    });
    expect(await deskTarget(t.db, { accountId: 'acc_first', preferBurrowId: 'ready_a' })).toBeNull();
    expect(await deskTarget(t.db, { accountId: 'missing' })).toBeNull();
  });

  it('uses the domain fallback without a matching claim and observes later changes', async () => {
    try {
      for (const claimer of [null, '', 'acc_unknown']) {
        await t.db
          .update(applianceState)
          .set({ claimedByAccountId: claimer })
          .where(eq(applianceState.id, 1));
        const places = await personPlaces(t.db);
        expect(places).toEqual(await domainPlaces(t.db));
        expect(places.get('ready_a')).toBe('person_first');
        expect(await deskTarget(t.db, { accountId: 'acc_first', preferBurrowId: 'ready_b' })).toEqual({
          id: 'person_first',
          burrowId: 'ready_a',
        });
      }
      await t.db.delete(applianceState).where(eq(applianceState.id, 1));
      expect(await personPlaces(t.db)).toEqual(await domainPlaces(t.db));
    } finally {
      await t.db
        .insert(applianceState)
        .values({ id: 1, claimedByAccountId: 'acc_owner' })
        .onConflictDoUpdate({
          target: applianceState.id,
          set: { claimedByAccountId: 'acc_owner' },
        });
    }
    expect((await personPlaces(t.db)).get('ready_a')).toBe('person_ready_a');
  });
});
