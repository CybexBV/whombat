/**
 * Report trackers through automations (Whombat docs/decisions/report-trackers.md): the report a run started from, as
 * people read it on the run page (`tracker.item`), what they may set on it (`tracker.update`), and what an automation's
 * `tracker_update` step writes back. The tracker stays the system of record: nothing here is a copy Whombat keeps in
 * step. Its name and words come from its driver (`TrackerWords`); the vocabulary of statuses, assessments and
 * priorities below is the one every driver maps its tracker's own onto.
 */

import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { ConnectionId } from '../ids.js';
import type { AutomationAssessment } from './automation.js';
import { Timestamp } from './common.js';

/** A tracker item's id, as its tracker names it (its `number` is what people say). */
export const TrackerItemId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\s]+$/, { message: 'Expected a report id' });
export type TrackerItemId = z.infer<typeof TrackerItemId>;

/**
 * What a tracker is called, as its driver words it: its name as customers know it (“Acme Desk”) and who answers them
 * there (“Acme Desk team”: Whombat's replies arrive as the team). Kept on a tracker recipe so its definition stays what
 * it was made with.
 */
export const TrackerWords = z.object({
  product: z.string().trim().min(1).max(40),
  team: z.string().trim().min(1).max(60),
});
export type TrackerWords = z.infer<typeof TrackerWords>;

const UNKNOWN_TRACKER_WORDS_KEYS = ['product', 'team'] as const;

/** The words of a tracker whose driver isn't there (or a viewer who can't see its connection). */
export function unknownTrackerWords(
  locale?: string | null,
): Readonly<Record<(typeof UNKNOWN_TRACKER_WORDS_KEYS)[number], string>> {
  return coreWords(locale, 'tracker.unknown', UNKNOWN_TRACKER_WORDS_KEYS);
}

export const UNKNOWN_TRACKER_WORDS: TrackerWords = unknownTrackerWords('en');

/**
 * A tracker recipe's words (`RecipeWhen` of kind `tracker`): the driver's `TrackerWords` and its own lines for the
 * agent's prompt, taken when the automation is made, so its definition stays what it was made with whatever the driver
 * says later. `source`: who sent the report and through what, before it is quoted (“A signed-in Acme customer sent the
 * report below through Acme’s own Feedback”); `access`: what `tracker_read` reaches with the organization's access
 * (“its devices, deployments and audit”) — absent when the tracker grants none.
 */
export const TrackerRecipeWords = TrackerWords.extend({
  source: z.string().trim().min(1).max(400).optional(),
  access: z.string().trim().min(1).max(200).optional(),
}).strict();
export type TrackerRecipeWords = z.infer<typeof TrackerRecipeWords>;

/** What a report is, as its reporter filed it. */
export const TrackerItemKind = z.enum(['bug', 'feature']);
export type TrackerItemKind = z.infer<typeof TrackerItemKind>;

/**
 * The statuses a person sets with `tracker.update` (TA-15). Never `available` (the tracker's release tooling records
 * it), `new`, `confirmed` or `duplicate`; `not_planned` only with a reply.
 */
export const TrackerUpdateStatus = z.enum([
  'investigating',
  'needs_information',
  'planned',
  'in_progress',
  'awaiting_release',
  'closed',
  'not_planned',
]);
export type TrackerUpdateStatus = z.infer<typeof TrackerUpdateStatus>;

const TRACKER_STATUS_LABELS_KEYS = [
  'new',
  'investigating',
  'needs_information',
  'planned',
  'in_progress',
  'awaiting_release',
  'available',
  'confirmed',
  'closed',
  'not_planned',
  'duplicate',
] as const;

/** A status's words, for every status of the tracker vocabulary (`trackerStatusLabel` for one a tracker adds). */
export function trackerStatusLabels(
  locale?: string | null,
): Readonly<Record<(typeof TRACKER_STATUS_LABELS_KEYS)[number], string>> {
  return coreWords(locale, 'tracker.status', TRACKER_STATUS_LABELS_KEYS);
}

export const TRACKER_STATUS_LABELS: Readonly<Record<string, string>> = trackerStatusLabels('en');

const TRACKER_ASSESSMENT_LABELS_KEYS = [
  'likely_bug',
  'reproduced',
  'needs_information',
  'duplicate',
  'feature_request',
] as const;

/** The assessments a tracker keeps on a report, in words (TA-11; `reproduced` only ever by a person there). */
export function trackerAssessmentLabels(
  locale?: string | null,
): Readonly<Record<(typeof TRACKER_ASSESSMENT_LABELS_KEYS)[number], string>> {
  return coreWords(locale, 'tracker.assessment', TRACKER_ASSESSMENT_LABELS_KEYS);
}

export const TRACKER_ASSESSMENT_LABELS: Readonly<Record<string, string>> = trackerAssessmentLabels('en');

const TRACKER_PRIORITY_LABELS_KEYS = ['urgent', 'high', 'normal', 'low'] as const;

