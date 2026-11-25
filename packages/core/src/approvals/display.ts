/**
 * The approval display state machine the mocks use, for every surface: approval card, approval modal,
 * branch pane STAGING summary, plan gate step, audit log pill/DECIDED row, mobile inbox row and mobile
 * approval screen. Copy is verbatim from the mocks for deploys and follows the same pattern for other
 * action types.
 *
 * Phases:
 *   needs_person  pending                               NEEDS A PERSON                  (warn, warn border)
 *   waiting       approved, other conditions unmet      APPROVED · WAITING FOR CHECKS   (warn)
 *   executing     approved, all met, not yet executed   APPROVED · DEPLOYING            (ok)
 *   executed      action ran                            DEPLOYED                        (ok)
 *   failed        action failed                         DEPLOY FAILED                   (bad)
 *   declined      declined                              DECLINED                        (bad)
 */

import { COMMAND_SCOPES, type CommandScope } from '../commands/commands.js';
import { COMMAND_DECLINE_CTA, commandScopeLabels, isToolCategory } from '../commands/copy.js';
import type { Approval, ApprovalAction, ApprovalActionType, ApprovalCondition } from '../domain/approval.js';
import type { Tone } from '../domain/common.js';
import { TEAM_REPORT_DRAFT_ACTION, teamReportDraftWords } from '../domain/team-reports.js';
import { alwaysAllowRow } from '../keys/actions.js';
import { KEY_CATALOG } from '../keys/catalog.js';
import { alwaysAllowLabel, keyRiskRow } from '../keys/grants.js';
import { requestedTier } from '../keys/requests.js';
import { shortSha, stepNumber } from '../text/format.js';
import {
  type DateInput,
  daysAgo,
  formatAgo,
  formatClock,
  formatDate,
  formatDuration,
  formatRecent,
  formatShortWeekday,
  toDate,
  zonedParts,
} from '../text/time.js';
import { conditionMet, otherConditions, otherConditionsMet, unmetOtherConditions } from './conditions.js';
import { approvalCopy } from './copy.js';
import { canDecide, type Decider, undoBlock } from './transitions.js';

export type ApprovalPhase = 'needs_person' | 'waiting' | 'executing' | 'executed' | 'failed' | 'declined';

export function approvalPhase(approval: Approval): ApprovalPhase {
  if (approval.state === 'pending') return 'needs_person';
  if (approval.state === 'declined') return 'declined';
  if (approval.executedAt !== null || approval.execution.state === 'succeeded') return 'executed';
  if (approval.execution.state === 'failed') return 'failed';
  if (approval.execution.state === 'running') return 'executing';
  return otherConditionsMet(approval) ? 'executing' : 'waiting';
}

interface Verbs {
  /** deploy */
  base: string;
  /** deploys */
  third: string;
  /** deploying */
  ing: string;
  /** deployed */
  past: string;
  /** Object of "won’t {base} …": "this commit". */
  declinedObject: string;
}

const VERBS: Record<ApprovalActionType, Verbs> = {
  deploy: {
    base: 'deploy',
    third: 'deploys',
    ing: 'deploying',
    past: 'deployed',
    declinedObject: 'this commit',
  },
  refund: {
    base: 'refund',
    third: 'refunds',
    ing: 'refunding',
    past: 'refunded',
    declinedObject: 'this payment',
  },
  push_shared_branch: {
    base: 'push',
    third: 'pushes',
    ing: 'pushing',
    past: 'pushed',
    declinedObject: 'this commit',
  },
  merge_pr: {
    base: 'merge',
    third: 'merges',
    ing: 'merging',
    past: 'merged',
    declinedObject: 'this pull request',
  },
  message_external: {
    base: 'send the message',
    third: 'sends the message',
    ing: 'sending the message',
    past: 'sent',
    declinedObject: '',
  },
  custom: { base: 'go ahead', third: 'goes ahead', ing: 'going ahead', past: 'done', declinedObject: '' },
  mail_send: {
    base: 'send the email',
    third: 'sends the email',
    ing: 'sending the email',
    past: 'sent',
    declinedObject: '',
  },
  calendar_invite: {
    base: 'send the invite',
    third: 'sends the invite',
    ing: 'sending the invite',
    past: 'sent',
    declinedObject: '',
  },
  files_share: {
    base: 'share the file',
    third: 'shares the file',
    ing: 'sharing the file',
    past: 'shared',
    declinedObject: '',
  },
  files_trash: {
    base: 'move the file to the trash',
    third: 'moves the file to the trash',
    ing: 'moving the file to the trash',
    past: 'moved to the trash',
    declinedObject: '',
  },
  grant_key: {
    base: 'give the key',
    third: 'gives the key',
    ing: 'giving the key',
    past: 'given',
    declinedObject: '',
  },
  run_command: {
    base: 'run the command',
    third: 'runs the command',
    ing: 'running the command',
    past: 'ran',
    declinedObject: '',
  },
  connection_call: {
    base: 'do it',
    third: 'does it',
    ing: 'doing it',
    past: 'done',
    declinedObject: '',
  },
};

