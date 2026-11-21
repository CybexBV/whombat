/** Principals (people, the agent, Whombat's own signers), inside a commit. */
import {
  type AgentFace,
  AgentRuntime,
  type AgentStatus,
  handleFrom,
  initialsOf,
  newId,
  topics,
} from '@whombat/core';
import { and, eq, like, or, sql } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import type { Tx } from '../db/client';
import { principals } from '../db/schema/index';
import { loadConversation } from '../read/conversations';

/** The longest handle (core's handle pattern). */
const HANDLE_MAX = 32;

/**
 * `nugget`, or `nugget-2` when taken. A long stem is cut so the suffix still fits the 32 characters a handle may have
 * (`assess-new-issues-and-pull-req-2`; automation-recipes.md: two automations with the same long name).
 */
export async function uniqueHandle(tx: Tx, burrowId: string, base: string): Promise<string> {
  const stem = (base || 'someone').slice(0, HANDLE_MAX);
  // Room for `-99`; past that each candidate is asked for by itself.
  const short = stem.slice(0, HANDLE_MAX - 3).replace(/-+$/g, '') || 'someone';
  const rows = await tx
    .select({ handle: principals.handle })
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, burrowId),
        or(eq(principals.handle, stem), like(principals.handle, `${short}-%`)),
      ),
    );
  const taken = new Set(rows.map((r) => r.handle));
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 100; i++) if (!taken.has(`${short}-${i}`)) return `${short}-${i}`;
  for (let i = 100; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${short.slice(0, HANDLE_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    const [held] = await tx
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, burrowId), eq(principals.handle, candidate)));
    if (!held) return candidate;
  }
}

/** Next position in a burrow (people in join order). */
async function nextPosition(tx: Tx, burrowId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${principals.position}), -1)::int` })
    .from(principals)
    .where(eq(principals.burrowId, burrowId));
  return (row?.max ?? -1) + 1;
}

export interface NewPerson {
  id?: string;
  burrowId: string;
  name: string;
  email: string;
  accountId: string | null;
  tone: string;
  shortName?: string | null;
  initials?: string;
  title?: string | null;
  handle?: string;
  createdAt: Date;
  keySeed?: string;
}

export async function insertPerson(session: TxSession, p: NewPerson): Promise<string> {
  const id = p.id ?? newId('principal');
  const keys = session.services.custody.newPrincipalKeys(
    id,
    p.keySeed !== undefined ? { seed: p.keySeed } : {},
  );
  await session.tx.insert(principals).values({
    id,
    burrowId: p.burrowId,
    kind: 'person',
    name: p.name,
    handle: p.handle ?? (await uniqueHandle(session.tx, p.burrowId, handleFrom(p.name))),
    ...keys,
    createdAt: p.createdAt,
    accountId: p.accountId,
    shortName: p.shortName ?? null,
    initials: p.initials ?? initialsOf(p.name),
    tone: p.tone,
    title: p.title ?? null,
    email: p.email,
    position: await nextPosition(session.tx, p.burrowId),
  });
  return id;
}

/** The burrow's one agent (one-agent.md OA-01) as `createTheAgent` makes it. */
export interface NewAgent {
  id?: string;
  burrowId: string;
  name: string;
  /** The face it wears (OA-08): one of the five drawings; null: Dusty's. */
  face?: AgentFace | null;
  status?: AgentStatus;
  doing: string;
  job: string;
  /** Stored with defaults filled in (scratch directory, worktree checkout, guarded). */
  runtime: AgentRuntime;
  handle?: string;
  createdAt: Date;
  keySeed?: string;
}

export async function insertAgent(session: TxSession, a: NewAgent): Promise<{ id: string; handle: string }> {
  const id = a.id ?? newId('principal');
  const handle = a.handle ?? (await uniqueHandle(session.tx, a.burrowId, handleFrom(a.name)));
  const keys = session.services.custody.newPrincipalKeys(
    id,
    a.keySeed !== undefined ? { seed: a.keySeed } : {},
  );
  await session.tx.insert(principals).values({
    id,
    burrowId: a.burrowId,
    kind: 'agent',
    name: a.name,
    handle,
    ...keys,
    createdAt: a.createdAt,
    agentFace: a.face ?? null,
    status: a.status ?? 'idle',
    doing: a.doing,
    job: a.job,
    runtime: AgentRuntime.parse(a.runtime),
    position: await nextPosition(session.tx, a.burrowId),
  });
  return { id, handle };
}

/**
 * One of Whombat's own signers (one-agent.md OA-17): GitHub's, an automation's, Feedback's, the trackers', the
 * Servers'. Kind `system`, never the agent: no keys of its own unless an automation's, no channels, never dispatched.
 */
export async function insertSystemPrincipal(
  session: TxSession,
  p: {
    burrowId: string;
    name: string;
    system: string;
    /** The handle's stem; absent: from the name. */
    handle?: string;
    doing?: string;
    job?: string;
    createdAt: Date;
  },
): Promise<{ id: string; handle: string }> {
  const id = newId('principal');
  const handle = await uniqueHandle(session.tx, p.burrowId, p.handle ?? handleFrom(p.name));
  await session.tx.insert(principals).values({
    id,
    burrowId: p.burrowId,
    kind: 'system',
    system: p.system,
    name: p.name,
    handle,
    ...session.services.custody.newPrincipalKeys(id, {}),
    createdAt: p.createdAt,
    status: 'idle',
    doing: p.doing ?? '',
    job: p.job ?? '',
    position: await nextPosition(session.tx, p.burrowId),
  });
  return { id, handle };
}

/** Publishes the conversation's current header data (`conversation.updated`). */
export async function publishConversation(
  session: TxSession,
  conversationId: string,
  eventId: string | null,
) {
  const conversation = await loadConversation(session.tx, conversationId);
  if (!conversation) return;
  session.publish(
    topics.burrow(conversation.burrowId),
    { type: 'conversation.updated', conversation },
    { eventId },
  );
}
