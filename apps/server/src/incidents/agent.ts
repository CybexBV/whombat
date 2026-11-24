/**
 * The assistant reads status and history (docs/decisions/monitoring.md MON-10), read-only, for the person:
 *
 * - `watch_status`: what needs the person now: what waits for them in the Inbox, the things that aren't fine and why,
 *   what is down or broken right now and since when, and what is kept quiet for a while.
 * - `watch_history`: one thing's or every thing's incidents over a period (when, how long, why), their uptime, and the
 *   servers' alerts.
 *
 * Compact, in words the assistant can pass on: times as the person's clock reads them, no ids but the things'.
 */
import {
  type AgentIncident,
  type HostAlert,
  type McpToolOutput,
  needsYouGroupOf,
  parseThingId,
  THING_WATCH_DEFAULT_MINUTES,
  thingId,
} from '@whombat/core';
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import { connectionByHandle } from '../connections/context';
import { burrows, type IncidentRow, quietWindows } from '../db/schema/index';
import { deskFleet, deskLooks } from '../desk/glance';
import { turnPerson } from '../domain/turn-person';
import { homeOverview, things } from '../home/overview';
import type { HostsActor } from '../hosts/client';
import { HEARTBEAT_RULE } from '../hosts/quiet-lines';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { wayOutHistory, wayOutHistoryWords } from '../managed/way-out';
import type { ToolContext, ToolHandler } from '../mcp/tools';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import { thingVisible } from '../things/page';
import { hostsAlertsSince, periodUptime } from './history';
import { incidentsSince, openIncidents } from './store';
import { cancelThingWatch, runningThingWatches, startThingWatch } from './thing-watch';
import { thingWatchView } from './thing-watch-cards';

const DAY = 24 * 60 * 60_000;
/** How far back `watch_history` looks unless asked. */
export const HISTORY_DAYS = 7;
/** The most incidents, alerts and things an answer lists. */
const LIST_MAX = 60;
const ITEMS_MAX = 5;

/** A time as the person's clock reads it: “Today 07:31”, “Yesterday 22:10”, “Mon 17 Nov 07:31”. */
export function momentWords(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  if (day(at) === day(now)) return `Today ${time}`;
  if (day(at) === day(new Date(now.getTime() - DAY))) return `Yesterday ${time}`;
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(at);
  return `${date.replace(',', '')} ${time}`;
}

/** An incident as the assistant reads it. */
export function agentIncident(row: IncidentRow, now: Date, timeZone: string): AgentIncident {
  const end = row.endedAt ?? now;
  return {
    thing: row.thingId,
    name: row.name,
    nature: row.nature === 'down' ? 'down' : 'problem',
    words: row.words,
    started: momentWords(row.startedAt, now, timeZone),
    ...(row.endedAt ? { ended: momentWords(row.endedAt, now, timeZone) } : {}),
    minutes: Math.max(0, Math.round((end.getTime() - row.startedAt.getTime()) / 60_000)),
    ...(row.causeName ? { causedBy: row.causeName } : {}),
  };
}

/**
 * The quiet windows that hold now (a thing kept quiet until a time, with its note), for `watch_status`, named as Home
 * names the thing; a window on something Home doesn't list keeps its id.
 */
export async function quietWindowsFor(
  services: Services,
  burrowId: string,
  now: Date,
  names: ReadonlyMap<string, string> = new Map(),
): Promise<{ thing: string; name: string; until: Date; note?: string }[]> {
  const rows = await services.db
    .select()
    .from(quietWindows)
    .where(
      and(
        eq(quietWindows.ownerId, burrowId),
        isNull(quietWindows.endedAt),
        lte(quietWindows.startsAt, now),
        gt(quietWindows.endsAt, now),
      ),
    )
    .orderBy(asc(quietWindows.endsAt));
  return rows.map((w) => ({
    thing: w.thingId,
    name: names.get(w.thingId) ?? w.thingId,
    until: w.endsAt,
    ...(w.note ? { note: w.note } : {}),
  }));
}

/** The person the turn is for, its time zone and how the hosts service names the assistant for them. */
async function turnOf(ctx: ToolContext): Promise<{ person: PrincipalRow; actor: HostsActor }> {
  if (outsidersTurn(ctx.dispatch))
    throw forbidden('This work came from outside, so it can’t see how things are here.');
  const person = await turnPerson(ctx.services.db, { burrowId: ctx.burrowId, agentId: ctx.agentId });
  if (!person) throw notFound('Person');
  const agent = await loadPrincipalRow(ctx.services.db, ctx.agentId);
  const name = `${agent?.name ?? 'Whombat'} for ${person.shortName || person.name}`;
  return { person, actor: { id: ctx.agentId, name, role: 'viewer' } };
}

