/** Which key an approval action needs, and the scope it touches. */
import { commandCategoryKey } from '../commands/commands.js';
import type { ApprovalAction } from '../domain/approval.js';
import { formatEuro } from '../text/format.js';
import { joinWithAnd, KEY_CATALOG, type KeyId } from './catalog.js';
import type { RequestScope } from './engine.js';
import { branchWriteKey, type KeyTierRow, keyTierRowOf } from './grants.js';

/**
 * The catalog key an action needs: every action has one (since 3.0, CT-1573, `skill_share` went). A `run_command` needs
 * its category's key (`commandCategoryKey`, AC-41).
 */
export function actionKey(action: ApprovalAction): KeyId {
  switch (action.type) {
    case 'deploy':
      return action.params.environment === 'production'
        ? 'deploy.production'
        : action.params.environment === 'staging'
          ? 'deploy.staging'
          : 'deploy';
    case 'refund':
      return 'refunds.issue';
    case 'push_shared_branch':
      return branchWriteKey(action.params.branch);
    case 'merge_pr':
      return action.params.base === 'main' || action.params.base === 'master' ? 'merge.main' : 'merge';
    case 'message_external':
      return 'messages.external';
    case 'custom':
      return action.params.keyId;
    case 'mail_send':
      return 'mail.send';
    case 'calendar_invite':
      return 'calendar.invite';
    case 'files_share':
      return 'files.share';
    case 'files_trash':
      return 'files.delete';
    // The key asked for: the approval is about it (asking needs no key, key-requests.md KR-02).
    case 'grant_key':
      return action.params.keyId;
    case 'run_command':
      return commandCategoryKey(action.params.category);
    // A call that asks changes something, or is a sensitive read (CX-21): the server stores the key it needed.
    case 'connection_call':
      return 'connections.write';
  }
}

/**
 * The typed actions whose card may offer “Always allow {Agent} to …” (Whombat resourceful-agents.md RA-06): a deploy, a
 * merge, a push (to main), an outside message and a refund. Never a key request, an ask about a person's mail, invites
 * or files (they always ask its owner), or a `run_command` (AC-42's choices). A `custom` ask offers it only when it is
 * the agent's `gh` write (`isGhWriteAsk`).
 */
export const ALWAYS_ALLOW_ACTION_TYPES = [
  'deploy',
  'merge_pr',
  'push_shared_branch',
  'message_external',
  'refund',
] as const satisfies readonly ApprovalAction['type'][];

/**
 * The risk row an approval card offers “Always allow {Agent} to {verb}” for (RA-06): the row of the key a typed action
 * of `ALWAYS_ALLOW_ACTION_TYPES` needs (`actionKey`) — Deploy, Merge into main, Push to main (a push to the default
 * branch only), Message people outside your Whombat, Money — else null. `approvals.decide` takes `scope: 'agent'` exactly
 * for these: it approves and sets the row to On (`withKeyRowTier(…, 'can')`), for people who may change the agent's keys
 * (`agents.manage`), signed as a key change.
 */
export function alwaysAllowRow(action: ApprovalAction): KeyTierRow | null {
  if (!(ALWAYS_ALLOW_ACTION_TYPES as readonly string[]).includes(action.type) && !isGhWriteAsk(action))
    return null;
  const key = actionKey(action);
  return key ? keyTierRowOf(key) : null;
}

/**
 * The card of an agent's `gh` write that waits for a yes (“Edit release v1.0.10 in acme/os”): a `custom` ask carrying
 * the command's `ghHash`. Its key is the row that decides every such command, so “Always allow” stops these asks too
 * (docs/decisions/agent-gh.md); any other `custom` ask names a key the agent picked and keeps Approve and Decline.
 */
export function isGhWriteAsk(action: ApprovalAction): boolean {
  return action.type === 'custom' && typeof action.params.data.ghHash === 'string';
}

export function actionScope(action: ApprovalAction): RequestScope {
  switch (action.type) {
    case 'deploy': {
      const scope: RequestScope = { environment: action.params.environment, branch: action.params.ref };
      if (action.params.repo) scope.repo = action.params.repo;
      return scope;
    }
    case 'push_shared_branch':
      return { repo: action.params.repo, branch: action.params.branch };
    case 'merge_pr':
      return action.params.repo
        ? { repo: action.params.repo, branch: action.params.base }
        : { branch: action.params.base };
    // A command pushing to main names the branch; the rest carry no scope the keys engine reads.
    case 'run_command':
      return action.params.category === 'push_main' && action.params.target
        ? { branch: action.params.target }
        : {};
    default:
      return {};
  }
}

