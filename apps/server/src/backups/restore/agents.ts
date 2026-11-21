/**
 * Restoring the agent (BF-04, BF-07; one-agent.md OA-01): the file's agent is this Whombat's one agent — never a second
 * one — with the file's name, face, model and keys when the person chooses “Use the backup”. Its schedules come back
 * paused.
 */
import {
  AGENT_NAME_MAX,
  AGENT_NAME_PATTERN,
  type AgentFace,
  type AgentModelRuntime,
  type BackupAgentRecord,
  type BackupAgentsLine,
  type BackupCommandAllowanceRecord,
  type BackupScheduleRecord,
  type Grant,
  isKeyId,
  isReservedAgentName,
  KEY_CATALOG,
  type KeyScope,
  newId,
} from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import {
  agentWhere,
  grantsThatFit,
  offeredModelRuntime,
  publishAgent,
  renameAgentDms,
  writeGrants,
} from '../../commands/agents';
import type { Db } from '../../db/client';
import { agentSchedules, commandAllowances, messages, principals } from '../../db/schema/index';
import { publishConversation } from '../../domain/members';
import {
  agentRuntimeOf,
  faceOf,
  loadAgentRow,
  loadGrants,
  loadPrincipalRow,
  type PrincipalRow,
} from '../../read/principals';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreAgents(run: RestoreRun, record: BackupAgentsLine): Promise<RecordOutcome> {
  switch (record.type) {
    case 'agent':
      return agent(run, record);
    case 'schedule':
      return schedule(run, record);
    // An older file's morning briefing: there is no brief any more.
    case 'briefing':
      return 'skipped';
    case 'command_allowance':
      return commandAllowance(run, record);
  }
}

async function grantsHere(run: RestoreRun, r: BackupAgentRecord, agentId: string): Promise<Grant[]> {
  const out: Grant[] = [];
  for (const g of r.grants) {
    if (!isKeyId(g.keyId)) continue;
    let scope: KeyScope | undefined;
    if (g.scope) {
      scope = { ...g.scope };
      if (g.scope.connections)
        scope.connections = (await run.resolveAll(g.scope.connections)).ids.filter(
          (id) => !run.isStandIn(id),
        );
    }
    out.push({ agentId, keyId: g.keyId, tier: g.tier, ...(scope ? { scope } : {}) });
  }
  return out;
}

const grantKey = (gs: readonly { keyId: string; tier: string }[]) =>
  gs
    .map((g) => `${g.keyId}:${g.tier}`)
    .sort()
    .join(',');

/**
 * The file's agent onto this Whombat's one agent (one-agent.md OA-01; BF-04): never a second agent. The same, or
 * different — kept, or the file's name, face, model and keys with “Use the backup”. Keys are clamped to what the agent
 * may hold and saved with Settings → Agent's signed events (BF-S07); the model is one this Whombat offers (BF-S06). A file
 * with more than one agent (made before one agent) maps them all onto it.
 */
async function agent(run: RestoreRun, r: BackupAgentRecord): Promise<RecordOutcome> {
  const row = await loadAgentRow(run.db as Db, run.burrow.id);
  if (!row) {
    run.note('missing_reference', 'agents');
    return 'skipped';
  }
  run.remember(r.id, row.id, 'agent');
  return agentHere(run, r, row);
}

/** The agent's model runtime as this Whombat offers it (BF-19, BF-S06). */
function runtimeHere(run: RestoreRun, r: BackupAgentRecord): z.output<typeof AgentModelRuntime> {
  const offered = offeredModelRuntime(
    { services: run.services, burrow: run.burrow },
    {
      provider: r.runtime.provider,
      ...(r.runtime.model ? { model: r.runtime.model } : {}),
      ...(r.runtime.backgroundModel ? { backgroundModel: r.runtime.backgroundModel } : {}),
      ...(r.runtime.effort ? { effort: r.runtime.effort } : {}),
      ...(r.runtime.fast !== null ? { fast: r.runtime.fast } : {}),
    },
  );
  // A model this Whombat doesn't offer: the tool's default, and the preview says so.
  if (r.runtime.model && (offered.provider !== r.runtime.provider || offered.model !== r.runtime.model))
    run.note('model_unavailable', 'agents');
  return offered;
}

