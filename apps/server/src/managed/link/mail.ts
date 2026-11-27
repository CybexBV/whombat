/**
 * Email through Whombat Link (docs/decisions/link-email.md; contracts 4.15 `link.mail.set`, `mail.send`). The owner
 * makes two choices in Settings → Notifications, kept here in `appliance_state`:
 *
 * - **offline** (on unless turned off): Whombat Link emails the Link account's address when it stops hearing from this
 *   box. Control does that on its own; the box only tells it the choice.
 * - **notifications** (off unless turned on): this box's notification email and its notices in fixed words go out
 *   through Whombat Link, to the Link account's own address and nowhere else. The notification email is a count only
 *   (“3 things are waiting for you”), never who, where or what; a notice is the two fixed lines a phone shows.
 *
 * Control is told the choices whenever it knows the box (any Link state but off): at start, when Link moves, when the
 * owner changes them, and again every few minutes until it took them. A mail server of the owner's own still sends the
 * notification email itself; notices then still go through Link when the owner chose it.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { LinkMailAuditPayload, LinkMailSummary } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { applianceState } from '../../db/schema/index';
import { configuredBoxLocale } from '../../i18n/locale';
import type { Services } from '../../services';
import { appendApplianceEvent } from '../audit';
import { ManagerCallError, type ManagerPort } from '../ports';
import type { SecurityNotice } from '../security-push';
import type { LinkService } from './service';

const STATE_ID = 1;

/** What a box has before its owner chose anything: told when it goes offline, notifications by its own means. */
export const LINK_MAIL_DEFAULTS: LinkMailSummary = { offline: true, notifications: false };

/**
 * After control refused the language, the box asks with it again only after this long (or when Link moves or the owner
 * changes the language): an older control takes the choices without it meanwhile, and nothing is asked twice each sweep.
 */
export const LOCALE_RETRY_MS = 6 * 3_600_000;

/**
 * Whether a refusal may be control not knowing `locale` yet: the manager's strict check (400) or control's own refusal
 * passed on by the manager (502 `control_refused`). Never a manager that can't reach control (503, unreachable).
 */
export function refusesLocale(err: unknown): boolean {
  return (
    err instanceof ManagerCallError &&
    (err.status === 400 || (err.status === 502 && err.code === 'control_refused'))
  );
}

/** Clips a fixed line to what the contract takes (one line, at most `max` code points). */
function line(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const points = [...one];
  return points.length <= max ? one : `${points.slice(0, max - 1).join('')}…`;
}

