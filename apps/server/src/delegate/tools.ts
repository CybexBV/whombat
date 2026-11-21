/**
 * The delegation's tools (docs/decisions/delegate.md): `delegate_offer`, `delegate_update`, `delegate_finish` and
 * `delegate_read`, in the person's own turns while a T3 Code connection manages. Each answer tells the agent the card's
 * list as it is now, so the numbers it and the person use stay the card's; each refusal says what to do instead.
 */

import {
  DELEGATION_AT_ONCE_DEFAULT,
  type DelegateFinishOutput,
  type DelegateOfferOutput,
  type DelegateReadOutput,
  type DelegateTaskInput,
  type DelegateUpdateOutput,
  type McpToolName,
  newId,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { loadCouncil, loadMembers, roundIn } from '../council/commands';
import { oneSeat, providersOf, type T3Provider } from '../council/members';
import { councilConnection, findProject, t3Projects } from '../council/run';
import type { CouncilRow, CouncilSeat } from '../db/schema/index';
import { messages } from '../db/schema/index';
import { ApiError, conflict } from '../lib/errors';
import type { ToolContext, ToolHandler } from '../mcp/tools';
import { callT3 } from '../things/kinds/business/t3code';
import { ownTurn } from '../vault/self-serve';
import { mergeOnCard } from './card';
import {
  chainedLines,
  delegationOfThread,
  finishDelegation,
  isLive,
  loadDelegation,
  loadTasks,
  offerDelegation,
  type TaskSpec,
  updateDelegation,
} from './commands';
import { delegationContext } from './context';
import { mergeReady, sendToTasks, startReady, stopTaskThreads } from './run';

type Refusal = Extract<DelegateOfferOutput, { status: 'refused' }>;
const refuse = (reason: Refusal['reason'], message: string): Refusal => ({
  status: 'refused',
  reason,
  message,
});

const opts = (ctx: ToolContext) => ({
  burrowId: ctx.burrowId,
  actorId: ctx.agentId,
  onBehalfOf: ctx.onBehalfOf,
});

const NO_REPLY = 'NO_REPLY';

/** The thread this turn works in: its root, or the message it answers when that opens one. */
async function threadOf(ctx: ToolContext): Promise<string | null> {
  if (ctx.dispatch.threadRootId) return ctx.dispatch.threadRootId;
  if (!ctx.dispatch.messageId) return null;
  const [m] = await ctx.services.db
    .select({ id: messages.id, threadRootId: messages.threadRootId })
    .from(messages)
    .where(eq(messages.id, ctx.dispatch.messageId));
  return m ? (m.threadRootId ?? m.id) : null;
}

/** A refusal from a commit's conflict, in words for the agent. */
function conflictText(err: unknown): { reason: Refusal['reason']; message: string } | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'not_found') return { reason: 'not_found', message: 'That delegation isn’t here.' };
  if (err.code !== 'conflict') return null;
  switch (err.message) {
    case 'busy':
      return {
        reason: 'busy',
        message:
          'There is a delegation card in this thread already: change that one with delegate_update (add, change, remove or tick tasks), or finish it first.',
      };
    case 'still_working':
      return {
        reason: 'busy',
        message:
          'Tasks are still at work: wait until they end (you are woken), or pass stopped: true to stop them.',
      };
    case 'still_waiting':
      return {
        reason: 'busy',
        message:
          'Tasks still wait their turn and will start by themselves: wait, or pass stopped: true to end it now.',
      };
    case 'still_merging':
      return {
        reason: 'busy',
        message:
          'Pull requests still wait to be merged and will be, one at a time: wait (you are woken), or pass stopped: true to end it now and leave them open.',
      };
    default:
      return { reason: 'busy', message: err.message };
  }
}

/**
 * The tasks as a command takes them, with the AI the person named for each resolved from what T3 Code runs now. A
 * refusal when one names an AI T3 Code can't run.
 */
