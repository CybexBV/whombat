/**
 * Approval copy written from the action itself, never from the requester's wording: the card title, the
 * modal / mobile question, the card header target and the "what actually runs" line (WHAT HAPPENS 01).
 * The server stores this copy when it creates an approval; every surface renders it from the stored action
 * too, so a row whose wording disagrees with its action still shows what would run.
 *
 * For the mock's deploy it reproduces the mock copy: "Deploy feat/invoice-pdf to staging",
 * "Deploy feat/invoice-pdf to staging?", "staging · billing-api".
 */

import { normaliseCommand } from '../commands/commands.js';
import type { Approval, ApprovalAction } from '../domain/approval.js';
import { serviceLabel } from '../domain/connectors.js';
import { actionKey, describeAction } from '../keys/actions.js';
import { joinWithAnd, KEY_CATALOG } from '../keys/catalog.js';
import { requestedTier } from '../keys/requests.js';
import { formatEuro, shortSha } from '../text/format.js';

export interface ActionCopy {
  /** Card title: "Deploy feat/invoice-pdf to staging". */
  title: string;
  /** Modal / mobile question: "Deploy feat/invoice-pdf to staging?". */
  question: string;
  /** Card header right side: "staging · billing-api". */
  target: string;
  /**
   * What actually runs, with every fact the executor uses: "Build the latest commit on main in
   * whombat/billing, then roll billing-api to production".
   */
  runs: string;
}

/** Short names for principals the action names (channel members, the agent asking for a key). */
export type ActionNames = (principalId: string) => { shortName: string } | undefined;

/** Who a `grant_key` action gives the key to when the requester's name is unknown. */
const SOMEONE_AGENT = 'the agent';

