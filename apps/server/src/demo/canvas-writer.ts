/**
 * The agent writes the third rule of the plan canvas while the demo plays — the mock's live moment ("Dusty is
 * writing", its caret after "…keyed by invoice number and locale") made real, through `canvas_edit` (`edit_canvas`,
 * signed as the burrow's agent under its "Write canvases" key) like any agent edit:
 *
 * - `start`: the rule restarts from its first words and the agent types it in a few edits (the canvas shows its
 *   caret and "Dusty is writing" after each), ending where the mock catches it. It then stays at the end of the
 *   rule, still writing (its awareness is renewed while the run plays), so anyone who opens the canvas during the
 *   demo sees the mock's state.
 * - `finish` (the run is done): it writes the full stop and stops writing; the collaboration service lets "writing"
 *   lapse and its presence expire as after any agent edit.
 *
 * A burrow without the canvas or an agent is skipped quietly; a canvas without the rule gets it appended.
 */
import { caretJSON, type CanvasNode as PMNode, readCanvas } from '@whombat/canvas-schema';
import type { CanvasEdit } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { editCanvas } from '../collab/commands';
import { canvases, principals } from '../db/schema/index';
import type { Services } from '../services';

export const PLAN_RULE = {
  canvasSlug: 'invoice-pdf-export-plan',
  /** The rule as the agent types it, edit by edit; together they are the seeded rule (no full stop yet). */
  words: [
    'PDFs are generated on request',
    ' and cached for 24 hours,',
    ' keyed by invoice number',
    ' and locale',
  ],
  /** What it writes once the run is done. */
  end: '.',
} as const;

export interface CanvasWriterTimings {
  /** Between two of the agent's edits. */
  stepMs: number;
  /** How often its "writing" and caret are renewed while it stays at the end of the rule. */
  heartbeatMs: number;
}

export const DEFAULT_CANVAS_WRITER_TIMINGS: CanvasWriterTimings = { stepMs: 650, heartbeatMs: 3000 };

interface Target {
  burrowId: string;
  agentId: string;
  canvasId: string;
}

/** The rule's text in a document (the textblock starting with its first words), or null. */
export function ruleText(doc: PMNode): string | null {
  let found: string | null = null;
  doc.descendants((node) => {
    if (found !== null) return false;
    if (node.isTextblock) {
      if (node.textContent.startsWith(PLAN_RULE.words[0])) found = node.textContent;
      return false;
    }
    return true;
  });
  return found;
}

export class CanvasWriter {
  private generation = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly services: Services,
    readonly timings: CanvasWriterTimings = { ...DEFAULT_CANVAS_WRITER_TIMINGS },
  ) {}

  /** The agent (re)writes the rule, then keeps writing at its end until `finish` / `stop`. */
  start(burrowId: string): Promise<void> {
    const gen = ++this.generation;
    this.stopHeartbeat();
    return this.enqueue(async () => {
      const target = await this.target(burrowId);
      if (!target) return;
      let written = '';
      for (const [i, words] of PLAN_RULE.words.entries()) {
        if (gen !== this.generation) return;
        if (i > 0) await sleep(this.timings.stepMs);
        const next = written + words;
        await this.write(
          target,
          i === 0 ? await this.restart(target, next) : [{ op: 'replace', find: written, markdown: next }],
        );
        written = next;
      }
      if (gen === this.generation) this.keepWriting(target, gen);
    });
  }

  /** The run is done: the agent ends the rule with its full stop. */
  finish(burrowId: string): Promise<void> {
    const gen = ++this.generation;
    this.stopHeartbeat();
    return this.enqueue(async () => {
      const target = await this.target(burrowId);
      if (!target || gen !== this.generation) return;
      const current = ruleText(await this.doc(target));
      if (!current || current.endsWith(PLAN_RULE.end)) return;
      await this.write(target, [{ op: 'replace', find: current, markdown: current + PLAN_RULE.end }]);
    });
  }

  /** Stops writing (rewind, shutdown). */
  stop(): void {
    this.generation++;
    this.stopHeartbeat();
  }

  /** Resolves once queued edits are written. */
  settled(): Promise<unknown> {
    return this.work;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.work.then(fn, fn);
    this.work = next.catch((err) =>
      this.services.log.error({ err: String(err) }, 'demo: the agent could not write the canvas'),
    );
    return next;
  }

  private async target(burrowId: string): Promise<Target | null> {
    const db = this.services.db;
    // The burrow's one agent (one-agent.md OA-01).
    const [agent] = await db
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, burrowId), eq(principals.kind, 'agent')))
      .orderBy(asc(principals.position));
    const [canvas] = await db
      .select({ id: canvases.id })
      .from(canvases)
      .where(and(eq(canvases.burrowId, burrowId), eq(canvases.slug, PLAN_RULE.canvasSlug)));
    return agent && canvas ? { burrowId, agentId: agent.id, canvasId: canvas.id } : null;
  }

  private async doc(target: Target): Promise<PMNode> {
    const [row] = await this.services.db.select().from(canvases).where(eq(canvases.id, target.canvasId));
    if (!row) throw new Error('The plan canvas is gone.');
    return this.services.collab.currentDoc(row);
  }

  /** The first edit: the rule back to its first words (appended when the canvas does not have it). */
  private async restart(target: Target, first: string): Promise<CanvasEdit[]> {
    const current = ruleText(await this.doc(target));
    if (current === null) return [{ op: 'append', markdown: `- ${first}` }];
    return [{ op: 'replace', find: current, markdown: first }];
  }

  private async write(target: Target, edits: CanvasEdit[]): Promise<void> {
    const res = await this.services.pipeline.commit(
      editCanvas,
      { canvas: PLAN_RULE.canvasSlug, edits },
      { burrowId: target.burrowId, actorId: target.agentId },
    );
    if (res.status !== 'ok') throw new Error(`The agent's canvas edit was ${res.status}`);
  }

  /** The agent stays at the end of the rule, writing: its state is renewed with its caret after the last word. */
  private keepWriting(target: Target, gen: number): void {
    const renew = async () => {
      if (gen !== this.generation) return;
      const collab = this.services.collab;
      await collab.participantWriting(target.canvasId, target.agentId, true);
      const [row] = await this.services.db.select().from(canvases).where(eq(canvases.id, target.canvasId));
      if (!row || gen !== this.generation) return;
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, await collab.currentState(row));
        const { doc, meta } = readCanvas(scratch);
        const end = ruleEnd(doc);
        if (end !== null)
          collab.participantWrote(target.canvasId, target.agentId, caretJSON(scratch, meta, end));
      } finally {
        scratch.destroy();
      }
    };
    this.heartbeat = setInterval(() => void renew().catch(() => {}), this.timings.heartbeatMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

/** Document position just after the rule's last character. */
function ruleEnd(doc: PMNode): number | null {
  let end: number | null = null;
  doc.descendants((node, pos) => {
    if (end !== null) return false;
    if (node.isTextblock) {
      if (node.textContent.startsWith(PLAN_RULE.words[0])) end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  return end;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
