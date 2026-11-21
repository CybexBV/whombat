/**
 * An automation's authority (BP-09, docs/decisions/bp-automations.md BP-C04): everything a run does is signed by
 * the automation's own principal, and may only do what BOTH its grants allow AND the person who published the
 * version it runs may do right now. Re-checked immediately before every step (and again inside an approval's
 * execution). Whoever or whatever triggered the run adds nothing; neither does anything an agent wrote.
 */
import { type Decision, decide, type KeyId, type RequestScope } from '@whombat/core';
import type { Db } from '../db/client';
import { inBurrow } from '../read/conversations';
import {
  engineActor,
  loadAgentRow,
  loadGrants,
  loadPrincipalRow,
  type PrincipalRow,
} from '../read/principals';

const RANK = { deny: 0, ask: 1, allow: 2 } as const;

/** The stricter of two decisions (deny < ask < allow). */
export function intersect(a: Decision, b: Decision): Decision {
  return RANK[a.outcome] <= RANK[b.outcome] ? a : b;
}

export type AuthorityCheck = { ok: true } | { ok: false; reason: string };

/** The publisher is still a person of the burrow who may manage automations. */
export async function publisherCheck(
  db: Db,
  burrowId: string,
  publishedById: string,
): Promise<{ ok: true; publisher: PrincipalRow } | { ok: false; reason: string }> {
  const publisher = await loadPrincipalRow(db, publishedById);
  if (!publisher || publisher.burrowId !== burrowId || publisher.kind !== 'person')
    return { ok: false, reason: 'The person who published this automation is no longer on this Whombat.' };
  const may = decide(engineActor(publisher), [], 'agents.manage');
  if (may.outcome !== 'allow')
    return { ok: false, reason: `${publisher.name} may no longer run automations.` };
  return { ok: true, publisher };
}

/**
 * Each of these conversations is still one of the publisher's burrow, so the automation may read and post there: every
 * conversation is the person's.
 */
export async function conversationsCheck(
  db: Db,
  publisher: PrincipalRow,
  conversationIds: readonly string[],
): Promise<AuthorityCheck> {
  for (const id of new Set(conversationIds)) {
    if (!(await inBurrow(db, publisher.burrowId, id)))
      return { ok: false, reason: 'That room is gone, so the automation can’t act there.' };
  }
  return { ok: true };
}

/** The effective decision for a key: the automation's grants ∩ the publisher's own authority. */
export async function keyDecision(
  db: Db,
  automationPrincipalId: string,
  publisher: PrincipalRow,
  keyId: KeyId,
  scope?: RequestScope,
): Promise<Decision> {
  const own = decide(
    { id: automationPrincipalId, kind: 'agent' },
    await loadGrants(db, automationPrincipalId),
    keyId,
    scope,
  );
  const person = decide(engineActor(publisher), [], keyId, scope);
  return intersect(own, person);
}

/**
 * The agent an automation asks (one-agent.md OA-15): the burrow's one agent, for the automation's person; a step names
 * no agent of its own.
 */
export async function automationAgent(db: Db, burrowId: string): Promise<PrincipalRow | null> {
  return (await loadAgentRow(db, burrowId)) ?? null;
}
