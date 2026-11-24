/**
 * A 1Password connection's page (docs/decisions/onepassword-sync.md OPW-50, OPW-51): its first tab is 1Password, which
 * the apps draw from the connection's own read (`connections.onePassword`: the counts, Sync now, “Not in your Vault”,
 * the guard's question); its head says which vault and how many entries are kept in step; Worth a look has the sync's
 * lines with their checks. Everything comes from what the last pass stored: the page never calls 1Password, and the
 * connection isn't in Home's health pass (it is no agent's).
 */
import {
  ONEPASSWORD_TAB,
  ONEPASSWORD_WATCH_CHECKS,
  ONEPASSWORD_WORDS,
  type OnePasswordSyncView,
  onePasswordGoneTitle,
  onePasswordKeptLine,
  onePasswordWaitingLine,
} from '@whombat/core';
import { registerOnePasswordSource } from '../../vault/onepassword/inbox';
import { onePasswordSyncView } from '../../vault/onepassword/store';
import { onePasswordSyncFor } from '../../vault/onepassword/sync';
import type { KindCheck, KindNotice } from '../quiet/types';
import { line } from '../words';
import type { KindModule } from './registry';
import type { KindView } from './types';

export const ONEPASSWORD_CHECKS: readonly KindCheck[] = ONEPASSWORD_WATCH_CHECKS;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Worth a look: the guard's pause, a pass that can't finish, the limit's wait, a token that can only read. */
export function onePasswordNotices(view: OnePasswordSyncView, timeZone: string): KindNotice[] {
  const out: KindNotice[] = [];
  if (view.outcome === 'paused' && view.removals)
    out.push({
      id: 'onepassword-paused',
      tone: 'warn',
      icon: 'key',
      title: onePasswordGoneTitle(view.removals.entries.length),
      detail: `${ONEPASSWORD_WORDS.removeHere} or ${ONEPASSWORD_WORDS.keepHere.toLowerCase()}: open 1Password to choose.`,
      nature: 'you',
      check: 'onepassword.paused',
      ignore: { lifts: 'fixed', words: 'Until you choose.' },
      episode: view.removals.token,
    });
  if (view.outcome === 'failing')
    out.push({
      id: 'onepassword-failing',
      tone: 'bad',
      icon: 'network',
      title: clip(view.problem ?? ONEPASSWORD_WORDS.unreachable, 120),
      nature: 'problem',
      check: 'onepassword.unreachable',
      ignore: { lifts: 'fixed', words: 'Until it syncs again.' },
    });
  if (view.outcome === 'waiting' && view.nextTryAt)
    out.push({
      id: 'onepassword-limit',
      tone: 'info',
      icon: 'clock',
      title: 'Waiting for 1Password’s limit',
      detail: onePasswordWaitingLine(view.nextTryAt, timeZone),
      nature: 'fyi',
      check: 'onepassword.limit',
      ignore: { lifts: 'fixed', words: 'Until the wait is over.' },
    });
  if (view.readOnly)
    out.push({
      id: 'onepassword-read-only',
      tone: 'warn',
      icon: 'key',
      title: 'This token can only read',
      detail: ONEPASSWORD_WORDS.readOnly,
      nature: 'you',
      check: 'onepassword.paused',
      ignore: { lifts: 'fixed', words: 'Until it can write.' },
      episode: 'read-only',
    });
  return out;
}

/**
 * The head's state from how the last pass ended: failing a problem with its words, paused (or a token that can only
 * read) needs the person, the limit's wait fine with the waiting line, else fine. Worth a look's lines decide it when
 * Whombat watches their checks; this is what the head says when it doesn't, and for an app that reads only the state.
 */
export function onePasswordHeadStatus(
  view: OnePasswordSyncView,
  timeZone: string,
): Pick<KindView, 'status' | 'problem'> {
  if (view.outcome === 'failing')
    return {
      status: { status: 'bad', badge: 'Can’t reach 1Password' },
      problem: clip(view.problem ?? ONEPASSWORD_WORDS.unreachable, 200),
    };
  if (view.outcome === 'paused' && view.removals)
    return {
      status: { status: 'warn', badge: clip(onePasswordGoneTitle(view.removals.entries.length), 60) },
    };
  if (view.readOnly) return { status: { status: 'warn', badge: 'This token can only read' } };
  if (view.outcome === 'waiting' && view.nextTryAt)
    return { status: { status: 'ok', badge: clip(onePasswordWaitingLine(view.nextTryAt, timeZone), 60) } };
  return view.checkedAt ? { status: { status: 'ok', badge: 'Kept in step' } } : {};
}

/** The page: the 1Password tab first (the apps draw it), the vault's name and the count in the head, its lines. */
export function onePasswordKindView(view: OnePasswordSyncView, timeZone: string): KindView {
  return {
    ...onePasswordHeadStatus(view, timeZone),
    // No response time: nothing is sent to its address.
    charts: [],
    notices: onePasswordNotices(view, timeZone),
    panels: [],
    lead: ONEPASSWORD_TAB,
    tabs: [{ key: ONEPASSWORD_TAB, label: '1Password', panels: [] }],
    facts: [
      ...(view.vaultTitle ? [line(`Vault **${clip(view.vaultTitle, 100)}**`)] : []),
      line(onePasswordKeptLine(view.kept)),
    ],
    actions: [],
    readAt: view.checkedAt ? new Date(view.checkedAt) : null,
    // The assistant doesn't use this connection: nothing to ask it here.
    suggestions: [],
  };
}

// The Inbox's 1Password items (the guard's question, a sync that can't finish) come with the kind.
registerOnePasswordSource();

export const ONEPASSWORD_KIND: KindModule = {
  checks: ONEPASSWORD_CHECKS,
  page: async ({ services, row, timeZone }) =>
    onePasswordKindView(
      await onePasswordSyncView(services.db, row, onePasswordSyncFor(services).syncing),
      timeZone,
    ),
};
