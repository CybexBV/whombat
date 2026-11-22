import {
  type AutomationStep,
  blockedEventFields,
  type JsonObject,
  keyLabel,
  MissingMailAttachment,
  missingAttachmentsText,
  newId,
} from '@whombat/core';
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { automationDispatchRuntime } from '../../chats/runtime-rules';
import type { ApplyContext } from '../../commit/types';
import type { Db, Tx } from '../../db/client';
import { automationRunSteps, automationRuns, dispatches, messages } from '../../db/schema/index';
import { postMessage } from '../../domain/messages';
import { billedTokensSum } from '../../domain/turn-usage';
import { linkAttachments } from '../../files/commands';
import { loadConversationRow } from '../../read/conversations';
import { loadMessageRow } from '../../read/messages';
import { agentRuntimeOf } from '../../read/principals';
import { publishDispatch } from '../../runtime/activity';
import { outsidersTurn } from '../../runtime/person';
import { automationAgent } from '../authority';
import { turnThreadsOf } from '../mail-text';
import { proposableConnections } from '../proposed-actions';
import {
  type ReusableAssessment,
  reusableAssessment,
  reusedMessage,
  reusedOutput,
  reusedSummary,
} from '../reuse';
import { outsidersRun, runPersonOf } from '../runs';
import {
  type AutomationRunRow,
  type AutomationStepRow,
  HANDED_TOKENS_SUM,
  HAS_HANDED_TOKENS,
  runTokens,
} from '../store';
import { handedTurnEnded, handedWaitOf, resumedOutput } from '../turn-waits';
import {
  approvedBranchRequest,
  branchDecision,
  branchProposal,
  type RunWorkspace,
  resolveStepWorkspace,
} from '../workspace';
import { CONTINUE_STEP, requestStepApproval } from './approval';
import { triggerFileCopies } from './post-message';
import { block, updateStep } from './state';
import { placeFor } from './thread';
import type { StepExecution } from './types';
import { checkoutWords, requestLine, stepInstructions } from './words';

/**
 * Whether this step's prompt is the run's first agent turn, which carries the files of what started the run: no agent
 * step of the run (this one in an earlier attempt included) posted a prompt yet. Otherwise the ids this step kept from
 * an earlier attempt, if any.
 */
export function handoverOf(
  run: Pick<AutomationRunRow, 'definition'>,
  steps: readonly Pick<AutomationStepRow, 'idx' | 'promptMessageId' | 'output'>[],
  idx: number,
): { first: true } | { first: false; kept: string[] | null } {
  const turned = steps.some(
    (s) => !!s.promptMessageId && run.definition.steps[s.idx]?.kind === 'dispatch_agent',
  );
  if (!turned) return { first: true };
  const kept = (steps.find((s) => s.idx === idx)?.output as { triggerFileIds?: unknown } | undefined)
    ?.triggerFileIds;
  return {
    first: false,
    kept: Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : null,
  };
}

