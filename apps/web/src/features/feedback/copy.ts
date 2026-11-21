/**
 * Whombat Feedback copy for the web app (docs/decisions/feedback.md; not in the mocks): Settings → Feedback and
 * the report details. Outcome and error wording follows the rest of the app (“Couldn’t …”, “Waiting for a person
 * to approve (approval #N).”). Pure.
 */
import {
  AGENT_FALLBACK_NAME,
  ApiError,
  type CommitResult,
  InvalidRequestError,
  NetworkError,
  problemText,
} from '@whombat/client';
import { FEEDBACK_DROP_TEXT, type FeedbackIntegrationHealth } from '@whombat/core/contracts';
import type {
  FeedbackEvidence,
  FeedbackIntegration,
  FeedbackReproduction,
  FeedbackSeverity,
} from '@whombat/core/domain';
import { plural } from '@whombat/core/text';

export const FEEDBACK_TEXT = {
  intro:
    'A form for your website where visitors report bugs and ideas: each one comes to Feedback, where your agent looks into it.',
  integrations: 'INTEGRATIONS',
  newIntegration: 'New integration',
  none: 'No integrations yet. Create one to get the snippet for your website.',
  locked: 'Feedback integrations can’t be set up on this Whombat.',
  loadFailed: 'Couldn’t load feedback integrations. Try again in a moment.',
  open: 'Open',
  /** The integration's chat with the agent (feedback-chat.md AP-1832). */
  openChat: 'Open the chat',
  /** Health's first fact in chat mode: whose chat the reports land in (AP-1832). */
  reportsGoTo: 'Reports go to',
  kicker: 'FEEDBACK INTEGRATION',
  editSettings: 'Edit settings',
  accepting: 'Accepting reports',
  intakeOff: 'Intake off',
  assessmentOn: 'Assessment on',
  assessmentPaused: 'Assessment paused',
  noAgent: 'Not assessed',
  acceptReports: 'Accept reports',
  acceptReportsHint:
    'Off hides the form from your website and refuses new reports. Reports already received keep their state, and queued assessments still run.',
  assessReports: 'Assess new reports',
  assessReportsHint:
    'Paused keeps the form open: new reports are posted and wait until you resume, then they are assessed in turn.',
  assessNoAgent: 'Your agent can’t assess these reports yet. Check its AI in Settings → Agent.',
  install: 'INSTALL',
  installMethod: 'INSTALLATION METHOD',
  floatingMethod: 'Feedback button (default)',
  customMethod: 'Use my own Feedback button',
  installHint:
    'Choose one method. Replace any existing widget script; don’t add a second script or button. Both methods open the same form, with bug and idea choices inside.',
  basicHint: 'Paste this before </body> on every page that should show the Feedback button.',
  customHint:
    'Use this instead of the default snippet. Reuse your existing button by adding data-whombat-feedback; add the example button only if you don’t have one. No floating button is added.',
  copySnippet: 'Copy snippet',
  copyCsp: 'Copy',
  snippetCopied: 'Snippet copied.',
  cspCopied: 'CSP copied.',
  cspHint: 'If your website sends a Content-Security-Policy, allow this Whombat:',
  health: 'HEALTH',
  settings: 'SETTINGS',
  publicAddress: 'Public address',
  noPublicAddress: 'Not set. Set PUBLIC_URL so websites can reach the form.',
  managedUnavailable:
    'Website feedback isn’t available on a managed Whombat yet. Reports from your website need a public address that only a self-hosted Whombat has today.',
  // A managed Whombat's delivery through the encrypted drop (AP-105, Whombat FD-26). The policy sentence is the
  // runtime's own (`FEEDBACK_DROP_TEXT.policy`, the reason of `appliance.status` policy `feedbackIntake`).
  widgetAddress: 'Widget address',
  delivery: 'Delivery',
  deliveryDrop: FEEDBACK_DROP_TEXT.policy,
  published: 'Site published',
  notPublished: 'Not yet',
  lastCollected: 'Last collected',
  notCollected: 'Nothing yet',
  // The integration pages (docs/decisions/ui-improvements.md AP-400…AP-409).
  back: '← Website feedback',
  status: 'STATUS',
  testReport: 'SEND A TEST REPORT',
  checkReports: 'Check for reports',
  testIntakeOff: 'Accept reports is off, so your website doesn’t show the form. Switch it on first.',
  next: 'Next',
  previous: 'Back',
  cancel: 'Cancel',
  create: 'Create integration',
  done: 'Done',
  created: 'Created. Install it on your website, then send a test report.',
  save: 'Save changes',
  discard: 'Discard',
  unsaved: 'Unsaved changes',
  noChanges: 'No unsaved changes',
  leaveConfirm: 'Leave this page? Your changes to this integration aren’t saved.',
  advanced: 'Privacy and limits',
  advancedHint: 'Optional. What reports keep, and how many a site may send. The defaults suit most sites.',
  steps: 'Setup steps',
  // The navigation trail and reporter sign-in (AP-434, CT-161, CT-162).
  pagesVisited: 'PAGES VISITED',
  pagesVisitedOn: 'Send the last 10 pages',
  pagesVisitedOff: 'Don’t send',
  reporterSignIn: 'REPORTER SIGN-IN',
  reporterSignInOn: 'Let visitors sign in to follow their reports',
  reporterSignInOff: 'Off',
  pagesBefore: 'Pages before reporting',
  emailVerified: 'Email verified',
  emailVerifiedLabel: 'Email verified: the visitor signed in with this address',
  notFound: 'This integration no longer exists.',
  loadOneFailed: 'Couldn’t load this integration. Try again in a moment.',
} as const;

