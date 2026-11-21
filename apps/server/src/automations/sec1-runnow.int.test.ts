/**
 * Security review part 1, L-6 (MA-19g; docs/decisions/managed-runtime.md MR-31), for the one agent: on a managed
 * appliance the person's Run now is never refused for the sign-in the agent runs on: every turn runs on the person's
 * (one-person.md OP-S09).
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { principals } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { runAutomationNow } from './commands';

const w = useAutomationWorld({ env: { WHOMBAT_MODE: 'managed' } });

const manual = (_agentId: string) =>
  ({
    version: 1,
    conversationId: IDS.general,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'ask', kind: 'dispatch_agent', prompt: 'Status? {{trigger.text}}' }],
  }) as AutomationDefinitionInput;

async function setSource(agentId: string, source: unknown) {
  const [row] = await w.services.db.select().from(principals).where(eq(principals.id, agentId));
  await w.services.db
    .update(principals)
    .set({ runtime: { ...(row?.runtime ?? {}), credentialSource: source } as never })
    .where(eq(principals.id, agentId));
}

describe('Run now on the person’s sign-in', () => {
  it('the person’s own sign-in serves their Run now (SUB-57, one-person.md OP-S09)', async () => {
    const [mara] = await w.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    await setSource(IDS.dusty, { kind: 'member', accountId: mara?.accountId });
    const id = await w.publish(manual(IDS.dusty), { by: IDS.mara, name: 'Status on Mara’s sign-in' });
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false });
    expect(runId).toBeTruthy();
  });

  it('L-6: an old organization credential source doesn’t refuse the person’s Run now', async () => {
    await setSource(IDS.dusty, { kind: 'org', credentialId: 'orgc_team0001' });
    const id = await w.publish(manual(IDS.dusty), { by: IDS.mara, name: 'Status on an organization key' });
    const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId: id, test: false });
    expect(runId).toBeTruthy();
  });
});
