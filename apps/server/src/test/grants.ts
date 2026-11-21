/** Test helper: an agent's key at a tier, set directly in the database. */
import { and, eq } from 'drizzle-orm';
import { grants } from '../db/schema/index';
import type { TestServer } from './harness';

export async function grantKey(
  t: TestServer,
  agentId: string,
  keyId: string,
  tier: 'can' | 'ask' | 'cannot' = 'can',
) {
  await t.services.db.delete(grants).where(and(eq(grants.agentId, agentId), eq(grants.keyId, keyId)));
  await t.services.db.insert(grants).values({ burrowId: t.burrowId, agentId, keyId, tier, position: 90 });
}