/** A trail step's page as the details show it: the path (all steps are on the site), or the URL as sent. */
export function trailPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * How long before sending the visitor got to a page (`at` against the report's `sentAt`, both the visitor's clock):
 * “under a minute before”, “8 min before”, “1 h 5 min before”. Null without `sentAt` or with a time that doesn't
 * parse; a step after sending (a wrong clock) reads as “under a minute before”.
 */
export function trailBefore(at: string, sentAt: string | null): string | null {
  if (!sentAt) return null;
  const ms = Date.parse(sentAt) - Date.parse(at);
  if (Number.isNaN(ms)) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute before';
  if (minutes < 60) return `${minutes} min before`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min before` : `${h} h before`;
}

/**
 * The install snippet as the website needs it: with pages visited off, the loader must not record them
 * (`data-trail="off"`, CT-161). The runtime builds snippets with core's generator, which doesn't know the attribute, so
 * the page adds it before `defer` unless the snippet already has one (AP-435).
 */
export function snippetForTrail(snippet: string, trail: 'on' | 'off'): string {
  if (trail !== 'off' || snippet.includes('data-trail=')) return snippet;
  return snippet.replace(/\n( *)defer\n/, '\n$1data-trail="off"\n$1defer\n');
}

/**
 * One installation method, using the runtime's basic script without changing its address, key or privacy
 * attributes. Older runtimes' complete custom examples contain a second, bug-specific button; don't display
 * or copy those. The app supplies one neutral example control instead.
 */
export function snippetForLauncher(snippet: string, launcher: 'floating' | 'custom'): string {
  const floating = snippet.replace(/\n *data-launcher="custom"/, '');
  if (launcher === 'floating') return floating;
  const custom = floating.replace(/\n( *)defer\n/, '\n$1data-launcher="custom"\n$1defer\n');
  return `${custom}\n\n<!-- Reuse your existing button; add this only if you don't have one. -->\n<button type="button" data-whombat-feedback>Feedback</button>`;
}

/** `Step 2 of 4`. */
export function stepCounter(n: number, of: number): string {
  return `Step ${n} of ${of}`;
}

/** `Last changed 29 Sep by Jamie · revision 4`: the edit page's save bar when nothing is unsaved. */
export function lastChangedLine(date: string, by: string | null, revision: number): string {
  return `Last changed ${date}${by ? ` by ${by}` : ''} · revision ${revision}`;
}

