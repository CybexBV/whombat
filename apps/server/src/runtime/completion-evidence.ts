import { and, desc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { activities } from '../db/schema/index';

/** Observations, not agent-authored run logs or test counts. Scope every query to this actor and task. */
export async function completionEvidence(
  db: Db | Tx,
  scope: {
    burrowId: string;
    agentId: string;
    runId?: string;
    dispatchId?: string;
    conversationId?: string;
    threadRootId?: string;
  },
) {
  if (!scope.runId && !scope.dispatchId && !scope.threadRootId) return [];
  return db
    .select({
      id: activities.id,
      tool: activities.tool,
      title: activities.title,
      detail: activities.detail,
      exitCode: activities.exitCode,
    })
    .from(activities)
    .where(
      and(
        eq(activities.burrowId, scope.burrowId),
        eq(activities.agentId, scope.agentId),
        scope.runId
          ? eq(activities.runId, scope.runId)
          : scope.dispatchId
            ? eq(activities.dispatchId, scope.dispatchId)
            : and(
                eq(activities.conversationId, scope.conversationId ?? ''),
                eq(activities.threadRootId, scope.threadRootId ?? ''),
              ),
        eq(activities.status, 'done'),
        or(isNull(activities.exitCode), eq(activities.exitCode, 0)),
        inArray(activities.kind, ['command', 'read', 'edit', 'web', 'tool', 'whombat']),
        notInArray(
          activities.tool,
          [
            'completion_evidence',
            'finish_run',
            'run_tests',
            'run_log',
            'run_step',
            'run_files',
            'report_back',
            'skill_result',
            'memory',
            'post_message',
            'post_answer',
            'set_status',
            'Skill',
          ].flatMap((name) => [name, `whombat.${name}`, `mcp__whombat__${name}`]),
        ),
      ),
    )
    .orderBy(desc(activities.finishedAt))
    .limit(20);
}
