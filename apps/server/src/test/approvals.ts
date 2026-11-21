/**
 * Test helpers for approvals. No Whombat simulates an action by default (docs/decisions/essentials-agents.md EA-02):
 * a suite that is about something else than who carries a deploy out — its copy, its conditions, its approvers — asks
 * for the stand-in explicitly here.
 */
import type { ApprovalActionType, KeyId, Tier } from '@whombat/core';
import { simulatedExecutor } from '../approvals/engine';
import { grants } from '../db/schema/index';
import { TEST_BURROW_ID } from '../seed/test-world';
import type { Services } from '../services';

/** Installs the do-nothing stand-in for these action types (a deploy “succeeds” without a workflow). */
export function simulateExecutors(services: Services, ...types: ApprovalActionType[]): void {
  for (const type of types) services.approvals.setExecutor(type, simulatedExecutor);
}

/** Gives an agent of the test burrow a key at a tier (upsert). */
export async function setGrant(services: Services, agentId: string, keyId: KeyId, tier: Tier): Promise<void> {
  await services.db
    .insert(grants)
    .values({ burrowId: TEST_BURROW_ID, agentId, keyId, tier })
    .onConflictDoUpdate({ target: [grants.agentId, grants.keyId], set: { tier } });
}