async function specsOf(
  ctx: ToolContext,
  connection: NonNullable<Awaited<ReturnType<typeof councilConnection>>>,
  tasks: readonly DelegateTaskInput[],
  builder: CouncilSeat | null = null,
): Promise<TaskSpec[] | Refusal> {
  let providers: T3Provider[] | null = null;
  const specs: TaskSpec[] = [];
  for (const t of tasks) {
    // A council's plan: its builder seat builds it, with its effort, unless the person named another (CNL-60).
    if (!t.provider && builder) {
      specs.push({
        title: t.title,
        why: t.why ?? null,
        brief: t.brief,
        picked: t.picked ?? true,
        after: t.after ?? null,
        provider: builder.provider,
        model: builder.model,
        modelLabel: builder.label,
        options: builder.options,
        areas: t.areas ?? [],
      });
      continue;
    }
    let seat: { provider: string; model: string; label: string } | null = null;
    if (t.provider) {
      if (!providers)
        try {
          providers = providersOf(await callT3(ctx.services, connection, 'orchestrator_capabilities', {}));
        } catch {
          return refuse('unavailable', 'T3 Code can’t be reached now, so I can’t check which AI it runs.');
        }
      seat = oneSeat(providers, t.provider, t.model);
      if (!seat)
        return refuse(
          'invalid',
          `T3 Code can’t run “${t.model ? `${t.provider} ${t.model}` : t.provider}” now. It runs: ${providers.map((p) => p.name).join(', ') || 'nothing'}. Leave provider out for T3 Code’s own choice.`,
        );
    }
    specs.push({
      title: t.title,
      why: t.why ?? null,
      brief: t.brief,
      picked: t.picked ?? true,
      after: t.after ?? null,
      provider: seat?.provider ?? null,
      model: seat?.model ?? null,
      modelLabel: seat?.label ?? null,
      options: null,
      areas: t.areas ?? [],
    });
  }
  return specs;
}

/** The seat that builds a council's plan: its own choice when still seated, else the first. */
function builderOf(council: CouncilRow): CouncilSeat | null {
  return council.seats[council.builderSeat] ?? council.seats[0] ?? null;
}

/** What a task's merge adds to its state for the agent: “waiting to merge”, “merged”. */
const MERGE_WORDS = {
  waiting: 'waiting to merge',
  merging: 'merging',
  merged: 'merged',
  not_merged: 'not merged',
} as const;

/** The card's list as it is now, one line per task, for the agent: “1. Fix the empty Inbox (working)”. */
async function listNow(ctx: ToolContext, delegationId: string): Promise<string> {
  const tasks = await loadTasks(ctx.services.db, delegationId);
  const byId = new Map(tasks.map((t, i) => [t.id, i + 1]));
  return tasks
    .map((t, i) => {
      const merge = mergeOnCard(t);
      const state =
        t.state === 'offered'
          ? t.picked
            ? 'ticked'
            : 'not ticked'
          : merge
            ? MERGE_WORDS[merge]
            : t.state.replace('_', ' ');
      const after = t.afterId ? `, with ${byId.get(t.afterId)}` : '';
      const final = t.kind === 'final' ? ', Whombat’s check of everything together' : '';
      return `${i + 1}. ${t.title} (${state}${after}${final})`;
    })
    .join('\n');
}

