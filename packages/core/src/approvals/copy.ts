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
import { type CoreTranslator, coreTranslator } from '../i18n/catalog.js';
import { actionKey, describeAction } from '../keys/actions.js';
import { joinWithAnd, KEY_CATALOG, keyLabel } from '../keys/catalog.js';
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

/** The agent asking (`grant_key` names it: the key is always for the requester, key-requests.md KR-01). */
function requesterName(tr: CoreTranslator, requesterId: string | undefined, names?: ActionNames): string {
  return (requesterId ? names?.(requesterId)?.shortName : undefined) ?? tr.t('approval.copy.someone');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A title's first letter in capitals, except where it starts with a name or a branch (“feat/invoice-pdf uitrollen …”):
 * Dutch phrases often start with their object.
 */
function capTitle(tr: CoreTranslator, s: string): string {
  if (tr.language !== 'nl') return cap(s);
  const first = s.split(' ')[0] ?? '';
  return /^[a-zà-ÿ]+(-[a-zà-ÿ]+)?$/.test(first) ? cap(s) : s;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** A key's label, or its id when the catalog doesn't know it (a `custom` ask names any id). */
function labelOf(keyId: string, locale?: string | null): string {
  return keyId in KEY_CATALOG ? keyLabel(keyId as keyof typeof KEY_CATALOG, locale) : keyId;
}

function titleOf(
  tr: CoreTranslator,
  action: ApprovalAction,
  names?: ActionNames,
  requesterId?: string,
): string {
  if (action.type === 'custom') return cap(action.params.name);
  if (action.type === 'connection_call')
    return action.params.words
      ? cap(action.params.words)
      : tr.t('approval.copy.title.connection', { tool: action.params.tool, handle: action.params.handle });
  if (action.type === 'grant_key')
    return tr.t('approval.copy.title.grant', {
      who: requesterName(tr, requesterId, names),
      label: keyLabel(action.params.keyId, tr.locale),
    });
  return capTitle(tr, describeAction(action, tr.locale));
}

function targetOf(
  tr: CoreTranslator,
  action: ApprovalAction,
  names?: ActionNames,
  requesterId?: string,
): string {
  switch (action.type) {
    case 'deploy':
      return `${action.params.environment} · ${action.params.service}`;
    case 'refund':
      return tr.t('approval.copy.target.refund', {
        account: action.params.accountId,
        amount: formatEuro(action.params.amountCents),
      });
    case 'push_shared_branch':
      return `${action.params.repo} · ${action.params.branch}`;
    case 'merge_pr':
      return [action.params.repo, `PR #${action.params.prNumber}`].filter(Boolean).join(' · ');
    case 'message_external':
      return action.params.to;
    case 'custom':
      return labelOf(action.params.keyId, tr.locale);
    case 'mail_send':
      return `${serviceLabel('mail', action.params.provider ?? 'google')} · ${action.params.connectionEmail}`;
    case 'calendar_invite':
      return `${serviceLabel('calendar', action.params.provider ?? 'google')} · ${action.params.summary}`;
    case 'files_share':
    case 'files_trash':
      return `${serviceLabel('files', action.params.provider ?? 'google')} · ${action.params.fileName}`;
    case 'grant_key':
      return tr.t('approval.copy.target.grant', { who: requesterName(tr, requesterId, names) });
    // “web-1 · Deploy to production”, “Push to main”.
    case 'run_command': {
      const key = actionKey(action);
      const label = key ? keyLabel(key, tr.locale) : '';
      return [action.params.target, label].filter(Boolean).join(' · ');
    }
    // “homeassistant · HassTurnOn”.
    case 'connection_call':
      return `${action.params.handle} · ${action.params.tool}`;
  }
}

function runsOf(
  tr: CoreTranslator,
  action: ApprovalAction,
  names?: ActionNames,
  requesterId?: string,
): string {
  const locale = tr.locale;
  switch (action.type) {
    case 'deploy': {
      const p = action.params;
      const commit = p.sha
        ? tr.t('approval.copy.runs.deploy.sha', { sha: shortSha(p.sha), ref: p.ref })
        : tr.t('approval.copy.runs.deploy.latest', { ref: p.ref });
      const where = [p.repo ? ` in ${p.repo}` : '', p.prNumber ? ` (PR #${p.prNumber})` : ''].join('');
      return tr.t('approval.copy.runs.deploy', { commit, where, service: p.service, env: p.environment });
    }
    case 'refund':
      return tr.t('approval.copy.runs.refund', {
        amount: formatEuro(action.params.amountCents),
        account: action.params.accountId,
      });
    case 'push_shared_branch':
      return tr.t('approval.copy.runs.push', {
        sha: shortSha(action.params.sha),
        branch: action.params.branch,
        repo: action.params.repo,
      });
    case 'merge_pr': {
      // A squash, the default, says nothing.
      const method = action.params.method ?? 'squash';
      return tr.t('approval.copy.runs.merge', {
        n: action.params.prNumber,
        inRepo: action.params.repo ? ` in ${action.params.repo}` : '',
        base: action.params.base,
        how: method === 'squash' ? '' : tr.t(`approval.copy.runs.merge.${method}`),
      });
    }
    case 'message_external':
      return tr.t('approval.copy.runs.message', {
        to: action.params.to,
        subject: action.params.subject ? `: “${action.params.subject}”` : '',
      });
    case 'custom':
      return tr.t('approval.copy.runs.custom', {
        name: cap(action.params.name),
        label: labelOf(action.params.keyId, locale),
      });
    case 'mail_send': {
      const p = action.params;
      const subject = p.subject ? `“${p.subject}”` : tr.t('approval.copy.runs.mail.theEmail');
      const copies = [
        p.cc.length ? `cc ${joinWithAnd(p.cc, locale)}` : '',
        p.bcc.length ? `bcc ${joinWithAnd(p.bcc, locale)}` : '',
      ].filter(Boolean);
      return cap(
        tr.t('approval.copy.runs.mail', {
          subject,
          from: p.connectionEmail,
          to: joinWithAnd(p.to, locale),
          copies: copies.length ? `, ${copies.join(', ')}` : '',
        }),
      );
    }
    case 'calendar_invite': {
      const p = action.params;
      const guests = tr.tp('approval.copy.guests', p.guests.length);
      return tr.t(`approval.copy.runs.calendar.${p.op}`, { summary: p.summary, guests });
    }
    case 'files_share':
      return tr.t('approval.copy.runs.share', {
        file: action.params.fileName,
        email: action.params.email,
        role: tr.t(`approval.copy.role.${action.params.role}`),
      });
    case 'files_trash':
      return tr.t('approval.copy.runs.trash', { file: action.params.fileName });
    case 'grant_key': {
      const who = requesterName(tr, requesterId, names);
      const label = keyLabel(action.params.keyId, locale);
      return requestedTier(action.params.keyId) === 'can'
        ? tr.t('approval.copy.runs.grant.can', { who, label })
        : tr.t('approval.copy.runs.grant.ask', { who, label });
    }
    // The exact command, on one line; the card shows it in full (`ApprovalView.content`).
    case 'run_command':
      return tr.t('approval.copy.runs.command', { command: normaliseCommand(action.params.command) });
    // The server's own words for the call (CT-347): “Restart web on pve-02 once, then say how it went …”.
    case 'connection_call':
      return action.params.words
        ? tr.t('approval.copy.runs.connection.words', { words: cap(action.params.words) })
        : tr.t('approval.copy.runs.connection', { tool: action.params.tool, handle: action.params.handle });
  }
}

/**
 * Copy for an action (lengths fit the Approval contract). `requesterId`: the agent asking, named by a `grant_key` action
 * (“Give Tinker “Browse the web””). The server stores the English copy; `locale` words it for the person reading.
 */
export function actionCopy(
  action: ApprovalAction,
  names?: ActionNames,
  requesterId?: string,
  locale?: string | null,
): ActionCopy {
  const tr = coreTranslator(locale);
  const title = clip(titleOf(tr, action, names, requesterId), 160);
  return {
    title,
    question: clip(`${title}?`, 200),
    target: clip(targetOf(tr, action, names, requesterId), 120),
    runs: clip(runsOf(tr, action, names, requesterId), 280),
  };
}

/**
 * The copy an approval shows: from its action, except `custom` actions, whose title and question the
 * server writes from the command that asked (their action carries no more than a name). Whether the stored copy
 * matches is judged on the English copy the server stores.
 */
export function approvalCopy(
  approval: Pick<Approval, 'action' | 'title' | 'question' | 'target'> & { requesterId?: string },
  names?: ActionNames,
  locale?: string | null,
): ActionCopy & { matchesStored: boolean } {
  const english = actionCopy(approval.action, names, approval.requesterId);
  const derived =
    coreTranslator(locale).language === 'en'
      ? english
      : actionCopy(approval.action, names, approval.requesterId, locale);
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
      approval.title === english.title &&
      approval.question === english.question &&
      approval.target === english.target,
  };
}
