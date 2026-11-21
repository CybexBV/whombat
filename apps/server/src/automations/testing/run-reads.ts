/** Minimal relational workload shared by the run-read regression tests and benchmark; no engine or outside calls. */
import { AutomationDefinition, IDLE_EXECUTION } from '@whombat/core';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Db, Sql } from '../../db/client';
import * as schema from '../../db/schema/index';
import {
  approvals,
  automationRunSteps,
  automationRuns,
  automations,
  burrows,
  dispatches,
  runs,
} from '../../db/schema/index';

export function runReadDb(sql: Sql, queries: string[]) {
  return drizzle(sql, { schema, logger: { logQuery: (query) => queries.push(query) } });
}

export async function seedRunReadWorkload(db: Db, count = 30) {
  const burrowId = 'bur_run_reads';
  const conversationId = 'cnv_run_reads';
  const personId = 'prn_run_reads';
  const now = new Date('2026-10-31T10:00:00.000Z');
  const definition = AutomationDefinition.parse({
    version: 1,
    conversationId,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'read', kind: 'dispatch_agent', prompt: 'Read the service status.' }],
  });
  await db.insert(burrows).values({ id: burrowId, slug: 'run-reads', name: 'Run reads', createdAt: now });
  await db.insert(automations).values(
    Array.from({ length: 4 }, (_, i) => ({
      id: `aut_run_reads_${i}`,
      burrowId,
      name: `Automation ${i}`,
      principalId: `prn_run_reads_${i}`,
      createdById: personId,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const usage = [
    null,
    { inputTokens: 0, outputTokens: 0 },
    { inputTokens: 4, outputTokens: 0, cacheReadTokens: 4 },
    { inputTokens: 10, outputTokens: 3 },
    { inputTokens: 30, outputTokens: 2, cacheReadTokens: 50 },
    { inputTokens: 1500, outputTokens: 200, cacheReadTokens: 1000, cacheWriteTokens: 400 },
  ];
  const inputs = Array.from({ length: count }, (_, i) => ({
    id: `arn_run_reads_${i}`,
    burrowId,
    number: i + 1,
    automationId: `aut_run_reads_${i % 4}`,
    version: 0,
    definition,
    publishedById: personId,
    status: 'succeeded' as const,
    trigger: {
      kind: 'manual' as const,
      summary: 'Run now',
      actorId: personId,
      eventId: null,
      messageId: null,
      scheduledFor: null,
    },
    triggerKey: `manual:${i}`,
    conversationId,
    startedById: personId,
    createdAt: new Date(now.getTime() + i * 1000),
    deadlineAt: new Date(now.getTime() + 3_600_000),
    updatedAt: now,
  }));
  await db.insert(automationRuns).values(inputs);
  await db.insert(dispatches).values(
    inputs.flatMap((row, i) =>
      [0, 1].map((n) => ({
        id: `dsp_run_reads_${i}_${n}`,
        burrowId,
        agentId: 'prn_run_reads_agent',
        trigger: 'automation' as const,
        conversationId,
        usage: usage[i % usage.length],
        createdAt: row.createdAt,
      })),
    ),
  );
  await db.insert(approvals).values(
    inputs.map((row, i) => ({
      id: `apr_run_reads_${i}`,
      burrowId,
      number: i + 1,
      requesterId: personId,
      action: {
        type: 'merge_pr' as const,
        params: { repo: 'example/service', prNumber: i + 1, base: 'main' },
      },
      title: 'Merge the change',
      question: 'Merge this change?',
      conditions: [],
      execution: IDLE_EXECUTION,
      conversationId,
      createdAt: row.createdAt,
    })),
  );
  await db.insert(runs).values(
    inputs.flatMap((row, i) =>
      [0, 1].map((n) => ({
        id: `run_run_reads_${i}_${n}`,
        burrowId,
        number: i * 2 + n + 1,
        agentId: 'prn_run_reads_agent',
        title: 'Read the service',
        branch: `read/${i}/${n}`,
        status: 'done' as const,
        askedById: personId,
        conversationId,
        dispatchId: `dsp_run_reads_${i}_0`,
        startedAt: row.createdAt,
      })),
    ),
  );
  // Insertion order differs from step order; a batched query interleaves equal positions across runs.
  await db.insert(automationRunSteps).values(
    [3, 1, 2, 0].flatMap((idx) =>
      inputs.map((row, i) => ({
        runId: row.id,
        idx,
        stepId: `step_${idx}`,
        kind: idx < 2 ? ('dispatch_agent' as const) : ('post_message' as const),
        name: `Step ${idx}`,
        state: 'succeeded' as const,
        dispatchId: idx < 2 ? `dsp_run_reads_${i}_${idx}` : null,
        approvalId: idx === 2 ? `apr_run_reads_${i}` : null,
        inputSummary: idx === 3 ? 'A'.repeat(400) : `Read ${i}`,
        output: { item: i, step: idx },
        updatedAt: now,
      })),
    ),
  );
  return db.select().from(automationRuns).orderBy(asc(automationRuns.number));
}
