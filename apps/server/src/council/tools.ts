/**
 * The council's tools (docs/decisions/council.md CNL-S04): `council_start`, `council_note`, `council_tell`,
 * `council_finish` and `council_read`, in the person's own turns while a T3 Code connection manages. Each refusal says
 * in a line what to do instead; the agent passes it on in its own words.
 */
import type {
  CouncilFinishOutput,
  CouncilOkOutput,
  CouncilReadOutput,
  CouncilStartOutput,
  CouncilTellOutput,
  McpToolName,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { messages } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { ToolContext, ToolHandler } from '../mcp/tools';
import { loadPrincipalRow } from '../read/principals';
import { turnRuntime } from '../runtime/turn-runtime';
import { personWordsFor } from '../t3code/follow';
import { callT3 } from '../things/kinds/business/t3code';
import { ownTurn } from '../vault/self-serve';
import { listOf } from './card';
import { finishCouncil, loadCouncil, noteCouncil, startCouncil } from './commands';
import { councilContext, councilOfThread } from './context';
import { chatSeat, isEffortOption, pickSeats, providersOf, T3_COUNCIL, t3CouncilSeats } from './members';
import {
  councilConnection,
  councilDefaults,
  findProject,
  launchLead,
  settleLead,
  stopThreads,
  t3Projects,
  tellLead,
} from './run';
import { lastT3Council, theCouncil } from './setups';

type Refusal = Extract<CouncilStartOutput, { status: 'refused' }>;
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
  if (err.code === 'not_found') return { reason: 'not_found', message: 'That council isn’t here.' };
  if (err.code !== 'conflict') return null;
  if (err.message === 'no_lead')
    return {
      reason: 'busy',
      message: 'This council has no T3 Code thread to tell: finish it with council_finish.',
    };
  return { reason: 'busy', message: err.message };
}

/** The turns a person's own message starts. */
const PERSONS_TURN = new Set<string>(['mention', 'dm', 'retry']);

/** What the person wrote to start this turn, for the lead to read as it was asked; null in any other turn. */
const personWords = (ctx: ToolContext) =>
  personWordsFor(ctx.services.db, { agentId: ctx.agentId, dispatch: ctx.dispatch, reportTurn: false }).catch(
    () => null,
  );

/** The person's own turn, or a refusal: councils are theirs (CNL-05). */
async function personsTurn(ctx: ToolContext) {
  const turn = await ownTurn(ctx.services.db, ctx);
  return turn ?? null;
}