/** `TRACKER_PRIORITY_LABELS` in a locale. */
export function trackerPriorityLabels(
  locale?: string | null,
): Readonly<Record<(typeof TRACKER_PRIORITY_LABELS_KEYS)[number], string>> {
  return coreWords(locale, 'tracker.priority', TRACKER_PRIORITY_LABELS_KEYS);
}

export const TRACKER_PRIORITY_LABELS: Readonly<Record<string, string>> = trackerPriorityLabels('en');

/** “In progress”; a status this version doesn't know in the tracker's own words (`on_hold` → “On hold”). */
export function trackerStatusLabel(status: string): string {
  return TRACKER_STATUS_LABELS[status] ?? words(status);
}

function words(value: string): string {
  const text = value.replace(/_/g, ' ').trim();
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : value;
}

/** The longest public reply a person sends through the tracker (TA-15; it emails it). */
export const TRACKER_REPLY_MAX = 8000;
/** The largest screenshot `tracker.item` gives as a data URL (TA-14); a larger one is left out. */
export const TRACKER_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** One message of a report's conversation in the tracker: the reporter's, or the team's (a person's reply). */
export const TrackerItemMessage = z.object({
  author: z.enum(['reporter', 'team']),
  body: z.string().max(TRACKER_REPLY_MAX * 2),
  at: Timestamp,
});
export type TrackerItemMessage = z.infer<typeof TrackerItemMessage>;

/**
 * Where a report's fix is (0.75, CT-331; Whombat report-trackers.md TA-29…TA-33), as the run page shows it:
 * `open` — its pull request is open; `merged` — merged, not yet live on development; `development` — live on
 * development, waiting for a production release (a production report); `live` — live where the customer is;
 * `confirmed` — the customer says it works; `reopened` — the customer says it still happens; `closed` — the pull request
 * was closed without merging; `stopped` — Whombat stopped following it (it changes the device agent, it took too long,
 * the connection is gone).
 */
export const TrackerFixState = z.enum([
  'open',
  'merged',
  'development',
  'live',
  'confirmed',
  'reopened',
  'closed',
  'stopped',
]);
export type TrackerFixState = z.infer<typeof TrackerFixState>;

/** Where a fix went live: the tracker's address, the version it runs and when Whombat saw it. */
export const TrackerFixLive = z.object({
  host: z.string().max(253),
  version: z.string().max(100),
  at: Timestamp,
});
export type TrackerFixLive = z.infer<typeof TrackerFixLive>;

/** A report's fix as `tracker.item` gives it (0.75): the latest one Whombat follows for the run's report. */
export const TrackerFixView = z.object({
  state: TrackerFixState,
  repo: z.string().max(255),
  prNumber: z.number().int().positive(),
  prUrl: z.string().max(2048).nullable(),
  mergedAt: Timestamp.nullable(),
  development: TrackerFixLive.nullable(),
  production: TrackerFixLive.nullable(),
  /** Why Whombat stopped following it, or why the customer wasn't told, in plain words. */
  note: z.string().max(500).nullable(),
});
export type TrackerFixView = z.infer<typeof TrackerFixView>;

/**
 * A run's report as people read it, live from its tracker (`tracker.item`, TA-14). The reporter's name and email are for
 * people only: no agent ever gets them (FB-F08). Everything the customer wrote is unverified.
 */
export const TrackerItemView = z.object({
  connectionId: ConnectionId,
  /** The connection's label (“Acme Desk dev”). */
  connection: z.string().max(80),
  /** What the tracker is called (its driver's words): “In Acme Desk”, the team's messages as “Acme Desk team”. */
  words: TrackerWords.default(UNKNOWN_TRACKER_WORDS),
  reportId: TrackerItemId,
  number: z.number().int().positive(),
  title: z.string().max(300),
  type: TrackerItemKind,
  organization: z.string().max(200).nullable(),
  /** `production` or `development` (from the diagnostics' origin), else null. */
  environment: z.string().max(100).nullable(),
  /** In the tracker vocabulary (`awaiting_release`): `trackerStatusLabel` says them. */
  status: z.string().max(40),
  priority: z.string().max(40).nullable(),
  assessment: z.string().max(40).nullable(),
  createdAt: Timestamp,
  reporter: z.object({
    name: z.string().max(200).nullable(),
    email: z.string().max(320).nullable(),
  }),
  description: z.string(),
  expected: z.string(),
  /** A data URL (at most `TRACKER_SCREENSHOT_MAX_BYTES`); null without one, or when it is larger. */
  screenshot: z.string().nullable(),
  /** The conversation in the tracker, oldest first. */
  messages: z.array(TrackerItemMessage).max(200),
  /** The release the tracker recorded for the fix, when there is one. */
  release: z
    .object({ component: z.string().max(100), version: z.string().max(100), evidence: z.string().max(2000) })
    .nullable(),
  /** The fix Whombat follows for it (0.75, TA-29), null without one. */
  fix: TrackerFixView.nullable().default(null),
});
export type TrackerItemView = z.infer<typeof TrackerItemView>;

