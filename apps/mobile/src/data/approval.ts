/**
 * Mobile approval screen model (mock "Approval detail"): state label, question, context line, conditions,
 * explanation and the sticky footer (Decline / Approve while pending, Undo after deciding). All copy
 * comes from core's `approvalView`, the same state machine the desktop card and modal use. Pure.
 *
 * A `run_command` approval (agent-computer.md AC-41, AC-42) shows why the agent runs it under WHY (when it said), the
 * exact command under COMMAND in a mono block and
 * its target (“web-1 · Deploy to production”), and decides with one button per scope — “Allow once”, “Allow for this
 * task”, “Always allow for Banjo” — and “Don’t allow”. It has no Undo either: the command may already have run.
 *
 * An everyday ask (a server's or connection's call, a message, a file…) answers in the one order every place uses:
 * Yes, now · Yes, tonight · No where a later time is offered, else Yes, do it · No, every answer outlined alike so none
 * looks recommended; before them the one approval card's facts (`facts`). Code (a deploy, a merge) keeps Decline /
 * Approve.
 *
 * The lasting yes — a risk row's “Always allow Neo to deploy”, a Servers call's “Don’t ask again for thetitan…”
 * (server-asks.md SA-07) — approves this time and stops asking. It isn't one of the answers: a quiet text button at the
 * content's end that asks first, naming where it changes back.
 *
 * An automation asking (“Approve the fix”; automation-recipes.md AP-999) is not the agent: its mark instead of a
 * wombat, “AN AUTOMATION IS ASKING” while it waits, its name on the context line and “The automation” in the sentences.
 * The agent asking wears its face, labelled with its name (Whombat one-agent.md OA-08; AP-4995).
 */
import {
  AUTOMATION_ASKING,
  type AutomationAsker,
  agentFaceOf,
  approveToastFor,
  automationAsker,
  canManageAgent,
  OutcomeRedactedError,
  OutcomeUnknownError,
} from '@whombat/client';
import {
  type AgentFace,
  APPROVAL_ASK_WORDS,
  type Approval,
  type ApprovalLastingWords,
  alwaysAllowConfirm,
  alwaysAllowRow,
  approvalView,
  type CommandScope,
  formatClock,
  keyRiskRow,
  lastingWordsAt,
  type Tone,
} from '@whombat/core';
import {
  APPROVAL_CARD_WORDS,
  type ApprovalTonightView,
  type ApprovalUnmetView,
  approvalPermissionText,
  approvalTonight,
  approvalUnmet,
} from '@whombat/core/approvals';
import { approvalContext, type ViewContext } from './people';

export interface ApprovalConditionRow {
  id: string;
  /** "Checks pass on 7be20f" */
  label: string;
  /** "41 of 41", "approved 11:38", "you", "you · just now" */
  note: string;
  met: boolean;
}

/** One of an everyday ask's one-time answers, in the one order: now, tonight, no. */
export interface ApprovalAnswerButton {
  id: 'now' | 'later' | 'no';
  label: string;
  /** Never: every answer has the same weight, so none looks recommended (approval-card.md). */
  filled: false;
}

export type ApprovalFooter =
  | {
      kind: 'decide';
      canApprove: boolean;
      canDecline: boolean;
      /** “Approve”, or for a key request “Give Tinker “Run CI”” / “Give “Browse the web””, a share “Share”. */
      approveLabel: string;
      /** “Decline”. */
      declineLabel: string;
      /** A key request's label needs the room: Approve takes more of the row (key-requests.md KR-05). */
      approveWide: boolean;
    }
  /** An everyday ask: Yes, now · Yes, tonight · No, or Yes, do it · No. */
  | {
      kind: 'answers';
      canApprove: boolean;
      canDecline: boolean;
      answers: ApprovalAnswerButton[];
    }
  /**
   * A `run_command` (AC-42): one button per scope in core's order, then the decline (“Don’t allow”), stacked: four
   * don't fit side by side.
   */
  | {
      kind: 'choose';
      canApprove: boolean;
      canDecline: boolean;
      choices: { scope: CommandScope; label: string }[];
      declineLabel: string;
    }
  | { kind: 'undo'; canUndo: boolean }
  /** Decided and never undoable (a Vault use, VT-32): no footer at all rather than a dead Undo. */
  | { kind: 'none' };