const delegateOffer: ToolHandler<'delegate_offer'> = async (ctx, input): Promise<DelegateOfferOutput> => {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn) return refuse('unavailable', 'Tasks are handed to T3 Code only in a turn for the person.');
  const connection = await councilConnection(services.db, ctx.burrowId);
  if (!connection)
    return refuse(
      'no_t3',
      'Handing tasks over needs T3 Code connected at Manage: they run as T3 Code threads.',
    );
  const threadRootId = await threadOf(ctx);
  const here = await delegationOfThread(services.db, ctx.burrowId, ctx.dispatch.conversationId, threadRootId);
  if (here && isLive(here) && here.threadRootId === threadRootId) {
    const c = conflictText(conflict('busy'));
    if (c) return refuse(c.reason, c.message);
  }
  // A council's agreed plan (CNL-60): this thread's council, at work, its members in.
  let council: CouncilRow | null = null;
  if (input.council) {
    council = await services.db.transaction((tx) => loadCouncil(tx, ctx.burrowId, input.council as string));
    if (
      !council ||
      council.conversationId !== ctx.dispatch.conversationId ||
      council.threadRootId !== threadRootId ||
      council.state !== 'active'
    )
      return refuse('not_found', 'That council isn’t at work in this thread.');
    // A council's lead thread builds its plan itself, where the code is.
    if (council.builderThreadId)
      return refuse(
        'busy',
        'This council builds its plan in its own T3 Code thread: pass the person’s go-ahead to it with council_tell.',
      );
    if (!roundIn(await services.db.transaction((tx) => loadMembers(tx, (council as CouncilRow).id))))
      return refuse('busy', 'The council’s members are still at work: offer its plan once they agreed.');
  }
  let project: { id: string; title: string; root: string } | null =
    council?.projectId && !input.project
      ? { id: council.projectId, title: council.projectTitle ?? '', root: council.projectRoot ?? '' }
      : null;
  if (input.project) {
    const projects = await t3Projects(services, connection).catch(() => null);
    if (!projects)
      return refuse('unavailable', 'T3 Code can’t be reached now, so nothing can be handed over.');
    project = findProject(projects, input.project);
    if (!project)
      return refuse(
        'no_project',
        `T3 Code has no project “${input.project}”. Its projects: ${projects.map((p) => p.title).join(', ') || 'none'}. Clone or add it first (t3_project_clone, t3_project_create).`,
      );
  }
  const specs = await specsOf(ctx, connection, input.tasks, council ? builderOf(council) : null);
  if (!Array.isArray(specs)) return specs;
  try {
    const res = await services.pipeline.commit(
      offerDelegation,
      {
        id: newId('delegation'),
        conversationId: ctx.dispatch.conversationId,
        threadRootId,
        personId: turn.person.id,
        connectionId: connection.id,
        project,
        title: input.title,
        intro: input.intro,
        atOnce: input.atOnce ?? DELEGATION_AT_ONCE_DEFAULT,
        pullRequests: input.pullRequests ?? !!project,
        // Merged once done, unless the person wants to review them first.
        merge: input.merge ?? true,
        tasks: specs,
        // The person said to go all the way: the council's plan goes over without the checklist.
        start: input.start ?? council?.goAllTheWay ?? false,
        rules: input.rules ?? null,
        councilId: council?.id ?? null,
      },
      opts(ctx),
    );
    if (res.status !== 'ok') return refuse('unavailable', res.message);
    const d = res.result.delegation;
    const chained = chainedLines(res.result.chained);
    const after = chained.length ? `${chained.join('\n')}\n` : '';
    const id = d.id as Extract<DelegateOfferOutput, { status: 'offered' }>['delegationId'];
    if (d.stage === 'working') {
      const started = await startReady(services, d.id, d.burrowId);
      return {
        status: 'started',
        delegationId: id,
        message: `${after}${started} task${started === 1 ? '' : 's'} started in T3 Code; the rest start as places free up. The card under your intro shows their progress:\n${await listNow(ctx, d.id)}\nPost nothing else and end your turn with only ${NO_REPLY}; you are woken here as tasks end or ask something.`,
      };
    }
    const held = res.result.held
      ? 'A council is at work in this thread, so nothing was handed over yet: the person hands it over once it answers, or you do with delegate_update start then. '
      : '';
    return {
      status: 'offered',
      delegationId: id,
      message: `${after}${held}The checklist is on the card under your intro:\n${await listNow(ctx, d.id)}\nThe person ticks what they want and hands it over on the card, or tells you here what to change (then delegate_update; use these numbers). Post nothing else and end your turn with only ${NO_REPLY}.`,
    };
  } catch (err) {
    const c = conflictText(err);
    if (c) return refuse(c.reason, c.message);
    throw err;
  }
};

/** The agent's delegation of this turn: by id, in this burrow and conversation. */
async function ownDelegation(ctx: ToolContext, delegationId: string) {
  const d = await loadDelegation(ctx.services.db, ctx.burrowId, delegationId);
  if (!d || d.conversationId !== ctx.dispatch.conversationId) return null;
  return d;
}