export async function executeDispatchAgent({
  ctx,
  run,
  steps,
  idx,
  attempt,
  scope,
  publisher,
  base,
  step,
}: StepExecution<'dispatch_agent'>): Promise<void> {
  const tx = ctx.tx;
  const place = await placeFor(ctx, run, step);
  // The agent runs every step for the automation's person (one-agent.md OA-15).
  const agent = await automationAgent(tx, run.burrowId);
  if (!agent) return block(ctx, run, idx, 'That agent can’t be asked by an automation.');
  const conversation = await loadConversationRow(tx, place.conversationId);
  if (!conversation || conversation.burrowId !== run.burrowId)
    return block(ctx, run, idx, 'That conversation is gone.');
  const limits = run.definition.limits;
  if (limits.maxTokensPerRun) {
    const used = (await runTokens(tx, run.id)) ?? 0;
    if (used >= limits.maxTokensPerRun) return block(ctx, run, idx, 'This run reached its AI limit.');
  }
  if (limits.maxTokensPerDay) {
    const used = await tokensToday(tx, run.automationId, ctx.now);
    if (used >= limits.maxTokensPerDay)
      return block(ctx, run, idx, 'It reached today’s AI limit; it can run again tomorrow.');
  }
  // A report's fix starts only while fewer than `FIXES_AT_ONCE` report fixes are at work here (TA-69): its run
  // takes no place once the fix began, so this bounds the fixes running together; the next one starts a minute later.
  if (step.id === 'fix' && (run.scope as { kind?: unknown } | null)?.kind === 'tracker') {
    const atWork = await fixesAtWork(tx, run.burrowId, run.id);
    if (atWork >= FIXES_AT_ONCE) {
      await updateStep(
        tx,
        run.id,
        idx,
        {
          ...base,
          state: 'pending',
          wakeAt: new Date(ctx.now.getTime() + 60_000),
          inputSummary: FIX_WAITS_WORDS,
        },
        ctx.now,
      );
      return;
    }
  }
  // Coding work (BP-C26): the checkout the runner prepares. For `write`, the agent's branch key decides before
  // the agent is asked: an ask waits for a person (bound to this step and attempt), a no blocks the step.
  let workspace: RunWorkspace | null = null;
  const previous = (steps[idx]?.output ?? {}) as JsonObject;
  /** A person's approval of this attempt, when the agent's branch key asks (it lets the push through). */
  let branchApprovalId: string | null = null;
  if (step.workspace) {
    const resolved = await resolveStepWorkspace(
      tx,
      run.burrowId,
      step.workspace,
      scope,
      ctx.services.github.adapter,
    );
    if (!resolved.ok) return block(ctx, run, idx, resolved.reason);
    workspace = resolved.workspace;
  }
  const basePrompt = stepInstructions(run.definition, idx, scope);
  const offers = step.proposeActions ? await proposableConnections(tx, run.burrowId) : null;
  const prompt = offers?.note ? `${basePrompt}\n\n${offers.note}` : basePrompt;
  // A test run about a report or issue an earlier run just assessed the same way uses that assessment (RN-S2).
  const reusable = await reusableAssessment(tx, run, step, agent.id, workspace, prompt, ctx.now);
  if (reusable) return reuseAssessment(ctx, run, idx, step, agent, base, prompt, reusable);
  if (workspace?.access === 'write') {
    const decision = await branchDecision(tx, agent, publisher, workspace);
    if (decision.outcome === 'deny') {
      await ctx.emit({
        ...blockedEventFields(decision, agent.name, `work on ${workspace.branch}`),
        where: `${workspace.repo} · ${workspace.branch}`,
        aboutId: agent.id,
        payload: { runId: run.id, keyId: decision.keyId, reason: decision.reason },
      });
      return block(
        ctx,
        run,
        idx,
        `${agent.name} may not work on ${workspace.branch}: it doesn’t hold “${keyLabel(decision.keyId)}”.`,
      );
    }
    const asked = typeof previous.branchApprovalId === 'string' ? previous.branchApprovalId : null;
    if (asked && (await approvedBranchRequest(tx, asked, run.id, step, attempt))) branchApprovalId = asked;
    if (decision.outcome === 'ask' && !branchApprovalId) {
      const proposal = branchProposal(agent.name, workspace);
      const approval = await requestStepApproval(
        ctx,
        run,
        step,
        attempt,
        scope,
        { name: CONTINUE_STEP, input: { runId: run.id, stepId: step.id, attempt, proposal } },
        { ...proposal, keyId: decision.keyId },
      );
      await updateStep(
        tx,
        run.id,
        idx,
        {
          ...base,
          state: 'waiting',
          approvalId: approval.id,
          dispatchId: null,
          inputSummary: `Asked you to let ${agent.name} work on ${workspace.branch}`,
          output: {
            agentId: agent.id,
            workspace: { ...workspace },
            ...(turnThreadsOf(previous).length ? { turnThreads: turnThreadsOf(previous) } : {}),
          },
        },
        ctx.now,
      );
      await tx
        .update(automationRuns)
        .set({ status: 'waiting', updatedAt: ctx.now })
        .where(eq(automationRuns.id, run.id));
      return;
    }
  }
  // The run's first agent prompt carries the files of what started the run (OA-S101; the email's, for a mail run), once,
  // whatever step came before it (a posted message may have started the thread). Their ids are kept on the step: only
  // those files may be uploaded by what the run proposes. A later turn, or this step tried again, gets none.
  const handover = handoverOf(run, steps, idx);
  const files = handover.first ? await triggerFileCopies(ctx, run, conversation.id) : [];
  const triggerFileIds = handover.first ? files.map((f) => f.id) : handover.kept;
  // People see one line (“@Dusty Assess it: #5 “…””); the instructions go to the agent with its turn (CNR-08).
  const posted = await postMessage(ctx, {
    conversation,
    text: `@${agent.name} ${requestLine(step, scope)}`,
    threadRootId: place.threadRootId,
    mentions: [agent.id],
    dispatch: false,
    outsidersRun: outsidersRun(run.trigger),
    ...(files.length ? { attachmentIds: files.map((f) => f.id) } : {}),
  });
  if (files.length) await linkAttachments(tx, ctx, posted.id, files);
  const promptRow = await loadMessageRow(tx, posted.id);
  // The agent answers in the prompt's thread (a top-level prompt starts one), so its reply — and the verdict
  // read from it — is told apart from anything else it says in the room (BP-C40).
  const threadRootId = promptRow?.threadRootId ?? posted.id;
  if (place.startsThread)
    await tx.update(automationRuns).set({ threadRootId: posted.id }).where(eq(automationRuns.id, run.id));
  // The dispatch is created with the step's new state (outbox-style): a crash leaves both or neither.
  const dispatchId = newId('dispatch');
  const runtime = automationDispatchRuntime(agentRuntimeOf(agent.runtime), run.trigger.kind);
  const [queuedTurn] = await tx
    .insert(dispatches)
    .values({
      id: dispatchId,
      burrowId: run.burrowId,
      agentId: agent.id,
      // An automation's work is the person's; a run started by outsiders' input stays apart.
      onBehalfOfAccountId: await runPersonOf(tx, run),
      trigger: 'automation',
      mode: 'reply',
      runtime,
      conversationId: conversation.id,
      messageId: posted.id,
      threadRootId,
      state: 'queued',
      createdAt: ctx.now,
    })
    .returning();
  if (queuedTurn) publishDispatch(ctx, queuedTurn);
  await ctx.emit({
    type: 'dispatch.created',
    kind: 'System',
    text: null,
    where: null,
    aboutId: agent.id,
    payload: {
      dispatchId,
      agentId: agent.id,
      trigger: 'automation',
      mode: 'reply',
      messageId: posted.id,
      runId: run.id,
    },
  });
  const runScope = run.scope as {
    missingAttachments?: unknown;
    missingAttachmentsOmitted?: unknown;
  } | null;
  const missingParsed = MissingMailAttachment.array().max(20).safeParse(runScope?.missingAttachments);
  const missingOmitted =
    typeof runScope?.missingAttachmentsOmitted === 'number' &&
    Number.isInteger(runScope.missingAttachmentsOmitted) &&
    runScope.missingAttachmentsOmitted > 0
      ? runScope.missingAttachmentsOmitted
      : 0;
  const missingList = missingParsed.success ? missingParsed.data : [];
  const missingNote =
    missingList.length > 0 || missingOmitted > 0
      ? missingAttachmentsText(missingList, missingOmitted, 3)
      : '';
  const stepInputSummary = workspace
    ? `Asked ${agent.name} · ${checkoutWords(workspace)}`
    : missingNote
      ? `Asked ${agent.name} · ${missingNote}`
      : `Asked ${agent.name}`;
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'waiting',
      dispatchId,
      promptMessageId: posted.id,
      inputSummary: stepInputSummary,
      output: {
        agentId: agent.id,
        instructions: prompt,
        ...(offers ? { offeredActions: offers.offeredActions } : {}),
        ...(triggerFileIds ? { triggerFileIds } : {}),
        turnThreads: [...new Set([...turnThreadsOf(previous), threadRootId])],
        ...(workspace ? { workspace: { ...workspace } } : {}),
        ...(branchApprovalId ? { branchApprovalId } : {}),
      },
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'waiting', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
  const services = ctx.services;
  ctx.after(async () => {
    services.typing.start({ conversationId: conversation.id, threadRootId, principalId: agent.id });
    services.runtime.wake();
  });
  return;
}

