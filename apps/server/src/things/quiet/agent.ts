/**
 * The assistant and what Whombat watches (docs/decisions/on-purpose.md): `watch_checks` lists a thing's checks, and
 * switches one off or on when the person said so in the turn's own message (their words in the chat, or their press of
 * the step the assistant offered, which posts their go-ahead). The switch is the person's choice, made as them with the
 * assistant named on the change, so it is in what the assistant did with Undo; Undo puts the check back as it was.
 */
import { type McpToolInput, type McpToolOutput, parseThingId, thingId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { connectionByHandle } from '../../connections/context';
import type { ConnectionViewer } from '../../connections/store';
import { burrows } from '../../db/schema/index';
import { turnPerson } from '../../domain/turn-person';
import type { DirectUndoCtx, DirectUndoResult, RecordedChange } from '../../home/registry';
import { setServerWatchLimit } from '../../hosts/quiet';
import { ApiError, badRequest, forbidden, notFound } from '../../lib/errors';
import type { ToolContext } from '../../mcp/tools';
import { loadPrincipalRow, type PrincipalRow } from '../../read/principals';
import { outsidersTurn } from '../../runtime/person';
import type { Services } from '../../services';
import type { WatchUndo } from './commands';
import { setThingWatch, thingWatch } from './service';
import type { WireWatch } from './wire';

/** What the assistant hears when it switches a check without the person having said so in this turn. */
export const ASK_FIRST_TEXT =
  'Only the person switches off what Whombat watches. Ask them first, or offer it as your step; once they say so in this conversation, call watch_checks again.';

function viewerOf(person: PrincipalRow): ConnectionViewer {
  return { accountId: person.accountId ?? '', burrowId: person.burrowId, principal: person };
}

async function timeZoneOf(services: Services, burrowId: string): Promise<string> {
  const [row] = await services.db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return row?.timeZone ?? 'UTC';
}

/** A thing's page id from what the assistant gave: a page id as it is, a connection's handle as its page id. */
async function thingOf(ctx: ToolContext, value: string): Promise<string> {
  const given = value.trim();
  if (parseThingId(given)) return given;
  const found = await connectionByHandle(ctx.services.db, ctx.agentId, ctx.dispatch, given);
  if (!found) throw notFound('Thing');
  return thingId('connection', found.row.id);
}

/** The checks as the assistant reads them: one line of exceptions each, no ids but the check's. */
function agentChecks(watch: WireWatch): McpToolOutput<'watch_checks'> {
  return {
    status: 'ok',
    checks: watch.checks.map((c) => {
      const except = c.exceptions.map((e) => {
        const what = e.subject ? `${e.subject.name} (${e.subject.id})` : 'the whole thing';
        const state = e.state === 'stopped' ? 'not watched' : e.state;
        return `${what}: ${state}${e.words ? ` ${e.words}` : ''}`;
      });
      return {
        check: c.check,
        name: c.name,
        nature: c.nature,
        on: c.on,
        ...(except.length ? { except } : {}),
        ...(c.limit ? { limit: c.limit } : {}),
      };
    }),
  };
}

/** `watch_checks` (on-purpose.md): list a thing's checks; switch one when the person said so in this turn. */
export async function watchChecksTool(
  ctx: ToolContext,
  input: McpToolInput<'watch_checks'>,
): Promise<McpToolOutput<'watch_checks'>> {
  const { services, burrowId, agentId } = ctx;
  if (outsidersTurn(ctx.dispatch))
    throw forbidden('This work came from outside, so it can’t see what Whombat watches.');
  const person = await turnPerson(services.db, { burrowId, agentId });
  if (!person) throw notFound('Person');
  const viewer = viewerOf(person);
  const timeZone = await timeZoneOf(services, burrowId);
  const thing = await thingOf(ctx, input.thing);
  const subject = input.subject
    ? { id: input.subject, name: (input.subjectName ?? input.subject).slice(0, 80) }
    : undefined;
  if (input.limit !== undefined) {
    if (ctx.onBehalfOf.principalId !== person.id)
      throw forbidden(
        'Ask the person before changing a limit. Change it when they say so in this conversation.',
      );
    if (!input.check || input.watched !== undefined)
      throw badRequest('Name the check and change its limit in a separate call.');
    const parsed = parseThingId(thing);
    if (parsed?.kind !== 'server') throw badRequest('Choose a server to change its alert limit.');
    const result = await setServerWatchLimit(
      services,
      { burrowId, actorId: person.id, serverId: parsed.id, agentId },
      { check: input.check, ...(subject ? { subject } : {}), limit: input.limit },
    );
    return agentChecks(result.watch);
  }
  if (input.watched !== undefined) {
    if (!input.check) throw badRequest('Name the check to switch.');
    // Their own message started this turn: their words, or the go-ahead their press of the step posted.
    if (ctx.onBehalfOf.principalId !== person.id) throw forbidden(ASK_FIRST_TEXT);
    const watch = await setThingWatch(
      services,
      viewer,
      thing,
      { check: input.check, ...(subject ? { subject } : {}), watched: input.watched },
      timeZone,
      { agentId },
    );
    return agentChecks(watch);
  }
  return agentChecks(await thingWatch(services, viewer, thing, timeZone));
}

function isWatchUndo(value: unknown): value is WatchUndo {
  const v = value as WatchUndo | null;
  return (
    !!v &&
    typeof v.thing === 'string' &&
    typeof v.check === 'string' &&
    typeof v.watched === 'boolean' &&
    (v.subject === undefined || (typeof v.subject.id === 'string' && typeof v.subject.name === 'string'))
  );
}

/** Undo of the assistant's switch: the check back as it was, as the person who pressed Undo. */
export async function undoAgentWatch(ctx: DirectUndoCtx, change: RecordedChange): Promise<DirectUndoResult> {
  const undo = change.undo.payload;
  if (!isWatchUndo(undo)) return { ok: false, reason: 'This can’t be undone any more.' };
  const person = await loadPrincipalRow(ctx.services.db, ctx.person.id);
  if (person?.kind !== 'person') return { ok: false, reason: 'Only you can choose what Whombat watches.' };
  try {
    await setThingWatch(
      ctx.services,
      viewerOf(person),
      undo.thing,
      { check: undo.check, ...(undo.subject ? { subject: undo.subject } : {}), watched: undo.watched },
      await timeZoneOf(ctx.services, ctx.burrowId),
    );
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'not_allowed'))
      return { ok: false, reason: 'That check is gone, so this can’t be undone.' };
    throw err;
  }
  return { ok: true, state: 'undone' };
}
