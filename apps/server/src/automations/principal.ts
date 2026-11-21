/**
 * Each automation acts as its own principal (BP-09, bp-automations BP-C04): agent-shaped so it signs and holds
 * keys like an agent, marked `principals.system = 'automation'` so it is not on the roster, not hireable, never
 * dispatched and holds no personal keys — the same pattern as GitHub's system principal (github/actors.ts).
 */
import { topics } from '@whombat/core';
import type { TxSession } from '../commit/types';
import { insertSystemPrincipal } from '../domain/members';
import { loadPrincipalRow, toPrincipal } from '../read/principals';

export const SYSTEM_AUTOMATION = 'automation';

export async function createAutomationPrincipal(
  session: TxSession,
  args: { name: string; createdAt: Date },
): Promise<string> {
  const { id } = await insertSystemPrincipal(session, {
    burrowId: session.burrowId,
    system: SYSTEM_AUTOMATION,
    name: args.name.slice(0, 80),
    doing: 'Runs an automation people published.',
    job: 'Runs the steps of an automation, with no more authority than the person who published it.',
    createdAt: args.createdAt,
  });
  await session.append(id, {
    type: 'automation.principal_created',
    kind: 'System',
    text: null,
    where: null,
    payload: { principalId: id },
    createdAt: args.createdAt.toISOString(),
  });
  const row = await loadPrincipalRow(session.tx, id);
  if (row)
    session.publish(topics.burrow(session.burrowId), {
      type: 'principal.created',
      principal: toPrincipal(row),
    });
  return id;
}

/** Whether a principal is an automation's. */
export function isAutomationPrincipal(row: { system: string | null } | undefined): boolean {
  return row?.system === SYSTEM_AUTOMATION;
}
