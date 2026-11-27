/**
 * Push on a managed Whombat (MA-03, MA-10, MA-18; assignment §12): the client registers its push address with
 * control over the cloud session — an app install's FCM/APNs token or a browser's Web Push subscription — and gets
 * an opaque handle, which it gives its appliance over the secure session (`push.handles.set`). The appliance asks
 * control to wake that handle with a generic kind, an opaque ref and (CT-286) a short preview unless the person
 * turned previews off; control passes it on without storing it; a tap opens the app, which fetches what happened
 * through the session.
 *
 * Push state is its own thing, separate from the session's connection state: a phone can receive pushes while no
 * session is open, and a session can be open while pushes are off or denied. Pure: the control API, the session
 * and the store are injected (unit-tested with fakes).
 */
import type { LinkRef } from '@whombat/core/domain';
import { clientTranslator } from '../i18n/catalog';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ControlApi, PushRegistration } from './control';

/** What this install has registered (kept in the platform store; removed on sign-out). */
export interface SavedPush {
  platform: PushRegistration['platform'];
  /** The FCM/APNs token or the Web Push endpoint the handle was issued for. */
  address: string;
  handle: string;
  /** Appliances told this handle (`push.handles.set`). */
  appliances: string[];
}

export interface PushStore {
  get(): Promise<SavedPush | null>;
  set(value: SavedPush): Promise<void>;
  remove(): Promise<void>;
}

/**
 * The push side of the app, shown on its own (never folded into “connected”):
 * - `off`: not set up yet, or turned off here;
 * - `denied`: the person (or the system) refused notifications — only the system settings can change that;
 * - `unavailable`: this build or device has no push service (no Firebase, no VAPID key from control);
 * - `registered`: control has this install's address and the appliance has the handle;
 * - `failed`: control or the appliance couldn't be told (retried at the next start).
 */
export type PushState =
  | { status: 'off' }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: string }
  | { status: 'registering' }
  | { status: 'registered'; handle: string }
  | { status: 'failed'; reason: string };

export function registrationAddress(registration: PushRegistration): string {
  return registration.platform === 'webpush' ? registration.subscription.endpoint : registration.token;
}

/**
 * The handle for this registration: reused while the address is the same, else registered with control (and
 * the previous handle forgotten there, best effort).
 */
export async function ensurePushHandle(
  control: Pick<ControlApi, 'pushRegister' | 'pushUnregister'>,
  store: PushStore,
  registration: PushRegistration,
): Promise<SavedPush> {
  const address = registrationAddress(registration);
  const saved = await store.get();
  if (saved && saved.address === address && saved.platform === registration.platform) return saved;
  if (saved) await control.pushUnregister(saved.handle).catch(() => {});
  const { handle } = await control.pushRegister(registration);
  const next: SavedPush = { platform: registration.platform, address, handle, appliances: [] };
  await store.set(next);
  return next;
}

/** Gives the appliance this install's handle (idempotent: the appliance keeps one handle per endpoint). */
export async function tellAppliance(
  session: ApplianceSession,
  store: PushStore,
  device: string,
  saved: SavedPush,
): Promise<SavedPush> {
  await sessionOps.pushHandlesSet(session, saved.handle);
  const current = (await store.get()) ?? saved;
  if (current.handle !== saved.handle || current.appliances.includes(device)) return current;
  const next = { ...current, appliances: [...current.appliances, device] };
  await store.set(next);
  return next;
}

/**
 * Sign-out or turning notifications off: the open appliance forgets the handle (when a session is at hand),
 * control forgets it, and so does this install. Every step is best effort: signing out must always finish.
 */
export async function clearPush(
  control: Pick<ControlApi, 'pushUnregister'>,
  store: PushStore,
  session?: ApplianceSession | null,
): Promise<void> {
  const saved = await store.get();
  await store.remove();
  if (!saved) return;
  if (session) await sessionOps.pushHandlesClear(session).catch(() => {});
  await control.pushUnregister(saved.handle).catch(() => {});
}

/**
 * This device was removed from an appliance (revocation): that appliance won't wake it any more (it drops
 * revoked endpoints), so it is only taken off the local list; the handle stays for the other appliances.
 */
export async function forgetAppliance(store: PushStore, device: string): Promise<void> {
  const saved = await store.get();
  if (!saved?.appliances.includes(device)) return;
  await store.set({ ...saved, appliances: saved.appliances.filter((d) => d !== device) });
}

