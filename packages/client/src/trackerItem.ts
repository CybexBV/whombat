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
export function trackerItemText(words: TrackerWords = UNKNOWN_TRACKER_WORDS) {
  const product = words.product.trim() || UNKNOWN_TRACKER_WORDS.product;
  const known = !unknownTracker({ product });
  const team = words.team.trim() || UNKNOWN_TRACKER_WORDS.team;
  const Product = capitalised(product);
  return {
    loading: `Reading the report from ${product}…`,
    /** The server's words, ending in one full stop. */
    failedWith: (message: string) =>
      `Couldn’t read the report from ${product}: ${message.replace(/\.$/, '')}.`,
    failed: `Couldn’t read the report from ${product}. Try again in a moment.`,
    /** Who wrote a message the team sent (a person's reply, or Whombat's): “Acme team”. */
    teamAuthor: capitalised(team),
    emails: `${Product} emails the reporter what you send.`,
    replyNote: `${Product} emails your reply to the reporter and shows it as from ${known ? `“${team}”` : team}. It’s also posted in the run’s thread.`,
    statusNote: `${Product} emails the reporter about the change.`,
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
): string | null {
  if (output.wrote === false || (output.wrote === undefined && typeof output.reason === 'string'))
    return reasonOf(output);
  if (output.wrote !== true) return null;
  const connection = connectionOf(output, words.product);
  const write: TrackerWrite = {
    assessment: oneOf(ASSESSMENTS, output.assessment),
    priority: oneOf(PRIORITIES, output.priority),
  };
  if (typeof output.number !== 'number') return `Wrote to ${connection}.`;
  // Neither written: the report alone, not a line ending in a colon.
  if (!write.assessment && !write.priority) return `Wrote to ${connection} #${output.number}.`;
  return `Wrote to ${trackerWriteLine(connection, output.number, write)}.`;
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
): string | null {
  if (output.sent === false || (output.sent === undefined && typeof output.reason === 'string'))
    return reasonOf(output);
  if (output.sent !== true) return null;
  const connection = connectionOf(output, words.product);
  const report = typeof output.number === 'number' ? `${connection} #${output.number}` : connection;
  const status = typeof output.status === 'string' && output.status.trim() ? output.status.trim() : null;
  return status
    ? `Replied to the customer and set ${report} to “${trackerStatusLabel(status)}”.`
    : `Replied to the customer on ${report}.`;
}

/** What a `tracker_decision` step adds while it waits: where the person answers. */
export const DECISION_WAITING = 'Waiting for your answer on its card in the thread.';

/** “PR #52”: how the fix line starts, and what links to the pull request. */
export const fixPullRequest = (fix: Pick<TrackerFixView, 'prNumber'>): string => `PR #${fix.prNumber}`;

/** “live on dev.desk.acme.example (Acme Desk 0.1.176)”; “(version 0.1.176)” for a tracker whose name isn't known. */
function liveAt(live: NonNullable<TrackerFixView['development']>, product: string): string {
  const version = live.version.trim();
  const name = !product || unknownTracker({ product }) ? 'version' : product;
  return `live on ${live.host}${version ? ` (${name} ${version})` : ''}`;
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
): string {
  const pr = fixPullRequest(fix);
  const live = fix.production ?? fix.development;
  const liveOn = (at: NonNullable<TrackerFixView['development']>) => liveAt(at, words.product.trim());
  switch (fix.state) {
    case 'open':
      return `${pr} open`;
    case 'closed':
      return `${pr} closed without merging`;
    case 'merged':
      return `${pr} merged · not live yet`;
    case 'development':
      return fix.development
        ? `${pr} merged · ${liveOn(fix.development)} · waiting for production`
        : `${pr} merged · waiting for production`;
    case 'live':
    case 'confirmed':
    case 'reopened':
      return live ? `${pr} merged · ${liveOn(live)}` : `${pr} merged · live`;
    case 'stopped':
      return [fix.mergedAt ? `${pr} merged` : pr, ...(live ? [liveOn(live)] : []), 'no longer followed'].join(
        ' · ',
      );
  }
}

/** What the customer said about the fix, when they did: it works, or it still happens. */
export function fixFollowUp(fix: Pick<TrackerFixView, 'state'>): string | null {
  if (fix.state === 'confirmed') return 'The customer says it works.';
  if (fix.state === 'reopened') return 'The customer says it still happens.';
  return null;
}
