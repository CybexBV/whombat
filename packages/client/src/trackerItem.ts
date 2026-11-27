/**
 * A run's tracker report, in the words the web and the phone say alike: what the write-back and the reply steps did,
 * where a feature request waits for its answer, where the report's fix is, and the report's lines that name the
 * tracker — in the words its driver gives (`TrackerWords`: “Acme Desk”, “Acme team”), never a tracker's own name
 * written here. How each page lays out the report and its run's steps stays with the app. Pure.
 */
import {
  type Automation,
  type TrackerFixView,
  type TrackerWords,
  type TrackerWrite,
  trackerStatusLabel,
  trackerWriteLine,
  UNKNOWN_TRACKER_WORDS,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { AUTOMATIONS_AREA_WORDS } from './i18n/messages/chatWork/automations';

const own = (locale?: string | null) => clientTree(locale, AUTOMATIONS_AREA_WORDS).tracker;

/* The tracker's words --------------------------------------------------------------------------------------------- */

/** Whether these are the stand-in words of a tracker whose driver isn't known (“the tracker”, “the team”). */
export const unknownTracker = (words: Pick<TrackerWords, 'product'>): boolean =>
  words.product === UNKNOWN_TRACKER_WORDS.product;

/**
 * The tracker's words an automation keeps — its recipe's, as the driver gave them when it was made (the live
 * definition's, else the draft's) — else the plain ones. What a run's page says until its report has loaded.
 */
export function automationTrackerWords(
  automation: Pick<Automation, 'definition' | 'draft'> | null | undefined,
): TrackerWords {
  for (const d of [automation?.definition, automation?.draft]) {
    const when = d?.recipe?.when;
    if (when?.kind === 'tracker' && when.words) return { product: when.words.product, team: when.words.team };
  }
  return UNKNOWN_TRACKER_WORDS;
}

/** “the tracker emails…” at a sentence's start: “The tracker emails…”; a name stays as it is. */
const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The report's lines that name the tracker, on the web and the phone alike: “Reading the report from Acme Desk…”, the
 * team's messages as “Acme team”, “Acme Desk emails the reporter what you send.” A tracker whose driver isn't known
 * reads “the tracker” and “the team”, never “the the”.
 */
export function trackerItemText(words: TrackerWords = UNKNOWN_TRACKER_WORDS, locale?: string | null) {
  const w = own(locale);
  const product = words.product.trim() || UNKNOWN_TRACKER_WORDS.product;
  const known = !unknownTracker({ product });
  const team = words.team.trim() || UNKNOWN_TRACKER_WORDS.team;
  const Product = capitalised(product);
  return {
    loading: interpolate(w.loading, { product }),
    /** The server's words, ending in one full stop. */
    failedWith: (message: string) =>
      interpolate(w.failedWith, { product, message: message.replace(/\.$/, '') }),
    failed: interpolate(w.failed, { product }),
    /** Who wrote a message the team sent (a person's reply, or Whombat's): “Acme team”. */
    teamAuthor: capitalised(team),
    emails: interpolate(w.emails, { product: Product }),
    replyNote: interpolate(w.replyNote, { product: Product, team: known ? `“${team}”` : team }),
    statusNote: interpolate(w.statusNote, { product: Product }),
  };
}

/* The run's steps --------------------------------------------------------------------------------------------- */

const ASSESSMENTS = ['likely_bug', 'feature_request', 'needs_information', 'duplicate'] as const;
const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;

/** The server's reason when a step did nothing, trimmed; null when it gave none. */
const reasonOf = (output: Record<string, unknown>): string | null =>
  typeof output.reason === 'string' && output.reason.trim() ? output.reason.trim() : null;

/** The connection's name as the step's output says it, else the tracker's (`product`). */
const connectionOf = (output: Record<string, unknown>, product: string): string =>
  typeof output.connection === 'string' && output.connection.trim() ? output.connection.trim() : product;

/**
 * A `tracker_update` step's outcome: “Wrote to Acme Desk dev #15: Likely bug · high priority.” when it wrote, the
 * server's reason when it wrote nothing (“Nothing to write: Banjo says it’s not a bug.”), else nothing to say (its raw
 * `text` never shows). `words`: the tracker's, for an output without its connection's name.
 */
export function trackerWriteOutcome(
  output: Record<string, unknown>,
  words: Pick<TrackerWords, 'product'> = UNKNOWN_TRACKER_WORDS,
  locale?: string | null,
): string | null {
  const w = own(locale);
  if (output.wrote === false || (output.wrote === undefined && typeof output.reason === 'string'))
    return reasonOf(output);
  if (output.wrote !== true) return null;
  const connection = connectionOf(output, words.product);
  const write: TrackerWrite = {
    assessment: oneOf(ASSESSMENTS, output.assessment),
    priority: oneOf(PRIORITIES, output.priority),
  };
  if (typeof output.number !== 'number') return interpolate(w.wrote, { connection });
  // Neither written: the report alone, not a line ending in a colon.
  if (!write.assessment && !write.priority)
    return interpolate(w.wroteNumber, { connection, number: output.number });
  return interpolate(w.wroteLine, { line: trackerWriteLine(connection, output.number, write) });
}

/**
 * A `tracker_reply` step's outcome: “Replied to the customer and set Acme Desk dev #16 to “Needs information”.”,
 * “Replied to the customer on Acme Desk dev #16.” when the status stayed, the server's reason when it sent nothing
 * (“Nothing to send: Banjo had nothing to tell the customer.”), else nothing to say. The server's step output:
 * `{sent: true, connectionId, connection, reportId, number, message, status}` or `{sent: false, reason}`.
 */
export function trackerReplyOutcome(
  output: Record<string, unknown>,
  words: Pick<TrackerWords, 'product'> = UNKNOWN_TRACKER_WORDS,
  locale?: string | null,
): string | null {
  const w = own(locale);
  if (output.sent === false || (output.sent === undefined && typeof output.reason === 'string'))
    return reasonOf(output);
  if (output.sent !== true) return null;
  const connection = connectionOf(output, words.product);
  const report = typeof output.number === 'number' ? `${connection} #${output.number}` : connection;
  const status = typeof output.status === 'string' && output.status.trim() ? output.status.trim() : null;
  return status
    ? interpolate(w.repliedSet, { report, status: trackerStatusLabel(status) })
    : interpolate(w.replied, { report });
}

/** What a `tracker_decision` step adds while it waits: where the person answers. */
export function decisionWaiting(locale?: string | null): string {
  return own(locale).decisionWaiting;
}

/** What a `tracker_decision` step adds while it waits: where the person answers. */
export const DECISION_WAITING = decisionWaiting();

/** “PR #52”: how the fix line starts, and what links to the pull request. */
export const fixPullRequest = (fix: Pick<TrackerFixView, 'prNumber'>): string => `PR #${fix.prNumber}`;

/** “live on dev.desk.acme.example (Acme Desk 0.1.176)”; “(version 0.1.176)” for a tracker whose name isn't known. */
function liveAt(
  live: NonNullable<TrackerFixView['development']>,
  product: string,
  locale?: string | null,
): string {
  const w = own(locale);
  const version = live.version.trim();
  const name = !product || unknownTracker({ product }) ? w.version : product;
  return `${interpolate(w.liveOn, { host: live.host })}${version ? ` (${name} ${version})` : ''}`;
}

/**
 * Where the report's fix is, in one line: “PR #52 open”, “PR #52 merged · not live yet”, “PR #52 merged · live on
 * dev.desk.acme.example (Acme Desk 0.1.176) · waiting for production” (a production report fixed in development), “PR
 * #52 merged · live on desk.acme.example (Acme Desk 0.1.180)”, “PR #52 closed without merging”, and “… · no longer
 * followed” once Whombat stopped (its `note` says why). `words`: the tracker's, which name the version it runs.
 */
export function fixLine(
  fix: TrackerFixView,
  words: Pick<TrackerWords, 'product'> = UNKNOWN_TRACKER_WORDS,
  locale?: string | null,
): string {
  const w = own(locale);
  const pr = fixPullRequest(fix);
  const merged = interpolate(w.merged, { pr });
  const live = fix.production ?? fix.development;
  const liveOn = (at: NonNullable<TrackerFixView['development']>) => liveAt(at, words.product.trim(), locale);
  switch (fix.state) {
    case 'open':
      return interpolate(w.open, { pr });
    case 'closed':
      return interpolate(w.closed, { pr });
    case 'merged':
      return interpolate(w.mergedNotLive, { pr });
    case 'development':
      return fix.development
        ? `${merged} · ${liveOn(fix.development)} · ${w.waitingProduction}`
        : `${merged} · ${w.waitingProduction}`;
    case 'live':
    case 'confirmed':
    case 'reopened':
      return live ? `${merged} · ${liveOn(live)}` : `${merged} · ${w.live}`;
    case 'stopped':
      return [fix.mergedAt ? merged : pr, ...(live ? [liveOn(live)] : []), w.noLongerFollowed].join(' · ');
  }
}

/** What the customer said about the fix, when they did: it works, or it still happens. */
export function fixFollowUp(fix: Pick<TrackerFixView, 'state'>, locale?: string | null): string | null {
  if (fix.state === 'confirmed') return own(locale).works;
  if (fix.state === 'reopened') return own(locale).stillHappens;
  return null;
}