/** How to send a test report: the real widget on the website, with its own button or the floating one. */
export function testReportText(
  i: Pick<FeedbackIntegration, 'launcher' | 'launcherLabel'>,
  /** Where it lands: “Feedback”, or “your chat with Dusty” (AP-1832). */
  where: string,
): string {
  const open =
    i.launcher === 'floating'
      ? `choose “${i.launcherLabel}” and send a report`
      : 'open the form with your own button and send a report';
  return `Open your website with the snippet in place, ${open}. It becomes a thread in ${where}, and Health counts it.`;
}

/**
 * Whether a managed Whombat takes website reports through the encrypted drop (AP-105): its health has a `delivery`
 * (a runtime before contracts 0.13 sends none, which reads as null) and no `drop_unsupported` warning (its manager or
 * Whombat's cloud can't carry the drop, Whombat FD-25/FD-38). Otherwise the INSTALL section keeps AP-102's notice.
 */
export function dropAvailable(health: Pick<FeedbackIntegrationHealth, 'delivery' | 'warnings'>): boolean {
  return health.delivery != null && !health.warnings.some((w) => w.code === 'drop_unsupported');
}

/** Health warnings about the public address and the widget build, which a managed Whombat has neither of (AP-102). */
export const SELF_HOSTED_WARNINGS: ReadonlySet<string> = new Set([
  'public_url_missing',
  'public_url_not_https',
  'widget_not_built',
]);

export function intakeLabel(i: Pick<FeedbackIntegration, 'intake'>): string {
  return i.intake === 'enabled' ? FEEDBACK_TEXT.accepting : FEEDBACK_TEXT.intakeOff;
}

/** `assesses`: whether the agent can assess reports now (`assessorProblem`, one-agent.md AP-4935). */
export function assessmentLabel(
  i: Pick<FeedbackIntegration, 'assessment'>,
  words: Pick<FeedbackWords, 'noAgent'> = feedbackWords(AGENT_FALLBACK_NAME),
  assesses = true,
): string {
  if (!assesses) return words.noAgent;
  return i.assessment === 'active' ? FEEDBACK_TEXT.assessmentOn : FEEDBACK_TEXT.assessmentPaused;
}

/** `No reports in the last 24 h`, `1 report in the last 24 h`. */
export function reportsLine(n: number): string {
  return n === 0 ? 'No reports in the last 24 h' : `${plural(n, 'report')} in the last 24 h`;
}

export function warningsLine(n: number): string {
  return plural(n, 'warning');
}

export const REPRODUCTION_LABELS: Record<FeedbackReproduction, string> = {
  not_attempted: 'Not attempted',
  attempted_not_reproduced: 'Tried, not reproduced',
  reproduced: 'Reproduced',
  unknown: 'Unknown',
};

export const SEVERITY_LABELS: Record<FeedbackSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
  unknown: 'Unknown',
};

export const EVIDENCE_KIND_LABELS: Record<FeedbackEvidence['kind'], string> = {
  file: 'File',
  test: 'Test',
  doc: 'Doc',
  observation: 'Observation',
  report: 'Report',
};

export const CONFIDENCE_LABELS = { low: 'Low', medium: 'Medium', high: 'High' } as const;

export const ATTEMPT_STATE_LABELS = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
} as const;

/**
 * What a write that did not simply succeed tells the person: waiting on an approval, blocked (the server's
 * words), or null when it went through.
 */
export function outcomeText(result: CommitResult<unknown>): string | null {
  if (result.status === 'ok') return null;
  if (result.status === 'pending_approval')
    return `Waiting for a person to approve (approval #${result.approvalNumber}).`;
  return result.message;
}

/** A feedback write's body: the commit outcome itself (`commitOutcome` in the contract). */
export type FeedbackOutcome<T> =
  | ({ status: 'ok' } & T)
  | { status: 'pending_approval'; approvalNumber: number; message: string }
  | { status: 'blocked'; message: string };

export type Settled<T> = { ok: true; data: T } | { ok: false; pending: boolean; text: string };

/**
 * Unwraps a feedback write: the keys engine may answer on the HTTP level (202 / 403, `CommitResult`) or the
 * command in its body (`{status: 'pending_approval' | 'blocked'}`); either way the person reads one sentence.
 */