/**
 * The next turn of a step whose turn handed its T3 Code wait to Whombat, now that the thread finished or asks something
 * (docs/decisions/outsiders-turns.md): queued like the first, for the same agent and person, in reply to the same request (so it
 * gets the step's instructions, with a line on the thread it handed over), as one more turn of the same attempt. False
 * when the handed turn isn't there as it was.
 */
export async function resumeDispatchAgent(
  ctx: ApplyContext,
  run: AutomationRunRow,
  row: AutomationStepRow,
): Promise<boolean> {
  const tx = ctx.tx;
  if (!row.dispatchId) return false;
  const [handed] = await tx.select().from(dispatches).where(eq(dispatches.id, row.dispatchId));
  if (!handed || !handedTurnEnded(handed)) return false;
  // What the new turn says is its result; what came before it in the thread isn't (`dispatchResult`).
  const [last] = await tx
    .select({ ord: sql<string | number | null>`max(${messages.ord})` })
    .from(messages)
    .where(eq(messages.conversationId, handed.conversationId));
  const dispatchId = newId('dispatch');
  const [queuedTurn] = await tx
    .insert(dispatches)
    .values({
      id: dispatchId,
      burrowId: handed.burrowId,
      agentId: handed.agentId,
      onBehalfOfAccountId: handed.onBehalfOfAccountId,
      trigger: 'automation',
      mode: 'reply',
      runtime: handed.runtime,
      conversationId: handed.conversationId,
      messageId: handed.messageId,
      threadRootId: handed.threadRootId,
      state: 'queued',
      createdAt: ctx.now,
    })
    .returning();
  if (queuedTurn) publishDispatch(ctx, queuedTurn);
  await ctx.emit({
    type: 'dispatch.created',
    kind: 'System',
    text: null,
    where: null,
    aboutId: handed.agentId,
    payload: {
      dispatchId,
      agentId: handed.agentId,
      trigger: 'automation',
      mode: 'reply',
      messageId: handed.messageId,
      runId: run.id,
    },
  });
  // Postgres says a bigint's max as text.
  const after = last?.ord == null ? null : Number(last.ord);
  await updateStep(
    tx,
    run.id,
    row.idx,
    {
      dispatchId,
      output: resumedOutput(
        row.output as JsonObject,
        handed,
        after !== null && Number.isFinite(after) ? after : null,
      ),
    },
    ctx.now,
  );
  const services = ctx.services;
  ctx.after(async () => services.runtime.wake());
  return true;
}