/* Writing an assessment back (TA-11, TA-12) ------------------------------------------------------------------- */

/** What a `tracker_update` step writes: the report's assessment and priority (either may be null: not sent). */
export interface TrackerWrite {
  assessment: 'likely_bug' | 'feature_request' | 'needs_information' | 'duplicate' | null;
  priority: 'urgent' | 'high' | 'normal' | 'low' | null;
}

const PRIORITY_OF: Record<AutomationAssessment['importance'], NonNullable<TrackerWrite['priority']>> = {
  critical: 'urgent',
  high: 'high',
  medium: 'normal',
  low: 'low',
};

/**
 * What an assessment writes to a report (TA-11): bug → `likely_bug`, feature → `feature_request`, a question or
 * unclear → `needs_information` (a question its reply answers: nothing, TA-54), duplicate → `duplicate`, not a bug →
 * nothing; the priority for a bug or a feature
 * only. Never `reproduced`, a status or a message. `skip` when there is nothing to write: it isn't a bug, or nothing was
 * assessed (`unassessed()`, the same rule as `assessmentLine`'s “Not assessed”).
 */
export function trackerWriteOf(
  a: AutomationAssessment,
): { write: TrackerWrite } | { skip: 'not_a_bug' | 'not_assessed' | 'answered' } {
  if (a.kind === 'unclear' && a.confidence === 'low') return { skip: 'not_assessed' };
  if (a.kind === 'not_a_bug') return { skip: 'not_a_bug' };
  // A question the reply answers needs nothing from the customer: “Needs information” would tell the team the opposite.
  if (a.kind === 'question' && !a.replyAsks && a.reply.trim()) return { skip: 'answered' };
  const assessment =
    a.kind === 'bug'
      ? 'likely_bug'
      : a.kind === 'feature'
        ? 'feature_request'
        : a.kind === 'duplicate'
          ? 'duplicate'
          : 'needs_information';
  const priority = a.kind === 'bug' || a.kind === 'feature' ? PRIORITY_OF[a.importance] : null;
  return { write: { assessment, priority } };
}

/** Why a `tracker_update` step wrote nothing: “Nothing to write: Banjo says it’s not a bug.” */
export function trackerNothingToWriteText(
  reason: 'not_a_bug' | 'not_assessed' | 'answered' | 'unchanged',
  agent: string,
  product = UNKNOWN_TRACKER_WORDS.product,
): string {
  switch (reason) {
    case 'not_a_bug':
      return `Nothing to write: ${agent} says it’s not a bug.`;
    case 'answered':
      return `Nothing to write: ${agent} answered the question.`;
    case 'not_assessed':
      return `Nothing to write: ${agent} didn’t assess it.`;
    case 'unchanged':
      return `Nothing to write: ${product} already has this assessment and priority.`;
  }
}

/** What a person says yes to when the key asks (TA-12): “Acme Desk dev #15: Likely bug · high priority”. */
export function trackerWriteLine(connection: string, number: number, write: TrackerWrite): string {
  const parts = [
    ...(write.assessment ? [TRACKER_ASSESSMENT_LABELS[write.assessment] ?? words(write.assessment)] : []),
    ...(write.priority ? [`${write.priority} priority`] : []),
  ];
  return `${connection} #${number}: ${parts.join(' · ')}`;
}

/* Replying to the customer (0.75, CT-331; Whombat report-trackers.md TA-25…TA-33) -------------------------------- */

/** The longest reply an agent writes for a customer (`AutomationAssessment.reply`), before its signature. */
export const TRACKER_CUSTOMER_REPLY_MAX = 1500;

/**
 * The statuses an automation sets on a report (TA-27, TA-30): never confirmed. Planned, In progress and
 * Not planned only carry a person's decision on a feature request (3.12, TA-48); Closed only a reply to a report that
 * is finished (`closes`: the customer withdrew it or said it's solved, a question was answered, a test, TA-54), and
 * Duplicate a reply to a repeat of the same organization's open report, linked to it (TA-54).
 */
export const TRACKER_AUTOMATION_STATUSES = [
  'closed',
  'duplicate',
  'investigating',
  'needs_information',
  'awaiting_release',
  'available',
  'planned',
  'in_progress',
  'not_planned',
] as const;

/**
 * How the agent signs what a customer reads (TA-26): “Dusty - AI Assistant”, so the customer knows an AI wrote it
 * (a tracker shows every integration's message as its team).
 */
export function customerSignature(name: string): string {
  return `${name.trim()} - AI Assistant`;
}

/** The longest signature a tracker connection may give its replies (`signature`). */
export const TRACKER_SIGNATURE_MAX = 60;

/**
 * A tracker connection's own signature for its replies (“Whombat Team (AI assistant)”), from its `signature` field, on
 * one line; null without one, and the agent's name signs as before (`customerSignature`). Whombat team-reports.md.
 */
