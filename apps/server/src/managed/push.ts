/**
 * Push on a managed appliance (MA-03, MA-10; CT-11; docs/decisions/managed-runtime.md MR-13). The push transports
 * are off in managed mode: each notification becomes a control `PushRequest` through the manager — a generic kind,
 * an opaque ref and collapse key (hashes, not ids), the recipients' opaque push handles (`push.handles.set`) and,
 * since contracts 0.51, a short preview (who and the start of the text, NT-14) unless the person turned previews
 * off. The collapse key keeps one notification per thread or approval on the phone (NT-15); `clear` removes a
 * decided approval's (NT-16). The app fetches the rest through its session.
 */
import { hkdfSync, randomBytes } from 'node:crypto';
import type { PushKind, PushRequest } from '@whombat/control-contracts/device';
import { type LinkRef, notificationPreferencesOf, type PushPayload } from '@whombat/core';
import { PushRef, pushRefFor } from '@whombat/protocol/session';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { managedAppOrigin } from '../config';
import {
  accounts,
  applianceEndpoints,
  burrows,
  messages,
  notifications,
  principals,
} from '../db/schema/index';
import { previewBody, previewTitle, pushKind } from '../domain/push-preview';
import { ApiError } from '../lib/errors';
import type { ControlPushOptions } from '../push/sender';
import type { Services } from '../services';
import { ManagerCallError, type ManagerPort } from './ports';
import { appPageTarget, type SecurityNotice, SecurityPushes } from './security-push';

export { pushKind } from '../domain/push-preview';

export const PUSH_MAX_HANDLES = 50;
export const PUSH_TTL_S = 3_600;

/**
 * The push ref (CT-32 `PushRef`): HMAC-SHA256 with an appliance-local key (`pushRefFor`), so what reaches Apple and
 * Google is neither an id nor an unkeyed derivation. The key comes from `WHOMBAT_MASTER_KEY` (HKDF, its own label);
 * without one (development) a random key of this process.
 */
let refKey: Uint8Array | null = null;
function pushRefKey(masterKey: string | undefined): Uint8Array {
  if (!refKey)
    refKey = masterKey
      ? new Uint8Array(hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), 'whombat', 'push-ref/1', 32))
      : new Uint8Array(randomBytes(32));
  return refKey;
}

export function opaqueRef(salt: string, value: string, masterKey?: string): string {
  return PushRef.parse(pushRefFor(pushRefKey(masterKey), `${salt}:${value}`));
}

/** What the push is about, without content: the notification, else the run or approval behind a live activity. */
function subject(payload: PushPayload): string {
  return (
    payload.notificationId ??
    (payload.run ? `run:${payload.burrow}:${payload.run.number}` : null) ??
    (payload.approval ? `approval:${payload.burrow}:${payload.approval.number}` : `burrow:${payload.burrow}`)
  );
}

