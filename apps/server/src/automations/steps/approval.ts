import type { AutomationStep, JsonObject, KeyId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { asQuestion, createApproval } from '../../approvals/create';
import type { ApplyContext } from '../../commit/types';
import { automations, messages } from '../../db/schema/index';
import { notFound } from '../../lib/errors';
import { loadConversationRow } from '../../read/conversations';
import { loadPrincipalRow, shortName } from '../../read/principals';
import { outsidersRun, runPersonOf } from '../runs';
import type { AutomationRunRow } from '../store';
import { stepBinding } from './binding';
import { startsRunThread } from './thread';
import { approvalWords } from './words';

/** The deferred command an approved `request_approval` step runs: it continues the run. */
export const CONTINUE_STEP = 'automation.continue_step';

/** The approval card for a `request_approval` step (or an integration step whose key asks). */
export async function requestStepApproval(
  ctx: ApplyContext,
  run: AutomationRunRow,
  step: AutomationStep,
  attempt: number,
  scope: Record<string, unknown>,
  command: { name: string; input: JsonObject },
  copy: {
    title: string;
    details: string;
    keyId: KeyId;
    cardText?: string;
    /**
     * The card's question when it is the step's own words (a definition's “Ship it?”, Whombat's “Fix this bug?”, AR-D07);
     * else the title as a question. Never found in details that hold someone else's words.
     */
    question?: string | null;
    /** WHAT HAPPENS line by line, when the step wrote every line itself; else made from the details. */
    whatHappens?: string[];
    /** The short summary (mobile); else the start of the details. */
    summary?: string;
  },
) {
  const [automation] = await ctx.tx.select().from(automations).where(eq(automations.id, run.automationId));
  const conversation = await loadConversationRow(ctx.tx, run.conversationId);
  if (!conversation) throw notFound('Conversation');
  const publisher = await loadPrincipalRow(ctx.tx, run.publishedById);
  const name = automation?.name ?? 'Automation';
  const binding = await stepBinding(ctx.tx, run, step, attempt, scope);
  const { approval, messageId } = await createApproval(ctx, {
    keyId: copy.keyId,
    action: {
      type: 'custom',
      params: {
        name: `continue “${name}”`.slice(0, 80),
        keyId: copy.keyId,
        data: { automationId: run.automationId, runId: run.id, stepId: step.id, attempt },
      },
    },
    decision: null,
    title: copy.title.slice(0, 160),
    ...(copy.whatHappens
      ? { question: copy.question ?? asQuestion(copy.title.slice(0, 198)), whatHappens: copy.whatHappens }
      : approvalWords(copy.title, copy.details, copy.question ?? null)),
    target: `${name} · run #${run.number}`.slice(0, 120),
    explainer:
      `“${name}” is an automation${publisher ? ` ${shortName(publisher)} published` : ''}. It waits here until a person says yes; if you decline, it stops.`.slice(
        0,
        600,
      ),
    summary: (copy.summary ?? copy.details).slice(0, 600),
    conditions: [],
    involvedIds: [],
    conversation,
    // In the run's thread, with everything else about the issue or report (AR-31); before it has one the card starts it.
    threadRootId: run.threadRootId,
    cardText: (copy.cardText ?? `I need a person to say yes before I go on: ${copy.title}`).slice(0, 4000),
    askText: 'Asked you to say yes before going on',
    where: null,
    // What it continues is the run's work: the person's, or apart for outsiders' input (OP-17).
    onBehalfOfAccountId: await runPersonOf(ctx.tx, run),
    outsidersRun: outsidersRun(run.trigger),
    command,
    binding,
  });
  // The card is the run's first post: it starts the run's thread, so what follows is under it (OA-S100).
  if (!run.threadRootId) {
    const [card] = await ctx.tx
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, messageId));
    if (card?.conversationId === run.conversationId) await startsRunThread(ctx.tx, run.id, messageId);
  }
  return approval;
}