const delegateUpdate: ToolHandler<'delegate_update'> = async (ctx, input): Promise<DelegateUpdateOutput> => {
  const { services } = ctx;
  const d = await ownDelegation(ctx, input.delegationId);
  if (!d) return refuse('not_found', 'That delegation isn’t in this conversation.');
  const connection = await councilConnection(services.db, ctx.burrowId);
  if (
    !connection &&
    (input.add?.some((t) => t.provider) || input.start || input.retry?.length || input.send?.length)
  )
    return refuse('no_t3', 'T3 Code isn’t connected at Manage now, so nothing can start.');
  const council = d.councilId
    ? await services.db.transaction((tx) => loadCouncil(tx, ctx.burrowId, d.councilId as string))
    : null;
  const add =
    input.add?.length && connection
      ? await specsOf(ctx, connection, input.add, council ? builderOf(council) : null)
      : [];
  if (!Array.isArray(add)) return add;
  try {
    const res = await services.pipeline.commit(
      updateDelegation,
      {
        delegationId: d.id,
        note: input.note ?? null,
        title: input.title ?? null,
        atOnce: input.atOnce ?? null,
        pullRequests: input.pullRequests ?? null,
        merge: input.merge ?? null,
        rules: input.rules ?? null,
        add,
        change: input.change ?? [],
        remove: input.remove ?? [],
        order: input.order ?? [],
        start: input.start ?? false,
        stop: input.stop ?? [],
        retry: input.retry ?? [],
        send: input.send ?? [],
      },
      opts(ctx),
    );
    if (res.status !== 'ok') return refuse('unavailable', res.message);
    const { delegation, stop, send, said } = res.result;
    await stopTaskThreads(services, delegation, stop, 'The assistant stopped the task.');
    const sent = await sendToTasks(services, delegation, send);
    const started =
      delegation.stage === 'working' ? await startReady(services, delegation.id, delegation.burrowId) : 0;
    if (delegation.stage === 'working') await mergeReady(services, delegation.id, delegation.burrowId);
    const done = [
      started ? `${started} task${started === 1 ? '' : 's'} started.` : '',
      send.length ? `${sent} of ${send.length} got the new work.` : '',
      ...said,
    ].filter(Boolean);
    return {
      status: 'ok',
      message: `${done.length ? `${done.join(' ')}\n` : ''}The card now:\n${await listNow(ctx, delegation.id)}\nSay what you changed in a line, in your own words (the card shows the list: don’t repeat it).`,
    };
  } catch (err) {
    const c = conflictText(err);
    if (c) return refuse(c.reason, c.message);
    throw err;
  }
};

const delegateFinish: ToolHandler<'delegate_finish'> = async (ctx, input): Promise<DelegateFinishOutput> => {
  const { services } = ctx;
  const d = await ownDelegation(ctx, input.delegationId);
  if (!d) return refuse('not_found', 'That delegation isn’t in this conversation.');
  try {
    const res = await services.pipeline.commit(
      finishDelegation,
      { delegationId: d.id, summary: input.summary, stopped: input.stopped ?? false, next: input.next ?? [] },
      opts(ctx),
    );
    if (res.status !== 'ok') return refuse('unavailable', res.message);
    await stopTaskThreads(services, d, res.result.working, 'The assistant finished.');
    if (!res.result.messageId) return refuse('unavailable', 'It ended, but its card is gone.');
    return {
      status: 'finished',
      messageId: res.result.messageId as Extract<DelegateFinishOutput, { status: 'finished' }>['messageId'],
      message: d.councilId
        ? `Your summary is posted under the card. Finish the council too (council_finish), then end your turn with only ${NO_REPLY}.`
        : `Your summary is posted under the card, and the person is told. End your turn with only ${NO_REPLY}.`,
    };
  } catch (err) {
    const c = conflictText(err);
    if (c) return refuse(c.reason, c.message);
    throw err;
  }
};

const delegateRead: ToolHandler<'delegate_read'> = async (ctx, input): Promise<DelegateReadOutput> => {
  const { db } = ctx.services;
  const d = input.delegationId
    ? await ownDelegation(ctx, input.delegationId)
    : await delegationOfThread(db, ctx.burrowId, ctx.dispatch.conversationId, await threadOf(ctx));
  if (!d) return refuse('not_found', 'There is no delegation card in this thread.');
  const context = await delegationContext(db, d, 'reply', () => true, true);
  return context
    ? { status: 'ok', delegation: context }
    : refuse('unavailable', 'Its T3 Code connection is gone.');
};

export const DELEGATE_TOOL_HANDLERS = {
  delegate_offer: delegateOffer,
  delegate_update: delegateUpdate,
  delegate_finish: delegateFinish,
  delegate_read: delegateRead,
} as const satisfies { [K in McpToolName & `delegate_${string}`]: ToolHandler<K> };
