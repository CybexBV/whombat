/**
 * A connection's dot as whoever shows it works it out (quiet-notices.md QN-14, QN-22; QN-S07): signed out is its one
 * line (`conn.signin`, only you); otherwise the lines the last health pass kept, with the quiet rows of this moment. A
 * glance from before 0136 (no `lines`) keeps the status it has. And the desk's look of a thing: which line is behind its
 * dot (`thingNotice`), kept beside the summary rather than on it (the contract's `ThingSummary` gains nothing).
 */
import type { ThingSummary } from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import type { ConnectionGlance } from '../../home/types';
import { signinNotice } from '../panels';
import { type GlanceLine, type GlanceNotice, glanceLine, type Verdict, verdict } from './glance';
import type { ThingQuiet } from './store';

/** The dot now; null when the stored glance stands (none yet, or one from before 0136). */
export function connectionVerdict(
  row: Pick<CatalogConnectionRow, 'status' | 'glance' | 'label'>,
  quiet: ThingQuiet,
  now: Date,
): Verdict | null {
  if (row.status === 'needs_reauth') return verdict([glanceLine(signinNotice(row.label))], quiet, now);
  const glance = row.glance as ConnectionGlance | null;
  if (!glance?.lines) return null;
  return verdict(glance.lines, quiet, now);
}

const NOTICES = new WeakMap<ThingSummary, GlanceNotice>();
const LINES = new WeakMap<ThingSummary, readonly GlanceLine[]>();

/**
 * Keeps the line behind a thing's dot beside its summary (for the desk's look, QN-20), and every line behind it (what
 * the assistant looks into there).
 */
export function withNotice<T extends ThingSummary>(
  thing: T,
  notice: GlanceNotice | undefined,
  lines?: readonly GlanceLine[],
): T {
  if (notice) NOTICES.set(thing, notice);
  if (lines?.length) LINES.set(thing, lines);
  return thing;
}

/** Keeps the lines behind `from`'s dot for `to` too: the same thing, its words said in another language. */
export function carryNotice(from: ThingSummary, to: ThingSummary): void {
  const notice = NOTICES.get(from);
  const lines = LINES.get(from);
  if (notice) NOTICES.set(to, notice);
  if (lines) LINES.set(to, lines);
}

/** The line behind a thing's dot, when it was kept. */
export function thingNotice(thing: ThingSummary): GlanceNotice | undefined {
  return NOTICES.get(thing);
}

/** Every line behind a thing's dot, when they were kept. */
export function thingLines(thing: ThingSummary): readonly GlanceLine[] {
  return LINES.get(thing) ?? [];
}