export function connectionSignature(
  fields: Readonly<Record<string, string>> | null | undefined,
): string | null {
  const own = (fields?.signature ?? '').replace(/\s+/g, ' ').trim();
  return own && own.length <= TRACKER_SIGNATURE_MAX ? own : null;
}

/** A reply as the tracker sends it: the text, a blank line and the signature. */
export function signedReply(text: string, signature: string): string {
  return `${text.trim()}\n\n${signature}`;
}

/** The statuses a reply may close a report from (TA-54): one nobody decided on yet, without a fix under way. */
export const TRACKER_CLOSABLE_STATUSES: readonly string[] = ['new', 'investigating', 'needs_information'];

/**
 * The statuses a reply may also close a report from when the agent said the customer calls it solved or withdrew it
 * (`solved`): its fix waits for a release or is out, and no fix of it is under way.
 */
export const TRACKER_SOLVED_CLOSABLE_STATUSES: readonly string[] = ['awaiting_release', 'available'];

/**
 * The status a reply after an assessment sets (TA-27): “Needs information” when it asks the customer something,
 * “Closed” when the report is finished (`closes`, TA-54) and still open for it, “Investigating” for a new report or
 * one that waited for the customer, else none (the status stays).
 */
export function trackerReplyStatus(
  a: Pick<AutomationAssessment, 'replyAsks'> & { closes?: boolean; solved?: boolean },
  current: string,
): 'closed' | 'investigating' | 'needs_information' | null {
  if (a.replyAsks) return current === 'needs_information' ? null : 'needs_information';
  if (
    a.closes &&
    (TRACKER_CLOSABLE_STATUSES.includes(current) ||
      (a.solved && TRACKER_SOLVED_CLOSABLE_STATUSES.includes(current)))
  )
    return 'closed';
  return current === 'new' || current === 'needs_information' ? 'investigating' : null;
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]"'”’]+/gi;
const HASH_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;
const FILE_RE =
  /(?:^|[\s(“"'`])(?:[\w.-]+\/)*[\w-]+\.(?:rs|ts|tsx|js|jsx|mjs|py|sql|go|toml|ya?ml|nix|sh|java|kt|rb|php|cs|swift)\b/i;
const PATH_RE = /(?:^|\s)(?:\.{0,2}\/)?(?:src|web|agent|apps|packages|deploy|migrations|docs)\/[\w./-]+/;
const PR_RE = /\bpull request\b|\bPR\s*#?\d+|\bmerge request\b/i;
const MENTION_RE = /(?:^|\s)@[A-Za-z][\w-]{1,}/;

/**
 * What is wrong with a reply before it reaches a customer (TA-28), in plain words; null when nothing is. It is sent only
 * when nothing is: else it waits for a person's yes, whatever the key says. Too long; a link off the tracker's `origin`; a
 * commit hash, a file in the code, a pull request, code or an @mention; or the name of another of the installation's
 * organizations (`organizations`, the report's own left out).
 */
export function customerReplyProblem(
  text: string,
  context: { origin?: string | null; organizations?: readonly string[]; product?: string } = {},
): string | null {
  const reply = text.trim();
  if (reply.length > TRACKER_CUSTOMER_REPLY_MAX)
    return `It is longer than ${TRACKER_CUSTOMER_REPLY_MAX} characters.`;
  const allowed = hostOf(context.origin ?? '');
  for (const link of reply.match(URL_RE) ?? []) {
    const host = hostOf(link);
    if (!host || host !== allowed)
      return `It links to ${host ?? 'an address'}, outside ${context.product ?? UNKNOWN_TRACKER_WORDS.product}.`;
  }
  if (reply.includes('`')) return 'It contains code.';
  if (HASH_RE.test(reply)) return 'It contains what looks like a commit hash.';
  if (FILE_RE.test(reply) || PATH_RE.test(reply)) return 'It names a file in the code.';
  if (PR_RE.test(reply)) return 'It mentions a pull request.';
  if (MENTION_RE.test(reply)) return 'It @mentions someone.';
  const lower = reply.toLowerCase();
  for (const name of context.organizations ?? []) {
    const n = name.trim();
    if (n.length < 3) continue;
    // Every place it appears: the first may be inside another word (“Demographic” for “Demo”) and a later one not.
    for (let at = lower.indexOf(n.toLowerCase()); at >= 0; at = lower.indexOf(n.toLowerCase(), at + 1)) {
      const before = lower[at - 1] ?? ' ';
      const after = lower[at + n.length] ?? ' ';
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after))
        return `It names another customer, ${n}.`;
    }
    // Its short form too (“HollowMere” of “HollowMere College”), as a fix's pull request leaves it out (TA-68).
    if (namesOrganization(reply, n)) return `It names another customer, ${n}.`;
  }
  return null;
}

/** Whether a text names a report's organization the way `withoutOrganization` would take it out. */
export function namesOrganization(text: string, organization: string | null | undefined): boolean {
  return withoutOrganization(text, organization) !== text;
}

/** The host of an `http(s)://` address, lowercase (core has no `URL`); null for anything else. */
function hostOf(url: string): string | null {
  const host = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]+)/i.exec(url.trim())?.[1];
  return host ? host.toLowerCase() : null;
}