/** A generic push's kind (control's `PushKind`), as a tap delivers it. */
export type PushKind =
  | 'message'
  | 'mention'
  | 'approval'
  | 'run'
  | 'update'
  | 'backup'
  | 'security'
  | 'generic';

const KINDS = new Set<PushKind>([
  'message',
  'mention',
  'approval',
  'run',
  'update',
  'backup',
  'security',
  'generic',
]);

export function pushKindOf(value: unknown): PushKind {
  return typeof value === 'string' && KINDS.has(value as PushKind) ? (value as PushKind) : 'generic';
}

/**
 * What a notification says when it has no preview (CT-286: an appliance before contracts 0.51, or previews turned off
 * in Settings → Notifications), and on Android's lock screen with sensitive content hidden: one line per kind. What
 * happened is fetched through the session after the tap. The same words as Android's `LiveNotifications.GENERIC_TEXT`
 * and the web's `sw.js` (both checked by tests).
 */
export function pushText(locale?: string | null): Record<PushKind, string> {
  const tr = clientTranslator(locale);
  return {
    message: tr.t('push.message'),
    mention: tr.t('push.mention'),
    approval: tr.t('push.approval'),
    run: tr.t('push.run'),
    update: tr.t('push.update'),
    backup: tr.t('push.backup'),
    security: tr.t('push.security'),
    generic: tr.t('push.generic'),
  };
}

export const PUSH_TEXT: Record<PushKind, string> = pushText();

/**
 * What a tapped push opens (CT-49): the appliance maps the push's opaque ref back to the item (`push.resolve`), if
 * this person may still see it.
 * - `link`: open it in its burrow;
 * - `inbox` (`missing`): the appliance answered `not_found` (gone, or no longer visible — the same answer): the inbox
 *   with a quiet note; without `missing` (the question couldn't be asked, e.g. offline) just the inbox;
 * - `by_kind`: this appliance predates `push.resolve` (`unknown_op`): fall back to `pushTarget` over the inbox.
 */
export type PushOpen =
  | { to: 'link'; burrow: string; link: LinkRef }
  | { to: 'inbox'; missing: boolean }
  | { to: 'by_kind' };

export async function resolvePushRef(session: ApplianceSession, ref: string): Promise<PushOpen> {
  try {
    const r = await sessionOps.pushResolve(session, ref);
    return { to: 'link', burrow: r.burrow, link: r.link };
  } catch (error) {
    if (error instanceof OperationError && error.code === 'unknown_op') return { to: 'by_kind' };
    return { to: 'inbox', missing: error instanceof OperationError && error.code === 'not_found' };
  }
}

/**
 * Where a tapped generic push leads on an appliance without `push.resolve` (the fallback of `resolvePushRef`),
 * decided from what the session says now (never from the push itself).
 */
export type PushTarget =
  | { to: 'item'; item: { id: string; burrow: string; link: unknown; approvalId: string | null } }
  | { to: 'inbox' }
  | { to: 'appliance' };

interface InboxLike {
  id: string;
  kind: 'needs_you' | 'mention' | 'agent_update' | 'direct' | 'reply';
  link: { type: string };
  approvalId: string | null;
  createdAt: string;
  readAt: string | null;
}

/**
 * Resolves a tapped push against the inbox fetched through the session: the newest unread row of the push's kind
 * (an approval push opens the approval waiting for the person), the appliance's own state for update, backup and
 * security pushes, else the inbox. The push's ref is opaque (CT-32) and is not interpreted here.
 */
export function pushTarget(kind: PushKind, burrow: string, items: readonly InboxLike[]): PushTarget {
  if (kind === 'update' || kind === 'backup' || kind === 'security') return { to: 'appliance' };
  const unread = items
    .filter((i) => i.readAt === null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const pick = (test: (i: InboxLike) => boolean) => unread.find(test);
  const found =
    kind === 'approval'
      ? (pick((i) => i.kind === 'needs_you' && i.approvalId !== null) ?? pick((i) => i.kind === 'needs_you'))
      : kind === 'mention'
        ? pick((i) => i.kind === 'mention' || i.kind === 'reply')
        : kind === 'run'
          ? (pick((i) => i.link.type === 'run') ?? pick((i) => i.kind === 'agent_update'))
          : kind === 'message'
            ? (pick((i) => i.kind === 'direct') ?? pick((i) => i.kind === 'agent_update'))
            : unread[0];
  if (!found) return { to: 'inbox' };
  return { to: 'item', item: { id: found.id, burrow, link: found.link, approvalId: found.approvalId } };
}
