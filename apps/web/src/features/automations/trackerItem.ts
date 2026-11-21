/**
 * The tracker report on a run's page (docs/decisions/report-trackers.md AP-1024…AP-1026; contracts 0.69, CT-325;
 * Whombat TA-14, TA-15): how the report reads — its heading, where it comes from, its tags, the reporter, the
 * conversation — what a person may send to the reporter (a reply, a status, both), when that can't go yet, the
 * request id a retry reuses so the tracker replays it instead of emailing twice, what the customer got and the
 * `tracker_decision` step's outcome. The write-back and reply steps' outcomes, where the report's fix is and the lines
 * that name the tracker (its driver's words, `trackerItemText`) are the words the phone says too: `@whombat/client`'s.
 * Pure, so the rules are tested without a screen. Everything the customer wrote is plain text.
 */
import { DECISION_WAITING, trackerItemText } from '@whombat/client';
import {
  type AutomationRun,
  TRACKER_ASSESSMENT_LABELS,
  TRACKER_PRIORITY_LABELS,
  TRACKER_REPLY_MAX,
  TRACKER_STATUS_LABELS,
  type TrackerFixView,
  type TrackerItemMessage,
  type TrackerItemView,
  TrackerUpdateStatus,
  type TrackerWords,
  trackerStatusLabel,
} from '@whombat/core';

/** The report's own words; the lines that name the tracker are `trackerItemText`'s. */
export const TRACKER_TEXT = {
  section: 'TRACKER REPORT',
  retry: 'Try again',
  reporter: 'REPORTER',
  filed: 'FILED',
  happened: 'WHAT HAPPENED',
  expected: 'WHAT THEY EXPECTED',
  screenshot: 'SCREENSHOT',
  conversation: 'CONVERSATION',
  fix: 'FIX',
  nothingWritten: 'Nothing written.',
  noReplies: 'No replies yet.',
  notGiven: 'Not given',
  enlarge: 'The reporter’s screenshot, opens it larger',
  screenshotAlt: 'The reporter’s screenshot',
  reply: 'Reply to the reporter…',
  setStatus: 'Set status…',
  replyTitle: 'Reply to the reporter',
  statusTitle: 'Set the status',
  replyLabel: 'REPLY',
  replyPlaceholder: 'What should the reporter hear from you?',
  alsoStatus: 'ALSO SET THE STATUS',
  statusLabel: 'STATUS',
  statusReplyHint: 'Optional. Not planned needs one: tell the reporter why.',
  cancel: 'Cancel',
  sendReply: 'Send reply',
  sendStatus: 'Set status',
  unreachable: 'Couldn’t reach your Whombat. Try again.',
} as const;

/** “#15 · The rollout never finishes”. */
export const reportHeading = (r: Pick<TrackerItemView, 'number' | 'title'>): string =>
  `#${r.number} · ${r.title}`;

/** `production` → “Production”; whatever else the tracker says, capitalised. */
export function environmentLabel(environment: string): string {
  const text = environment.replace(/_/g, ' ').trim();
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : environment;
}

/** “Acme Desk dev · HollowMere College · Production”: the organization and environment when the tracker names them. */
export function reportPlace(r: Pick<TrackerItemView, 'connection' | 'organization' | 'environment'>): string {
  return [
    r.connection,
    ...(r.organization ? [r.organization] : []),
    ...(r.environment ? [environmentLabel(r.environment)] : []),
  ].join(' · ');
}

/** The report's tags: what it is (first, in ink), its status, its priority and the tracker's assessment when set. */
export function reportTags(
  r: Pick<TrackerItemView, 'type' | 'status' | 'priority' | 'assessment'>,
): string[] {
  const label = (labels: Readonly<Record<string, string>>, value: string) =>
    labels[value] ?? environmentLabel(value);
  return [
    r.type === 'bug' ? 'Bug report' : 'Feature request',
    trackerStatusLabel(r.status),
    ...(r.priority ? [`${label(TRACKER_PRIORITY_LABELS, r.priority)} priority`] : []),
    ...(r.assessment ? [label(TRACKER_ASSESSMENT_LABELS, r.assessment)] : []),
  ];
}

/** “Anna de Vries · anna@hollowmere.example”, either alone, else “Not given” (people only: agents never see it). */
export function reporterLine(reporter: TrackerItemView['reporter']): string {
  const parts = [reporter.name?.trim(), reporter.email?.trim()].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : TRACKER_TEXT.notGiven;
}

/** Who wrote a message of the conversation, as the tracker shows it: “The reporter”, or its team (“Acme team”). */
export const authorLabel = (author: TrackerItemMessage['author'], words: TrackerWords): string =>
  author === 'reporter' ? 'The reporter' : trackerItemText(words).teamAuthor;

/** “Released in console 0.1.132.” when the tracker recorded the fix's release. */
export const releaseLine = (release: NonNullable<TrackerItemView['release']>): string =>
  `Released in ${release.component} ${release.version}.`;

