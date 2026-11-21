import { fingerprintOf, GENESIS_HASH } from '@whombat/core';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { events, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { verifyBurrowChain } from './verify';

const t = useTestServer({ seed: true });

/** The burrow's events by type, counted. */
async function eventCounts(): Promise<Map<string, number>> {
  const rows = await t.services.db
    .select({ type: events.type })
    .from(events)
    .where(eq(events.burrowId, t.burrowId));
  const counts = new Map<string, number>();
  for (const { type } of rows) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}
const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);

describe('seeded world', () => {
  it('signs and chains every seeded event, verifiable end to end', async () => {
    const report = await verifyBurrowChain(t.services.db, t.burrowId);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    // burrow.created + one message.posted per message + the explicit history.
    expect(report.checked).toBe(1 + 20 + 10);
    const rows = await t.services.db
      .select()
      .from(events)
      .where(eq(events.burrowId, t.burrowId))
      .orderBy(asc(events.seq));
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    // Chain order follows the clock.
    const times = rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Explicit history keeps its ids and is signed by the actor's seed key.
    const blocked = rows.find((r) => r.id === 'evt_9d31');
    expect(blocked).toMatchObject({
      actorId: IDS.dusty,
      kind: 'Blocked',
      keyNote: 'not one of Dusty’s keys',
    });
    const [dusty] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.dusty));
    expect(blocked?.signer).toBe(dusty?.publicKey);
    expect(dusty?.fingerprint).toBe('1035 d0ed');
    expect(fingerprintOf(dusty?.publicKey ?? '')).toBe('1035 d0ed');
  });

  it('never stores a secret key in the clear', async () => {
    const rows = await t.services.db
      .select({ id: principals.id, enc: principals.secretKeyEnc })
      .from(principals);
    for (const r of rows) {
      expect(r.enc).toMatch(/^v1:/);
      expect(t.services.custody.decrypt(r.id, r.enc)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('append-only events', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on events', async () => {
    const sql = t.services.sql;
    await expect(sql`update events set text = 'edited' where id = 'evt_9d31'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from events where id = 'evt_9d31'`).rejects.toThrow(/append-only/);
    await expect(sql`truncate events cascade`).rejects.toThrow(/append-only/);
    const [row] = await sql`select text from events where id = 'evt_9d31'`;
    expect(row?.text).toBe('Tried to merge PR #479 into main. Blocked.');
  });
});

describe('concurrent appends', () => {
  it('keep one gap-free chain when many commits race in the same burrow', async () => {
    await t.services.background.settle();
    const before = await verifyBurrowChain(t.services.db, t.burrowId);
    const countsBefore = await eventCounts();
    const authors = [IDS.mara, IDS.mara, IDS.mara, IDS.dusty, IDS.dusty, IDS.dusty, IDS.dusty, IDS.dusty];
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        t.commit(authors[i % authors.length] as string, sendMessage, {
          conversationId: IDS.billing,
          text: `Parallel message ${i}`,
        }),
      ),
    );
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    const after = await verifyBurrowChain(t.services.db, t.burrowId);
    expect(after.ok).toBe(true);
    // Every event the race added is in the chain: the 24 messages and what they set off, which depends on their order
    // (agents' status settling, AS-03; a person replying right after an agent wakes it) (TS-02).
    const countsAfter = await eventCounts();
    expect((countsAfter.get('message.posted') ?? 0) - (countsBefore.get('message.posted') ?? 0)).toBe(24);
    expect(after.checked).toBe(before.checked + total(countsAfter) - total(countsBefore));
  });
});

describe('tamper detection', () => {
  it('flags an event whose stored content no longer matches its signature', async () => {
    const sql = t.services.sql;
    // Only the table owner bypassing the trigger can do this; the chain still exposes it.
    await sql`alter table events disable trigger events_no_update_or_delete`;
    try {
      await sql`update events set text = 'Nothing to see here' where id = 'evt_9f02'`;
    } finally {
      await sql`alter table events enable trigger events_no_update_or_delete`;
    }
    const report = await verifyBurrowChain(t.services.db, t.burrowId);
    expect(report.ok).toBe(false);
    const [tampered] = await sql`select seq from events where id = 'evt_9f02'`;
    expect(report.failures).toContainEqual({ seq: tampered?.seq, id: 'evt_9f02', reason: 'hash_mismatch' });
    // The next event still links to the original hash, so only the edited one fails.
    expect(report.failures.filter((f) => f.reason !== 'hash_mismatch')).toEqual([]);
  });
});
