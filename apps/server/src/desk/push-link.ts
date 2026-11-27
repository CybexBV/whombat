/**
 * Where a tap on the unlock push opens (docs/decisions/desk-display-server.md DK-S21): This Whombat in Settings, where
 * the request waits with Unlock and No — on the phone and on the web alike. The push carries only a keyed hash of
 * `desk-unlock:{id}` (`opaqueRef`), so `push.resolve` matches it against the requests this runtime sent the account,
 * kept as long as a push lives (`PUSH_TTL_S`).
 */
import { deskWords } from '@whombat/core';
import { tServer } from '../i18n/catalog';
import type { PushTarget } from '../managed/push';

/** The page a tap opens, under the hosted app's origin. */
export const DESK_SETTINGS_PATH = '/settings?tab=appliance';

/** The push's subject (`forAccounts`' `what` and its collapse group). */
export const unlockPushWhat = (requestId: string) => `desk-unlock:${requestId}`;

/** What the unlock push says on the phone, in the person's language (English without one). */
export function unlockPushPreview(locale?: string | null): { title: string; body: string } {
  return {
    title: deskWords(locale ?? null).settings.unlockRequest,
    body: tServer(locale, 'desk.unlockPush.body'),
  };
}

interface Sent {
  accountId: string;
  burrowSlug: string;
  at: number;
}

/** The unlock pushes sent within `keepMs`, to answer their taps. */
export class UnlockPushes {
  readonly #sent = new Map<string, Sent>();

  constructor(private readonly keepMs: number) {}

  remember(requestId: string, accountId: string, burrowSlug: string, now: number): void {
    this.#prune(now);
    this.#sent.set(requestId, { accountId, burrowSlug, at: now });
  }

  /**
   * The target of a tap on one of them (`ref` the keyed hash `refOf` makes of its subject), only for the account it was
   * sent to; null for anything else.
   */
  resolve(
    ref: string,
    accountId: string,
    now: number,
    refOf: (what: string) => string,
    appOrigin: string,
  ): PushTarget | null {
    this.#prune(now);
    for (const [id, sent] of this.#sent) {
      if (sent.accountId !== accountId || refOf(unlockPushWhat(id)) !== ref) continue;
      return {
        burrow: sent.burrowSlug,
        link: { type: 'external', url: `${appOrigin.replace(/\/$/, '')}${DESK_SETTINGS_PATH}` },
      };
    }
    return null;
  }

  #prune(now: number): void {
    for (const [id, sent] of this.#sent) if (now - sent.at > this.keepMs) this.#sent.delete(id);
  }
}