/**
 * The longest key-request label the mobile approval footer's primary button holds on a 360dp-wide screen: about
 * 192dp of 16px semibold Bricolage (~8.3dp a character) once a key request widens it. A longer one says only the
 * key: “Give “Browse the web”” (key-requests.md KR-05).
 */
export const MOBILE_CTA_MAX_CHARS = 22;

export function actionVerbs(action: ApprovalAction): Verbs {
  return VERBS[action.type];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

export interface NameInfo {
  /** Full name ("Mara Okafor"). */
  name: string;
  /** Short name ("Mara"). */
  shortName: string;
}

export interface ApprovalViewContext {
  /** Name lookup for principals referenced by the approval. */
  names: (principalId: string) => NameInfo | undefined;
  /** The person looking at it (for "you or Joris", "Needs you", Approve buttons). */
  viewer?: Decider;
  now: DateInput;
  timeZone: string;
  /** Where the request was made, for the mobile context line ("#billing-v2"). */
  where?: string;
}

export interface ConditionView {
  id: string;
  kind: ApprovalCondition['kind'];
  met: boolean;
  /** Desktop label ("Checks pass on the latest commit"). */
  label: string;
  /** Mobile label ("Checks pass on 7be20f"). */
  mobileLabel: string;
  /** Desktop note ("38 of 41 · fixing", "approved 11:38", "you or Joris", "Mara · just now"). */
  note: string;
  /** Mobile note (uses "you" for the viewer's own decision). */
  mobileNote: string;
  /** ✓ when met. */
  mark: '✓' | '';
}

export interface ApprovalView {
  phase: ApprovalPhase;
  /** Card title, written from the action ("Deploy feat/invoice-pdf to staging"). */
  title: string;
  /** Modal / mobile question, written from the action ("Deploy feat/invoice-pdf to staging?"). */
  question: string;
  /** Card header target, written from the action ("staging · billing-api"). */
  target: string;
  /**
   * "What actually runs: …" when the approval's stored wording disagrees with its action (a request stored
   * with its requester's own copy); null when the copy on screen already says what runs.
   */
  actionNote: string | null;
  /** Card / modal label. */
  label: string;
  tone: Tone;
  /** Mobile approval screen label (same machine; "APPROVED · DEPLOYING" once checks are green). */
  mobileLabel: string;
  /** 1.5px warn border while pending. */
  pendingBorder: boolean;
  /** "NEO IS ASKING" */
  kicker: string;
  /** Desktop primary button while pending: "Approve in advance" / "Approve and deploy". */
  cta: string;
  /** Mobile primary button. */
  mobileCta: string;
  /** The decline button: “Decline”, or “Don’t allow” for a command (AC-42). */
  declineCta: string;
  /**
   * A `run_command`'s allow buttons, in order (agent-computer.md AC-42): “Allow once”, “Allow for this task”, “Always
   * allow for Banjo”, each sending `approvals.decide` with its `scope`. Since 0.44 (Whombat resourceful-agents.md RA-06) a
   * risk-row card's (`alwaysAllowRow`):
   * `once` with the card's `cta` (“Approve and deploy”, “Approve in advance”; mobile shows `mobileCta` for it), then
   * `agent`, “Always allow Banjo to merge into main” (approves and sets the row to On). Since 0.86 (Whombat server-asks.md SA-07) a Servers call with
   * `params.server`, to the person: `once`, then `agent`, “Don’t ask again on The Titan” (approves and sets the server to
   * Never ask). Null for every other action (one Approve button, `cta`).
   */
  scopeChoices: { scope: CommandScope; label: string }[] | null;
  /** Explanation under the conditions on the card. */
  message: string;
  /** Explanation on the mobile approval screen. */
  mobileMessage: string;
  /** Branch pane STAGING line. */
  short: string;
  /** Mobile inbox status line after deciding ("Approved · deploying"); null while pending. */
  inboxDone: string | null;
  /** Mobile context line: "Neo · #billing-v2 · 11:25". */
  mobileContext: string;
  conditions: ConditionView[];
  whatHappens: { n: string; text: string }[];
  /**
   * What the action sends or runs, in full, for the approver to read: the body of an email (`MESSAGE`, IN-16), the
   * exact command of a `run_command` (`COMMAND`, AC-41), the words of the assistant's draft report to the Whombat Team
   * (`REPORT`); null otherwise.
   */
  content: { label: string; text: string } | null;
  /**
   * What the agent says a `run_command` is for (the `# why:` line it started the command with), under the title; null
   * when it said nothing, for a web or browser tool call (whose reason is what it looks at) and every other action.
   */
  why: string | null;
  /**
   * How the card asks for an everyday action (Whombat handle-it.md; a server's or connection's call, a message, an
   * invite, a file, a `custom` ask): “Neo needs your OK”, *Yes, do it*, *Tonight* (approve now, run at 03:00), *No*,
   * with what the tool is and what it sends under *Technical details*. Null for code (deploys, merges, pushes, a
   * refund), a command's allow choices and a key, which keep `label` and `cta`; null once decided.
   */
  ask: ApprovalAskWords | null;
  /**
   * The lasting yes an everyday ask offers apart from its answers, behind a confirmation (“Don’t ask again for
   * pve-02…”, “Always allow Neo to send messages outside…”): `approvals.decide {scope: 'agent'}`. Null when it offers none.
   */
  lasting: ApprovalLastingWords | null;
  /** Viewer may approve / decline / undo right now. */
  canApprove: boolean;
  canDecline: boolean;
  canUndo: boolean;
  /** Audit log pill for the Asks event. */
  logPill: { text: string; tone: Tone };
  /** Audit log DECIDED row for the Asks event. */
  logDecided: { text: string; tone: Tone };
  /** Plan gate step. */
  planStep: { state: 'gate' | 'done' | 'blocked'; label: string };
  /**
   * Toasts after the viewer decides; `always` after “Always allow” on a risk-row card (RA-06): “Approved. From now on
   * Banjo may merge into main without asking.” — absent where the card doesn't offer it.
   */
  toasts: { approve: string; decline: string; always?: string };
}

/**
 * The everyday ask's words on the card (`ApprovalView.ask`). The answers keep one order everywhere (the thread's card,
 * the Inbox row, the approval's details): *Yes, now* · *Yes, tonight* · *No* where a later time is offered, *Yes, do it* ·
 * *No* where it isn't.
 */
export interface ApprovalAskWords {
  /** “Neo needs your OK” */
  needs: string;
  /** The yes where no later time is offered. */
  yes: string;
  /** The yes beside *Yes, tonight*. */
  now: string;
  later: string;
  no: string;
  details: string;
}

/** The lasting yes on an everyday ask, and the confirmation that guards it (`ApprovalView.lasting`). */
export interface ApprovalLastingWords {
  /** The text button under the answers: “Don’t ask again for pve-02…”. */
  link: string;
  /** “Let Neo do this on pve-02 without asking?” */
  title: string;
  body: string;
  /** “Let Neo do it” */
  confirm: string;
  /** “Keep asking” */
  keep: string;
}

/** The actions a person who isn't a developer is asked about in plain words (`ApprovalView.ask`). */
export const EVERYDAY_ASKS: readonly ApprovalActionType[] = [
  'connection_call',
  'custom',
  'mail_send',
  'calendar_invite',
  'files_share',
  'files_trash',
  'message_external',
];

export const APPROVAL_ASK_WORDS = {
  needs: '{name} needs your OK',
  yes: 'Yes, do it',
  now: 'Yes, now',
  later: 'Yes, tonight',
  no: 'No',
  details: 'Technical details',
} as const;

/** Whether an approval is an everyday ask in plain words (a server's or connection's call, a message, a file…). */
export function isEverydayAsk(approval: Pick<Approval, 'action'>): boolean {
  return EVERYDAY_ASKS.includes(approval.action.type);
}

/** What the lasting yes means, before where it changes back. */
const LASTING_NEXT = 'Next time it does it and tells you after.';
const LASTING_BODY = `${LASTING_NEXT} You can change this in Settings.`;

/**
 * The lasting yes's confirmation naming the real place it changes back where that isn't Settings (“on pve-02’s page in
 * Overview”, “on the web”): `where` follows “You can change it back”.
 */
export function lastingWordsAt(words: ApprovalLastingWords, where: string): ApprovalLastingWords {
  return { ...words, body: `${LASTING_NEXT} You can change it back ${where}.` };
}

/** The lasting yes on a Servers call that may stop asking (server-asks.md SA-07), behind its confirmation. */
export function stopAskingConfirm(agent: string, server: string): ApprovalLastingWords {
  return {
    link: `Don’t ask again for ${server}…`,
    title: `Let ${agent} do this on ${server} without asking?`,
    body: LASTING_BODY,
    confirm: `Let ${agent} do it`,
    keep: 'Keep asking',
  };
}

/** The lasting yes on a risk row's action (“Always allow Neo to send messages outside”), behind its confirmation. */
export function alwaysAllowConfirm(agent: string, verb: string, label: string): ApprovalLastingWords {
  return {
    link: `${label}…`,
    title: `Let ${agent} ${verb} without asking?`,
    body: LASTING_BODY,
    confirm: `Let ${agent} do it`,
    keep: 'Keep asking',
  };
}

/** Where an answered everyday ask is: to come at its time, running, done, failed, approved (waiting to start), no. */
export type ApprovalAnswerState = 'scheduled' | 'running' | 'done' | 'failed' | 'approved' | 'declined';

export interface ApprovalAnswer {
  state: ApprovalAnswerState;
  /** “Scheduled for tonight, 03:00”, “Running”, “Done · 09:46”, “It didn’t work”, “You said no · 09:46”. */
  text: string;
  tone: 'ok' | 'mut' | 'bad';
}

/** “09:46” today, “Tue” this week, else the date: when an answer happened, after its state. */
function answeredWhen(at: string, ctx: Pick<ApprovalViewContext, 'now' | 'timeZone'>): string {
  const days = daysAgo(at, ctx.now, ctx.timeZone);
  if (days <= 0) return formatClock(at, ctx.timeZone);
  if (days < 7) return formatShortWeekday(at, ctx.timeZone);
  return formatDate(at, ctx.timeZone, { now: ctx.now });
}

/** “Scheduled for tonight, 03:00”, “Scheduled for tomorrow, 09:00”, “Scheduled for Fri, 09:00”. */
function scheduledText(at: string, ctx: Pick<ApprovalViewContext, 'now' | 'timeZone'>): string {
  const ahead = -daysAgo(at, ctx.now, ctx.timeZone);
  const { hour } = zonedParts(at, ctx.timeZone);
  const clock = formatClock(at, ctx.timeZone);
  // The small hours after midnight still count as tonight, as the quiet hours for changes do.
  const tonight = (ahead === 0 && (hour >= 18 || hour < 6)) || (ahead === 1 && hour < 6);
  const day = tonight
    ? 'tonight'
    : ahead <= 0
      ? 'today'
      : ahead === 1
        ? 'tomorrow'
        : ahead < 7
          ? formatShortWeekday(at, ctx.timeZone)
          : formatDate(at, ctx.timeZone, { now: ctx.now });
  return `Scheduled for ${day}, ${clock}`;
}

/**
 * What an answered ask says under its title, from what the approval carries: “Scheduled for tonight, 03:00” (a yes for
 * later, its real time), “Running”, “Done · 09:46”, “It didn’t work”, “You said no · 09:46” (someone else's no: “Mara
 * said no”). Null while it waits.
 */
export function approvalAnswer(
  approval: Pick<Approval, 'state' | 'executeAt' | 'execution' | 'executedAt' | 'decidedAt' | 'decidedById'>,
  ctx: Pick<ApprovalViewContext, 'now' | 'timeZone' | 'viewer' | 'names'>,
): ApprovalAnswer | null {
  if (approval.state === 'pending') return null;
  const at = (iso: string | null | undefined) => (iso ? ` · ${answeredWhen(iso, ctx)}` : '');
  if (approval.state === 'declined') {
    const mine = !approval.decidedById || approval.decidedById === ctx.viewer?.id;
    const who = mine ? 'You' : nameOf(ctx, approval.decidedById).shortName;
    return { state: 'declined', text: `${who} said no${at(approval.decidedAt)}`, tone: 'mut' };
  }
  const run = approval.execution.state;
  if (run === 'running') return { state: 'running', text: 'Running', tone: 'ok' };
  if (run === 'succeeded' || (run === 'idle' && approval.executedAt))
    return {
      state: 'done',
      text: `Done${at(approval.executedAt ?? approval.execution.finishedAt)}`,
      tone: 'ok',
    };
  if (run === 'failed') return { state: 'failed', text: 'It didn’t work', tone: 'bad' };
  const executeAt = approval.executeAt ?? null;
  if (executeAt && toDate(executeAt).getTime() > toDate(ctx.now).getTime())
    return { state: 'scheduled', text: scheduledText(executeAt, ctx), tone: 'ok' };
  return { state: 'approved', text: 'Approved', tone: 'ok' };
}

function nameOf(ctx: ApprovalViewContext, id: string | null | undefined): NameInfo {
  if (!id) return { name: 'Someone', shortName: 'Someone' };
  return ctx.names(id) ?? { name: 'Someone', shortName: 'Someone' };
}

/** When a decision happened, in DECIDED rows: "just now" / "at 17:20" / "on 3 Mar at 17:20". */
function decidedWhen(at: string, ctx: ApprovalViewContext): string {
  const seconds = (toDate(ctx.now).getTime() - toDate(at).getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return 'just now';
  const clock = formatClock(at, ctx.timeZone);
  if (daysAgo(at, ctx.now, ctx.timeZone) <= 1) return `at ${clock}`;
  return `on ${formatDate(at, ctx.timeZone, { now: ctx.now })} at ${clock}`;
}

function checksNote(c: Extract<ApprovalCondition, { kind: 'checks_pass' }>): string {
  if (c.total === 0) {
    return { pending: 'waiting', running: 'running', passed: 'passed', failed: 'failed' }[c.state];
  }
  const base = `${c.passed} of ${c.total}`;
  return c.fixing && c.state !== 'passed' ? `${base} · fixing` : base;
}

function conditionView(cond: ApprovalCondition, approval: Approval, ctx: ApprovalViewContext): ConditionView {
  const met = conditionMet(cond, approval.state);
  let note = '';
  let mobileNote = '';
  let mobileLabel = cond.label;
  switch (cond.kind) {
    case 'checks_pass':
      note = checksNote(cond);
      mobileNote = note;
      if (cond.headSha) mobileLabel = `Checks pass on ${shortSha(cond.headSha)}`;
      break;
    case 'review_approved': {
      const n = {
        approved: cond.reviewedAt
          ? `approved ${formatRecent(cond.reviewedAt, ctx.now, ctx.timeZone)}`
          : 'approved',
        changes_requested: 'changes requested',
        pending: 'waiting',
        commented: 'commented',
      }[cond.reviewState];
      note = n;
      mobileNote = n;
      break;
    }
    case 'person_approves': {
      if (approval.state === 'approved') {
        const when = approval.decidedAt
          ? formatRecent(approval.decidedAt, ctx.now, ctx.timeZone)
          : 'just now';
        note = `${nameOf(ctx, approval.decidedById).shortName} · ${when}`;
        mobileNote = `${ctx.viewer?.id === approval.decidedById ? 'you' : nameOf(ctx, approval.decidedById).shortName} · ${when}`;
      } else if (approval.state === 'declined') {
        note = 'declined';
        mobileNote = 'declined';
      } else {
        const viewerId = ctx.viewer?.id;
        const ordered = [
          ...cond.approverIds.filter((id) => id === viewerId),
          ...cond.approverIds.filter((id) => id !== viewerId),
        ];
        note = joinOr(ordered.map((id) => (id === viewerId ? 'you' : nameOf(ctx, id).shortName)));
        // The phone's condition says what it waits on, so “You say yes · you” doesn't read as a riddle.
        mobileNote = `Waiting for ${note}`;
      }
      break;
    }
  }
  return {
    id: cond.id,
    kind: cond.kind,
    met,
    label: cond.label,
    mobileLabel,
    note,
    mobileNote,
    mark: met ? '✓' : '',
  };
}

/** "checks are green" / "Waffle signs off" — what an approved request is still waiting for. */
function waitingPhrases(approval: Approval, ctx: ApprovalViewContext): { long: string[]; short: string[] } {
  const long: string[] = [];
  const short: string[] = [];
  for (const c of unmetOtherConditions(approval)) {
    if (c.kind === 'checks_pass') {
      long.push('checks are green');
      short.push('checks');
    } else if (c.kind === 'review_approved') {
      const reviewer = nameOf(ctx, c.reviewerId).shortName;
      long.push(`${reviewer} signs off`);
      short.push(reviewer);
    }
  }
  return { long, short };
}

function metPhrases(approval: Approval, ctx: ApprovalViewContext): string[] {
  const out: string[] = [];
  for (const c of otherConditions(approval)) {
    if (!conditionMet(c, approval.state)) continue;
    if (c.kind === 'checks_pass') out.push('checks are green');
    else if (c.kind === 'review_approved') out.push(`${nameOf(ctx, c.reviewerId).shortName} approved`);
  }
  return out;
}

function environmentOf(action: ApprovalAction): string | null {
  return action.type === 'deploy' ? action.params.environment : null;
}

/**
 * What the agent says a `run_command` is for, first letter capital; null when it said nothing, for a web or browser
 * tool call (its reason is what it looks at) and every other action.
 */
function commandWhyOf(action: ApprovalAction): string | null {
  if (action.type !== 'run_command' || isToolCategory(action.params.category)) return null;
  const why = action.params.reason?.trim();
  return why ? cap(why) : null;
}

/** Builds every piece of approval copy for one viewer at one moment. */
export function approvalView(approval: Approval, ctx: ApprovalViewContext): ApprovalView {
  const phase = approvalPhase(approval);
  const v = actionVerbs(approval.action);
  const R = nameOf(ctx, approval.requesterId).shortName;
  const D = nameOf(ctx, approval.decidedById);
  const env = environmentOf(approval.action);
  const others = otherConditions(approval);
  const waiting = waitingPhrases(approval, ctx);
  const involved = approval.involvedIds.map((id) => nameOf(ctx, id).shortName);
  // A key request (key-requests.md): the requester doesn't act, a person gives it the key.
  const grant =
    approval.action.type === 'grant_key'
      ? {
          label: `“${KEY_CATALOG[approval.action.params.keyId].label}”`,
          asks: requestedTier(approval.action.params.keyId) === 'ask',
        }
      : null;
  // A command of the agent's (agent-computer.md AC-41, AC-42): allowed once, for the task, or always.
  const command = approval.action.type === 'run_command' ? approval.action.params : null;
  // A Servers call that asks only for its sensitive rules (server-asks.md SA-07): Approve, or stop asking on that
  // server. The person only, as for the server's own setting.
  const askServer =
    approval.action.type === 'connection_call' ? (approval.action.params.server ?? null) : null;
  const offersStopAsking = askServer !== null && ctx.viewer?.kind === 'person';
  const stopAskingSentence =
    askServer && approval.scope === 'agent'
      ? ` From now on Whombat acts on ${askServer.name} without asking.`
      : '';
  // A typed action under a risk row (RA-06): Approve, or always allow the agent the row.
  const riskRow = alwaysAllowRow(approval.action);
  const offersAlways = riskRow !== null;
  const alwaysSentence =
    riskRow && approval.scope === 'agent'
      ? ` From now on ${R} may ${keyRiskRow(riskRow).verb} without asking.`
      : stopAskingSentence;
  const scopeLabels = command ? commandScopeLabels(R) : null;
  const why = commandWhyOf(approval.action);
  // The assistant's draft report to the Whombat Team: exactly what would be sent, wherever the card can be answered.
  const reportWords =
    approval.action.type === 'custom' && approval.action.params.name === TEAM_REPORT_DRAFT_ACTION
      ? teamReportDraftWords(approval.action.params.data)
      : null;
  const allowedSentence = command
    ? approval.scope === 'task'
      ? 'Allowed for this task.'
      : approval.scope === 'agent'
        ? `Always allowed for ${R}.`
        : 'Allowed once.'
    : '';
  const toldSentence =
    involved.length === 0 ? '' : ` ${joinAnd(involved)} ${involved.length === 1 ? 'has' : 'have'} been told.`;
  const declinedSentence = grant
    ? `${R} won’t get ${grant.label}.`
    : `${R} won’t ${v.base}${v.declinedObject ? ` ${v.declinedObject}` : ''}.`;
  const hasUnmetChecks = unmetOtherConditions(approval).some((c) => c.kind === 'checks_pass');
  const hasUnmetReview = unmetOtherConditions(approval).some((c) => c.kind === 'review_approved');
  const allOthersMet = otherConditionsMet(approval);

  // Label and tone
  const waitingFor = hasUnmetChecks ? 'CHECKS' : hasUnmetReview ? 'REVIEW' : 'CONDITIONS';
  const labels: Record<ApprovalPhase, [string, Tone]> = {
    needs_person: ['NEEDS A PERSON', 'warn'],
    waiting: [`APPROVED · WAITING FOR ${waitingFor}`, 'warn'],
    executing: [`APPROVED · ${v.ing.toUpperCase()}`, 'ok'],
    executed: [v.past.toUpperCase(), 'ok'],
    failed: [`${v.base.toUpperCase()} FAILED`, 'bad'],
    declined: ['DECLINED', 'bad'],
  };
  const [label, tone] = labels[phase];

  // Card message
  const n = others.length;
  const needsMessage = grant
    ? `${R} can’t get a key without a person.${grant.asks ? ' Once given, it still asks a person each time it uses it.' : ''}`
    : n === 0
      ? `${R} won’t ${v.base} without a person.`
      : `${R} won’t ${v.base} without a person. Approve now and it goes out once the first ${numberWord(n)} ${n === 1 ? 'is' : 'are'} green.`;
  const durationText =
    approval.execution.durationMs !== null ? formatDuration(approval.execution.durationMs) : undefined;
  const executingMessage = grant
    ? `Giving ${R} ${grant.label} now.`
    : command
      ? `${allowedSentence} ${R} runs the command in its turn.`
      : approval.action.type === 'deploy'
        ? `${R} is rolling ${approval.action.params.service} to ${approval.action.params.environment}. You’ll get a note here when it’s live, usually in about two minutes.${alwaysSentence}`
        : `${R} is ${v.ing} now. You’ll get a note here when it’s done.${alwaysSentence}`;
  const executedMessage = grant
    ? grant.asks
      ? `Given. ${R} holds ${grant.label} and asks a person each time it uses it.`
      : `Given. ${R} can use ${grant.label} from its next turn.`
    : command
      ? `${allowedSentence} ${R} ran the command.`
      : approval.action.type === 'deploy'
        ? `Deployed to ${approval.action.params.environment}${durationText ? ` in ${durationText}` : ''}.${
            approval.execution.resultUrl ? ` Try it: ${stripProtocol(approval.execution.resultUrl)}` : ''
          }${alwaysSentence}`
        : `${cap(v.past)}${durationText ? ` in ${durationText}` : ''}.${
            approval.execution.resultUrl ? ` See ${stripProtocol(approval.execution.resultUrl)}` : ''
          }${alwaysSentence}`;
  const failedMessage = `${cap(v.base)}${env ? ` to ${env}` : ''} failed.${approval.execution.error ? ` ${approval.execution.error}` : ''}`;
  const messages: Record<ApprovalPhase, string> = {
    needs_person: needsMessage,
    waiting: `Approved. ${R} ${v.third} as soon as ${joinAnd(waiting.long)}.`,
    executing: executingMessage,
    executed: executedMessage,
    failed: failedMessage,
    declined: `Declined. ${declinedSentence}${toldSentence}`,
  };
  const mobileMessages: Record<ApprovalPhase, string> = {
    ...messages,
    needs_person: approval.summary || needsMessage,
    declined: `${declinedSentence}${toldSentence}`,
  };

  // Branch pane STAGING summary. "2m 14s ago" within the hour (as in the mock), "3 hours ago" after.
  let executedAgo = '';
  if (approval.executedAt) {
    const ms = Math.max(0, toDate(ctx.now).getTime() - toDate(approval.executedAt).getTime());
    executedAgo =
      ms < 3_600_000
        ? ` ${formatDuration(ms)} ago`
        : ` ${formatAgo(approval.executedAt, ctx.now, ctx.timeZone)}`;
  }
  const shorts: Record<ApprovalPhase, string> = {
    needs_person: env
      ? `${R} is waiting for a person to approve the ${env} deploy.`
      : `${R} is waiting for a person to approve.`,
    waiting: `${D.shortName} approved. Waiting for ${joinAnd(waiting.short)}.`,
    executing: env
      ? `${D.shortName} approved. ${R} is deploying to ${env}.`
      : grant
        ? `${D.shortName} approved. Giving ${R} ${grant.label}.`
        : `${D.shortName} approved. ${R} is ${v.ing}.`,
    executed: env
      ? `Deployed to ${env}${executedAgo}. ${D.shortName} approved.`
      : `${cap(v.past)}${executedAgo}. ${D.shortName} approved.`,
    failed: failedMessage,
    declined: `Declined by ${D.shortName}.`,
  };

  const inboxDone: Record<ApprovalPhase, string | null> = {
    needs_person: null,
    waiting: `Approved · waiting for ${joinAnd(waiting.short)}`,
    executing: `Approved · ${v.ing}`,
    executed: cap(v.past),
    failed: `${cap(v.base)} failed`,
    declined: 'Declined',
  };

  // Log pill and DECIDED row
  const logPill: ApprovalView['logPill'] =
    approval.state === 'pending'
      ? { text: 'WAITING ON A PERSON', tone: 'warn' }
      : approval.state === 'approved'
        ? { text: `APPROVED BY ${D.shortName.toUpperCase()}`, tone: 'ok' }
        : { text: `DECLINED BY ${D.shortName.toUpperCase()}`, tone: 'bad' };
  const logDecided: ApprovalView['logDecided'] =
    approval.state === 'pending'
      ? {
          text:
            approval.action.type === 'deploy'
              ? `Nobody yet. ${R} is holding the deploy.`
              : `Nobody yet. ${R} is waiting.`,
          tone: 'warn',
        }
      : {
          text: `${D.name} ${approval.state} ${approval.decidedAt ? decidedWhen(approval.decidedAt, ctx) : 'just now'}`,
          tone: 'neutral',
        };

  // Plan gate step
  const viewerIsApprover = !!ctx.viewer && canDecide(approval, ctx.viewer) === null;
  const planLabels: Record<ApprovalPhase, string> = {
    needs_person: viewerIsApprover ? 'Needs you' : 'Needs a person',
    waiting: 'Approved',
    executing: 'Approved',
    executed: cap(v.past),
    failed: 'Failed',
    declined: 'Declined',
  };

  const pending = approval.state === 'pending';
  const viewerCanDecide = !!ctx.viewer && canDecide(approval, ctx.viewer) === null;
  const undoable = !command && !!ctx.viewer && undoBlock(approval) === null && ctx.viewer.kind === 'person';

  const approveToast = grant
    ? `Approved. Giving ${R} ${grant.label}.`
    : command
      ? `${allowedSentence} ${R} runs the command now.`
      : allOthersMet
        ? env
          ? `Approved. ${R} is deploying to ${env}.`
          : `Approved. ${R} is ${v.ing}.`
        : `Approved in advance. ${R} will ${v.base} when ${waitingPhrases(approval, ctx).long[0] ?? 'everything is ready'}.`;

  const copy = approvalCopy(approval, ctx.names);

  const created = approval.createdAt;
  const mobileContext = [R, ctx.where, formatClock(created, ctx.timeZone)].filter(Boolean).join(' · ');

  return {
    phase,
    title: copy.title,
    question: copy.question,
    target: copy.target,
    actionNote: copy.matchesStored ? null : `What actually runs: ${copy.runs}.`,
    label,
    tone,
    mobileLabel: label,
    pendingBorder: pending,
    kicker: `${R.toUpperCase()} IS ASKING`,
    cta: grant
      ? copy.title
      : scopeLabels
        ? scopeLabels.once
        : allOthersMet
          ? `Approve and ${v.base}`
          : 'Approve in advance',
    mobileCta: grant
      ? copy.title.length <= MOBILE_CTA_MAX_CHARS
        ? copy.title
        : `Give ${grant.label}`
      : scopeLabels
        ? scopeLabels.once
        : 'Approve',
    declineCta: command ? COMMAND_DECLINE_CTA : 'Decline',
    scopeChoices: scopeLabels
      ? COMMAND_SCOPES.map((scope) => ({ scope, label: scopeLabels[scope] }))
      : offersAlways && riskRow
        ? [
            { scope: 'once', label: allOthersMet ? `Approve and ${v.base}` : 'Approve in advance' },
            { scope: 'agent', label: alwaysAllowLabel(R, riskRow) },
          ]
        : offersStopAsking && askServer
          ? [
              { scope: 'once', label: allOthersMet ? `Approve and ${v.base}` : 'Approve in advance' },
              { scope: 'agent', label: stopAskingLabel(askServer.name) },
            ]
          : null,
    message: messages[phase],
    mobileMessage: mobileMessages[phase],
    short: shorts[phase],
    inboxDone: inboxDone[phase],
    mobileContext,
    conditions: approval.conditions.map((c) => conditionView(c, approval, ctx)),
    whatHappens: [
      ...approval.whatHappens,
      ...(approval.action.type === 'mail_send'
        ? (approval.action.params.attachments ?? []).map(
            (a) => `Attach “${a.name}” (${a.size.toLocaleString('en-US')} bytes)`,
          )
        : []),
    ].map((text, i) => ({
      n: stepNumber(i),
      text,
    })),
    content:
      approval.action.type === 'mail_send'
        ? { label: 'MESSAGE', text: approval.action.params.body ?? approval.action.params.bodyPreview }
        : command
          ? { label: 'COMMAND', text: command.command }
          : reportWords
            ? { label: 'REPORT', text: reportWords }
            : null,
    why,
    ask:
      pending && EVERYDAY_ASKS.includes(approval.action.type)
        ? { ...APPROVAL_ASK_WORDS, needs: APPROVAL_ASK_WORDS.needs.replace('{name}', R) }
        : null,
    lasting:
      pending && EVERYDAY_ASKS.includes(approval.action.type)
        ? offersAlways && riskRow
          ? alwaysAllowConfirm(R, keyRiskRow(riskRow).verb, alwaysAllowLabel(R, riskRow))
          : offersStopAsking && askServer
            ? stopAskingConfirm(R, askServer.name)
            : null
        : null,
    canApprove: pending && viewerCanDecide,
    canDecline: pending && viewerCanDecide,
    canUndo: undoable,
    logPill,
    logDecided,
    planStep: {
      state: phase === 'executed' ? 'done' : phase === 'declined' || phase === 'failed' ? 'blocked' : 'gate',
      label: planLabels[phase],
    },
    toasts: {
      approve: approveToast,
      decline: `Declined. ${declinedSentence}`,
      ...(offersAlways && riskRow
        ? { always: `Approved. From now on ${R} may ${keyRiskRow(riskRow).verb} without asking.` }
        : offersStopAsking && askServer
          ? { always: stopAskingToast(askServer.name) }
          : {}),
    },
  };
}

/** Inbox row text for a needs-you approval: "Deploy feat/invoice-pdf to staging. Checks are green and Waffle approved." */
export function approvalInboxText(approval: Approval, ctx: Pick<ApprovalViewContext, 'names'>): string {
  const full = { ...ctx, now: approval.createdAt, timeZone: 'UTC' };
  const met = metPhrases(approval, full);
  const waiting = waitingPhrases(approval, full).long;
  const title = approvalCopy(approval, ctx.names).title;
  // A command's why, which the person decides by: “Run a destructive command on staging. Clear the stale cache.”
  const why = commandWhyOf(approval.action);
  if (why) return `${title}. ${why}${/[.!?…]$/.test(why) ? '' : '.'}`;
  if (waiting.length === 0) {
    return met.length ? `${title}. ${cap(joinAnd(met))}.` : `${title}.`;
  }
  return `${title}. Goes out once ${joinAnd(waiting)}.`;
}

/** The card's second button on a Servers call that may stop asking (server-asks.md SA-07). */
export function stopAskingLabel(server: string): string {
  return `Don’t ask again on ${server}`;
}

/** The toast after “Don’t ask again on {server}” (SA-07). */
export function stopAskingToast(server: string): string {
  return `Approved. Whombat won’t ask again on ${server}.`;
}
