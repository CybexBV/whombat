/**
 * Commit-pipeline commands for the collaborative canvas:
 *
 * - `record_canvas_edit` — what a person (or an agent on a socket) typed on `/collab`, flushed in bursts by
 *   the collaboration service: the Yjs update row, provenance ("edited by Mara, Dusty · 12 min ago") and a
 *   hidden signed `canvas.edited` event carrying the update's hash, in one transaction. Edits to the plan
 *   block become Plan changes in the same commit.
 * - `edit_canvas` — `canvas_edit` from MCP: Markdown edits applied to the Y.Doc server-side, as the agent,
 *   with its awareness ("Dusty is writing" and a caret) shown to everyone on the canvas.
 */
import { createHash } from 'node:crypto';
import {
  applyEditsToYDoc,
  CanvasEditError,
  CanvasMarkdownError,
  caretJSON,
  type DocPlanStep,
  mergePlanEdits,
  planStepsFromDoc,
  readCanvas,
} from '@whombat/canvas-schema';
import { CanvasId, MCP_TOOLS, newId, type Plan, PlanId, topics } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { canvases, type StoredPlanStep as StoredStep } from '../db/schema/index';
import { commandWriter, lockPlanRow, savePlan } from '../domain/plans';
import { badRequest, notFound } from '../lib/errors';
import { loadPlan } from '../read/work';
import { toCanvas } from '../read/work-views';
import { exportMarkdown, principalNames, scratchDoc } from './document';
import { insertCanvasUpdate } from './store';

type CanvasRow = typeof canvases.$inferSelect;

const DocPlanStepSchema = z.object({
  stepId: z.string().max(80).nullable(),
  title: z.string().max(400),
  state: z.string().max(20),
});

const PlanEdit = z.object({
  planId: PlanId,
  before: z.array(DocPlanStepSchema).max(200),
  after: z.array(DocPlanStepSchema).max(200),
});
export type PlanEdit = z.infer<typeof PlanEdit>;

async function canvasFor(ctx: ApplyContext, where: { id?: string; slug?: string }): Promise<CanvasRow> {
  const [row] = await ctx.tx
    .select()
    .from(canvases)
    .where(
      and(
        eq(canvases.burrowId, ctx.burrow.id),
        where.id ? eq(canvases.id, where.id) : eq(canvases.slug, where.slug ?? ''),
      ),
    );
  if (!row) throw notFound('Canvas');
  return row;
}

/**
 * Stores a canvas update written by the actor: the update row, provenance, the exported Markdown and a
 * hidden signed `canvas.edited` event whose payload pins the update (sha256), then `canvas.updated`.
 */
async function persistEdit(
  ctx: ApplyContext,
  row: CanvasRow,
  update: Uint8Array,
  markdown: string,
  extra: Record<string, string | number> = {},
) {
  const updateId = await insertCanvasUpdate(ctx.tx, {
    canvasId: row.id,
    update,
    authorId: ctx.actor.id,
    createdAt: ctx.now,
  });
  // "edited by Mara, Dusty": other editors, most recent first; the author who drafted it is named apart.
  const editorIds =
    row.provenance.createdById === ctx.actor.id
      ? row.provenance.editorIds
      : [ctx.actor.id, ...row.provenance.editorIds.filter((id) => id !== ctx.actor.id)];
  const [updated] = await ctx.tx
    .update(canvases)
    .set({ provenance: { ...row.provenance, editorIds }, markdown, updatedAt: ctx.now })
    .where(eq(canvases.id, row.id))
    .returning();
  const event = await ctx.emit({
    type: 'canvas.edited',
    kind: 'Messages',
    text: null,
    where: row.title,
    ref: { type: 'canvas', slug: row.slug },
    payload: {
      canvasId: row.id,
      updateId,
      bytes: update.byteLength,
      sha256: createHash('sha256').update(update).digest('hex'),
      ...extra,
    },
  });
  if (updated)
    ctx.publish(
      topics.canvas(row.id),
      { type: 'canvas.updated', canvas: toCanvas(updated) },
      { eventId: event.id },
    );
  return { updateId, eventId: event.id };
}

/**
 * Applies plan-block edits to the Plan (as the actor): `savePlan`, so a signed `plan.updated`, the frame to the
 * plan's members and its search document. A started step removed in the block is kept (WS-07) and the block is
 * re-synced from the plan, even when nothing else changed.
 */
