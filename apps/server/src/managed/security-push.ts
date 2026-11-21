/**
 * What a `security` push says and where its tap opens (docs/decisions/push-words.md PW-01…PW-03). These pushes are
 * about the box itself (a new device, a sign-in at its screen, the recovery kit, remote help), not about a message, so
 * the words are fixed sentences: nothing from the person's data, so they may go out as a preview like a message's.
 * Someone who turned “Show message text in notifications” off gets the phone's generic line for `security` instead.
 */
import type { PushTarget } from './push';

/** A security notice: the two lines the phone shows and the page a tap opens (under the hosted app's origin). */
export interface SecurityNotice {
  title: string;
  body: string;
  path: string;
}

const THIS_WHOMBAT = '/settings?tab=appliance';
const DEVICES = '/settings?tab=appliance&section=devices';
const ABOUT = '/settings?tab=appliance&section=about';

export const SECURITY_NOTICES = {
  passkeyEnrolled: {
    title: 'A new device signed in',
    body: 'A device signed in to your Whombat with your passkey. If it wasn’t you, remove it in Settings.',
    path: DEVICES,
  },
  screenEnrolled: {
    title: 'A device signed in at the screen',
    body: 'Someone typed the letters from your Whombat’s screen and a device is in. If it wasn’t you, remove it in Settings.',
    path: DEVICES,
  },
  screenBackoff: {
    title: 'Wrong letters at the screen',
    body: 'Someone typed the wrong sign-in letters on your Whombat a few times. It now makes them wait between tries.',
    path: DEVICES,
  },
  recoveryStarted: {
    title: 'Recovery kit being made',
    body: 'Someone started making a recovery kit for your Whombat. If it wasn’t you, look in Settings.',
    path: THIS_WHOMBAT,
  },
  recoveryRotating: {
    title: 'Recovery kit being replaced',
    body: 'Someone started replacing your Whombat’s recovery kit. If it wasn’t you, look in Settings.',
    path: THIS_WHOMBAT,
  },
  recoveryRegistered: {
    title: 'Recovery kit saved',
    body: 'Your Whombat has a recovery kit now. Keep it somewhere safe.',
    path: THIS_WHOMBAT,
  },
  recoveryRotated: {
    title: 'New recovery kit',
    body: 'Your Whombat has a new recovery kit. The old one doesn’t work any more.',
    path: THIS_WHOMBAT,
  },
  ownAddressForeign: {
    title: 'A certificate you didn’t ask for',
    body: 'Someone got a certificate for your Whombat’s address that it didn’t ask for. Until you know why, use the phone app or your home network.',
    path: ABOUT,
  },
  remoteHelpLockedOut: {
    title: 'Remote help turned off',
    body: 'Remote help turned itself off after 5 wrong help codes.',
    path: ABOUT,
  },
} as const satisfies Record<string, SecurityNotice>;

/** A bring back is done and the box waits for the person's one answer (a `backup` push, sent in quarantine). */
export const RESTORE_DONE_NOTICE: SecurityNotice = {
  title: 'Your Whombat is back',
  body: 'Open it to finish.',
  path: '/settings?tab=appliance&section=backups&finish=restore',
};

/** A remote help visit, for a person without a Chat to say it in (`remoteHelpVisitText` is the body). */
export function remoteHelpVisitNotice(body: string): SecurityNotice {
  return { title: 'Support is looking at your Whombat', body, path: ABOUT };
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
