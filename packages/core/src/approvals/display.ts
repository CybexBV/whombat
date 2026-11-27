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
import { commandDeclineCta, commandScopeLabels, isToolCategory } from '../commands/copy.js';
import type { Approval, ApprovalAction, ApprovalActionType, ApprovalCondition } from '../domain/approval.js';
import type { Tone } from '../domain/common.js';
import { TEAM_REPORT_DRAFT_ACTION, teamReportDraftWords } from '../domain/team-reports.js';
import { type CoreTranslator, coreTranslator } from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import { alwaysAllowRow } from '../keys/actions.js';
import { joinWithAnd, keyLabel } from '../keys/catalog.js';
import { alwaysAllowLabel, type KeyTierRow, keyRiskRow } from '../keys/grants.js';
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
import {
  conditionMet,
  defaultConditionLabel,
  otherConditions,
  otherConditionsMet,
  unmetOtherConditions,
} from './conditions.js';
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

/**
 * An action's own words for the card's sentences, in a locale: `not` is what follows “won’t” (Dutch “gaat … niet
 * uitrollen” carries its own “niet”), `declined` the same with its object (“deploy this commit”).
 */
interface ActionWords {
  base: string;
  third: string;
  ing: string;
  past: string;
  not: string;
  declined: string;
}

function actionWords(type: ApprovalActionType, tr: CoreTranslator): ActionWords {
  return {
    base: tr.t(`approval.verb.${type}.base`),
    third: tr.t(`approval.verb.${type}.third`),
    ing: tr.t(`approval.verb.${type}.ing`),
    past: tr.t(`approval.verb.${type}.past`),
    not: tr.t(`approval.verb.${type}.not`),
    declined: tr.t(`approval.verb.${type}.declined`),
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const numberWord = (tr: CoreTranslator, n: number) =>
  n >= 0 && n <= 10 ? tr.t(`approval.number.${n}` as 'approval.number.0') : String(n);

function joinOr(tr: CoreTranslator, items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return tr.t('approval.or', { items: items.slice(0, -1).join(', '), last: items[items.length - 1] ?? '' });
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
  /** The reader's language (English when absent). */
  locale?: string | null;
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

/** `APPROVAL_ASK_WORDS` in a locale. */
export function approvalAskWords(locale?: string | null): { [K in keyof typeof APPROVAL_ASK_WORDS]: string } {
  const tr = coreTranslator(locale);
  return {
    needs: tr.raw('approval.ask.needs'),
    yes: tr.t('approval.ask.yes'),
    now: tr.t('approval.ask.now'),
    later: tr.t('approval.ask.later'),
    no: tr.t('approval.ask.no'),
    details: tr.t('approval.ask.details'),
  };
}

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
export function lastingWordsAt(
  words: ApprovalLastingWords,
  where: string,
  locale?: string | null,
): ApprovalLastingWords {
  const tr = coreTranslator(locale);
  return { ...words, body: tr.t('approval.lasting.at', { next: tr.t('approval.lasting.next'), where }) };
}

function lastingBody(tr: CoreTranslator): string {
  return tr.t('approval.lasting.body', { next: tr.t('approval.lasting.next') });
}

/** The lasting yes on a Servers call that may stop asking (server-asks.md SA-07), behind its confirmation. */
export function stopAskingConfirm(
  agent: string,
  server: string,
  locale?: string | null,
): ApprovalLastingWords {
  const tr = coreTranslator(locale);
  return {
    link: tr.t('approval.lasting.stopLink', { server }),
    title: tr.t('approval.lasting.stopTitle', { agent, server }),
    body: lastingBody(tr),
    confirm: tr.t('approval.lasting.confirm', { agent }),
    keep: tr.t('approval.lasting.keep'),
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

/** `alwaysAllowConfirm` for a risk row, in a locale. */
export function alwaysAllowConfirmFor(
  agent: string,
  row: KeyTierRow,
  locale?: string | null,
): ApprovalLastingWords {
  const tr = coreTranslator(locale);
  return {
    link: `${alwaysAllowLabel(agent, row, locale)}…`,
    title: tr.t(`key.risk.${row}.letTitle`, { agent }),
    body: lastingBody(tr),
    confirm: tr.t('approval.lasting.confirm', { agent }),
    keep: tr.t('approval.lasting.keep'),
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
function answeredWhen(at: string, ctx: Pick<ApprovalViewContext, 'now' | 'timeZone' | 'locale'>): string {
  const days = daysAgo(at, ctx.now, ctx.timeZone);
  if (days <= 0) return formatClock(at, ctx.timeZone);
  if (days < 7) return formatShortWeekday(at, ctx.timeZone, ctx.locale);
  return formatDate(at, ctx.timeZone, { now: ctx.now }, ctx.locale);
}

/** “Scheduled for tonight, 03:00”, “Scheduled for tomorrow, 09:00”, “Scheduled for Fri, 09:00”. */
function scheduledText(at: string, ctx: Pick<ApprovalViewContext, 'now' | 'timeZone' | 'locale'>): string {
  const tr = coreTranslator(ctx.locale);
  const ahead = -daysAgo(at, ctx.now, ctx.timeZone);
  const { hour } = zonedParts(at, ctx.timeZone);
  const clock = formatClock(at, ctx.timeZone);
  // The small hours after midnight still count as tonight, as the quiet hours for changes do.
  const tonight = (ahead === 0 && (hour >= 18 || hour < 6)) || (ahead === 1 && hour < 6);
  const day = tonight
    ? tr.t('approval.answer.tonight')
    : ahead <= 0
      ? tr.t('approval.answer.today')
      : ahead === 1
        ? tr.t('approval.answer.tomorrow')
        : ahead < 7
          ? formatShortWeekday(at, ctx.timeZone, ctx.locale)
          : formatDate(at, ctx.timeZone, { now: ctx.now }, ctx.locale);
  return tr.t('approval.answer.scheduled', { day, clock });
}

/**
 * What an answered ask says under its title, from what the approval carries: “Scheduled for tonight, 03:00” (a yes for
 * later, its real time), “Running”, “Done · 09:46”, “It didn’t work”, “You said no · 09:46” (someone else's no: “Mara
 * said no”). Null while it waits.
 */
export function approvalAnswer(
  approval: Pick<Approval, 'state' | 'executeAt' | 'execution' | 'executedAt' | 'decidedAt' | 'decidedById'>,
  ctx: Pick<ApprovalViewContext, 'now' | 'timeZone' | 'viewer' | 'names' | 'locale'>,
): ApprovalAnswer | null {
  if (approval.state === 'pending') return null;
  const tr = coreTranslator(ctx.locale);
  const at = (iso: string | null | undefined) => (iso ? ` · ${answeredWhen(iso, ctx)}` : '');
  if (approval.state === 'declined') {
    const mine = !approval.decidedById || approval.decidedById === ctx.viewer?.id;
    const who = mine ? tr.t('approval.answer.you') : nameOf(ctx, approval.decidedById).shortName;
    return {
      state: 'declined',
      text: tr.t('approval.answer.saidNo', { who, at: at(approval.decidedAt) }),
      tone: 'mut',
    };
  }
  const run = approval.execution.state;
  if (run === 'running') return { state: 'running', text: tr.t('approval.answer.running'), tone: 'ok' };
  if (run === 'succeeded' || (run === 'idle' && approval.executedAt))
    return {
      state: 'done',
      text: tr.t('approval.answer.done', { at: at(approval.executedAt ?? approval.execution.finishedAt) }),
      tone: 'ok',
    };
  if (run === 'failed') return { state: 'failed', text: tr.t('approval.answer.failed'), tone: 'bad' };
  const executeAt = approval.executeAt ?? null;
  if (executeAt && toDate(executeAt).getTime() > toDate(ctx.now).getTime())
    return { state: 'scheduled', text: scheduledText(executeAt, ctx), tone: 'ok' };
  return { state: 'approved', text: tr.t('approval.answer.approved'), tone: 'ok' };
}

function nameOf(ctx: Pick<ApprovalViewContext, 'names' | 'locale'>, id: string | null | undefined): NameInfo {
  const someone = () => {
    const name = coreTranslator(ctx.locale).t('approval.someone');
    return { name, shortName: name };
  };
  if (!id) return someone();
  return ctx.names(id) ?? someone();
}

/** When a decision happened, in DECIDED rows: "just now" / "at 17:20" / "on 3 Mar at 17:20". */
function decidedWhen(at: string, ctx: ApprovalViewContext): string {
  const tr = coreTranslator(ctx.locale);
  const seconds = (toDate(ctx.now).getTime() - toDate(at).getTime()) / 1000;
  if (seconds >= 0 && seconds < 60) return tr.t('approval.when.justNow');
  const clock = formatClock(at, ctx.timeZone);
  if (daysAgo(at, ctx.now, ctx.timeZone) <= 1) return tr.t('approval.when.at', { clock });
  return tr.t('approval.when.on', {
    date: formatDate(at, ctx.timeZone, { now: ctx.now }, ctx.locale),
    clock,
  });
}

function checksNote(c: Extract<ApprovalCondition, { kind: 'checks_pass' }>, tr: CoreTranslator): string {
  if (c.total === 0) {
    const state = { pending: 'waiting', running: 'running', passed: 'passed', failed: 'failed' } as const;
    return tr.t(`approval.checks.${state[c.state]}`);
  }
  const base = tr.t('approval.checks.of', { passed: c.passed, total: c.total });
  return c.fixing && c.state !== 'passed' ? tr.t('approval.checks.fixing', { base }) : base;
}

/** A condition's label: the stored one, or the reader's words for one of the labels the server writes by default. */
function conditionLabel(cond: ApprovalCondition, tr: CoreTranslator): string {
  if (tr.language === 'en') return cond.label;
  if (cond.kind === 'checks_pass' && cond.label === defaultConditionLabel({ kind: 'checks_pass' }))
    return tr.t('approval.condition.checks_pass');
  if (cond.kind === 'person_approves' && cond.label === defaultConditionLabel({ kind: 'person_approves' }))
    return tr.t('approval.condition.person_approves');
  const review = / approves the PR$/;
  if (cond.kind === 'review_approved' && review.test(cond.label))
    return tr.t('approval.condition.review_approved', { name: cond.label.replace(review, '') });
  return cond.label;
}

function conditionView(cond: ApprovalCondition, approval: Approval, ctx: ApprovalViewContext): ConditionView {
  const tr = coreTranslator(ctx.locale);
  const met = conditionMet(cond, approval.state);
  const label = conditionLabel(cond, tr);
  let note = '';
  let mobileNote = '';
  let mobileLabel = label;
  switch (cond.kind) {
    case 'checks_pass':
      note = checksNote(cond, tr);
      mobileNote = note;
      if (cond.headSha) mobileLabel = tr.t('approval.checks.on', { sha: shortSha(cond.headSha) });
      break;
    case 'review_approved': {
      const n =
        cond.reviewState === 'approved' && cond.reviewedAt
          ? tr.t('approval.review.approvedAt', {
              when: formatRecent(cond.reviewedAt, ctx.now, ctx.timeZone, ctx.locale),
            })
          : tr.t(`approval.review.${cond.reviewState}`);
      note = n;
      mobileNote = n;
      break;
    }
    case 'person_approves': {
      if (approval.state === 'approved') {
        const when = approval.decidedAt
          ? formatRecent(approval.decidedAt, ctx.now, ctx.timeZone, ctx.locale)
          : tr.t('approval.when.justNow');
        note = `${nameOf(ctx, approval.decidedById).shortName} · ${when}`;
        mobileNote = `${ctx.viewer?.id === approval.decidedById ? tr.t('approval.you') : nameOf(ctx, approval.decidedById).shortName} · ${when}`;
      } else if (approval.state === 'declined') {
        note = tr.t('approval.person.declined');
        mobileNote = note;
      } else {
        const viewerId = ctx.viewer?.id;
        const ordered = [
          ...cond.approverIds.filter((id) => id === viewerId),
          ...cond.approverIds.filter((id) => id !== viewerId),
        ];
        note = joinOr(
          tr,
          ordered.map((id) => (id === viewerId ? tr.t('approval.you') : nameOf(ctx, id).shortName)),
        );
        // The phone's condition says what it waits on, so “You say yes · you” doesn't read as a riddle.
        mobileNote = tr.t('approval.person.waitingFor', { names: note });
      }
      break;
    }
  }
  return {
    id: cond.id,
    kind: cond.kind,
    met,
    label,
    mobileLabel,
    note,
    mobileNote,
    mark: met ? '✓' : '',
  };
}

/** "checks are green" / "Waffle signs off" — what an approved request is still waiting for. */
function waitingPhrases(approval: Approval, ctx: ApprovalViewContext): { long: string[]; short: string[] } {
  const tr = coreTranslator(ctx.locale);
  const long: string[] = [];
  const short: string[] = [];
  for (const c of unmetOtherConditions(approval)) {
    if (c.kind === 'checks_pass') {
      long.push(tr.t('approval.phrase.checksGreen'));
      short.push(tr.t('approval.phrase.checks'));
    } else if (c.kind === 'review_approved') {
      const reviewer = nameOf(ctx, c.reviewerId).shortName;
      long.push(tr.t('approval.phrase.signsOff', { name: reviewer }));
      short.push(reviewer);
    }
  }
  return { long, short };
}

function metPhrases(approval: Approval, ctx: ApprovalViewContext): string[] {
  const tr = coreTranslator(ctx.locale);
  const out: string[] = [];
  for (const c of otherConditions(approval)) {
    if (!conditionMet(c, approval.state)) continue;
    if (c.kind === 'checks_pass') out.push(tr.t('approval.phrase.checksGreen'));
    else if (c.kind === 'review_approved')
      out.push(tr.t('approval.phrase.approved', { name: nameOf(ctx, c.reviewerId).shortName }));
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

/** Builds every piece of approval copy for one viewer at one moment, in the viewer's language (`ctx.locale`). */
export function approvalView(approval: Approval, ctx: ApprovalViewContext): ApprovalView {
  const tr = coreTranslator(ctx.locale);
  const locale = ctx.locale;
  const phase = approvalPhase(approval);
  const v = actionWords(approval.action.type, tr);
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
          label: `“${keyLabel(approval.action.params.keyId, locale)}”`,
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
      ? tr.t('approval.stopAskingSentence', { server: askServer.name })
      : '';
  // A typed action under a risk row (RA-06): Approve, or always allow the agent the row.
  const riskRow = alwaysAllowRow(approval.action);
  const offersAlways = riskRow !== null;
  const mayNow = (row: KeyTierRow) => ` ${tr.t(`key.risk.${row}.mayNow`, { agent: R })}`;
  const alwaysSentence = riskRow && approval.scope === 'agent' ? mayNow(riskRow) : stopAskingSentence;
  const scopeLabels = command ? commandScopeLabels(R, locale) : null;
  const why = commandWhyOf(approval.action);
  // The assistant's draft report to the Whombat Team: exactly what would be sent, wherever the card can be answered.
  const reportWords =
    approval.action.type === 'custom' && approval.action.params.name === TEAM_REPORT_DRAFT_ACTION
      ? teamReportDraftWords(approval.action.params.data)
      : null;
  const allowedSentence = command
    ? approval.scope === 'task'
      ? tr.t('approval.allowed.task')
      : approval.scope === 'agent'
        ? tr.t('approval.allowed.agent', { agent: R })
        : tr.t('approval.allowed.once')
    : '';
  const toldSentence =
    involved.length === 0
      ? ''
      : tr.tp('approval.told', involved.length, { names: joinWithAnd(involved, locale) });
  const declinedSentence = grant
    ? tr.t('approval.declined.grant', { agent: R, label: grant.label })
    : tr.t('approval.declined.action', { agent: R, what: v.declined });
  const hasUnmetChecks = unmetOtherConditions(approval).some((c) => c.kind === 'checks_pass');
  const hasUnmetReview = unmetOtherConditions(approval).some((c) => c.kind === 'review_approved');
  const allOthersMet = otherConditionsMet(approval);
  const upper = (text: string) => text.toLocaleUpperCase(tr.locale);

  // Label and tone
  const waitingFor = tr.t(
    hasUnmetChecks
      ? 'approval.waitingFor.checks'
      : hasUnmetReview
        ? 'approval.waitingFor.review'
        : 'approval.waitingFor.conditions',
  );
  const labels: Record<ApprovalPhase, [string, Tone]> = {
    needs_person: [tr.t('approval.label.needs'), 'warn'],
    waiting: [tr.t('approval.label.waiting', { what: waitingFor }), 'warn'],
    executing: [tr.t('approval.label.executing', { ing: upper(v.ing) }), 'ok'],
    executed: [upper(v.past), 'ok'],
    failed: [tr.t('approval.label.failed', { base: upper(v.base) }), 'bad'],
    declined: [tr.t('approval.label.declined'), 'bad'],
  };
  const [label, tone] = labels[phase];

  // Card message
  const n = others.length;
  const needsMessage = grant
    ? `${tr.t('approval.needs.grant', { agent: R })}${grant.asks ? tr.t('approval.needs.grantAsks') : ''}`
    : n === 0
      ? tr.t('approval.needs.action', { agent: R, what: v.not })
      : tr.tp('approval.needs.actionAfter', n, { agent: R, what: v.not, countWord: numberWord(tr, n) });
  const durationText =
    approval.execution.durationMs !== null
      ? formatDuration(approval.execution.durationMs, locale)
      : undefined;
  const duration = durationText ? tr.t('approval.in', { duration: durationText }) : '';
  const resultUrl = approval.execution.resultUrl ? stripProtocol(approval.execution.resultUrl) : null;
  const executingMessage = grant
    ? tr.t('approval.executing.grant', { agent: R, label: grant.label })
    : command
      ? tr.t('approval.executing.command', { allowed: allowedSentence, agent: R })
      : approval.action.type === 'deploy'
        ? tr.t('approval.executing.deploy', {
            agent: R,
            service: approval.action.params.service,
            env: approval.action.params.environment,
            always: alwaysSentence,
          })
        : tr.t('approval.executing.action', { agent: R, ing: v.ing, always: alwaysSentence });
  const executedMessage = grant
    ? grant.asks
      ? tr.t('approval.executed.grantAsks', { agent: R, label: grant.label })
      : tr.t('approval.executed.grant', { agent: R, label: grant.label })
    : command
      ? tr.t('approval.executed.command', { allowed: allowedSentence, agent: R })
      : approval.action.type === 'deploy'
        ? tr.t('approval.executed.deploy', {
            env: approval.action.params.environment,
            duration,
            link: resultUrl ? tr.t('approval.tryIt', { url: resultUrl }) : '',
            always: alwaysSentence,
          })
        : tr.t('approval.executed.action', {
            past: cap(v.past),
            duration,
            link: resultUrl ? tr.t('approval.see', { url: resultUrl }) : '',
            always: alwaysSentence,
          });
  const failedMessage = tr.t('approval.failed', {
    base: cap(v.base),
    env: env ? tr.t('approval.toEnv', { env }) : '',
    error: approval.execution.error ? ` ${approval.execution.error}` : '',
  });
  const messages: Record<ApprovalPhase, string> = {
    needs_person: needsMessage,
    waiting: tr.t('approval.waiting', { agent: R, third: v.third, list: joinWithAnd(waiting.long, locale) }),
    executing: executingMessage,
    executed: executedMessage,
    failed: failedMessage,
    declined: tr.t('approval.declined', { sentence: declinedSentence, told: toldSentence }),
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
        ? tr.t('approval.ago', { duration: formatDuration(ms, locale) })
        : ` ${formatAgo(approval.executedAt, ctx.now, ctx.timeZone, locale)}`;
  }
  const shorts: Record<ApprovalPhase, string> = {
    needs_person: env
      ? tr.t('approval.short.needsEnv', { agent: R, env })
      : tr.t('approval.short.needs', { agent: R }),
    waiting: tr.t('approval.short.waiting', {
      decider: D.shortName,
      list: joinWithAnd(waiting.short, locale),
    }),
    executing: env
      ? tr.t('approval.short.executingEnv', { decider: D.shortName, agent: R, env })
      : grant
        ? tr.t('approval.short.executingGrant', { decider: D.shortName, agent: R, label: grant.label })
        : tr.t('approval.short.executing', { decider: D.shortName, agent: R, ing: v.ing }),
    executed: env
      ? tr.t('approval.short.executedEnv', { env, ago: executedAgo, decider: D.shortName })
      : tr.t('approval.short.executed', { past: cap(v.past), ago: executedAgo, decider: D.shortName }),
    failed: failedMessage,
    declined: tr.t('approval.short.declined', { decider: D.shortName }),
  };

  const inboxDone: Record<ApprovalPhase, string | null> = {
    needs_person: null,
    waiting: tr.t('approval.inbox.waiting', { list: joinWithAnd(waiting.short, locale) }),
    executing: tr.t('approval.inbox.executing', { ing: v.ing }),
    executed: cap(v.past),
    failed: tr.t('approval.inbox.failed', { base: cap(v.base) }),
    declined: tr.t('approval.inbox.declined'),
  };

  // Log pill and DECIDED row
  const logPill: ApprovalView['logPill'] =
    approval.state === 'pending'
      ? { text: tr.t('approval.pill.waiting'), tone: 'warn' }
      : approval.state === 'approved'
        ? { text: tr.t('approval.pill.approved', { name: upper(D.shortName) }), tone: 'ok' }
        : { text: tr.t('approval.pill.declined', { name: upper(D.shortName) }), tone: 'bad' };
  const logDecided: ApprovalView['logDecided'] =
    approval.state === 'pending'
      ? {
          text:
            approval.action.type === 'deploy'
              ? tr.t('approval.decided.nobodyDeploy', { agent: R })
              : tr.t('approval.decided.nobody', { agent: R }),
          tone: 'warn',
        }
      : {
          text: tr.t(
            approval.state === 'approved' ? 'approval.decided.approved' : 'approval.decided.declined',
            {
              name: D.name,
              when: approval.decidedAt ? decidedWhen(approval.decidedAt, ctx) : tr.t('approval.when.justNow'),
            },
          ),
          tone: 'neutral',
        };

  // Plan gate step
  const viewerIsApprover = !!ctx.viewer && canDecide(approval, ctx.viewer) === null;
  const planLabels: Record<ApprovalPhase, string> = {
    needs_person: viewerIsApprover ? tr.t('approval.plan.needsYou') : tr.t('approval.plan.needs'),
    waiting: tr.t('approval.plan.approved'),
    executing: tr.t('approval.plan.approved'),
    executed: cap(v.past),
    failed: tr.t('approval.plan.failed'),
    declined: tr.t('approval.plan.declined'),
  };

  const pending = approval.state === 'pending';
  const viewerCanDecide = !!ctx.viewer && canDecide(approval, ctx.viewer) === null;
  const undoable = !command && !!ctx.viewer && undoBlock(approval) === null && ctx.viewer.kind === 'person';

  const approveToast = grant
    ? tr.t('approval.toast.grant', { agent: R, label: grant.label })
    : command
      ? tr.t('approval.toast.command', { allowed: allowedSentence, agent: R })
      : allOthersMet
        ? env
          ? tr.t('approval.toast.deploy', { agent: R, env })
          : tr.t('approval.toast.action', { agent: R, ing: v.ing })
        : tr.t('approval.toast.advance', {
            agent: R,
            base: v.base,
            cond: waitingPhrases(approval, ctx).long[0] ?? tr.t('approval.phrase.ready'),
          });

  const copy = approvalCopy(approval, ctx.names, locale);

  const created = approval.createdAt;
  const mobileContext = [R, ctx.where, formatClock(created, ctx.timeZone)].filter(Boolean).join(' · ');
  const approveAnd = allOthersMet
    ? tr.t('approval.cta.approveAnd', { base: v.base })
    : tr.t('approval.cta.advance');
  const askWords = approvalAskWords(locale);

  return {
    phase,
    title: copy.title,
    question: copy.question,
    target: copy.target,
    actionNote: copy.matchesStored ? null : tr.t('approval.actionNote', { runs: copy.runs }),
    label,
    tone,
    mobileLabel: label,
    pendingBorder: pending,
    kicker: tr.t('approval.kicker', { agent: upper(R) }),
    cta: grant ? copy.title : scopeLabels ? scopeLabels.once : approveAnd,
    mobileCta: grant
      ? copy.title.length <= MOBILE_CTA_MAX_CHARS
        ? copy.title
        : tr.t('approval.cta.give', { label: grant.label })
      : scopeLabels
        ? scopeLabels.once
        : tr.t('approval.cta.approve'),
    declineCta: command ? commandDeclineCta(locale) : tr.t('approval.cta.decline'),
    scopeChoices: scopeLabels
      ? COMMAND_SCOPES.map((scope) => ({ scope, label: scopeLabels[scope] }))
      : offersAlways && riskRow
        ? [
            { scope: 'once', label: approveAnd },
            { scope: 'agent', label: alwaysAllowLabel(R, riskRow, locale) },
          ]
        : offersStopAsking && askServer
          ? [
              { scope: 'once', label: approveAnd },
              { scope: 'agent', label: stopAskingLabel(askServer.name, locale) },
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
        ? (approval.action.params.attachments ?? []).map((a) =>
            tr.t('approval.attach', {
              name: a.name,
              size: formatLocaleNumber(a.size, tr.locale),
            }),
          )
        : []),
    ].map((text, i) => ({
      n: stepNumber(i),
      text,
    })),
    content:
      approval.action.type === 'mail_send'
        ? {
            label: tr.t('approval.content.message'),
            text: approval.action.params.body ?? approval.action.params.bodyPreview,
          }
        : command
          ? { label: tr.t('approval.content.command'), text: command.command }
          : reportWords
            ? { label: tr.t('approval.content.report'), text: reportWords }
            : null,
    why,
    ask:
      pending && EVERYDAY_ASKS.includes(approval.action.type)
        ? { ...askWords, needs: tr.t('approval.ask.needs', { name: R }) }
        : null,
    lasting:
      pending && EVERYDAY_ASKS.includes(approval.action.type)
        ? offersAlways && riskRow
          ? tr.language === 'en'
            ? alwaysAllowConfirm(R, keyRiskRow(riskRow).verb, alwaysAllowLabel(R, riskRow))
            : alwaysAllowConfirmFor(R, riskRow, locale)
          : offersStopAsking && askServer
            ? stopAskingConfirm(R, askServer.name, locale)
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
      decline: tr.t('approval.toast.decline', { sentence: declinedSentence }),
      ...(offersAlways && riskRow
        ? { always: tr.t('approval.toast.always', { sentence: mayNow(riskRow) }) }
        : offersStopAsking && askServer
          ? { always: stopAskingToast(askServer.name, locale) }
          : {}),
    },
  };
}

/** Inbox row text for a needs-you approval: "Deploy feat/invoice-pdf to staging. Checks are green and Waffle approved." */
export function approvalInboxText(
  approval: Approval,
  ctx: Pick<ApprovalViewContext, 'names' | 'locale'>,
): string {
  const full = { ...ctx, now: approval.createdAt, timeZone: 'UTC' };
  const met = metPhrases(approval, full);
  const waiting = waitingPhrases(approval, full).long;
  const title = approvalCopy(approval, ctx.names, ctx.locale).title;
  // A command's why, which the person decides by: “Run a destructive command on staging. Clear the stale cache.”
  const why = commandWhyOf(approval.action);
  if (why) return `${title}. ${why}${/[.!?…]$/.test(why) ? '' : '.'}`;
  if (waiting.length === 0) {
    return met.length ? `${title}. ${cap(joinWithAnd(met, ctx.locale))}.` : `${title}.`;
  }
  return coreTranslator(ctx.locale).t('approval.inboxText.goesOut', {
    title,
    list: joinWithAnd(waiting, ctx.locale),
  });
}

/** The card's second button on a Servers call that may stop asking (server-asks.md SA-07). */
export function stopAskingLabel(server: string, locale?: string | null): string {
  return coreTranslator(locale).t('approval.stopAsking.label', { server });
}

/** The toast after “Don’t ask again on {server}” (SA-07). */
export function stopAskingToast(server: string, locale?: string | null): string {
  return coreTranslator(locale).t('approval.stopAsking.toast', { server });
}