export interface ApprovalScreenModel {
  number: number;
  /** The face the requesting agent wears; null for a person or an automation (no wombat). */
  requesterFace: AgentFace | null;
  requesterName: string;
  /** An automation asks (AP-999): its mark, labelled “Automation “<name>””, where an agent's wombat goes. */
  automation: AutomationAsker | null;
  /** "NEEDS A PERSON", "APPROVED · DEPLOYING", "DECLINED"; “AN AUTOMATION IS ASKING” while an automation waits. */
  label: string;
  tone: Tone;
  /** "Deploy feat/invoice-pdf to staging?" */
  question: string;
  /** "Neo · #billing-v2 · 11:25"; an automation by its name: "Assess and fix … · #incidents · 11:25". */
  context: string;
  conditions: ApprovalConditionRow[];
  /**
   * An email's whole body under “MESSAGE”, as it will be sent (connectors.md IN-16), or a `run_command`'s exact command
   * under “COMMAND” (`mono`, AC-41); null otherwise.
   */
  content: { label: string; text: string; mono: boolean } | null;
  /** What the agent says a `run_command` is for, under “WHY” (its `# why:` line); null otherwise. */
  why: string | null;
  /** A `run_command`'s target line: “web-1 · Deploy to production” (AC-41); null for every other action. */
  target: string | null;
  /** An everyday ask's tool and target (“servers · server_command”), folded under Details; null otherwise. */
  technical: { label: string; text: string } | null;
  /**
   * An everyday ask's facts before its answers, as the one approval card has them (approval-card.md): what happens, the
   * permission it uses, what it still waits for besides the person's yes, and the exact moment Yes, tonight means. Null
   * for every other approval.
   */
  facts: {
    happens: string[];
    permission: { label: string; text: string };
    unmet: ApprovalUnmetView[];
    unmetLabel: string;
    tonight: ApprovalTonightView | null;
  } | null;
  message: string;
  footer: ApprovalFooter;
  /**
   * The lasting yes apart from the answers: its text button (`link`) and the confirmation's words, naming where it
   * changes back; null when it isn't offered (not an owner, not a risk row or a server that may stop asking, decided).
   */
  lasting: ApprovalLastingWords | null;
  toasts: { approve: string; decline: string };
}

/** Where a lasting yes changes back from the phone: a server's own page, else the web. */
function lastingWhere(server: { name: string } | null): string {
  return server ? `on ${server.name}’s page in Overview` : 'on the web';
}

/**
 * Who asks, where and when, under the question: “Neo · #billing-v2 · 14:03”. A conversation named after the one who
 * asks (the agent's own chat) isn't said twice.
 */
export function approvalByline(asker: string | null, where: string | undefined, clock: string): string {
  const place = where && where !== asker ? where : null;
  return [asker, place, clock].filter(Boolean).join(' · ');
}

