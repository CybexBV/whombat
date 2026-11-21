/**
 * Run hydration needs Postgres to check grouped billed-token rounding, joins and ordered steps across a whole page.
 * A minimal relational fixture exercises those reads without starting a server or an automation engine.
 */
import { AutomationRun, definitionHash } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { automationRunSteps, automations, automationVersions } from '../db/schema/index';
import { useTestDb } from '../test/db';
import { type AutomationRunRow, runTokens, toAutomation, toRun, toRuns } from './store';
import { runReadDb, seedRunReadWorkload } from './testing/run-reads';

const t = useTestDb();
const queries: string[] = [];
let db: ReturnType<typeof runReadDb>;
let rows: AutomationRunRow[];

beforeAll(async () => {
  db = runReadDb(t.sql, queries);
  rows = await seedRunReadWorkload(db, 8);
});

function row(index: number) {
  const found = rows[index];
  if (!found) throw new Error(`Missing fixture run ${index}`);
  return found;
}

describe('batched automation run reads', () => {
  it('reads a page in five statements, preserving input order, duplicates, step order and links', async () => {
    const selected = [row(4), row(2), row(0), row(4)];
    queries.length = 0;
    const loaded = await toRuns(db, selected);
    expect(queries).toHaveLength(5);
    expect(loaded.map((r) => r.id)).toEqual(selected.map((r) => r.id));
    expect(loaded[0]).toEqual(loaded[3]);
    for (const run of loaded) {
      expect(AutomationRun.parse(run)).toEqual(run);
      expect(run.automationName).toBe(`Automation ${(run.number - 1) % 4}`);
      expect(run.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
      expect(run.steps[0]?.runNumbers).toEqual([run.number * 2 - 1, run.number * 2]);
      expect(run.steps[1]?.runNumbers).toEqual([]);
      expect(run.steps[2]?.approvalNumber).toBe(run.number);
      expect(run.steps[3]?.inputSummary).toHaveLength(300);
      expect(run.steps[3]?.inputSummary.endsWith('…')).toBe(true);
      expect(run.steps[0]?.output).toEqual({ item: run.number - 1, step: 0 });
    }
    expect(await toRun(db, row(4))).toEqual(loaded[0]);
  });

  it('keeps unknown usage distinct from zero and rounds cache reads once per run', async () => {
    const loaded = await toRuns(db, rows.slice(0, 6));
    // Two four-token cache reads bill round(8 * 0.1) = 1, rather than two independently rounded zeros.
    expect(loaded.map((run) => run.tokens)).toEqual([null, 0, 1, 26, 10, 1600]);
    for (const [index, run] of loaded.entries()) expect(await runTokens(db, row(index).id)).toBe(run.tokens);
  });

  it('returns no queries for an empty input, and retains missing-row and missing-link fallbacks', async () => {
    queries.length = 0;
    expect(await toRuns(db, [])).toEqual([]);
    expect(queries).toEqual([]);
    const absent = { ...row(0), id: 'arn_missing', automationId: 'aut_missing' };
    const [empty] = await toRuns(db, [absent]);
    expect(empty).toMatchObject({ id: absent.id, automationName: 'Automation', tokens: null, steps: [] });
    await db
      .update(automationRunSteps)
      .set({ dispatchId: 'dsp_missing', approvalId: 'apr_missing' })
      .where(and(eq(automationRunSteps.runId, row(7).id), eq(automationRunSteps.idx, 0)));
    const missing = await toRun(db, row(7));
    expect(missing.steps[0]).toMatchObject({ runNumbers: [], approvalNumber: null });
    expect(missing.steps[2]?.approvalNumber).toBe(row(7).number);
  });

  it('counts a shared dispatch once for each linked step, as the existing budget query does', async () => {
    await db
      .update(automationRunSteps)
      .set({ dispatchId: 'dsp_run_reads_2_0' })
      .where(and(eq(automationRunSteps.runId, row(6).id), eq(automationRunSteps.idx, 1)));
    const loaded = await toRuns(db, [row(6), row(2)]);
    expect(loaded.map((run) => run.tokens)).toEqual([0, 1]);
    expect(loaded[0]?.steps[1]?.runNumbers).toEqual([5, 6]);
    // Both steps in one run may refer to the same dispatch; its usage remains counted for each step.
    await db
      .update(automationRunSteps)
      .set({ dispatchId: 'dsp_run_reads_2_0' })
      .where(and(eq(automationRunSteps.runId, row(2).id), eq(automationRunSteps.idx, 1)));
    expect((await toRun(db, row(2))).tokens).toBe(1);
  });

  it('reads a published definition and its publisher from the same version once', async () => {
    const first = row(0);
    const [automation] = await db
      .update(automations)
      .set({ currentVersion: 1 })
      .where(eq(automations.id, first.automationId))
      .returning();
    if (!automation) throw new Error('Missing fixture automation');
    await db.insert(automationVersions).values({
      automationId: automation.id,
      n: 1,
      definition: first.definition,
      definitionHash: definitionHash(first.definition),
      publishedById: first.publishedById,
      publishedAt: first.createdAt,
    });
    queries.length = 0;
    const loaded = await toAutomation(db, automation);
    expect(queries.filter((query) => query.includes('from "automation_versions"'))).toHaveLength(1);
    expect(loaded.definition).toEqual(first.definition);
    expect(loaded.publishedById).toBe(first.publishedById);
  });
});
