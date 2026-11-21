/**
 * A turn of an automation run that started from a tracker's report (Whombat report-trackers.md TA-09, TA-10;
 * `DispatchContext.tracker`): which tools of the run the runtime offers — `tracker_item` in every such turn,
 * `tracker_read` only when the tracker granted the step access to the reporting organization, neither anywhere else
 * (Claude's policy and Codex's `disabled_tools`; the server lists and refuses the same) — and the turn's lines about
 * them.
 */
import { type DispatchContext, type McpToolName, TRACKER_RUN_TOOL_NAMES } from '@whombat/core/contracts';
import { formatClock } from '@whombat/core/text';
import { defuseDelimiters } from './defuse';

/** The run's report, read from its tracker now. */
export const TRACKER_ITEM_TOOL = 'tracker_item' as const satisfies McpToolName;
/** The reporting organization, read-only, with the step's grant. */
export const TRACKER_READ_TOOL = 'tracker_read' as const satisfies McpToolName;

/** Whether the step was granted read access to the reporting organization. */
export function trackerReads(context: Partial<Pick<DispatchContext, 'tracker'>>): boolean {
  return context.tracker?.access?.state === 'granted';
}

/** The tracker tools this turn may call: the report in a tracker run's turns, the organization only when granted. */
export function trackerTools(context: Partial<Pick<DispatchContext, 'tracker'>>): McpToolName[] {
  if (!context.tracker) return [];
  return [TRACKER_ITEM_TOOL, ...(trackerReads(context) ? [TRACKER_READ_TOOL] : [])];
}

/** The tracker tools this turn may not call (all of them outside a tracker run). */
export function unservedTrackerTools(context: Partial<Pick<DispatchContext, 'tracker'>>): McpToolName[] {
  const served = trackerTools(context);
  return TRACKER_RUN_TOOL_NAMES.filter((n) => !served.includes(n));
}

/**
 * The preface lines of a tracker run's turn (TA-09, TA-10): which report it is about, and whether the step may read the
 * reporting organization (with its scopes and until when) or why not. How to read it is `tracker_read`'s description.
 */
export function trackerTurnLines(context: Pick<DispatchContext, 'tracker' | 'burrow'>): string[] {
  const t = context.tracker;
  if (!t) return [];
  const report = `${defuseDelimiters(t.connection)} #${t.number}`;
  const product = defuseDelimiters(t.product ?? 'the tracker');
  const lines = [
    `This run is about ${report}, a report ${[article(product), product].filter(Boolean).join(' ')} customer sent: ${TRACKER_ITEM_TOOL} reads it in full.`,
  ];
  const access = t.access;
  if (!access) return lines;
  if (access.state !== 'granted') {
    lines.push(
      `You can’t look inside the reporting organization this time${access.reason ? `: ${defuseDelimiters(access.reason)}` : '.'} Assess without it, and say so when it matters.`,
    );
    return lines;
  }
  const until = access.expiresAt ? `, until ${formatClock(access.expiresAt, context.burrow.timeZone)}` : '';
  const scopes = access.scopes.length ? `scopes ${defuseDelimiters(access.scopes.join(', '))}` : 'read-only';
  lines.push(
    `${capital(product)} granted read-only access to the reporting organization for this report alone (${scopes}${until}): check what the report concerns there with ${TRACKER_READ_TOOL} before you conclude, and say what you saw.`,
  );
  return lines;
}

/** “a” or “an” before a tracker's name (“a Bramble customer”, “an Acme customer”); nothing before “the tracker”. */
function article(product: string): string {
  if (/^the\s/i.test(product)) return '';
  return /^[aeiou]/i.test(product) ? 'an' : 'a';
}

function capital(text: string): string {
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text;
}