export async function applyPlanEdit(
  ctx: ApplyContext,
  canvasId: string,
  edit: PlanEdit,
): Promise<Plan | null> {
  const plan = await lockPlanRow(ctx.tx, ctx.burrow.id, edit.planId);
  if (!plan || plan.canvasId !== canvasId) return null;
  // Our own record that a step started counts too (`stepRemovable`); `mergePlanEdits` sees it as a follow key.
  const guarded = plan.steps.map((s) => ({
    ...s,
    followKey: s.followKey || (s.startedAt ? 'started' : null),
  }));
  const merged = mergePlanEdits(guarded, edit.before, edit.after, { newStepId: () => newId('step') });
  const afterIds = new Set(edit.after.map((s) => s.stepId).filter(Boolean));
  const refused = edit.before.some(
    (s) => s.stepId && !afterIds.has(s.stepId) && (merged ?? plan.steps).some((p) => p.id === s.stepId),
  );
  if (!merged && !refused) return null;
  const stored = new Map(plan.steps.map((s) => [s.id, s]));
  const steps: StoredStep[] | undefined = merged?.map((s) => {
    const own = stored.get(s.id);
    // Restore the stored bookkeeping (the guard above only fed the merge).
    return { ...s, followKey: own?.followKey ?? null, startedAt: own?.startedAt ?? null };
  });
  const loaded = await savePlan(commandWriter(ctx), plan, {
    ...(steps ? { steps } : {}),
    text: null,
    payload: { canvasId },
    republish: refused,
  });
  return loaded ?? null;
}

/* record_canvas_edit ---------------------------------------------------------------------------- */

export const recordCanvasEdit = defineCommand({
  name: 'record_canvas_edit',
  schema: z.object({
    canvasId: CanvasId,
    /** The merged Yjs update (base64). */
    update: z.string().min(1).max(8_000_000),
    /** The document exported to canvas Markdown after the update. */
    markdown: z.string().max(2_000_000),
    plan: PlanEdit.optional(),
  }),
  async apply(_tx, ctx, input) {
    const row = await canvasFor(ctx, { id: input.canvasId });
    const update = new Uint8Array(Buffer.from(input.update, 'base64'));
    const stored = await persistEdit(ctx, row, update, input.markdown);
    const plan = input.plan ? await applyPlanEdit(ctx, row.id, input.plan) : null;
    const services = ctx.services;
    ctx.after(async () => services.collab.scheduleIndex(row.id));
    return { ...stored, planChanged: plan !== null };
  },
});

/* edit_canvas (MCP canvas_edit) ----------------------------------------------------------------- */

function planSteps(doc: Parameters<typeof planStepsFromDoc>[0], planId: string | null): DocPlanStep[] | null {
  return planId ? planStepsFromDoc(doc, planId) : null;
}

export const editCanvas = defineCommand({
  name: 'edit_canvas',
  schema: MCP_TOOLS.canvas_edit.input,
  requiredKey: (input) => ({
    keyId: 'canvas.write',
    attempt: `edit the canvas “${input.canvas}”`,
    where: 'Canvases',
  }),
  async apply(tx: Tx, ctx, input) {
    const row = await canvasFor(ctx, { slug: input.canvas });
    const collab = ctx.services.collab;
    const writer = { id: ctx.actor.id };
    // Collaborators see the writer at once, before the edit lands.
    await collab.participantWriting(row.id, writer.id, true);
    try {
      const plan = row.planId ? ((await loadPlan(tx, row.planId)) ?? null) : null;
      // The edits are computed on a scratch copy; the difference becomes the update this commit stores.
      const scratch = scratchDoc(await collab.currentState(row));
      const { doc } = readCanvas(scratch);
      const before = Y.encodeStateVector(scratch);
      let result: ReturnType<typeof applyEditsToYDoc>;
      try {
        result = applyEditsToYDoc(scratch, input.edits, {
          plan: (id) => (plan && id === plan.id ? plan : null),
          strictPlans: true,
          highlightAuthor: ctx.actor.id,
          forceHighlightAuthor: ctx.actor.kind === 'agent',
        });
      } catch (err) {
        scratch.destroy();
        if (err instanceof CanvasEditError || err instanceof CanvasMarkdownError)
          throw badRequest(err.message);
        throw err;
      }
      const update = Y.encodeStateAsUpdate(scratch, before);
      const caret = result.caret === null ? null : caretJSON(scratch, result.meta, result.caret);
      scratch.destroy();
      const markdown = exportMarkdown(result.doc, await principalNames(tx, ctx.burrow.id));
      await persistEdit(ctx, row, update, markdown, { edits: input.edits.length });
      const planBefore = planSteps(doc, row.planId);
      const planAfter = planSteps(result.doc, row.planId);
      if (row.planId && planBefore && planAfter)
        await applyPlanEdit(ctx, row.id, { planId: row.planId, before: planBefore, after: planAfter });
      ctx.after(async () => {
        await collab.applyStored(row.id, update);
        collab.participantWrote(row.id, writer.id, caret);
        collab.scheduleIndex(row.id);
      });
      return { updatedAt: ctx.at };
    } catch (err) {
      await collab.participantWriting(row.id, writer.id, false);
      throw err;
    }
  },
});