export class ControlPush {
  readonly #security = new SecurityPushes(PUSH_TTL_S * 1000);
  readonly #offResolver: () => void;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    /**
     * Whether control may be asked at all: not once the owner turned Whombat Link off, `security` pushes included, so
     * off means the box sends nothing; an ended Link still sends them (control lets `security` through), so a safety
     * notice never depends on paying (docs/decisions/whombat-link.md).
     */
    private readonly sends: () => boolean = () => true,
  ) {
    // A tap on a security push opens the page it is about (push-words.md PW-03).
    this.#offResolver = registerPushResolver(services, (accountId, ref) =>
      this.#resolveSecurity(accountId, ref),
    );
  }

  close(): void {
    this.#offResolver();
  }

  /**
   * A security notice (a new device, the recovery kit, remote help) to the accounts' devices: its words as the preview,
   * except for someone who turned previews off, who gets the phone's generic line for `security`. `what` names the
   * event (the ref and collapse key are its keyed hashes); a tap opens the notice's page.
   */
  async security(accountIdsIn: readonly string[], what: string, notice: SecurityNotice): Promise<void> {
    await this.notice('security', accountIdsIn, what, notice);
  }

  /**
   * A notice about the box in fixed words (a `security` one, or a `backup` one: the restore is done): its words as the
   * preview unless previews are off, its tap opening its page. `evenInQuarantine`: the one push a restored box sends
   * before the person answered — that it is back and waits for them.
   */
  async notice(
    kind: 'security' | 'backup',
    accountIdsIn: readonly string[],
    what: string,
    notice: SecurityNotice,
    options: { evenInQuarantine?: boolean } = {},
  ): Promise<void> {
    const accountIds = [...new Set(accountIdsIn)];
    if (!accountIds.length) return;
    this.#security.remember(what, accountIds, notice.path, this.services.clock().getTime());
    const rows = await this.services.db
      .select({ id: accounts.id, preferences: accounts.preferences })
      .from(accounts)
      .where(inArray(accounts.id, accountIds));
    const quiet = new Set(
      rows
        .filter((r) => r.preferences && notificationPreferencesOf(r.preferences).previews === false)
        .map((r) => r.id),
    );
    const plain = accountIds.filter((id) => quiet.has(id));
    const told = accountIds.filter((id) => !quiet.has(id));
    const preview = { title: previewTitle(notice.title), body: previewBody(notice.body) };
    const quarantine = options.evenInQuarantine ? { evenInQuarantine: true } : {};
    if (told.length) await this.forAccounts(told, kind, what, { preview }, quarantine);
    if (plain.length) await this.forAccounts(plain, kind, what, {}, quarantine);
  }

  async #resolveSecurity(accountId: string, ref: string): Promise<PushTarget | null> {
    const key = this.services.config.WHOMBAT_MASTER_KEY;
    const hit = this.#security.resolve(ref, accountId, this.services.clock().getTime(), (what) =>
      opaqueRef('ref', what, key),
    );
    if (!hit) return null;
    let origin: string;
    try {
      origin = managedAppOrigin(this.services.config);
    } catch {
      return null;
    }
    const [place] = await this.services.db
      .select({ slug: burrows.slug })
      .from(principals)
      .innerJoin(burrows, eq(burrows.id, principals.burrowId))
      .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')))
      .limit(1);
    return place ? appPageTarget(place.slug, origin, hit.path) : null;
  }

  /** A manager on contracts 0.50 refused a preview or a clear (NT-18): said once per process. */
  private olderManagerSaid = false;

  /** Asks control to wake the recipients' enrolled endpoints that registered a push handle. */
  async forPrincipals(
    principalIds: readonly string[],
    payload: PushPayload,
    options: ControlPushOptions = {},
  ): Promise<void> {
    const ids = [...new Set(principalIds)];
    if (!ids.length) return;
    const accountRows = await this.services.db
      .select({ accountId: principals.accountId })
      .from(principals)
      .where(inArray(principals.id, ids));
    const accountIds = accountRows.map((r) => r.accountId).filter((a): a is string => !!a);
    await this.forAccounts(accountIds, pushKind(payload.kind), subject(payload), options);
  }

  /**
   * Wakes the accounts' enrolled endpoints that registered a push handle: a generic `kind`, opaque hashes of `what`
   * (the ref) and of the group (the collapse key; `what` without one), and the preview when there is one.
   */
  async forAccounts(
    accountIdsIn: readonly string[],
    kind: PushKind,
    what: string,
    options: ControlPushOptions = {},
    gate: { evenInQuarantine?: boolean } = {},
  ): Promise<void> {
    // Quarantine (a restored replacement): no outbound effects, but the notice that it waits for the person.
    if (this.services.maintenance.quarantined && !gate.evenInQuarantine) return;
    if (!this.sends()) return;
    const accountIds = [...new Set(accountIdsIn)];
    if (!accountIds.length) return;
    const db = this.services.db;
    const rows = await db
      .select({
        id: applianceEndpoints.id,
        handle: applianceEndpoints.pushHandle,
        boxHandle: applianceEndpoints.pushTokenHandle,
      })
      .from(applianceEndpoints)
      .where(
        and(
          inArray(applianceEndpoints.accountId, accountIds),
          isNull(applianceEndpoints.revokedAt),
          or(isNotNull(applianceEndpoints.pushHandle), isNotNull(applianceEndpoints.pushTokenHandle)),
          // A screen is nobody's phone: it never sets a handle, and never gets one used if it somehow had one.
          ne(applianceEndpoints.enrolledVia, 'display'),
        ),
      );
    // The handle this box registered for the phone's own token (push through the box, whombat-link.md LNK-36) wins
    // over one the phone registered through its Whombat account, so a phone with both is woken once.
    const handles = [...new Set(rows.map((r) => (r.boxHandle ?? r.handle) as string))];
    for (let i = 0; i < handles.length; i += PUSH_MAX_HANDLES) {
      const batch = handles.slice(i, i + PUSH_MAX_HANDLES);
      const key = this.services.config.WHOMBAT_MASTER_KEY;
      const request: PushRequest = {
        kind,
        ref: opaqueRef('ref', what, key),
        handles: batch,
        collapseKey: opaqueRef('collapse', options.group ?? what, key),
        ttlS: PUSH_TTL_S,
        ...(options.clear ? { clear: true } : options.preview ? { preview: options.preview } : {}),
      };
      try {
        const result = await this.send(request);
        if (!result) continue;
        // Handles control no longer knows are dropped.
        for (const handle of result.invalidHandles) {
          await db
            .update(applianceEndpoints)
            .set({ pushHandle: null })
            .where(eq(applianceEndpoints.pushHandle, handle));
          // The phone's token stays: it is registered again with the next Link change or sweep.
          await db
            .update(applianceEndpoints)
            .set({ pushTokenHandle: null })
            .where(eq(applianceEndpoints.pushTokenHandle, handle));
        }
      } catch (err) {
        this.services.log.warn({ err: String(err) }, 'push request failed');
      }
    }
  }

  /**
   * One request; a manager on contracts 0.50 refuses `preview` and `clear` (strict schemas, NT-18): the request goes
   * again without its preview, a clear is dropped (null).
   */
  private async send(request: PushRequest) {
    try {
      return await this.manager.push(request);
    } catch (err) {
      if (!(request.preview || request.clear) || !refusedAsUnknown(err)) throw err;
      if (!this.olderManagerSaid) {
        this.olderManagerSaid = true;
        this.services.log.warn(
          { err: String(err) },
          'the manager refused a push preview (contracts before 0.51?): sending without previews',
        );
      }
      if (request.clear) return null;
      const { preview: _preview, ...plain } = request;
      return await this.manager.push(plain);
    }
  }
}

