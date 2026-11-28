/**
 * `internet_exposure` (docs/decisions/internet-exposure.md): the assistant reads what the page reads — every opening
 * with what it leads to, what guards it, whether it is new or meant and what is worth a look — and the places Whombat
 * read or can't see. Read-only; only in a turn for the person.
 */
import type { McpToolOutput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { outsidersTurn } from '../runtime/person';
import { exposureView } from './view';

/** How many openings the assistant reads at once: worth a look and new ones come first. */
const OPENINGS_MAX = 60;

export async function internetExposureTool(ctx: ToolContext): Promise<McpToolOutput<'internet_exposure'>> {
  if (outsidersTurn(ctx.dispatch))
    throw forbidden('This work came from outside, so it can’t see how things are here.');
  const [burrow] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.burrowId));
  if (!burrow) throw notFound('Burrow');
  const view = await exposureView(ctx.services, { burrowId: ctx.burrowId }, burrow.timeZone);
  return {
    status: 'ok',
    summary: view.summary,
    openings: view.openings.slice(0, OPENINGS_MAX).map((o) => ({
      line: o.title,
      via: o.via,
      protection: o.protection.words,
      ...(o.risk ? { worthALook: o.risk.words } : {}),
      isNew: o.isNew,
      meant: o.meant,
      ...(o.firstSeen ? { firstSeen: o.firstSeen.slice(0, 10) } : {}),
      source: o.watch.thing,
      subject: o.watch.subject.id,
      subjectName: o.watch.subject.name,
    })),
    places: view.sources.map((s) => ({ name: s.name, state: s.state, words: s.words })),
    note:
      view.openings.length > OPENINGS_MAX
        ? `${view.note} Only the first ${OPENINGS_MAX} of ${view.openings.length} openings are listed here.`
        : view.note,
  };
}