/** The agent asking (`grant_key` names it: the key is always for the requester, key-requests.md KR-01). */
function requesterName(requesterId: string | undefined, names?: ActionNames): string {
  return (requesterId ? names?.(requesterId)?.shortName : undefined) ?? SOMEONE_AGENT;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** How a merge's first WHAT HAPPENS line ends (CT-290): a squash, the default, says nothing. */
const MERGE_HOW = { squash: '', merge: ' with a merge commit', rebase: ', rebased' } as const;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function titleOf(action: ApprovalAction, names?: ActionNames, requesterId?: string): string {
  if (action.type === 'custom') return cap(action.params.name);
  if (action.type === 'connection_call')
    return action.params.words
      ? cap(action.params.words)
      : `Use ${action.params.tool} on ${action.params.handle}`;
  if (action.type === 'grant_key')
    return `Give ${requesterName(requesterId, names)} “${KEY_CATALOG[action.params.keyId].label}”`;
  return cap(describeAction(action));
}

function targetOf(action: ApprovalAction, names?: ActionNames, requesterId?: string): string {
  switch (action.type) {
    case 'deploy':
      return `${action.params.environment} · ${action.params.service}`;
    case 'refund':
      return `account ${action.params.accountId} · ${formatEuro(action.params.amountCents)}`;
    case 'push_shared_branch':
      return `${action.params.repo} · ${action.params.branch}`;
    case 'merge_pr':
      return [action.params.repo, `PR #${action.params.prNumber}`].filter(Boolean).join(' · ');
    case 'message_external':
      return action.params.to;
    case 'custom':
      return KEY_CATALOG[action.params.keyId]?.label ?? action.params.keyId;
    case 'mail_send':
      return `${serviceLabel('mail', action.params.provider ?? 'google')} · ${action.params.connectionEmail}`;
    case 'calendar_invite':
      return `${serviceLabel('calendar', action.params.provider ?? 'google')} · ${action.params.summary}`;
    case 'files_share':
    case 'files_trash':
      return `${serviceLabel('files', action.params.provider ?? 'google')} · ${action.params.fileName}`;
    case 'grant_key':
      return `keys · ${requesterName(requesterId, names)}`;
    // “web-1 · Deploy to production”, “Push to main”.
    case 'run_command': {
      const key = actionKey(action);
      const label = key ? KEY_CATALOG[key].label : '';
      return [action.params.target, label].filter(Boolean).join(' · ');
    }
    // “homeassistant · HassTurnOn”.
    case 'connection_call':
      return `${action.params.handle} · ${action.params.tool}`;
  }
}

const SHARE_ROLE_NOUNS = { reader: 'a viewer', commenter: 'a commenter', writer: 'an editor' } as const;

function guestsPhrase(n: number): string {
  return `${n} ${n === 1 ? 'guest' : 'guests'}`;
}

function runsOf(action: ApprovalAction, names?: ActionNames, requesterId?: string): string {
  switch (action.type) {
    case 'deploy': {
      const p = action.params;
      const commit = p.sha ? `Build ${shortSha(p.sha)} from ${p.ref}` : `Build the latest commit on ${p.ref}`;
      const where = [p.repo ? ` in ${p.repo}` : '', p.prNumber ? ` (PR #${p.prNumber})` : ''].join('');
      return `${commit}${where}, then roll ${p.service} to ${p.environment}`;
    }
    case 'refund':
      return `Refund ${formatEuro(action.params.amountCents)} on account ${action.params.accountId}`;
    case 'push_shared_branch':
      return `Push ${shortSha(action.params.sha)} to ${action.params.branch} in ${action.params.repo}`;
    case 'merge_pr':
      return `Merge PR #${action.params.prNumber}${action.params.repo ? ` in ${action.params.repo}` : ''} into ${action.params.base}${MERGE_HOW[action.params.method ?? 'squash']}`;
    case 'message_external':
      return `Send a message to ${action.params.to}${action.params.subject ? `: “${action.params.subject}”` : ''}`;
    case 'custom': {
      const label = KEY_CATALOG[action.params.keyId]?.label ?? action.params.keyId;
      return `${cap(action.params.name)}, using “${label}”`;
    }
    case 'mail_send': {
      const p = action.params;
      const subject = p.subject ? `“${p.subject}”` : 'the email';
      const copies = [
        p.cc.length ? `cc ${joinWithAnd(p.cc)}` : '',
        p.bcc.length ? `bcc ${joinWithAnd(p.bcc)}` : '',
      ].filter(Boolean);
      return `Send ${subject} from ${p.connectionEmail} to ${joinWithAnd(p.to)}${copies.length ? `, ${copies.join(', ')}` : ''}`;
    }
    case 'calendar_invite': {
      const p = action.params;
      const guests = guestsPhrase(p.guests.length);
      if (p.op === 'update') return `Change “${p.summary}” and email ${guests}`;
      if (p.op === 'delete') return `Cancel “${p.summary}” and tell ${guests}`;
      return `Add “${p.summary}” to the calendar and email ${guests}`;
    }
    case 'files_share':
      return `Share “${action.params.fileName}” with ${action.params.email} as ${SHARE_ROLE_NOUNS[action.params.role]}`;
    case 'files_trash':
      return `Move “${action.params.fileName}” to the trash`;
    case 'grant_key': {
      const who = requesterName(requesterId, names);
      const label = KEY_CATALOG[action.params.keyId].label;
      return requestedTier(action.params.keyId) === 'can'
        ? `Give ${who} “${label}”, to use without asking`
        : `Give ${who} “${label}”, still asking a person each time`;
    }
    // The exact command, on one line; the card shows it in full (`ApprovalView.content`).
    case 'run_command':
      return `Run “${normaliseCommand(action.params.command)}”`;
    // The server's own words for the call (CT-347): “Restart web on pve-02 once, then say how it went …”.
    case 'connection_call':
      return action.params.words
        ? `${cap(action.params.words)} once, then say how it went where it was asked`
        : `Call ${action.params.tool} on ${action.params.handle} once, then post the result where it was asked`;
  }
}

/**
 * Copy for an action (lengths fit the Approval contract). `requesterId`: the agent asking, named by a `grant_key` action
 * (“Give Tinker “Browse the web””).
 */
export function actionCopy(action: ApprovalAction, names?: ActionNames, requesterId?: string): ActionCopy {
  const title = clip(titleOf(action, names, requesterId), 160);
  return {
    title,
    question: clip(`${title}?`, 200),
    target: clip(targetOf(action, names, requesterId), 120),
    runs: clip(runsOf(action, names, requesterId), 280),
  };
}

/**
 * The copy an approval shows: from its action, except `custom` actions, whose title and question the
 * server writes from the command that asked (their action carries no more than a name).
 */
export function approvalCopy(
  approval: Pick<Approval, 'action' | 'title' | 'question' | 'target'> & { requesterId?: string },
  names?: ActionNames,
): ActionCopy & { matchesStored: boolean } {
  const derived = actionCopy(approval.action, names, approval.requesterId);
  // A key request names its requester; without a name for it the stored copy (written with it) stands.
  const unnamed =
    approval.action.type === 'grant_key' && !(approval.requesterId && names?.(approval.requesterId));
  if (approval.action.type === 'custom' || unnamed)
    return {
      ...derived,
      title: approval.title,
      question: approval.question,
      target: approval.target,
      matchesStored: true,
    };
  return {
    ...derived,
    matchesStored:
      approval.title === derived.title &&
      approval.question === derived.question &&
      approval.target === derived.target,
  };
}