const councilStart: ToolHandler<'council_start'> = async (ctx, input) => {
  const { services } = ctx;
  const turn = await personsTurn(ctx);
  if (!turn)
    return refuse('unavailable', 'A council is started only in a turn for the person, when they ask.');
  const connection = await councilConnection(services.db, ctx.burrowId);
  if (!connection)
    return refuse(
      'no_t3',
      'A council needs T3 Code connected at Manage: its members run as T3 Code threads on the person’s computer.',
    );
  const threadRootId = await threadOf(ctx);
  const here = await councilOfThread(services.db, ctx.burrowId, ctx.dispatch.conversationId, threadRootId);
  if (here?.state === 'active')
    return refuse('busy', 'A council is already at work in this thread: finish or stop it first.');
  let providers: ReturnType<typeof providersOf>;
  try {
    providers = providersOf(await callT3(services, connection, 'orchestrator_capabilities', {}));
  } catch {
    return refuse('unavailable', 'T3 Code can’t be reached now, so the council can’t start.');
  }
  // Who sits on it: the members the person named for this council alone, else always T3 Code's own council (its lead
  // sits its skill's members; Whombat starts with the ones it sat last time and follows). Settings keeps only the rounds
  // and the score.
  const setup = input.members?.length ? null : await theCouncil(services.db, ctx.burrowId);
  const t3Council = !input.members?.length;
  const seats = t3Council
    ? t3CouncilSeats(providers, await lastT3Council(services.db, ctx.burrowId))
    : pickSeats(providers, input.members ?? []);
  if (!seats.ok) return refuse(seats.reason, seats.message);
  let project: { id: string; title: string; root: string } | null = null;
  if (input.project) {
    const projects = await t3Projects(services, connection).catch(() => null);
    if (!projects) return refuse('unavailable', 'T3 Code can’t be reached now, so the council can’t start.');
    project = findProject(projects, input.project);
    if (!project)
      return refuse(
        'no_project',
        `T3 Code has no project “${input.project}”. Its projects: ${projects.map((p) => p.title).join(', ') || 'none'}. Clone or add it first (t3_project_clone, t3_project_create).`,
      );
  }
  if (input.kind === 'improve' && !project)
    return refuse('no_project', 'A council that improves something needs its project in T3 Code: name it.');
  const made = councilDefaults({
    kind: input.kind,
    target: input.target ?? setup?.target,
    rounds: input.rounds ?? setup?.rounds,
  });
  // The lead is the chat's own AI, as this turn runs it; only a company T3 Code can't run gives way to the first seat.
  const builderSeat = 0;
  const agent = await loadPrincipalRow(services.db, ctx.agentId);
  const leadSeat = chatSeat(providers, turnRuntime(agent?.runtime, ctx.dispatch));
  const res = await services.pipeline.commit(
    startCouncil,
    {
      id: made.id,
      conversationId: ctx.dispatch.conversationId,
      threadRootId,
      personId: turn.person.id,
      connectionId: connection.id,
      project,
      kind: input.kind,
      title: input.title,
      question: input.question,
      intro: input.intro,
      seatNotes: seats.notes,
      seats: seats.seats,
      builderSeat,
      lead: leadSeat,
      setupName: t3Council ? T3_COUNCIL : null,
      target: made.target,
      roundsMax: made.roundsMax,
      goAllTheWay: input.goAllTheWay ?? false,
    },
    opts(ctx),
  );
  if (res.status !== 'ok') return refuse('unavailable', res.message);
  const { council, lead } = res.result;
  // The tool's answer tells the agent how the start went: no wake for a lead that couldn't start.
  const started = await launchLead(services, council, lead, await personWords(ctx));
  const names = council.seats.map((seat) => seat.label);
  return {
    status: 'started',
    councilId: council.id as Extract<CouncilStartOutput, { status: 'started' }>['councilId'],
    members: council.seats.map((seat) => ({
      name: seat.label,
      provider: seat.providerName,
      effort: (seat.options.find((o) => isEffortOption(o.id))?.value as string | undefined) ?? null,
    })),
    // Your intro sits above the card and what T3 Code couldn't run as set under it: nothing goes in a reply of its own.
    message: started
      ? `The council is at work in T3 Code: ${t3Council ? `T3 Code’s own council sits on it (last time ${listOf(names)})` : `${listOf(names)} sit on it`}, and one thread leads it there.${seats.notes.length ? ` Under the card: ${seats.notes.join(' ')}` : ''} Post nothing else and end your turn with only NO_REPLY; you are woken here when the lead is done${council.kind === 'improve' && !council.goAllTheWay ? ' (first with the plan, for the person’s go-ahead)' : ''}.`
      : 'The council’s thread couldn’t start in T3 Code. Say why with council_finish (your summary goes under the card), then end your turn with only NO_REPLY.',
  };
};

/** The agent's council of this turn: by id, in this burrow and conversation. */
async function ownCouncil(ctx: ToolContext, councilId: string) {
  const council = await ctx.services.db.transaction((tx) => loadCouncil(tx, ctx.burrowId, councilId));
  if (!council || council.conversationId !== ctx.dispatch.conversationId) return null;
  return council;
}

const councilNote: ToolHandler<'council_note'> = async (ctx, input): Promise<CouncilOkOutput> => {
  const council = await ownCouncil(ctx, input.councilId);
  if (!council) return refuse('not_found', 'That council isn’t in this conversation.');
  if (council.state !== 'active')
    return refuse('busy', 'This council has ended: post your words as a reply.');
  try {
    await ctx.services.pipeline.commit(noteCouncil, input, opts(ctx));
  } catch (err) {
    const c = conflictText(err);
    if (c) return refuse(c.reason, c.message);
    throw err;
  }
  return {
    status: 'ok',
    message: 'It’s posted under the card. Post nothing else: end your turn with only NO_REPLY.',
  };
};