export function settle<T extends object>(result: CommitResult<FeedbackOutcome<T>>): Settled<T> {
  if (result.status !== 'ok')
    return {
      ok: false,
      pending: result.status === 'pending_approval',
      text: outcomeText(result) ?? '',
    };
  const body = result.data;
  if (body.status === 'ok') return { ok: true, data: body };
  if (body.status === 'pending_approval')
    return {
      ok: false,
      pending: true,
      text: body.message || `Waiting for a person to approve (approval #${body.approvalNumber}).`,
    };
  return { ok: false, pending: false, text: body.message };
}

export interface ErrorWords {
  /** 501: the server has this endpoint registered but not built yet. */
  notAvailable?: string;
  /** 404: the thing is gone, or the viewer may not see it. */
  notFound?: string;
}

/** A refused or failed write in plain words. The server's own message when it gave one. */
export function errorText(err: unknown, words: ErrorWords = {}): string {
  if (err instanceof ApiError) {
    if (err.status === 501 || err.code === 'not_implemented')
      return words.notAvailable ?? 'This Whombat can’t do that yet.';
    if (err.status === 404 && words.notFound) return words.notFound;
    return problemText(err, 'Something went wrong. Nothing changed.');
  }
  if (err instanceof InvalidRequestError) return 'Check the highlighted fields.';
  if (err instanceof NetworkError) return 'Couldn’t reach Whombat. Nothing changed, try again.';
  return err instanceof Error && err.message ? err.message : 'Something went wrong. Nothing changed.';
}

/**
 * Website feedback's words, the agent by its name (less-is-more.md AP-1804; one-agent.md AP-4935): it assesses every
 * report and builds the fix once you say yes (Whombat one-agent.md OA-16). Reports come to your Feedback room (chat-channel.md
 * AP-2410). Pure.
 */
export interface FeedbackWords {
  intro: string;
  assessor: string;
  /** Under ASSESSED BY. */
  assessorHint: string;
  repoHint: string;
  reposFailed: string;
  contextHint: string;
  handoff: string;
  developer: string;
  developerHint: string;
  noAgent: string;
  assessNoAgent: string;
  noteLabel: string;
  noteHint: string;
  /** Where reports go (feedback-chat.md AP-1827). */
  chat: FeedbackChatWords;
}

/** The words of where reports go (AP-1828). */
export interface FeedbackChatWords {
  label: string;
  /** “Feedback”, or “Your chat with Dusty”. */
  yours: string;
  /** The same inside a sentence. */
  inSentence: string;
  hint: string;
  /** The link to it. */
  open: string;
}

/** Every site's reports come to Feedback (Whombat chat-channel.md CHT-03; app chat-channel.md AP-2410). */
const CHAT_WORDS: FeedbackChatWords = {
  label: 'REPORTS GO TO',
  yours: 'Feedback',
  inSentence: 'Feedback',
  hint: 'Each report becomes a thread there.',
  open: 'Open Feedback',
};

export function feedbackWords(agent: string): FeedbackWords {
  const a = agent;
  const A = a.charAt(0).toUpperCase() + a.slice(1);
  return {
    intro: `A form for your website where visitors report bugs and ideas: each one comes to Feedback, where ${a} looks into it.`,
    assessor: 'ASSESSED BY',
    assessorHint: `${A} reads each report and changes nothing.`,
    repoHint: `Optional. A repository switched on in Settings → Connections → GitHub; ${a} gets a read-only copy.`,
    reposFailed: `Couldn’t load the repositories. ${A} can still assess without code.`,
    contextHint: `What the product is and where to look in the code. ${A} gets it with every report; visitors never see it.`,
    handoff: 'DEVELOPMENT',
    developer: 'BUILT BY',
    developerHint: `When development is asked for on an assessed report and you say yes, ${a} builds the fix in the thread.`,
    noAgent: 'Not assessed',
    assessNoAgent: `${A} can’t assess these reports yet. Check its AI in Settings → Agent.`,
    noteLabel: `Note for ${a} (optional)`,
    noteHint: `You say yes first. Then ${a} is asked in this thread.`,
    chat: CHAT_WORDS,
  };
}