/** “3 wait for you: Approve the restart of pve-02; Sign in to Google again; …”, or that nothing does. */
export function inboxWords(titles: readonly string[]): string {
  if (!titles.length) return 'Nothing waits for you in the Inbox.';
  const shown = titles.slice(0, ITEMS_MAX).join('; ');
  const more = titles.length > ITEMS_MAX ? `; and ${titles.length - ITEMS_MAX} more` : '';
  return `${titles.length} ${titles.length === 1 ? 'thing waits' : 'things wait'} for you in the Inbox: ${shown}${more}.`;
}

/** `watch_status`: what needs the person now. */
export async function watchStatusTool(ctx: ToolContext): Promise<McpToolOutput<'watch_status'>> {
  const { services, burrowId } = ctx;
  const { person } = await turnOf(ctx);
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  if (!burrow) throw notFound('Burrow');
  const now = services.clock();
  const timeZone = burrow.timeZone;
  const [overview, fleet, open] = await Promise.all([
    homeOverview(services, { burrow, principal: person }),
    deskFleet(services, burrowId).catch(() => null),
    openIncidents(services.db, burrowId),
  ]);
  const quiet = await quietWindowsFor(
    services,
    burrowId,
    now,
    new Map(overview.things.map((t) => [t.id, t.name])),
  );
  const waiting = (overview.needsYouList ?? []).filter(
    (i) => (i.group ?? needsYouGroupOf(i)) === 'you' && (i.state ?? 'open') === 'open',
  );
  const looks = deskLooks(fleet?.cards ?? [], overview.things, LIST_MAX);
  return {
    status: 'ok',
    inbox: inboxWords(waiting.map((i) => i.title)),
    notFine: looks.map((l) => ({
      thing: l.key,
      name: l.name,
      state: l.state,
      ...(l.reason ? { reason: l.reason } : {}),
      ...(l.causedBy ? { causedBy: l.causedBy.name } : {}),
    })),
    incidents: open.slice(0, LIST_MAX).map((r) => agentIncident(r, now, timeZone)),
    quiet: quiet.slice(0, LIST_MAX).map((q) => ({
      thing: q.thing,
      name: q.name,
      until: momentWords(q.until, now, timeZone),
      ...(q.note ? { note: q.note } : {}),
    })),
  };
}

/** A thing's page id from what the assistant gave: a page id as it is, a connection's handle as its page id. */
async function thingOf(ctx: ToolContext, value: string): Promise<string> {
  const given = value.trim();
  if (parseThingId(given)) return given;
  const found = await connectionByHandle(ctx.services.db, ctx.agentId, ctx.dispatch, given);
  if (!found) throw notFound('Thing');
  return thingId('connection', found.row.id);
}

/** A server alert as the assistant reads it. */
function agentAlert(a: HostAlert, now: Date, timeZone: string) {
  return {
    server: a.serverId ?? 'Whombat',
    title: a.title,
    severity: a.severity,
    opened: momentWords(new Date(a.openedAt), now, timeZone),
    ...(a.resolvedAt ? { resolved: momentWords(new Date(a.resolvedAt), now, timeZone) } : {}),
  };
}

/** `watch_history`: what went wrong over the last `days` (7 unless asked), for one thing or all. */
export async function watchHistoryTool(
  ctx: ToolContext,
  input: { thing?: string; days?: number },
): Promise<McpToolOutput<'watch_history'>> {
  const { services, burrowId } = ctx;
  const { person, actor } = await turnOf(ctx);
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  if (!burrow) throw notFound('Burrow');
  const timeZone = burrow.timeZone;
  const now = services.clock();
  const days = Math.min(90, Math.max(1, input.days ?? HISTORY_DAYS));
  const from = new Date(now.getTime() - days * DAY);
  const thing = input.thing ? await thingOf(ctx, input.thing) : undefined;
  if (thing) {
    const viewer = { accountId: person.accountId ?? '', burrowId, principal: person };
    if (!(await thingVisible(services, viewer, thing))) throw notFound('Thing');
  }
  const parsed = thing ? parseThingId(thing) : null;
  const [rows, alerts, wayOut] = await Promise.all([
    incidentsSince(services.db, burrowId, from, thing),
    // The servers' alerts: one server's, or every server's when no thing was named.
    !thing || parsed?.kind === 'server'
      ? hostsAlertsSince(services, burrowId, actor, {
          ...(parsed?.kind === 'server' ? { server: parsed.id } : {}),
          since: from,
        })
      : Promise.resolve(undefined),
    thing ? [] : wayOutHistory(services.db, from),
  ]);
  // Uptime for the thing asked about, else for each thing that had something.
  const things = thing ? [thing] : [...new Set(rows.map((r) => r.thingId))].slice(0, 20);
  const names = new Map(rows.map((r) => [r.thingId, r.name]));
  const resolved = alerts ?? [];
  const uptime = (
    await Promise.all(
      things.map(async (t) => {
        const said = await periodUptime(services, burrowId, t, {
          now,
          days,
          timeZone,
          rows: rows.filter((r) => r.thingId === t),
          ...(t.startsWith('server:')
            ? {
                alerts:
                  alerts === null
                    ? null
                    : resolved.filter((a) => `server:${a.serverId}` === t && a.rule === HEARTBEAT_RULE),
              }
            : {}),
        }).catch(() => null);
        return said ? { thing: t, name: names.get(t) ?? t, text: said.uptime.text } : null;
      }),
    )
  ).filter((u): u is NonNullable<typeof u> => u !== null);
  const note =
    alerts === null
      ? 'The servers’ alerts couldn’t be read just now.'
      : !rows.length && !resolved.length && !wayOut.length
        ? 'Nothing went down or had a problem in this period.'
        : undefined;
  return {
    status: 'ok',
    from: momentWords(from, now, timeZone),
    days,
    incidents: rows.slice(0, LIST_MAX).map((r) => agentIncident(r, now, timeZone)),
    uptime,
    serverAlerts: resolved.slice(0, LIST_MAX).map((a) => agentAlert(a, now, timeZone)),
    ...(!thing
      ? {
          wayOutOutages: wayOut.slice(0, LIST_MAX).map((o) => ({
            words: wayOutHistoryWords(o, timeZone),
            started: momentWords(o.startedAt, now, timeZone),
            ...(o.endedAt ? { ended: momentWords(o.endedAt, now, timeZone) } : {}),
          })),
        }
      : {}),
    ...(note ? { note } : {}),
  };
}