/** The manager's (400 `bad_request`) or control's (502 `control_refused`) answer to a request it can't parse. */
function refusedAsUnknown(err: unknown): boolean {
  return (
    err instanceof ManagerCallError &&
    (err.status === 400 || err.code === 'bad_request' || err.code === 'control_refused')
  );
}

/** Inbox items a notification tap can resolve for the person: the inbox's own window (`inbox`, 200). */
export const PUSH_RESOLVE_WINDOW = 200;

/** Where a notification tap opens: a burrow (its slug) and a link in it. */
export interface PushTarget {
  burrow: string;
  link: LinkRef;
}

/**
 * A push that isn't an inbox item (the desk screen's unlock request, desk-display-server.md DK-S21): matches the keyed
 * ref of a push it sent to this account and says where its tap opens, else null.
 */
export type PushRefResolver = (accountId: string, ref: string) => Promise<PushTarget | null>;

const pushResolvers = new WeakMap<object, Set<PushRefResolver>>();

/** Adds a resolver for these services' `push.resolve`; returns the function that takes it away. */
export function registerPushResolver(services: object, resolver: PushRefResolver): () => void {
  const set = pushResolvers.get(services) ?? new Set<PushRefResolver>();
  set.add(resolver);
  pushResolvers.set(services, set);
  return () => {
    set.delete(resolver);
  };
}

/**
 * `push.resolve {ref}` (contracts 0.5.2 CT-49, MA-20; MR-39): a notification tap. The ref is a keyed hash, so it is
 * matched, never reversed: against the pushes a registered resolver sent (the desk's unlock request), then the refs of
 * the caller's own inbox items (each of the account's person principals, the inbox's window), and a message link also
 * needs the caller still in its conversation. Anything else — an unknown ref, someone else's, an item that aged out or
 * a room the caller left — answers the same `not_found`.
 */
export async function resolvePushRef(
  services: Services,
  accountId: string,
  ref: string,
): Promise<PushTarget> {
  const notFound = () => new ApiError('not_found', 'Nothing to open for this notification.');
  const wanted = PushRef.safeParse(ref);
  if (!wanted.success) throw notFound();
  for (const resolve of pushResolvers.get(services) ?? []) {
    const hit = await resolve(accountId, wanted.data);
    if (hit) return hit;
  }
  const db = services.db;
  const people = await db
    .select({ id: principals.id })
    .from(principals)
    .where(
      and(
        eq(principals.accountId, accountId),
        eq(principals.kind, 'person'),
        // A burrow the account left opens nothing any more (essentials-people.md EP-02).
      ),
    );
  for (const person of people) {
    const rows = await db
      .select({ id: notifications.id, burrowId: notifications.burrowId, link: notifications.link })
      .from(notifications)
      .where(eq(notifications.principalId, person.id))
      .orderBy(desc(notifications.createdAt))
      .limit(PUSH_RESOLVE_WINDOW);
    const row = rows.find((r) => opaqueRef('ref', r.id, services.config.WHOMBAT_MASTER_KEY) === wanted.data);
    if (!row) continue;
    if (row.link.type === 'message') {
      const [message] = await db
        .select({ burrowId: messages.burrowId })
        .from(messages)
        .where(eq(messages.id, row.link.messageId));
      if (!message || message.burrowId !== row.burrowId) throw notFound();
    }
    const [burrow] = await db
      .select({ slug: burrows.slug })
      .from(burrows)
      .where(eq(burrows.id, row.burrowId));
    if (!burrow) throw notFound();
    return { burrow: burrow.slug, link: row.link };
  }
  throw notFound();
}