/** Which installation a tracker connection is (TA-32): its development or its production. */
export const TrackerEnvironment = z.enum(['development', 'production']);
export type TrackerEnvironment = z.infer<typeof TrackerEnvironment>;

const DEVELOPMENT_LABELS = new Set(['dev', 'development', 'staging', 'test', 'acc', 'acceptance', 'preview']);

/**
 * A tracker installation's environment (TA-32): what its health says, else
 * its address — a first label `dev`, `staging`, `test` … or one starting with `dev-` is development, anything else
 * production.
 */
export function trackerEnvironmentOf(reported: unknown, address: string): TrackerEnvironment {
  const said = TrackerEnvironment.safeParse(reported);
  if (said.success) return said.data;
  const host = hostOf(address) ?? address.toLowerCase();
  const first = host.split('.')[0] ?? '';
  return DEVELOPMENT_LABELS.has(first) || first.startsWith('dev-') || first.endsWith('-dev')
    ? 'development'
    : 'production';
}

/** The languages the fix notices are written in (TA-30); any other gets English. */
export const TRACKER_NOTICE_LANGUAGES = ['en', 'nl'] as const;
export type TrackerNoticeLanguage = (typeof TRACKER_NOTICE_LANGUAGES)[number];

const DUTCH_WORDS = new Set(
  'de het een en is niet wordt worden ik je jij we wij mijn bij van voor met op dat die dit er ook maar als naar geen wel kan kun zijn heb heeft hebben werkt deze nog dan'.split(
    ' ',
  ),
);
const ENGLISH_WORDS = new Set(
  'the a an and is not it i you we my at of for with on that this there also but if to no can be have has works these still then when does'.split(
    ' ',
  ),
);

/** The language a customer most likely wrote in, when the agent didn't say (TA-30): Dutch or English, else ''. */
export function guessLanguage(text: string): '' | TrackerNoticeLanguage {
  let nl = 0;
  let en = 0;
  for (const word of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (DUTCH_WORDS.has(word)) nl++;
    if (ENGLISH_WORDS.has(word)) en++;
  }
  if (nl === 0 && en === 0) return '';
  return nl > en ? 'nl' : 'en';
}

/** The notices' language for a reported or guessed language: Dutch for `nl`, English otherwise. */
export function noticeLanguage(language: string | null | undefined): TrackerNoticeLanguage {
  return language?.trim().toLowerCase() === 'nl' ? 'nl' : 'en';
}

const NOTICES: Record<
  TrackerNoticeLanguage,
  Record<'bug' | 'feature', { live: string; coming: string; nowLive: string }>
> = {
  en: {
    bug: {
      live: 'Good news: we’ve fixed this, and the fix is live now. Could you try again and let us know whether it works?',
      coming:
        'Good news: we’ve fixed this. The fix will reach you with the next {product} update, and we’ll let you know here as soon as it’s there.',
      nowLive: 'The fix is live now. Could you try again and let us know whether it works?',
    },
    feature: {
      live: 'Good news: what you asked for is ready and live now. Could you give it a try and let us know what you think?',
      coming:
        'Good news: we’ve built what you asked for. It will reach you with the next {product} update, and we’ll let you know here as soon as it’s there.',
      nowLive: 'What you asked for is live now. Could you give it a try and let us know what you think?',
    },
  },
  nl: {
    bug: {
      live: 'Goed nieuws: we hebben dit opgelost en de oplossing staat nu live. Wil je het nog eens proberen en laten weten of het werkt?',
      coming:
        'Goed nieuws: we hebben dit opgelost. De oplossing komt naar je toe met de volgende update van {product}, en we laten het je hier weten zodra die er is.',
      nowLive: 'De oplossing staat nu live. Wil je het nog eens proberen en laten weten of het werkt?',
    },
    feature: {
      live: 'Goed nieuws: wat je vroeg is klaar en staat nu live. Wil je het eens proberen en laten weten wat je ervan vindt?',
      coming:
        'Goed nieuws: we hebben gebouwd wat je vroeg. Het komt naar je toe met de volgende update van {product}, en we laten het je hier weten zodra die er is.',
      nowLive: 'Wat je vroeg staat nu live. Wil je het eens proberen en laten weten wat je ervan vindt?',
    },
  },
};

/** The notices around the fix's own words (TA-55): a full fix, or a change that solves part of it. */
const OUTCOME_NOTICES: Record<
  TrackerNoticeLanguage,
  Record<
    'fixed' | 'partly' | 'unknown',
    { live: string; liveEnd: string; coming: string; comingEnd: string; nowLive: string }
  >