const councilTell: ToolHandler<'council_tell'> = async (ctx, input): Promise<CouncilTellOutput> => {
  const council = await ownCouncil(ctx, input.councilId);
  if (!council) return refuse('not_found', 'That council isn’t in this conversation.');
  if (council.state !== 'active')
    return refuse('busy', 'This council has ended: start a new one if more is wanted.');
  if (!council.builderThreadId)
    return refuse('busy', 'This council has no T3 Code thread to tell: finish it with council_finish.');
  try {
    // The go-ahead is the person's own: only the turn their message started passes it on.
    const goAhead = input.goAhead === true && council.stage === 'approve';
    if (goAhead && !PERSONS_TURN.has(ctx.dispatch.trigger))
      return refuse(
        'busy',
        'The go-ahead is the person’s: tell them the plan and ask, and pass their yes on in the turn they answer in.',
      );
    const told = await tellLead(ctx.services, council, {
      message: input.message,
      goAhead,
      personWords: await personWords(ctx),
    });
    if (!told.ok) return refuse('unavailable', told.message);
    return {
      status: 'told',
      message: told.goAhead
        ? 'The lead builds the plan now, and the council’s card says so. Post nothing else: end your turn with only NO_REPLY; you are woken here when it is done.'
        : council.stage === 'approve'
          ? 'The lead changes the plan and nothing is built yet; the council’s card says so. Post nothing else: end your turn with only NO_REPLY; you are woken here with the new plan.'
          : 'The lead has it and works on. Post nothing else: end your turn with only NO_REPLY; you are woken here when it is done.',
    };
  } catch (err) {
    const c = conflictText(err);
    if (c) return refuse(c.reason, c.message);
    throw err;
  }
};

const councilFinishTool: ToolHandler<'council_finish'> = async (ctx, input): Promise<CouncilFinishOutput> => {
  const { services } = ctx;
  const council = await ownCouncil(ctx, input.councilId);
  if (!council) return refuse('not_found', 'That council isn’t in this conversation.');
  if (council.state !== 'active') return refuse('busy', 'This council has ended already.');
  try {
    const res = await services.pipeline.commit(
      finishCouncil,
      {
        councilId: council.id,
        summary: input.summary,
        notes: input.notes ?? [],
        stopped: input.stopped ?? false,
        next: input.next ?? [],
      },
      opts(ctx),
    );
    if (res.status !== 'ok') return refuse('unavailable', res.message);
    // A lead still at work is told to stop (its reviewers with it); one that is done is tidied away in T3 Code.
    if (res.result.working.length)
      await stopThreads(services, council, res.result.working, 'The council finished.');
    else await settleLead(services, council);
    if (!res.result.messageId) return refuse('unavailable', 'The council ended, but its card is gone.');
    return {
      status: 'finished',
      messageId: res.result.messageId as Extract<CouncilFinishOutput, { status: 'finished' }>['messageId'],
      message:
        'Your conclusion is posted under the council’s card, and the person is told. End your turn with only NO_REPLY.',
    };
  } catch (err) {
    const c = conflictText(err);
    if (c) return refuse(c.reason, c.message);
    throw err;
  }
};

const councilRead: ToolHandler<'council_read'> = async (ctx, input): Promise<CouncilReadOutput> => {
  const { db } = ctx.services;
  const council = input.councilId
    ? await ownCouncil(ctx, input.councilId)
    : await councilOfThread(db, ctx.burrowId, ctx.dispatch.conversationId, await threadOf(ctx));
  if (!council) return refuse('not_found', 'There is no council in this thread.');
  const context = await councilContext(db, council, null);
  return context
    ? { status: 'ok', council: context }
    : refuse('unavailable', 'Its T3 Code connection is gone.');
};

export const COUNCIL_TOOL_HANDLERS = {
  council_start: councilStart,
  council_note: councilNote,
  council_tell: councilTell,
  council_finish: councilFinishTool,
  council_read: councilRead,
} as const satisfies { [K in McpToolName & `council_${string}`]: ToolHandler<K> };