/** The run started from a tracker's report: its page shows the report (TA-14). */
export const fromTrackerItem = (run: Pick<AutomationRun, 'trigger'>): boolean =>
  run.trigger.kind === 'tracker';

/* Sending to the reporter (TA-15) ----------------------------------------------------------------------------- */

/** The statuses a person sets, in the tracker vocabulary's order and words (never `available`, `new`, `confirmed`, `duplicate`). */
export const STATUS_CHOICES: readonly { id: TrackerUpdateStatus; label: string }[] =
  TrackerUpdateStatus.options.map((id) => ({ id, label: TRACKER_STATUS_LABELS[id] ?? id }));

export type UpdateMode = 'reply' | 'status';

/** What the modal holds: a reply, a status ('' none chosen), or both. */
export interface UpdateDraft {
  mode: UpdateMode;
  message: string;
  status: TrackerUpdateStatus | '';
}

/** What goes to `tracker.update` besides the request id: the reply trimmed, the status when chosen. */
export function updateBody(draft: UpdateDraft): { message?: string; status?: TrackerUpdateStatus } {
  const message = draft.message.trim();
  return { ...(message ? { message } : {}), ...(draft.status ? { status: draft.status } : {}) };
}

/** Why it can't be sent yet, in the modal's words; null: it can. `current` is the report's status now. */
export function updateProblem(draft: UpdateDraft, current: string): string | null {
  const body = updateBody(draft);
  if (draft.message.length > TRACKER_REPLY_MAX)
    return `A reply is at most ${TRACKER_REPLY_MAX.toLocaleString('en-GB')} characters.`;
  if (draft.mode === 'reply') {
    if (!body.message) return 'Write a reply.';
    return null;
  }
  if (!body.status) return 'Choose a status.';
  if (body.status === 'not_planned' && !body.message)
    return 'Tell the reporter why when it isn’t planned: write a reply.';
  if (body.status === current && !body.message) return `It’s ${trackerStatusLabel(current)} already.`;
  return null;
}

/** The request id of one submission, and what it sent (`message` and `status`, as JSON). */
export interface UpdateRequest {
  id: string;
  key: string;
}

/**
 * The request id to send (AP-1025): a retry of the same reply and status after a lost or refused answer reuses the last
 * one, so the tracker replays it and the reporter is emailed once; anything changed is a new submission with a new id.
 * After a success the modal forgets it (`null`), so the next one is new too.
 */
export function nextRequest(
  previous: UpdateRequest | null,
  body: ReturnType<typeof updateBody>,
  make: () => string,
): UpdateRequest {
  const key = JSON.stringify([body.message ?? null, body.status ?? null]);
  return previous?.key === key ? previous : { id: make(), key };
}

/** The toast once the tracker has it: “Sent to the reporter, and set to In progress.”, “Set to Closed.”. */
export function updateDoneText(body: ReturnType<typeof updateBody>): string {
  const status = body.status ? trackerStatusLabel(body.status) : null;
  if (body.message && status) return `Sent to the reporter, and set to ${status}.`;
  if (body.message) return 'Sent to the reporter.';
  return `Set to ${status ?? 'it'}.`;
}

/* Replying to the customer (0.75, TA-27) ------------------------------------------------------------------------- */

/** What the customer got (AP-1110): the step's `message` as the tracker sent it, signature included; null when nothing went. */
export function trackerReplySent(output: Record<string, unknown>): string | null {
  if (output.sent !== true || typeof output.message !== 'string') return null;
  return output.message.trim() || null;
}

/* A feature request put to the person (3.12) -------------------------------------------------------------------- */

/**
 * A `tracker_decision` step's outcome: the server keeps the step's state in its words in `inputSummary` —
 * “Asked you about feature request #21” while it waits (then where to answer), “Approved by John · Planned”, “Declined by
 * John · “It only helps one customer.”” or “John asked the customer · “…”” once decided, why it was skipped (“Not a
 * feature request.”, “A newer assessment of this report replaced it.”) — said once, as a sentence. Null without one.
 */
export function trackerDecisionOutcome(step: { state: string; inputSummary: string }): string | null {
  const said = step.inputSummary.trim();
  if (!said) return null;
  // A sentence ends with its stop; one that ends in a quote (the person's own words) has it inside.
  const sentence = /[\p{L}\p{N}]$/u.test(said) ? `${said}.` : said;
  return step.state === 'waiting' ? `${sentence} ${DECISION_WAITING}` : sentence;
}

/* The report's fix (0.75, TA-29…TA-33) ---------------------------------------------------------------------------- */

/** The pull request's address when it is GitHub's own (`https://`), for the line's link; null otherwise. */
export function fixPullRequestUrl(fix: Pick<TrackerFixView, 'prUrl'>): string | null {
  return fix.prUrl?.startsWith('https://') ? fix.prUrl : null;
}