> = {
  en: {
    fixed: {
      live: 'Good news: we’ve fixed this, and the fix is live now.',
      liveEnd: 'Could you try again and let us know whether it works?',
      coming: 'Good news: we’ve fixed this.',
      comingEnd:
        'The fix will reach you with the next {product} update, and we’ll let you know here as soon as it’s there.',
      nowLive: 'The fix is live now. Could you try again and let us know whether it works?',
    },
    partly: {
      live: 'We’ve made a change for this, and it is live now.',
      liveEnd: 'Could you try it and let us know how it goes?',
      coming: 'We’ve made a change for this.',
      comingEnd:
        'It will reach you with the next {product} update, and we’ll let you know here as soon as it’s there.',
      nowLive: 'The change is live now. Could you try it and let us know how it goes?',
    },
    unknown: {
      live: 'We’ve made a change for this, and it is live now.',
      liveEnd: 'Could you try again and let us know whether it works?',
      coming: 'We’ve made a change for this.',
      comingEnd:
        'It will reach you with the next {product} update, and we’ll let you know here as soon as it’s there.',
      nowLive: 'The change is live now. Could you try again and let us know whether it works?',
    },
  },
  nl: {
    fixed: {
      live: 'Goed nieuws: we hebben dit opgelost en de oplossing staat nu live.',
      liveEnd: 'Wil je het nog eens proberen en laten weten of het werkt?',
      coming: 'Goed nieuws: we hebben dit opgelost.',
      comingEnd:
        'De oplossing komt naar je toe met de volgende update van {product}, en we laten het je hier weten zodra die er is.',
      nowLive: 'De oplossing staat nu live. Wil je het nog eens proberen en laten weten of het werkt?',
    },
    partly: {
      live: 'We hebben hier een aanpassing voor gemaakt, en die staat nu live.',
      liveEnd: 'Wil je het proberen en laten weten hoe het gaat?',
      coming: 'We hebben hier een aanpassing voor gemaakt.',
      comingEnd:
        'Die komt naar je toe met de volgende update van {product}, en we laten het je hier weten zodra die er is.',
      nowLive: 'De aanpassing staat nu live. Wil je het proberen en laten weten hoe het gaat?',
    },
    unknown: {
      live: 'We hebben hier een aanpassing voor gemaakt, en die staat nu live.',
      liveEnd: 'Wil je het nog eens proberen en laten weten of het werkt?',
      coming: 'We hebben hier een aanpassing voor gemaakt.',
      comingEnd:
        'Die komt naar je toe met de volgende update van {product}, en we laten het je hier weten zodra die er is.',
      nowLive: 'De aanpassing staat nu live. Wil je het nog eens proberen en laten weten of het werkt?',
    },
  },
};

/**
 * The live notice of a fix to what reaches customers' computers with a release of its own: it is ready for their
 * computers now, then how to get it right away (the tracker's own words), then the question.
 */
const READY_NOTICES: Record<
  TrackerNoticeLanguage,
  Record<'fixed' | 'partly' | 'unknown' | 'feature', { live: string; nowLive: string; end: string }>
> = {
  en: {
    fixed: {
      live: 'Good news: we’ve fixed this, and the fix is ready for your computers now.',
      nowLive: 'The fix is ready for your computers now.',
      end: 'Could you try again once they have it and let us know whether it works?',
    },
    partly: {
      live: 'We’ve made a change for this, and it is ready for your computers now.',
      nowLive: 'The change is ready for your computers now.',
      end: 'Could you try it once they have it and let us know how it goes?',
    },
    unknown: {
      live: 'We’ve made a change for this, and it is ready for your computers now.',
      nowLive: 'The change is ready for your computers now.',
      end: 'Could you try again once they have it and let us know whether it works?',
    },
    feature: {
      live: 'Good news: what you asked for is ready for your computers now.',
      nowLive: 'What you asked for is ready for your computers now.',
      end: 'Could you give it a try once they have it and let us know what you think?',
    },
  },
  nl: {
    fixed: {
      live: 'Goed nieuws: we hebben dit opgelost en de oplossing staat nu klaar voor je computers.',
      nowLive: 'De oplossing staat nu klaar voor je computers.',
      end: 'Wil je het nog eens proberen zodra ze die hebben en laten weten of het werkt?',
    },
    partly: {
      live: 'We hebben hier een aanpassing voor gemaakt, en die staat nu klaar voor je computers.',
      nowLive: 'De aanpassing staat nu klaar voor je computers.',
      end: 'Wil je het proberen zodra ze die hebben en laten weten hoe het gaat?',
    },
    unknown: {
      live: 'We hebben hier een aanpassing voor gemaakt, en die staat nu klaar voor je computers.',
      nowLive: 'De aanpassing staat nu klaar voor je computers.',
      end: 'Wil je het nog eens proberen zodra ze die hebben en laten weten of het werkt?',
    },
    feature: {
      live: 'Goed nieuws: wat je vroeg staat nu klaar voor je computers.',
      nowLive: 'Wat je vroeg staat nu klaar voor je computers.',
      end: 'Wil je het eens proberen zodra ze het hebben en laten weten wat je ervan vindt?',
    },
  },
};