/**
 * An assessment step of a test run that uses an earlier, identical assessment (RN-S2): nobody is asked; the step
 * succeeds with that assessment and answer, and one message — placed as the request would have been, so it starts the
 * run's thread when there is none — says whose it is and how to ask again.
 */
async function reuseAssessment(
  ctx: ApplyContext,
  run: AutomationRunRow,
  idx: number,
  step: Extract<AutomationStep, { kind: 'dispatch_agent' }>,
  agent: { id: string; name: string },
  base: Partial<typeof automationRunSteps.$inferInsert>,
  instructions: string,
  found: ReusableAssessment,
): Promise<void> {
  const tx = ctx.tx;
  const place = await placeFor(ctx, run, step);
  const conversation = await loadConversationRow(tx, place.conversationId);
  if (!conversation) return block(ctx, run, idx, 'That conversation is gone.');
  const posted = await postMessage(ctx, {
    conversation,
    text: reusedMessage(found, agent.name, ctx.now),
    threadRootId: place.threadRootId,
    mentions: [],
    dispatch: false,
    outsidersRun: outsidersRun(run.trigger),
  });
  if (place.startsThread)
    await tx.update(automationRuns).set({ threadRootId: posted.id }).where(eq(automationRuns.id, run.id));
  await updateStep(
    tx,
    run.id,
    idx,
    {
      ...base,
      state: 'succeeded',
      finishedAt: ctx.now,
      dispatchId: null,
      promptMessageId: null,
      messageIds: [posted.id],
      inputSummary: reusedSummary(found, agent.name),
      output: reusedOutput(found, instructions),
    },
    ctx.now,
  );
  await tx
    .update(automationRuns)
    .set({ status: 'running', updatedAt: ctx.now })
    .where(eq(automationRuns.id, run.id));
}

/** How many report fixes may be at work at once on this Whombat, whichever automation's (TA-69). */
export const FIXES_AT_ONCE = 2;
/** A fix step's summary while it waits for another fix to finish. */
export const FIX_WAITS_WORDS = 'Waits for another fix to finish';

/**
 * The other report runs on this Whombat whose fix step is at work (its turn asked, not finished yet), of any of its
 * tracker automations: a development and a production one fix in the same repository on the same computer.
 */
