/**
 * The quiet hours for changes (docs/decisions/care-plan.md): a Whombat's one change window, `burrows.change_window_*`,
 * 03:00–05:00 in its time zone until the person moves it. The care plans' updates and restarts and an approval's
 * *Tonight* use it; the agent is told it in every turn of the person's. Changed only through the commit pipeline.
 */
import {
  CHANGE_WINDOW_DEFAULT,
  type ChangeWindow,
  type ChangeWindowView,
  changeWindowText,
  clockMinutes,
  SetChangeWindowBody,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { defineCommand } from '../commit/types';
import { burrows } from '../db/schema/index';
import { forbidden } from '../lib/errors';

type WindowColumns = { changeWindowStart: string | null; changeWindowEnd: string | null };

/** A Whombat's quiet hours: its own, or the default while it never moved them. */
export function changeWindowOf(row: WindowColumns | null | undefined): ChangeWindow {
  return row?.changeWindowStart && row.changeWindowEnd
    ? { start: row.changeWindowStart, end: row.changeWindowEnd }
    : CHANGE_WINDOW_DEFAULT;
}

/** The view `changeWindow.get` and `.set` answer. */
export function changeWindowView(row: WindowColumns & { timeZone: string }): ChangeWindowView {
  return {
    window: changeWindowOf(row),
    timeZone: row.timeZone,
    default: !(row.changeWindowStart && row.changeWindowEnd),
  };
}

/** When the quiet hours start, as an hour and minute (*Tonight*). */
export function windowStartOf(row: WindowColumns | null | undefined): { hour: number; minute: number } {
  const m = clockMinutes(changeWindowOf(row).start);
  return { hour: Math.floor(m / 60), minute: m % 60 };
}

/** `changeWindow.set`: the person moves the quiet hours; signed with the times (no private words in them). */
export const setChangeWindow = defineCommand({
  name: 'care.window_set',
  schema: SetChangeWindowBody,
  async apply(tx, ctx, input): Promise<ChangeWindowView> {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can move the quiet hours for changes.');
    const [row] = await tx
      .update(burrows)
      .set({ changeWindowStart: input.window.start, changeWindowEnd: input.window.end })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    await ctx.emit({
      type: 'care.window_set',
      kind: 'System',
      text: `Moved the quiet hours for changes to ${changeWindowText(input.window)}`,
      where: null,
      payload: { start: input.window.start, end: input.window.end },
    });
    if (!row) throw forbidden('No Whombat here.');
    return changeWindowView(row);
  },
});