const MONTHS: Record<TrackerNoticeLanguage, readonly string[]> = {
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  nl: [
    'januari',
    'februari',
    'maart',
    'april',
    'mei',
    'juni',
    'juli',
    'augustus',
    'september',
    'oktober',
    'november',
    'december',
  ],
};

/**
 * What the customer is told when their fix goes live somewhere (TA-30), unsigned, in their language: a development
 * report once the fix is live on development, and a production report twice — “fixed, it comes with the next update”
 * when it is live on development (`awaiting_release`), and “live now” once production runs it (`available`). An
 * `available` notice comes with the release record's evidence, which the reporter also sees (“Live on dev.tracker.example
 * since 10 October 2026.”).
 */
export function trackerFixNotice(input: {
  report: TrackerEnvironment;
  live: TrackerEnvironment;
  kind: 'bug' | 'feature';
  language: string | null | undefined;
  host: string;
  at: Date;
  /** What the fix did for the customer, as its developer said it (`fixOutcomeOf`, TA-55); null: the plain words. */
  outcome?: FixOutcome | null;
  /** The tracker's product name, as the customer knows it (`TrackerWords.product`). */
  product: string;
  /**
   * The fix changes what reaches the customer's computers with a release of its own, and the tracker offers it now:
   * its live notice says it is ready for their computers, with `how` — the tracker's words for getting it right away,
   * in the customer's language — before the question. Absent: the plain live words.
   */
  separate?: { how: string | null } | null;
}): { text: string; status: 'available' | 'awaiting_release'; evidence: string | null } {
  const notice = trackerFixNoticeIn(input);
  return { ...notice, text: withProduct(notice.text, input.product) };
}

/** `{product}` in a notice's words, filled in. */
function withProduct(text: string, product: string): string {
  return text.replaceAll('{product}', product.trim() || UNKNOWN_TRACKER_WORDS.product);
}

function trackerFixNoticeIn(input: {
  report: TrackerEnvironment;
  live: TrackerEnvironment;
  kind: 'bug' | 'feature';
  language: string | null | undefined;
  host: string;
  at: Date;
  outcome?: FixOutcome | null;
  separate?: { how: string | null } | null;
}): { text: string; status: 'available' | 'awaiting_release'; evidence: string | null } {
  const language = noticeLanguage(input.language);
  const words = NOTICES[language][input.kind];
  const outcome = input.outcome ?? null;
  // With the fix's own words (TA-55): what changed for them in the first notice, and a partial fix never says “fixed”.
  // “Live now” after “comes with the next update” only says it arrived.
  // “Fixed” only when the fix said so (TA-55); without its word, a change is live. A feature built in part is a change.
  const told =
    input.kind === 'bug'
      ? OUTCOME_NOTICES[language][outcome ? (outcome.partly ? 'partly' : 'fixed') : 'unknown']
      : outcome?.partly
        ? OUTCOME_NOTICES[language].partly
        : null;
  // A feature that is built carries what it does too, after its first sentence.
  const featureWords = (text: string) => {
    if (!outcome?.note) return text;
    const at = text.indexOf('. ');
    return at < 0
      ? `${text} ${outcome.note}`
      : `${text.slice(0, at + 1)} ${outcome.note}${text.slice(at + 1)}`;
  };
  const withNote = (open: string, close: string) =>
    [open, outcome?.note ?? '', close].filter(Boolean).join(' ');
  if (input.report === 'production' && input.live === 'development')
    return {
      text: told ? withNote(told.coming, told.comingEnd) : featureWords(words.coming),
      status: 'awaiting_release',
      evidence: null,
    };
  const day = `${input.at.getUTCDate()} ${MONTHS[language][input.at.getUTCMonth()]} ${input.at.getUTCFullYear()}`;
  const evidence =
    language === 'nl' ? `Live op ${input.host} sinds ${day}.` : `Live on ${input.host} since ${day}.`;
  if (input.separate) {
    // A feature built in part is a change; a bug fix says “fixed” only with the fix's own word, as above.
    const ready =
      READY_NOTICES[language][
        outcome?.partly ? 'partly' : input.kind === 'feature' ? 'feature' : outcome ? 'fixed' : 'unknown'
      ];
    const how = input.separate.how?.trim() ?? '';
    // A production report heard what the fix does with “it comes with the next update”: this one says only it is there.
    const parts =
      input.report === 'production'
        ? [ready.nowLive, how, ready.end]
        : [ready.live, outcome?.note ?? '', how, ready.end];
    return { text: parts.filter(Boolean).join(' '), status: 'available', evidence };
  }
  return {
    text:
      input.report === 'production'
        ? (told?.nowLive ?? words.nowLive)
        : told
          ? withNote(told.live, told.liveEnd)
          : featureWords(words.live),
    status: 'available',
    evidence,
  };
}