export function approvalScreen(
  approval: Approval,
  ctx: ViewContext,
  where?: string,
  /** When Yes, tonight would run (the quiet hours' start); without it an everyday ask offers Yes, do it · No. */
  tonight?: string | null,
): ApprovalScreenModel {
  const view = approvalView(approval, approvalContext(ctx, approval, where));
  const requester = ctx.people.get(approval.requesterId);
  // An automation's own principal is a system one (OA-17): it asks as an automation, not as the agent (AP-999).
  const automation = automationAsker(approval, requester);
  const agent = requester?.kind === 'agent' && !automation ? requester : null;
  const command = approval.action.type === 'run_command';
  // A risk row and a Servers call that may stop asking offer the lasting yes; their choices aren't a command's.
  const riskRow = alwaysAllowRow(approval.action);
  const server = stopAskingServer(approval);
  const risk = riskRow !== null || server !== null;
  // Never for an automation's own request: nobody changes a system actor (`canManageAgent`, AP-5734).
  const always =
    risk && canManageAgent(requester) && view.canApprove
      ? (view.scopeChoices?.find((c) => c.scope === 'agent')?.label ?? null)
      : null;
  const agentName = requester?.name ?? 'Neo';
  const words =
    view.lasting ??
    (riskRow && always ? alwaysAllowConfirm(agentName, keyRiskRow(riskRow).verb, always) : null);
  const lasting = always && words ? lastingWordsAt(words, lastingWhere(server)) : null;
  const W = APPROVAL_ASK_WORDS;
  const later = Boolean(view.ask && tonight && view.canApprove);
  const answers: ApprovalAnswerButton[] = [
    { id: 'now', label: later ? W.now : W.yes, filled: false },
    ...(later ? [{ id: 'later' as const, label: W.later, filled: false as const }] : []),
    { id: 'no', label: W.no, filled: false },
  ];
  return {
    number: approval.number,
    requesterFace: agent ? agentFaceOf(agent) : null,
    requesterName: automation ? (automation.name ?? 'An automation') : (requester?.name ?? 'Someone'),
    automation,
    // The web modal's kicker while it waits: the mark alone doesn't say who asks.
    // An everyday ask in plain words (handle-it.md): “Neo needs your OK”, Yes, do it and No.
    label:
      automation && approval.state === 'pending' ? AUTOMATION_ASKING : (view.ask?.needs ?? view.mobileLabel),
    tone: view.tone,
    // Written from the action; a stored wording that disagrees gets "What actually runs: …" first.
    question: view.question,
    // The sentences say “The automation”; the byline names which one.
    context: approvalByline(
      automation ? (automation.name ?? 'An automation') : (requester?.name ?? null),
      where,
      formatClock(approval.createdAt, ctx.timeZone),
    ),
    // An everyday ask says the person's yes with its buttons, and what else it waits for among its facts.
    // A sole condition that is the person's yes says it with the buttons; a deploy keeps its checks, review and who
    // approved.
    conditions:
      view.ask || view.conditions.every((c) => c.kind === 'person_approves')
        ? []
        : view.conditions.map((c) => ({
            id: c.id,
            label: c.mobileLabel,
            note: c.mobileNote,
            met: c.met,
          })),
    content: view.content ? { ...view.content, mono: command } : null,
    why: view.why,
    target: command ? view.target : null,
    // An everyday ask's tool and target, folded under Technical details (handle-it.md).
    technical: view.ask ? { label: APPROVAL_CARD_WORDS.details, text: view.target } : null,
    facts: view.ask
      ? {
          happens: view.whatHappens.map((h) => h.text),
          permission: { label: APPROVAL_CARD_WORDS.permission, text: approvalPermissionText(approval.keyId) },
          unmet: approvalUnmet(view),
          unmetLabel: APPROVAL_CARD_WORDS.waiting,
          tonight: approvalTonight(later ? tonight : null, ctx.timeZone),
        }
      : null,
    // An everyday ask says what happens in its facts: only a stored wording that disagrees adds a line.
    message: view.ask
      ? (view.actionNote ?? '')
      : view.actionNote
        ? `${view.actionNote} ${view.mobileMessage}`
        : view.mobileMessage,
    footer:
      approval.state === 'pending' && view.scopeChoices && !risk
        ? {
            kind: 'choose',
            canApprove: view.canApprove,
            canDecline: view.canDecline,
            choices: view.scopeChoices,
            declineLabel: view.declineCta,
          }
        : approval.state === 'pending' && view.ask
          ? { kind: 'answers', canApprove: view.canApprove, canDecline: view.canDecline, answers }
          : approval.state === 'pending'
            ? {
                kind: 'decide',
                canApprove: view.canApprove,
                canDecline: view.canDecline,
                approveLabel: view.mobileCta,
                declineLabel: view.declineCta,
                approveWide: approval.action.type === 'grant_key',
              }
            : command
              ? { kind: 'none' }
              : { kind: 'undo', canUndo: view.canUndo },
    lasting,
    toasts: view.toasts,
  };
}

/**
 * What a yes with a scope says (AC-42): “Allowed for this task. Banjo runs the command now.”, “Always allowed for Banjo.
 * …”, “Allowed once. …” — core's toast for the approval as if decided with that scope; after “Always allow” on a
 * risk-row request “Approved. From now on Neo may deploy without asking.” (RA-06).
 */
export function scopedApproveToast(
  approval: Approval,
  scope: CommandScope,
  ctx: ViewContext,
  where?: string,
): string {
  const vc = approvalContext(ctx, approval, where);
  // “Don’t ask again on thetitan” (SA-07): “Approved. Whombat won’t ask again on thetitan.”
  if (scope === 'agent' && stopAskingServer(approval)) {
    const toasts = approvalView(approval, vc).toasts;
    return toasts.always ?? toasts.approve;
  }
  return approveToastFor(approval, scope, vc);
}

/**
 * The server a Servers approval could stop asking on (SA-07): a `connection_call` the server sent with
 * `params.server` (contracts 0.86). Null for every other approval.
 */
export function stopAskingServer(approval: Pick<Approval, 'action'>): { id: string; name: string } | null {
  return approval.action.type === 'connection_call' ? (approval.action.params.server ?? null) : null;
}

/**
 * Whether an answer may have reached the Whombat though no reply came (the connection dropped after it left, or its
 * outcome is unknown; command-safety.md): the screen says “Your answer may have gone through” and offers only to ask the
 * assistant to check, never to answer again.
 */
export function answerMayHaveGoneThrough(error: unknown): boolean {
  if (error instanceof OutcomeUnknownError) return true;
  return error instanceof OutcomeRedactedError && error.state !== 'completed';
}