/** The name and face the file gives the agent, when they are ones it can take and differ (BF-S03…BF-S05, OA-08). */
function namingOf(r: BackupAgentRecord, row: PrincipalRow): { name: string; face: AgentFace | null } | null {
  const wanted = r.name.trim();
  const name = wanted !== row.name && nameTakes(wanted) ? wanted : row.name;
  const face = r.face;
  const faceDiffers = face !== faceOf(row);
  if (name === row.name && !faceDiffers) return null;
  return { name, face: faceDiffers ? face : null };
}

/** A name a rename would take (BF-S05): one capitalised word, not reserved, not too long. */
function nameTakes(name: string): boolean {
  return name.length <= AGENT_NAME_MAX && AGENT_NAME_PATTERN.test(name) && !isReservedAgentName(name);
}

/** Gives the agent the file's name and face (BF-S03): a rename's own writes and its signed event. */
async function renameAgent(
  run: RestoreRun,
  row: PrincipalRow,
  naming: { name: string; face: AgentFace | null },
): Promise<void> {
  const ctx = run.ctx;
  const renamed = naming.name !== row.name;
  await run.tx
    .update(principals)
    .set({ name: naming.name, ...(naming.face ? { agentFace: naming.face } : {}) })
    .where(eq(principals.id, row.id));
  const dms = renamed ? await renameAgentDms(run.tx, row.id, naming.name) : [];
  const texts = [
    ...(renamed ? [`Renamed ${row.name} to ${naming.name}`] : []),
    ...(naming.face ? [`Changed ${naming.name}’s face`] : []),
  ];
  const event = await ctx.emit({
    type: 'agent.updated',
    kind: 'Keys',
    text: texts.join('. '),
    where: agentWhere(naming.name),
    aboutId: row.id,
    ref: { type: 'agent' },
    payload: {
      agentId: row.id,
      ...(renamed ? { name: naming.name, from: row.name } : {}),
      ...(naming.face ? { face: naming.face } : {}),
      restored: true,
    },
  });
  await publishAgent(ctx, row.id, event.id);
  for (const dm of dms) await publishConversation(ctx, dm.id, event.id);
}

/**
 * The agent here (BF-04): the same, or different — kept, or the file's name, face, model and keys with “Use the
 * backup”. Keys pass the limits Settings → Agent has and are saved with its signed events, so the apps hear them
 * (BF-S07); the model is one this Whombat offers (BF-S06).
 */
async function agentHere(run: RestoreRun, r: BackupAgentRecord, row: PrincipalRow): Promise<RecordOutcome> {
  const here = row.id;
  const runtime = agentRuntimeOf(row.runtime);
  const have = await loadGrants(run.db as Db, here);
  const wanted = grantsThatFit(await grantsHere(run, r, here));
  const model = runtimeHere(run, r);
  const naming = namingOf(r, row);
  const sameRest =
    runtime.provider === model.provider &&
    (runtime.model ?? null) === (model.model ?? null) &&
    (runtime.backgroundModel ?? null) === (model.backgroundModel ?? null) &&
    (runtime.effort ?? null) === (model.effort ?? null) &&
    (runtime.fast ?? null) === (model.fast ?? null) &&
    grantKey(have) === grantKey(wanted);
  if (sameRest && !naming) return 'unchanged';
  return run.different(async () => {
    const ctx = run.ctx;
    const { model: _m, backgroundModel: _bg, effort: _e, fast: _f, ...host } = runtime;
    await run.tx
      .update(principals)
      .set({ runtime: { ...host, ...model } })
      .where(eq(principals.id, here));
    if (naming) await renameAgent(run, row, naming);
    const current = (await loadPrincipalRow(run.tx, here)) ?? row;
    await writeGrants(ctx, current, have, wanted);
    await publishAgent(ctx, here, null);
  });
}

/**
 * A command a person always allows an agent (BF-20, BF-S16): for an agent that is here (never a stand-in), with a key
 * this Whombat knows and an agent may hold, given by a person here (else by the restorer). The same allowance twice is
 * one.
 */