export class LinkEmail {
  #choices: LinkMailSummary = LINK_MAIL_DEFAULTS;
  /**
   * The choices control last took (`offline/notifications/locale`, the locale empty when it took them without one), or
   * null: told again at the next chance.
   */
  #told: string | null = null;
  /** When control last refused the language (ms), or null: until `LOCALE_RETRY_MS` later the choices go without it. */
  #localeRefusedAt: number | null = null;
  #telling: Promise<void> | null = null;
  #refKey: Uint8Array;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    private readonly link: LinkService,
    /** The box's person (one person a box): the only one whose notification email goes through Link. */
    private readonly person: () => Promise<string | null> = async () => null,
  ) {
    const master = services.config.WHOMBAT_MASTER_KEY;
    this.#refKey = master
      ? new Uint8Array(hkdfSync('sha256', Buffer.from(master, 'utf8'), 'whombat', 'link-mail-ref/1', 32))
      : new Uint8Array(randomBytes(32));
  }

  /** Reads the stored choices (the runtime's start). */
  async load(): Promise<void> {
    const [row] = await this.services.db
      .select({
        offline: applianceState.linkMailOffline,
        notifications: applianceState.linkMailNotifications,
      })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    this.#choices = row ? { offline: row.offline, notifications: row.notifications } : LINK_MAIL_DEFAULTS;
  }

  choices(): LinkMailSummary {
    return this.#choices;
  }

  /** `link.mail.set` (the owner): stores the choices, signs `link.mail_set`, tells control. Answers the choices now. */
  async set(
    by: { accountId: string; endpointId: string | null },
    input: { offline?: boolean | undefined; notifications?: boolean | undefined },
  ): Promise<LinkMailSummary> {
    const next: LinkMailSummary = {
      offline: input.offline ?? this.#choices.offline,
      notifications: input.notifications ?? this.#choices.notifications,
    };
    if (next.offline === this.#choices.offline && next.notifications === this.#choices.notifications)
      return next;
    const now = this.services.clock();
    const payload: LinkMailAuditPayload = { byAccountId: by.accountId, ...next };
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
      await tx
        .update(applianceState)
        .set({ linkMailOffline: next.offline, linkMailNotifications: next.notifications, updatedAt: now })
        .where(eq(applianceState.id, STATE_ID));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'link.mail_set',
        actorAccountId: by.accountId,
        endpointId: by.endpointId,
        payload,
        at: now,
      });
    });
    this.#choices = next;
    this.services.log.info(next, 'link: the owner chose which emails Whombat Link sends');
    await this.tell();
    return next;
  }

  /** Link moved: control may not have the choices (a box it didn't know, Link on again), so they are told again. */
  linkMoved(): void {
    this.#told = null;
    this.#localeRefusedAt = null;
    void this.tell();
  }

  /** Owner's language changed: sync the new locale to control for offline and waiting emails. */
  localeChanged(): void {
    this.#told = null;
    this.#localeRefusedAt = null;
    void this.tell();
  }

  /** Whether control refused the language a short while ago, so it isn't asked with it again yet. */
  private localeRefusedNow(): boolean {
    return (
      this.#localeRefusedAt !== null &&
      this.services.clock().getTime() - this.#localeRefusedAt < LOCALE_RETRY_MS
    );
  }

  /**
   * Tells control the choices when it knows the box and hasn't taken these yet (one at a time). A failure is logged and
   * tried again at the next chance (the runtime's five-minute sweep, a Link move, the owner's next change).
   */
  tell(): Promise<void> {
    this.#telling ??= this.tellOnce().finally(() => {
      this.#telling = null;
    });
    return this.#telling;
  }

  private async tellOnce(): Promise<void> {
    const send = this.manager.linkMailSet?.bind(this.manager);
    if (!send || !this.link.known()) return;
    const choices = this.#choices;
    const configured = await configuredBoxLocale(this.services).catch(() => null);
    // While control refuses the language, the choices go without it, and that is all there is to tell.
    const locale = configured && !this.localeRefusedNow() ? configured : null;
    const keyOf = (sent: string | null) => `${choices.offline}/${choices.notifications}/${sent ?? ''}`;
    if (this.#told === keyOf(locale)) return;
    const plain = { offline: choices.offline, notifications: choices.notifications };
    try {
      await send({ ...plain, ...(locale ? { locale } : {}) });
      // The owner may have changed them meanwhile: only what was sent counts as told.
      this.#told = keyOf(locale);
      if (locale) this.#localeRefusedAt = null;
    } catch (err) {
      if (locale && refusesLocale(err)) {
        try {
          await send(plain);
          // Told without the language: a later sweep asks with it once `LOCALE_RETRY_MS` has passed.
          this.#told = keyOf(null);
          this.#localeRefusedAt = this.services.clock().getTime();
          this.services.log.info('link: Whombat Link took the email choices without the language');
          return;
        } catch {}
      }
      this.services.log.info(
        { status: err instanceof ManagerCallError ? err.status : undefined, err: String(err).slice(0, 200) },
        'link: the email choices weren’t told to Whombat Link yet',
      );
    }
  }

  /**
   * Whether the notification email goes through Link now: the owner chose it, Link is on or in grace, and no mail server
   * of the owner's own sends it (that one wins).
   */
  sendsWaiting(): boolean {
    if (!this.#choices.notifications || !this.manager.mailSend) return false;
    if (this.services.boxMail.availableNow()) return false;
    const state = this.link.state;
    return this.link.view().enabled && (state === 'on' || state === 'grace');
  }

  /** Whether notices go through Link now: the owner chose it and control knows the box (an ended Link included). */
  sendsNotices(): boolean {
    return this.#choices.notifications && Boolean(this.manager.mailSend) && this.link.known();
  }

  /** A keyed hash of what an email is about, so no id leaves the box (the contract's `LinkMailRef`). */
  private ref(what: string): string {
    return createHmac('sha256', this.#refKey).update(what).digest('base64url').slice(0, 32);
  }

  /**
   * The notification email through Link (the digest, notification email's EP-15): `count` things wait for
   * `accountId`, sent `cadence` as they chose; `path` the box's page that shows them. Only for the box's person. Whether
   * it was handed to control.
   */
  async waiting(
    accountId: string,
    count: number,
    cadence: 'hourly' | 'daily',
    path: string,
  ): Promise<boolean> {
    if (!this.sendsWaiting() || count < 1) return false;
    if ((await this.person().catch(() => null)) !== accountId) return false;
    const locale = await this.mailLocale();
    return this.send({
      kind: 'waiting',
      ref: this.ref(`waiting:${accountId}:${this.services.clock().toISOString()}`),
      count: Math.min(count, 999),
      cadence,
      ...(/^\/[A-Za-z0-9/_.~%?&=-]{0,199}$/.test(path) ? { path } : {}),
      ...(locale ? { locale } : {}),
    });
  }

  /**
   * A notice about the box in fixed words, by email too when the owner chose it (`ControlPush.notice`): the same two
   * lines as the push. Not while a restored box waits in quarantine, unless the notice is the one it may send then.
   */
  async notice(
    what: string,
    notice: SecurityNotice,
    options: { evenInQuarantine?: boolean } = {},
  ): Promise<boolean> {
    if (!this.sendsNotices()) return false;
    if (this.services.maintenance.quarantined && !options.evenInQuarantine) return false;
    const path = notice.path.startsWith('/') && notice.path.length <= 200 ? notice.path : undefined;
    const locale = await this.mailLocale();
    return this.send({
      kind: 'notice',
      ref: this.ref(`notice:${what}:${this.services.clock().toISOString()}`),
      title: line(notice.title, 80),
      body: line(notice.body, 240),
      ...(path ? { path } : {}),
      ...(locale ? { locale } : {}),
    });
  }

  /** The language an email asks for: the owner's, unless control refused it a short while ago. */
  private async mailLocale(): Promise<string | null> {
    if (this.localeRefusedNow()) return null;
    return configuredBoxLocale(this.services).catch(() => null);
  }

  private async send(mail: Parameters<NonNullable<ManagerPort['mailSend']>>[0]): Promise<boolean> {
    const send = this.manager.mailSend?.bind(this.manager);
    if (!send) return false;
    try {
      await send(mail);
      this.services.log.info({ kind: mail.kind }, 'link: an email went to Whombat Link');
      return true;
    } catch (err) {
      if ('locale' in mail && mail.locale && refusesLocale(err)) {
        const { locale: _l, ...withoutLocale } = mail;
        try {
          await send(withoutLocale as Parameters<NonNullable<ManagerPort['mailSend']>>[0]);
          // Control took it without the language: the next emails and the choices go without it for a while.
          this.#localeRefusedAt = this.services.clock().getTime();
          this.services.log.info({ kind: mail.kind }, 'link: an email went to Whombat Link');
          return true;
        } catch {}
      }
      // Control's refusal says the choice it has is off: tell it again at the next chance.
      if (err instanceof ManagerCallError && err.status === 502) this.#told = null;
      this.services.log.warn(
        {
          kind: mail.kind,
          status: err instanceof ManagerCallError ? err.status : undefined,
          err: String(err).slice(0, 200),
        },
        'link: an email didn’t go to Whombat Link',
      );
      return false;
    }
  }
}

const emails = new WeakMap<object, LinkEmail>();

/** The runtime's email through Link for these services (the digest, notices and capabilities read it). */
export function setLinkEmailFor(services: object, email: LinkEmail): void {
  emails.set(services, email);
}

export function linkEmailOf(services: object): LinkEmail | null {
  return emails.get(services) ?? null;
}
