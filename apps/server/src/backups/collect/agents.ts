/**
 * The agent (`agents.jsonl`, BF-05; one-agent.md OA-01): its name, handle, face, model, effort and provider, access,
 * checkout and its keys — with its schedules (they come back paused) and the commands
 * the person always allows it. Never signing keys, sign-ins, provider sessions or status.
 */
import type { BackupAgentsLine } from '@whombat/core';
import { and, asc, inArray } from 'drizzle-orm';
import { agentSchedules, commandAllowances, grants } from '../../db/schema/index';
import { iso } from '../../lib/time';
import { agentRuntimeOf, faceOf } from '../../read/principals';
import { type CategoryOut, type CollectScope, liveAgents } from './scope';

const rec = (v: BackupAgentsLine) => v as BackupAgentsLine & { type: string } & Record<string, unknown>;

export async function collectAgents(scope: CollectScope, out: CategoryOut): Promise<void> {
  const { db, burrow } = scope;
  const agents = (await liveAgents(db, burrow.id)).sort((a, b) => a.position - b.position);
  const ids = agents.map((a) => a.id);
  const grantRows = ids.length
    ? await db.select().from(grants).where(inArray(grants.agentId, ids)).orderBy(asc(grants.position))
    : [];
  const schedules = ids.length
    ? await db
        .select()
        .from(agentSchedules)
        .where(
          and(inArray(agentSchedules.agentId, ids), inArray(agentSchedules.status, ['active', 'paused'])),
        )
        .orderBy(asc(agentSchedules.createdAt))
    : [];
  for (const a of agents) {
    const runtime = agentRuntimeOf(a.runtime);
    const agentGrants = grantRows
      .filter((g) => g.agentId === a.id)
      .map((g) => {
        const scopeValue = g.scope ? { ...g.scope } : null;
        if (scopeValue?.connections) out.ref(...scopeValue.connections);
        return { keyId: g.keyId, tier: g.tier, scope: scopeValue };
      })
      .slice(0, 200);
    out.ref(a.id);
    await out.record(
      rec({
        type: 'agent',
        id: a.id,
        handle: a.handle,
        name: a.name.slice(0, 80),
        face: faceOf(a),
        runtime: {
          provider: runtime.provider,
          model: runtime.model ?? null,
          effort: runtime.effort ?? null,
          fast: runtime.fast ?? null,
        },
        grants: agentGrants,
        createdAt: iso(a.createdAt),
      }),
    );
  }

  for (const s of schedules) {
    out.ref(s.agentId, s.conversationId);
    await out.record(
      rec({
        type: 'schedule',
        id: s.id,
        agent: s.agentId,
        conversation: s.conversationId,
        threadRoot: scope.categories.has('messages') ? (s.threadRootId ?? null) : null,
        prompt: s.prompt.slice(0, 4000),
        when: s.when,
        status: s.status === 'paused' ? 'paused' : 'active',
        endsAt: s.endsAt ? iso(s.endsAt) : null,
        createdAt: iso(s.createdAt),
      }),
    );
  }

  // “Always allow” commands the person gave the agent (BF-20, BF-S16).
  const allowances = ids.length
    ? await db
        .select()
        .from(commandAllowances)
        .where(inArray(commandAllowances.agentId, ids))
        .orderBy(asc(commandAllowances.createdAt))
    : [];
  for (const c of allowances) {
    out.ref(c.agentId, c.createdById);
    await out.record(
      rec({
        type: 'command_allowance',
        agent: c.agentId,
        keyId: c.keyId,
        command: c.command,
        target: c.target || null,
        createdBy: c.createdById,
        createdAt: iso(c.createdAt),
      }),
    );
  }
}