async function commandAllowance(run: RestoreRun, r: BackupCommandAllowanceRecord): Promise<RecordOutcome> {
  const agentId = await run.resolve(r.agent);
  if (!agentId || run.isStandIn(agentId) || run.dry) return 'detail';
  if (!isKeyId(r.keyId) || KEY_CATALOG[r.keyId].agentMaxTier === 'never') return 'detail';
  const [agent] = await run.tx
    .select({ id: principals.id })
    .from(principals)
    .where(and(eq(principals.id, agentId), eq(principals.burrowId, run.burrow.id)));
  if (!agent) return 'detail';
  const by = r.createdBy ? await run.resolve(r.createdBy) : null;
  const [person] =
    by && !run.isStandIn(by)
      ? await run.tx
          .select({ id: principals.id })
          .from(principals)
          .where(and(eq(principals.id, by), eq(principals.kind, 'person')))
      : [];
  await run.tx
    .insert(commandAllowances)
    .values({
      id: newId('commandAllowance'),
      burrowId: run.burrow.id,
      agentId,
      keyId: r.keyId,
      command: r.command,
      target: r.target ?? '',
      createdById: person?.id ?? run.restorer.id,
      createdAt: new Date(r.createdAt),
    })
    .onConflictDoNothing();
  return 'detail';
}

/**
 * A schedule's thread, once the messages are back (BF-19, BF-S09): agents come back before messages, so a schedule
 * made then (or found here by an earlier restore) has no thread yet. Its thread root, mapped by the restore, becomes its
 * thread when it is a message of the schedule's own conversation and the schedule has none — the job's step after
 * Messages, on every restore that brings messages back.
 */
export async function restoreScheduleThread(run: RestoreRun, r: BackupAgentsLine): Promise<void> {
  if (r.type !== 'schedule' || !r.threadRoot || run.dry) return;
  const id = run.mapped(r.id);
  const root = run.mapped(r.threadRoot);
  if (!id || !root || run.isStandIn(id) || run.isStandIn(root)) return;
  const [message] = await run.tx
    .select({ conversationId: messages.conversationId, threadRootId: messages.threadRootId })
    .from(messages)
    .where(and(eq(messages.id, root), eq(messages.burrowId, run.burrow.id)));
  if (!message || message.threadRootId) return;
  await run.tx
    .update(agentSchedules)
    .set({ threadRootId: root, updatedAt: run.ctx.now })
    .where(
      and(
        eq(agentSchedules.id, id),
        eq(agentSchedules.burrowId, run.burrow.id),
        eq(agentSchedules.conversationId, message.conversationId),
        isNull(agentSchedules.threadRootId),
      ),
    );
}

async function schedule(run: RestoreRun, r: BackupScheduleRecord): Promise<RecordOutcome> {
  const agentId = await run.resolve(r.agent);
  const conversationId = await run.resolve(r.conversation);
  // The person's schedule (one-person.md OP-S75): for the person restoring.
  const accountId = run.restorer.accountId;
  if (!agentId || !conversationId || !accountId || run.isStandIn(agentId) || run.isStandIn(conversationId)) {
    if (!run.dry || !agentId || !conversationId) run.note('missing_reference', 'agents');
    return 'detail';
  }
  if (run.dry) return 'detail';
  const [same] = await run.tx
    .select({ id: agentSchedules.id })
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.agentId, agentId),
        eq(agentSchedules.conversationId, conversationId),
        eq(agentSchedules.prompt, r.prompt),
        inArray(agentSchedules.status, ['active', 'paused']),
      ),
    );
  if (same) {
    run.remember(r.id, same.id, 'schedule');
    return 'detail';
  }
  const threadRoot = r.threadRoot ? await run.resolve(r.threadRoot) : null;
  const id = newId('agentSchedule');
  const now = run.ctx.now;
  await run.tx.insert(agentSchedules).values({
    id,
    burrowId: run.burrow.id,
    agentId,
    conversationId,
    threadRootId: threadRoot && !run.isStandIn(threadRoot) ? threadRoot : null,
    forAccountId: accountId,
    prompt: r.prompt,
    when: r.when,
    // Every schedule comes back paused (BF-07): resuming it is a person's choice.
    status: 'paused',
    nextAt: null,
    endsAt: r.endsAt ? new Date(r.endsAt) : null,
    anchorAt: now,
    createdAt: new Date(r.createdAt),
    updatedAt: now,
  });
  run.remember(r.id, id, 'schedule');
  if (r.status === 'active') run.followUps.schedulesPaused++;
  return 'detail';
}