async function fixesAtWork(tx: Tx, burrowId: string, runId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(
      and(
        eq(automationRuns.burrowId, burrowId),
        sql`${automationRuns.scope}->>'kind' = 'tracker'`,
        ne(automationRuns.id, runId),
        inArray(automationRuns.status, ['running', 'waiting']),
        eq(automationRunSteps.stepId, 'fix'),
        inArray(automationRunSteps.state, ['waiting', 'running']),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Tokens an automation's runs reported in the last day, as billed (prompt-efficiency.md PE-04). */
async function tokensToday(tx: Tx, automationId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ tokens: billedTokensSum(sql`${dispatches.usage}`) })
    .from(dispatches)
    .innerJoin(automationRunSteps, eq(automationRunSteps.dispatchId, dispatches.id))
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        sql`${dispatches.createdAt} > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
        sql`${dispatches.usage} is not null`,
      ),
    );
  // A step's turns that handed their wait over, on the steps at work in the last day.
  const [handed] = await tx
    .select({ tokens: HANDED_TOKENS_SUM })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        HAS_HANDED_TOKENS,
        sql`${automationRunSteps.updatedAt} > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
      ),
    );
  return Number(row?.tokens ?? 0) + Number(handed?.tokens ?? 0);
}

/**
 * A step reads what its own dispatch posted inside the prompt’s thread. Older outsiders’ replies without a
 * dispatch id must carry the outsiders’ mark and fall inside the claim. Files never leave an outsiders’ step.
 */
export async function dispatchResult(tx: Db, step: AutomationStepRow, agentId: string) {
  const none = {
    text: '',
    reply: '',
    messageIds: [] as string[],
    attachmentIds: [] as string[],
    messageTexts: [] as string[],
  };
  if (!step.promptMessageId || !step.dispatchId) return none;
  const prompt = await loadMessageRow(tx, step.promptMessageId);
  if (!prompt) return none;
  const [dispatch] = await tx
    .select({
      agentId: dispatches.agentId,
      claimedAt: dispatches.claimedAt,
      finishedAt: dispatches.finishedAt,
      onBehalfOfAccountId: dispatches.onBehalfOfAccountId,
    })
    .from(dispatches)
    .where(eq(dispatches.id, step.dispatchId));
  if (dispatch?.agentId !== agentId) return none;
  const outside = outsidersTurn(dispatch);
  const own = eq(messages.dispatchId, step.dispatchId);
  const legacy =
    outside && dispatch.claimedAt
      ? and(
          isNull(messages.dispatchId),
          eq(messages.outsidersRun, true),
          gt(messages.createdAt, dispatch.claimedAt),
        )
      : undefined;
  const root = prompt.threadRootId ?? prompt.id;
  // After a handed wait, only what the step's newest turn said.
  const after = Math.max(prompt.ord, handedWaitOf(step.output)?.afterOrd ?? 0);
  const rows = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, prompt.conversationId),
        eq(messages.authorId, agentId),
        gt(messages.ord, after),
        eq(messages.threadRootId, root),
        or(own, legacy),
        ...(dispatch.finishedAt ? [lte(messages.createdAt, dispatch.finishedAt)] : []),
      ),
    )
    .orderBy(asc(messages.ord))
    .limit(20);
  const text = rows
    .map((m) => m.text)
    .join('\n\n')
    .slice(0, 8000);
  return {
    text,
    /** Its last message only (`{{steps.<id>.reply}}`, CT-322): what a recipe comments on GitHub, without a first line. */
    reply: keepEnds(rows.at(-1)?.text ?? '', 8000),
    messageIds: rows.map((m) => m.id),
    attachmentIds: outside ? [] : rows.flatMap((m) => m.attachmentIds ?? []).slice(0, 10),
    /** Each message on its own (a verdict is read from the reply that starts with one). */
    messageTexts: rows.map((m) => m.text),
  };
}

/**
 * A reply within `max` characters, its start and its end kept: a long one loses its middle, never its last line, where
 * a fix says what it did for the customer (report-trackers.md TA-55).
 */
export function keepEnds(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.min(1000, Math.floor(max / 4));
  return `${text.slice(0, max - tail - 3)}\n…\n${text.slice(-tail + 1)}`.slice(0, max);
}
