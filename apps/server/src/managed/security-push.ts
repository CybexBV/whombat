/**
 * What a `security` push says and where its tap opens (docs/decisions/push-words.md PW-01…PW-03). These pushes are
 * about the box itself (a new device, a sign-in at its screen, the recovery kit, remote help), not about a message, so
 * the words are fixed sentences: nothing from the person's data, so they may go out as a preview like a message's.
 * Someone who turned “Show message text in notifications” off gets the phone's generic line for `security` instead.
 */
import { fillRemoteHelpWords, remoteHelpWords } from '@whombat/core';
import { isEnglish, type ServerMessageKey, tServer } from '../i18n/catalog';
import { localizePhrase } from '../i18n/phrases';
import type { PushTarget } from './push';

/** A security notice: the two lines the phone shows and the page a tap opens (under the hosted app's origin). */
export interface SecurityNotice {
  title: string;
  body: string;
  path: string;
  /** The same two lines in another language; without it the lines are said through the phrasebook. */
  words?: (locale: string) => { title: string; body: string };
}

const THIS_WHOMBAT = '/settings?tab=appliance';
const DEVICES = '/settings?tab=appliance&section=devices';
const ABOUT = '/settings?tab=appliance&section=about';

type FixedNotice =
  | 'passkeyEnrolled'
  | 'screenEnrolled'
  | 'screenBackoff'
  | 'recoveryStarted'
  | 'recoveryRotating'
  | 'recoveryRegistered'
  | 'recoveryRotated'
  | 'ownAddressForeign'
  | 'remoteHelpLockedOut'
  | 'restoreDone';

/** A notice in fixed words from the catalog: English as it always was, other languages from the same keys. */
function fixed(name: FixedNotice, path: string): SecurityNotice {
  const title = `managed.security.${name}.title` as ServerMessageKey;
  const body = `managed.security.${name}.body` as ServerMessageKey;
  return {
    title: tServer(null, title),
    body: tServer(null, body),
    path,
    words: (locale) => ({ title: tServer(locale, title), body: tServer(locale, body) }),
  };
}

export const SECURITY_NOTICES = {
  passkeyEnrolled: fixed('passkeyEnrolled', DEVICES),
  screenEnrolled: fixed('screenEnrolled', DEVICES),
  screenBackoff: fixed('screenBackoff', DEVICES),
  recoveryStarted: fixed('recoveryStarted', THIS_WHOMBAT),
  recoveryRotating: fixed('recoveryRotating', THIS_WHOMBAT),
  recoveryRegistered: fixed('recoveryRegistered', THIS_WHOMBAT),
  recoveryRotated: fixed('recoveryRotated', THIS_WHOMBAT),
  ownAddressForeign: fixed('ownAddressForeign', ABOUT),
  remoteHelpLockedOut: fixed('remoteHelpLockedOut', ABOUT),
} as const satisfies Record<string, SecurityNotice>;

/** A bring back is done and the box waits for the person's one answer (a `backup` push, sent in quarantine). */
export const RESTORE_DONE_NOTICE: SecurityNotice = fixed(
  'restoreDone',
  '/settings?tab=appliance&section=backups&finish=restore',
);

/**
 * A remote help visit, for a person without a Chat to say it in (`remoteHelpVisitText` is the body); `who` names the
 * visitor so the body can be said again in another language.
 */
export function remoteHelpVisitNotice(body: string, who?: string): SecurityNotice {
  return {
    title: tServer(null, 'managed.security.remoteHelpVisit.title'),
    body,
    path: ABOUT,
    words: (locale) => ({
      title: tServer(locale, 'managed.security.remoteHelpVisit.title'),
      body:
        who === undefined
          ? localizePhrase(body, locale)
          : fillRemoteHelpWords(remoteHelpWords(locale).messages.visit, { who }),
    }),
  };
}

/** A notice's two lines in a locale: its own words when it has them, else through the phrasebook. */
export function noticeIn(notice: SecurityNotice, locale: string | null | undefined): SecurityNotice {
  if (!locale || isEnglish(locale)) return notice;
  const said = notice.words
    ? notice.words(locale)
    : { title: localizePhrase(notice.title, locale), body: localizePhrase(notice.body, locale) };
  return { ...notice, ...said };
}

interface Sent {
  accountIds: readonly string[];
  path: string;
  at: number;
}

/**
 * The security pushes sent within `keepMs` (as long as a push lives), to answer their taps: a keyed hash of a push's
 * subject matches one sent to the asking account, and opens its page.
 */
export class SecurityPushes {
  readonly #sent = new Map<string, Sent>();

  constructor(private readonly keepMs: number) {}

  remember(what: string, accountIds: readonly string[], path: string, now: number): void {
    this.#prune(now);
    this.#sent.set(what, { accountIds, path, at: now });
  }

  /** The page for a tap on one of them (`refOf` makes the keyed hash of a subject), only for its own accounts. */
  resolve(
    ref: string,
    accountId: string,
    now: number,
    refOf: (what: string) => string,
  ): { path: string } | null {
    this.#prune(now);
    for (const [what, sent] of this.#sent)
      if (sent.accountIds.includes(accountId) && refOf(what) === ref) return { path: sent.path };
    return null;
  }

  #prune(now: number): void {
    for (const [what, sent] of this.#sent) if (now - sent.at > this.keepMs) this.#sent.delete(what);
  }
}

/** A page of the hosted app as a tap's target in a burrow. */
export function appPageTarget(burrow: string, appOrigin: string, path: string): PushTarget {
  return { burrow, link: { type: 'external', url: `${appOrigin.replace(/\/$/, '')}${path}` } };
}