/** Use the same things and status the person sees, including the fleet's own server ids. */
async function watchTarget(ctx: ToolContext, person: PrincipalRow, value: string) {
  const { services, burrowId } = ctx;
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  if (!burrow) throw notFound('Burrow');
  const observedAt = services.clock();
  const parsed = parseThingId(value);
  const [list, fleet] = await Promise.all([
    parsed?.kind === 'server' ? [] : things(services, { burrow, principal: person }, observedAt),
    parsed && parsed.kind !== 'server' ? null : deskFleet(services, burrowId).catch(() => null),
  ]);
  const targets = [
    ...list.filter((thing) => thing.kind !== 'server'),
    ...[...(fleet?.rows ?? [])].map(([id, server]) => ({
      id: thingId('server', id),
      name: fleet?.cards.find((card) => card.id === id)?.name ?? id,
      status: server.status,
    })),
  ];
  const key = value.toLowerCase();
  const named = targets.filter(
    (t) => t.id === value || (!parsed && (t.name.toLowerCase() === key || t.id === thingId('server', value))),
  );
  const connection =
    named.length || parsed ? null : await connectionByHandle(services.db, ctx.agentId, ctx.dispatch, value);
  const matches = connection ? targets.filter((t) => parseThingId(t.id)?.id === connection.row.id) : named;
  if (matches.length > 1) throw badRequest('More than one thing has that name. Which one did you mean?');
  const target = matches[0];
  if (!target) throw notFound('Thing');
  const observed =
    target.status === 'offline'
      ? 'down'
      : target.status === 'ok' || target.status === 'warn'
        ? 'up'
        : 'unknown';
  return {
    thing: target.id,
    name: target.name.slice(0, 120),
    observed,
    observedAt: observedAt.toISOString(),
  } as const;
}

export const thingWatchTool: ToolHandler<'thing_watch'> = async (ctx, input) => {
  const { person } = await turnOf(ctx);
  const { services, burrowId, agentId, dispatch, onBehalfOf } = ctx;
  const options = { burrowId, actorId: agentId, onBehalfOf };
  if (input.action === 'list') {
    const rows = await runningThingWatches(services.db, burrowId, agentId);
    return {
      status: 'ok',
      watches: rows.map(thingWatchView),
      note: rows.length ? 'These watches are running.' : 'No watches are running.',
    };
  }
  if (input.action === 'cancel') {
    if (!input.watchId) throw badRequest('Choose a watch to stop.');
    const result = await services.pipeline.commit(cancelThingWatch, { watchId: input.watchId }, options);
    if (result.status !== 'ok') return result;
    return { status: 'ok', watches: [result.result.watch], note: 'The watch has ended.' };
  }
  if (!input.thing || !input.event)
    throw badRequest('Choose a thing and whether to watch for it to go down or come back.');
  const target = await watchTarget(ctx, person, input.thing);
  const result = await services.pipeline.commit(
    startThingWatch,
    {
      ...target,
      event: input.event,
      minutes: input.minutes ?? THING_WATCH_DEFAULT_MINUTES,
      conversationId: dispatch.conversationId,
      threadRootId: dispatch.threadRootId ?? dispatch.messageId,
    },
    options,
  );
  if (result.status !== 'ok') return result;
  const { watch } = result.result;
  return {
    status: 'ok',
    watches: [watch],
    note:
      watch.status === 'happened'
        ? 'It already happened. The result is in Chat. You can finish without repeating it.'
        : 'The watch is already in Chat. You can finish without repeating it.',
  };
};