/** Blocked event text: "Tried to merge PR #479 into main. Blocked." (`attempt` = "merge PR #479 into main"). */
export function describeBlocked(attempt: string): string {
  return `Tried to ${attempt}. Blocked.`;
}

/** Short description of an action for Blocked / Asks texts ("deploy feat/invoice-pdf to staging"). */
export function describeAction(action: ApprovalAction): string {
  switch (action.type) {
    case 'deploy':
      return `deploy ${action.params.ref} to ${action.params.environment}`;
    case 'refund':
      return `refund ${formatEuro(action.params.amountCents)} on account ${action.params.accountId}`;
    case 'push_shared_branch':
      return `push ${action.params.sha.slice(0, 6)} to ${action.params.branch}`;
    case 'merge_pr':
      return `merge PR #${action.params.prNumber} into ${action.params.base}`;
    case 'message_external':
      return `message ${action.params.to}`;
    case 'custom':
      return action.params.name;
    case 'mail_send':
      return `send an email to ${recipients(action.params.to)}`;
    case 'calendar_invite': {
      const n = action.params.guests.length;
      const people = `${n} ${n === 1 ? 'person' : 'people'}`;
      const summary = action.params.summary;
      if (action.params.op === 'update')
        return `send an updated calendar invite for “${summary}” to ${people}`;
      if (action.params.op === 'delete') return `cancel “${summary}” for ${people}`;
      return `send a calendar invite for “${summary}” to ${people}`;
    }
    case 'files_share':
      return `share “${action.params.fileName}” with ${action.params.email}`;
    case 'files_trash':
      return `move “${action.params.fileName}” to the trash`;
    case 'grant_key':
      return `get the key “${KEY_CATALOG[action.params.keyId].label}”`;
    // Never the command itself: it may hold a value the agent shouldn't have put there, and this text is signed.
    case 'run_command':
      return runCommandPhrase(action.params.category, action.params.target);
    case 'connection_call':
      return action.params.words ?? `use ${action.params.tool} on ${action.params.handle}`;
  }
}

/**
 * What a `run_command` does, without the command (AC-41): “run a command on the production server web-1”, “run a
 * command that pushes to main”, “run a destructive command on staging”; a Hermes tool call at Ask (CT-1236): “look
 * something up on the web”, “open example.com”, “use the browser”, “open example.com in the browser”.
 */
export function runCommandPhrase(
  category: Extract<ApprovalAction, { type: 'run_command' }>['params']['category'],
  target: string | null,
): string {
  switch (category) {
    case 'deploy_production':
      return target
        ? `run a command on the production server ${target}`
        : 'run a command that reaches production';
    case 'deploy':
      return 'run a deploy command';
    case 'merge':
      return target
        ? `run a command that merges a pull request in ${target}`
        : 'run a command that merges a pull request';
    case 'push_main':
      return `run a command that pushes to ${target ?? 'main'}`;
    case 'destructive':
      return target
        ? `run a destructive command on ${target}`
        : 'run a destructive command on another machine';
    case 'message_external':
      return target
        ? `run a command that sends a message to ${target}`
        : 'run a command that sends a message outside your Whombat';
    case 'web':
      return target ? `open ${target}` : 'look something up on the web';
    case 'browser':
      return target ? `open ${target} in the browser` : 'use the browser';
  }
}

/** “a@b.com”, “a@b.com and c@d.com”, “a@b.com, c@d.com and e@f.com”, then “a@b.com and 3 others”. */
function recipients(to: readonly string[]): string {
  if (to.length <= 3) return joinWithAnd(to);
  return `${to[0]} and ${to.length - 1} others`;
}

/**
 * `describeAction` for the audit log. Personal actions (a person's own mail, calendar and files) name no
 * recipients, subjects or files there (docs/decisions/connectors.md PA-09): “send an email”, “share a file”.
 * Only the owner's approval and DM hold that content. A Vault use is “use a private Vault entry” (VT-51).
 */
export function describeActionForLog(action: ApprovalAction): string {
  switch (action.type) {
    case 'mail_send':
      return 'send an email';
    case 'calendar_invite':
      if (action.params.op === 'update') return 'send an updated calendar invite';
      if (action.params.op === 'delete') return 'cancel an event';
      return 'send a calendar invite';
    case 'files_share':
      return 'share a file';
    case 'files_trash':
      return 'move a file to the trash';
    default:
      return describeAction(action);
  }
}

/** Asks event text: "Asked to deploy feat/invoice-pdf to staging"; content-free for personal actions. */
export function describeAsk(action: ApprovalAction): string {
  return `Asked to ${describeActionForLog(action)}`;
}
