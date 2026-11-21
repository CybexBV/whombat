/**
 * Push through the box (Whombat Link, docs/decisions/whombat-link.md LNK-36; contracts 4.4 `push.token.*`,
 * `push.register`, `push.unregister`). The phone gives its own APNs or FCM token to the box over its session; the box
 * keeps it on the device's endpoint and, while Link runs (starting, on, grace), registers it at control through the
 * manager, which answers a handle bound to this box. Pushes then go to that handle (`push.ts`). A token given while Link
 * is off waits and is registered once Link runs. Clearing the token, or removing the device, unregisters the handle
 * while control knows the box. Handles a phone registered through its Whombat account (`push.handles.set`) keep working.
 *
 * The token is the phone's secret: never logged, never in an event.
 */
import type { NativePushToken } from '@whombat/protocol';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { applianceEndpoints } from '../../db/schema/index';
import type { Services } from '../../services';
import { ManagerCallError, type ManagerPort } from '../ports';
import type { LinkService } from './service';

export class PushTokens {
  #syncing: Promise<void> | null = null;

  constructor(
    private readonly services: Services,
    private readonly manager: ManagerPort,
    private readonly link: LinkService,
  ) {}

  /** `push.token.set` for `endpointId`: kept, and registered now when Link runs. Whether it is registered. */
  async set(endpointId: string, token: NativePushToken): Promise<boolean> {
    const [row] = await this.services.db
      .select({ token: applianceEndpoints.pushToken, handle: applianceEndpoints.pushTokenHandle })
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, endpointId));
    const same = row?.token && sameToken(row.token, token);
    if (same && row?.handle) return true;
    // A new token replaces the old one; its handle goes at control.
    if (row?.handle && !same) await this.unregister(row.handle);
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx
        .update(applianceEndpoints)
        .set({ pushToken: token, pushTokenHandle: null })
        .where(eq(applianceEndpoints.id, endpointId));
    });
    if (!this.link.active()) return false;
    return this.register(endpointId, token);
  }

  /** `push.token.clear` for `endpointId`: forgotten here, and its handle at control while control knows the box. */
  async clear(endpointId: string): Promise<void> {
    await this.forget(endpointId);
  }

  /** A device removed (or its token cleared): its handle goes at control, its token here. */
  async forget(endpointId: string): Promise<void> {
    const [row] = await this.services.db
      .select({ handle: applianceEndpoints.pushTokenHandle, token: applianceEndpoints.pushToken })
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, endpointId));
    if (!row || (!row.handle && !row.token)) return;
    if (row.handle) await this.unregister(row.handle);
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx
        .update(applianceEndpoints)
        .set({ pushToken: null, pushTokenHandle: null })
        .where(eq(applianceEndpoints.id, endpointId));
    });
  }

  /**
   * Registers every kept token without a handle (Link just started to run) and forgets the handles of removed devices
   * (one sweep at a time). Nothing to do while Link is off.
   */
  sync(): Promise<void> {
    this.#syncing ??= this.syncOnce().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  private async syncOnce(): Promise<void> {
    if (this.link.known()) {
      const removed = await this.services.db
        .select({ id: applianceEndpoints.id })
        .from(applianceEndpoints)
        .where(and(isNotNull(applianceEndpoints.revokedAt), isNotNull(applianceEndpoints.pushTokenHandle)));
      for (const { id } of removed) await this.forget(id);
    }
    if (!this.link.active()) return;
    const waiting = await this.services.db
      .select({ id: applianceEndpoints.id, token: applianceEndpoints.pushToken })
      .from(applianceEndpoints)
      .where(
        and(
          isNull(applianceEndpoints.revokedAt),
          isNotNull(applianceEndpoints.pushToken),
          isNull(applianceEndpoints.pushTokenHandle),
        ),
      );
    for (const row of waiting) {
      if (!row.token) continue;
      if (!(await this.register(row.id, row.token))) break;
    }
  }

  private async register(endpointId: string, token: NativePushToken): Promise<boolean> {
    const register = this.manager.pushRegister?.bind(this.manager);
    if (!register) return false;
    let handle: string;
    try {
      ({ handle } = await register({ token }));
    } catch (err) {
      // Link off at control, or control not answering: kept, tried again with the next Link change or sweep.
      this.services.log.info(
        { status: err instanceof ManagerCallError ? err.status : 0, code: (err as ManagerCallError).code },
        'push: a phone’s token wasn’t registered yet',
      );
      return false;
    }
    // The token is compared in the same transaction that writes the handle: a late answer for a token the phone
    // replaced meanwhile must not overwrite the newer token's handle.
    const kept = await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select({ token: applianceEndpoints.pushToken, handle: applianceEndpoints.pushTokenHandle })
        .from(applianceEndpoints)
        .where(and(eq(applianceEndpoints.id, endpointId), isNull(applianceEndpoints.revokedAt)))
        .for('update');
      if (!row?.token || !sameToken(row.token, token)) return { kind: 'stale' as const, held: null };
      // The same token registered twice at once (a sweep and a `push.token.set`): the first handle stays.
      if (row.handle) return { kind: 'held' as const, held: row.handle };
      await tx
        .update(applianceEndpoints)
        .set({ pushTokenHandle: handle })
        .where(eq(applianceEndpoints.id, endpointId));
      return { kind: 'stored' as const, held: handle };
    });
    if (kept.kind === 'stored') return true;
    // Removed, given another token meanwhile, or already registered: this handle is nobody's. Control answers the
    // same handle for the same token, so a second registration of it may have got the very handle the row keeps:
    // that one stays.
    if (handle !== kept.held) await this.unregister(handle);
    return kept.kind === 'held';
  }

  private async unregister(handle: string): Promise<void> {
    const unregister = this.manager.pushUnregister?.bind(this.manager);
    if (!unregister || !this.link.known()) return;
    try {
      await unregister({ handle });
    } catch (err) {
      // Control lets an unused handle run out after 90 days: a lost unregister costs nothing more.
      this.services.log.info({ err: String(err).slice(0, 200) }, 'push: a handle wasn’t unregistered');
    }
  }
}

function sameToken(a: NativePushToken, b: NativePushToken): boolean {
  return a.platform === b.platform && a.token === b.token && a.appId === b.appId;
}
