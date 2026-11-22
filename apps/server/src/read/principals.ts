import {
  type Agent,
  AgentFace,
  AgentModelFallback,
  AgentRuntime,
  DEFAULT_AGENT_FACE,
  DEFAULT_AGENT_RUNTIME,
  type Grant,
  HUMAN_TONES,
  initialsOf,
  isKeyId,
  type Person,
  type Principal,
  type SystemKind,
  type SystemPrincipal,
  shortNameOf,
} from '@whombat/core';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { applianceState, grants, principals } from '../db/schema/index';
import { iso } from '../lib/time';

export type PrincipalRow = typeof principals.$inferSelect;

export function toPerson(row: PrincipalRow): Person {
  const person: Person = {
    id: row.id,
    burrowId: row.burrowId,
    kind: 'person',
    name: row.name,
    handle: row.handle,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: iso(row.createdAt),
    initials: row.initials ?? initialsOf(row.name),
    tone: row.tone ?? HUMAN_TONES[2],
    email: row.email ?? `${row.handle}@example.com`,
  };
  if (row.shortName) person.shortName = row.shortName;
  if (row.title) person.title = row.title;
  if (row.accountId) person.accountId = row.accountId;
  // Their photo (person-avatars.md PVA-03): only while the attachment is there (a deleted row clears the id).
  person.avatarUrl = row.avatarAttachmentId && row.avatarUrl ? row.avatarUrl : null;
  return person;
}

/**
 * A stored runtime with defaults filled in. A value that no longer parses keeps its provider, model, effort and fast
 * replies.
 */
export function agentRuntimeOf(stored: AgentRuntime | null | undefined): AgentRuntime {
  const parsed = AgentRuntime.safeParse(stored ?? DEFAULT_AGENT_RUNTIME);
  if (parsed.success) return parsed.data;
  const runtime: AgentRuntime = { ...DEFAULT_AGENT_RUNTIME };
  const provider = AgentRuntime.shape.provider.safeParse(stored?.provider);
  if (provider.success) runtime.provider = provider.data;
  if (typeof stored?.model === 'string' && stored.model) runtime.model = stored.model;
  if (typeof stored?.backgroundModel === 'string' && stored.backgroundModel)
    runtime.backgroundModel = stored.backgroundModel;
  const effort = AgentRuntime.shape.effort.safeParse(stored?.effort);
  if (effort.success && effort.data) runtime.effort = effort.data;
  if (typeof stored?.fast === 'boolean') runtime.fast = stored.fast;
  return runtime;
}

/**
 * The profile's `modelFallback` (docs/decisions/model-effort.md ME-05): the agent's last turn on its tool's default model
 * as the contract says it (without the tool's own words, which stay in the log); null when there is none.
 */
export function modelFallbackOf(row: Pick<PrincipalRow, 'modelFallback'>): AgentModelFallback | null {
  const stored = row.modelFallback;
  if (!stored) return null;
  const parsed = AgentModelFallback.safeParse({ model: stored.model, where: stored.where, at: stored.at });
  return parsed.success ? parsed.data : null;
}

/** The face the agent wears (one-agent.md OA-08): Dusty's drawing until the person picks another. */
export function faceOf(row: Pick<PrincipalRow, 'agentFace'>): AgentFace {
  const parsed = AgentFace.safeParse(row.agentFace);
  return parsed.success ? parsed.data : DEFAULT_AGENT_FACE;
}

/** The burrow's one agent as clients read it (one-agent.md OA-01). */
export function toAgent(row: PrincipalRow): Agent {
  return {
    id: row.id,
    burrowId: row.burrowId,
    kind: 'agent',
    name: row.name,
    handle: row.handle,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: iso(row.createdAt),
    face: faceOf(row),
    status: row.status ?? 'idle',
    doing: row.doing ?? '',
    runtime: agentRuntimeOf(row.runtime),
  };
}

/**
 * What a system signer is to clients (OA-17): the tracker signer (report-trackers.md TA-07) receives customer reports
 * like Feedback's; the Servers signer (agent-updates-server.md AU-S04) runs by itself like an automation.
 */
function systemKindOf(system: string | null): SystemKind {
  if (system === 'github' || system === 'automation' || system === 'feedback') return system;
  return system === 'tracker' ? 'feedback' : 'automation';
}

/** One of Whombat's own signers (`kind = 'system'`, OA-17) as clients read it. */
export function toSystemPrincipal(row: PrincipalRow): SystemPrincipal {
  return {
    id: row.id,
    burrowId: row.burrowId,
    kind: 'system',
    name: row.name,
    handle: row.handle,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: iso(row.createdAt),
    system: systemKindOf(row.system),
  };
}

/** The burrow's one agent (one-agent.md OA-01), if it has one yet. */
export async function loadAgentRow(db: Db | Tx, burrowId: string): Promise<PrincipalRow | undefined> {
  const [row] = await db
    .select()
    .from(principals)
    .where(and(eq(principals.burrowId, burrowId), eq(principals.kind, 'agent')));
  return row;
}

