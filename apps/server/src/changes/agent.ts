/**
 * `what_changed`: what changed on a thing (with the server a connection runs on) or everywhere over a period, newest
 * first, read-only, for the person (docs/decisions/outside-changes.md). Times as the person's clock reads them; a
 * change just before something broke is what the assistant may name, not proof of its cause.
 */
import { type McpToolOutput, parseThingId } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { burrows, catalogConnections } from '../db/schema/index';
import { serverLabel } from '../hosts/self';
import { momentWords, thingOf, turnOf } from '../incidents/agent';
import { notFound } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { thingVisible } from '../things/page';
import { changesSince } from './store';
import { changeWords } from './words';

const HOUR = 60 * 60_000;
/** How far back unless asked. */
export const WHAT_CHANGED_HOURS = 48;
/** The most changes an answer lists. */
const LIST_MAX = 60;

/** The names the person knows the things by: a connection's label, a server's name. */
async function thingNames(ctx: ToolContext, things: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const connections: string[] = [];
  for (const t of things) {
    const parsed = parseThingId(t);
    if (parsed?.kind === 'server') names.set(t, serverLabel(parsed.id));
    else if (parsed?.kind === 'connection') connections.push(parsed.id);
  }
  if (connections.length) {
    const rows = await ctx.services.db
      .select({ id: catalogConnections.id, label: catalogConnections.label })
      .from(catalogConnections)
      .where(and(eq(catalogConnections.burrowId, ctx.burrowId), inArray(catalogConnections.id, connections)));
    for (const r of rows) names.set(`connection:${r.id}`, r.label);
  }
  return names;
}

export async function whatChangedTool(
  ctx: ToolContext,
  input: { thing?: string; hours?: number },
): Promise<McpToolOutput<'what_changed'>> {
  const { services, burrowId } = ctx;
  const { person } = await turnOf(ctx);
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  if (!burrow) throw notFound('Burrow');
  const timeZone = burrow.timeZone;
  const now = services.clock();
  const hours = Math.min(2160, Math.max(1, input.hours ?? WHAT_CHANGED_HOURS));
  const from = new Date(now.getTime() - hours * HOUR);
  const thing = input.thing ? await thingOf(ctx, input.thing) : undefined;
  let things: string[] | undefined;
  if (thing) {
    const viewer = { accountId: person.accountId ?? '', burrowId, principal: person };
    if (!(await thingVisible(services, viewer, thing))) throw notFound('Thing');
    // A connection's service changes with the server it runs on: both, so “the server restarted” shows too.
    const parsed = parseThingId(thing);
    let runsOn: string | null = null;
    if (parsed?.kind === 'connection') {
      const [row] = await services.db
        .select({ glance: catalogConnections.glance })
        .from(catalogConnections)
        .where(and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.id, parsed.id)));
      runsOn = row?.glance?.machine?.serverId ?? null;
    }
    things = runsOn ? [thing, `server:${runsOn}`] : [thing];
  }
  const rows = await changesSince(services.db, burrowId, from, things, LIST_MAX);
  const names = await thingNames(ctx, [...new Set(rows.map((r) => r.thingId))]);
  return {
    status: 'ok',
    from: momentWords(from, now, timeZone),
    changes: rows.map((r) => ({
      thing: r.thingId,
      name: names.get(r.thingId) ?? r.thingId,
      kind: r.kind,
      words: changeWords(r.fact),
      seen: momentWords(r.seenAt, now, timeZone),
      ...(r.since ? { after: momentWords(r.since, now, timeZone) } : {}),
      by: r.by,
    })),
    ...(rows.length ? {} : { note: 'Whombat saw nothing change in this period.' }),
  };
}