const AGENT_NOTICES: Record<
  TrackerNoticeLanguage,
  { fixed: string; partly: string; feature: string; end: string }
> = {
  en: {
    fixed: 'Good news: we’ve fixed this.',
    partly: 'We’ve made a change for this.',
    feature: 'Good news: we’ve built what you asked for.',
    end: 'It reaches your computers with a coming update of the {product} software on them.',
  },
  nl: {
    fixed: 'Goed nieuws: we hebben dit opgelost.',
    partly: 'We hebben hier een aanpassing voor gemaakt.',
    feature: 'Goed nieuws: we hebben gebouwd wat je vroeg.',
    end: 'Het komt op je computers met een volgende update van de {product}-software daarop.',
  },
};

/**
 * What the customer is told when a fix to the device agent is merged (TA-59): it reaches computers with the agent's own
 * release, which Whombat doesn't follow, so they hear once that it's fixed and comes with a coming update
 * (`awaiting_release`), with the fix's own words (TA-55).
 */
export function trackerAgentFixNotice(input: {
  kind: 'bug' | 'feature';
  language: string | null | undefined;
  outcome?: FixOutcome | null;
  /** The tracker's product name (`TrackerWords.product`). */
  product: string;
}): { text: string; status: 'awaiting_release'; evidence: null } {
  const words = AGENT_NOTICES[noticeLanguage(input.language)];
  const open =
    input.kind === 'feature'
      ? words.feature
      : input.outcome && !input.outcome.partly
        ? words.fixed
        : words.partly;
  return {
    text: withProduct([open, input.outcome?.note ?? '', words.end].filter(Boolean).join(' '), input.product),
    status: 'awaiting_release',
    evidence: null,
  };
}

/**
 * What a fix did for the customer (TA-55), as its developer ends its reply: “For the customer (fixed): …” or “For the
 * customer (partly fixed): …” — one or two sentences in the customer's language. `partly`: part of what they reported
 * is still open, so the notice doesn't say it's fixed.
 */
export interface FixOutcome {
  partly: boolean;
  /** What changes for them and anything they must do; '' when the line said nothing more. */
  note: string;
}

/** The longest note a notice carries; a longer one isn't used (the plain words are). */
export const FIX_OUTCOME_NOTE_MAX = 400;

const OUTCOME_LINE =
  /^[\s>*_]*for the customer[\s*_]*\((fixed|partly fixed|partially fixed)\)[\s*_]*:[\s*_]*(.*)$/i;

/**
 * The outcome line of a fix's reply (TA-55): its last “For the customer (fixed|partly fixed): …” line, null when there
 * is none. The note is checked like any reply to a customer (`customerReplyProblem`): with a problem, or too long,
 * only whether it is partly fixed is kept.
 */
export function fixOutcomeOf(
  reply: string,
  context: { origin?: string | null; organizations?: readonly string[] } = {},
): FixOutcome | null {
  const lines = reply.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = (lines[i] ?? '').match(OUTCOME_LINE);
    if (!m) continue;
    const partly = (m[1] ?? '').toLowerCase() !== 'fixed';
    const note = (m[2] ?? '').replace(/[*_]+$/, '').trim();
    const usable = note.length <= FIX_OUTCOME_NOTE_MAX && !customerReplyProblem(note, context);
    return { partly, note: usable ? note : '' };
  }
  return null;
}

/**
 * A report fix's pull request text without the reporting organization's name (TA-18: it never names the organization;
 * GitHub isn't the tracker): “the customer's organization” in its place, whatever the case, as a whole word only — inside
 * another word (“commit” for “IT”, “DEMO-01” for “Demo”) it isn't the name, though “HollowMere-based” is. The first
 * word of a longer name, when no ordinary word could be it — a capital inside it or a digit (“HollowMere” of
 * “HollowMere College”, not “Device” of “Device Partners”) — is its short form and goes too, whatever the case. A name of
 * three letters or fewer is left to the prompt: as a word it is too often an ordinary one.
 */
export function withoutOrganization(text: string, organization: string | null | undefined): string {
  const name = organization?.trim();
  if (!name || name.length <= 3) return text;
  const word = (w: string) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_]|-\\p{N})`,
      'giu',
    );
  const out = text.replace(word(name), 'the customer’s organization');
  const first = name.split(/\s+/)[0] ?? '';
  const distinctive = first.length >= 5 && /^.\S*(?:\p{Lu}|\p{N})/u.test(first);
  return first !== name && distinctive ? out.replace(word(first), 'the customer’s organization') : out;
}

/** A fix's reply without its outcome line (TA-55): the pull request's description is for the team. */
export function withoutFixOutcome(reply: string): string {
  return reply
    .split('\n')
    .filter((line) => !OUTCOME_LINE.test(line))
    .join('\n')
    .trim();
}