export function toPrincipal(row: PrincipalRow): Principal {
  if (row.kind === 'person') return toPerson(row);
  return row.kind === 'system' ? toSystemPrincipal(row) : toAgent(row);
}

/** How the keys engine and the pipeline see a principal: Whombat's own signers act like the agent (OA-17). */
export function actorKind(kind: PrincipalRow['kind']): 'person' | 'agent' {
  return kind === 'person' ? 'person' : 'agent';
}

/** Short display name: "Mara" for Mara Okafor, the agent name for agents. */
export function shortName(row: Pick<PrincipalRow, 'kind' | 'name' | 'shortName'>): string {
  return shortNameOf({ kind: actorKind(row.kind), name: row.name, shortName: row.shortName ?? undefined });
}

/** The acting principal as the commit pipeline sees it. */
export interface ActorInfo {
  id: string;
  burrowId: string;
  kind: 'person' | 'agent';
  name: string;
  shortName: string;
  handle: string;
  secretKeyEnc: string;
}

export function toActor(row: PrincipalRow): ActorInfo {
  return {
    id: row.id,
    burrowId: row.burrowId,
    kind: actorKind(row.kind),
    name: row.name,
    shortName: shortName(row),
    handle: row.handle,
    secretKeyEnc: row.secretKeyEnc,
  };
}

/**
 * How the keys engine and the approval rules see a principal (one-person.md OP-S07): the person holds every key people
 * hold; the agent and Whombat's own signers hold their grants.
 */
export function engineActor(p: { id: string; kind: PrincipalRow['kind'] }) {
  return { id: p.id, kind: actorKind(p.kind) };
}

export async function loadPrincipalRow(db: Db, id: string): Promise<PrincipalRow | undefined> {
  const [row] = await db.select().from(principals).where(eq(principals.id, id));
  return row;
}

export async function loadPrincipalRows(db: Db, burrowId: string): Promise<PrincipalRow[]> {
  return db
    .select()
    .from(principals)
    .where(eq(principals.burrowId, burrowId))
    .orderBy(asc(principals.position), asc(principals.createdAt), asc(principals.id));
}

export async function loadPrincipalsByIds(db: Db, ids: readonly string[]): Promise<PrincipalRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(principals)
    .where(inArray(principals.id, [...new Set(ids)]));
}

export async function principalByHandle(
  db: Db,
  burrowId: string,
  handle: string,
): Promise<PrincipalRow | undefined> {
  const [row] = await db
    .select()
    .from(principals)
    .where(and(eq(principals.burrowId, burrowId), eq(principals.handle, handle)));
  return row;
}

/** An agent's grants in stored order. Unknown key ids (from a newer build) are skipped. */
export async function loadGrants(db: Db, agentIds: string | readonly string[]): Promise<Grant[]> {
  const ids = typeof agentIds === 'string' ? [agentIds] : [...agentIds];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(grants)
    .where(inArray(grants.agentId, ids))
    .orderBy(asc(grants.agentId), asc(grants.position));
  const out: Grant[] = [];
  for (const r of rows) {
    if (!isKeyId(r.keyId)) continue;
    const g: Grant = { agentId: r.agentId, keyId: r.keyId, tier: r.tier };
    if (r.scope) g.scope = r.scope;
    out.push(g);
  }
  return out;
}

/** Name info for the approval / audit display helpers in core. */
export function nameInfo(row: PrincipalRow) {
  return { name: row.name, shortName: shortName(row) };
}

/**
 * Whether the account a turn works for is a person of the burrow (essentials-people.md EP-08): a turn for an account
 * that isn't (one-person.md OP-S02: a person from before the box was one person's) is nobody's to start.
 */
export async function accountInBurrow(db: Db | Tx, burrowId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: principals.id })
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, burrowId),
        eq(principals.accountId, accountId),
        eq(principals.kind, 'person'),
      ),
    )
    .limit(1);
  return !!row;
}

/** The person's account: the one that claimed the box (one-person.md OP-S02); null before the claim. */
export async function personAccountId(db: Db | Tx): Promise<string | null> {
  const [row] = await db
    .select({ id: applianceState.claimedByAccountId })
    .from(applianceState)
    .where(eq(applianceState.id, 1));
  return row?.id ?? null;
}

/**
 * The burrow's person (one-person.md OP-S02): its person principal of the account that claimed the box, else (a burrow
 * made without a claim, in tests and development) its first person with an account.
 */
export async function loadPersonRow(db: Db | Tx, burrowId: string): Promise<PrincipalRow | undefined> {
  const rows = await db
    .select({ p: principals, claimer: applianceState.claimedByAccountId })
    .from(principals)
    .leftJoin(applianceState, eq(applianceState.id, 1))
    .where(
      and(eq(principals.burrowId, burrowId), eq(principals.kind, 'person'), isNotNull(principals.accountId)),
    )
    .orderBy(asc(principals.createdAt), asc(principals.id));
  return (rows.find((r) => r.p.accountId === r.claimer) ?? rows[0])?.p;
}
