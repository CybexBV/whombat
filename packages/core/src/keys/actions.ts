/** Which key an approval action needs, and the scope it touches. */
import { commandCategoryKey } from '../commands/commands.js';
import type { ApprovalAction } from '../domain/approval.js';
import { coreTranslator } from '../i18n/catalog.js';
import { formatEuro } from '../text/format.js';
import { joinWithAnd, type KeyId, keyLabel } from './catalog.js';
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
export function describeBlocked(attempt: string, locale?: string | null): string {
  return coreTranslator(locale).t('action.blocked', { attempt });
}

/** Short description of an action for Blocked / Asks texts ("deploy feat/invoice-pdf to staging"). */
export function describeAction(action: ApprovalAction, locale?: string | null): string {
  const tr = coreTranslator(locale);
  switch (action.type) {
    case 'deploy':
      return tr.t('action.deploy', { ref: action.params.ref, env: action.params.environment });
    case 'refund':
      return tr.t('action.refund', {
        amount: formatEuro(action.params.amountCents),
        account: action.params.accountId,
      });
    case 'push_shared_branch':
      return tr.t('action.push', { sha: action.params.sha.slice(0, 6), branch: action.params.branch });
    case 'merge_pr':
      return tr.t('action.merge', { n: action.params.prNumber, base: action.params.base });
    case 'message_external':
      return tr.t('action.message', { to: action.params.to });
    case 'custom':
      return action.params.name;
    case 'mail_send':
      return tr.t('action.mail', { to: recipients(action.params.to, locale) });
    case 'calendar_invite': {
      const people = tr.tp('action.people', action.params.guests.length);
      const summary = action.params.summary;
      if (action.params.op === 'update') return tr.t('action.calendar.update', { summary, people });
      if (action.params.op === 'delete') return tr.t('action.calendar.delete', { summary, people });
      return tr.t('action.calendar.create', { summary, people });
    }
    case 'files_share':
      return tr.t('action.share', { file: action.params.fileName, email: action.params.email });
    case 'files_trash':
      return tr.t('action.trash', { file: action.params.fileName });
    case 'grant_key':
      return tr.t('action.grant', { label: keyLabel(action.params.keyId, locale) });
    case 'run_command':
      return runCommandPhrase(action.params.category, action.params.target, locale);
    case 'connection_call':
      return (
        action.params.words ??
        tr.t('action.connection', { tool: action.params.tool, handle: action.params.handle })
      );
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
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  // A push always names its branch: main when the command didn't say.
  if (category === 'push_main') return tr.t('action.command.push_main', { target: target ?? 'main' });
  if (category === 'deploy') return tr.t('action.command.deploy');
  return target ? tr.t(`action.command.${category}.target`, { target }) : tr.t(`action.command.${category}`);
}

/** “a@b.com”, “a@b.com and c@d.com”, “a@b.com, c@d.com and e@f.com”, then “a@b.com and 3 others”. */
function recipients(to: readonly string[], locale?: string | null): string {
  if (to.length <= 3) return joinWithAnd(to, locale);
  return coreTranslator(locale).t('action.recipientsMore', { first: to[0] ?? '', count: to.length - 1 });
}

/**
 * `describeAction` for the audit log. Personal actions (a person's own mail, calendar and files) name no
 * recipients, subjects or files there (docs/decisions/connectors.md PA-09): “send an email”, “share a file”.
 * Only the owner's approval and DM hold that content. A Vault use is “use a private Vault entry” (VT-51).
 */
export function describeActionForLog(action: ApprovalAction, locale?: string | null): string {
  const tr = coreTranslator(locale);
  switch (action.type) {
    case 'mail_send':
      return tr.t('action.log.mail');
    case 'calendar_invite':
      return tr.t(`action.log.calendar.${action.params.op}`);
    case 'files_share':
      return tr.t('action.log.share');
    case 'files_trash':
      return tr.t('action.log.trash');
    default:
      return describeAction(action, locale);
  }
}

/** Asks event text: "Asked to deploy feat/invoice-pdf to staging"; content-free for personal actions. */
export function describeAsk(action: ApprovalAction, locale?: string | null): string {
  return coreTranslator(locale).t('action.asked', { what: describeActionForLog(action, locale) });
}
