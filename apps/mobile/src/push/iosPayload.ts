/**
 * iOS: what a delivered or tapped Whombat notification says, from its APNs payload. Pure, so the phone's two kinds of
 * Whombat alert — a managed Whombat's (control's `w: {kind, ref, tag}`) and a self-hosted one's (`path`, `burrow`,
 * `notificationId`) — are read the same way by the tap, the shade check and the inbox refresh.
 */
import type { ShadeNotification } from '../../modules/whombat-live';

/** The parts of an expo-notifications request this reads. */
export interface PushRequestLike {
  identifier: string;
  content: { data?: unknown };
  trigger?: unknown;
}

/**
 * The payload of a remote notification. expo-notifications' `content.data` holds only the Expo push service's own
 * `body` key for a push; Whombat's keys sit at the top of the APNs payload, which only the trigger keeps.
 */
export function pushPayload(
  request: Pick<PushRequestLike, 'content' | 'trigger'>,
): Record<string, unknown> | null {
  const trigger = request.trigger as { type?: unknown; payload?: unknown } | null | undefined;
  if (trigger && trigger.type === 'push' && trigger.payload && typeof trigger.payload === 'object')
    return trigger.payload as Record<string, unknown>;
  const data = request.content.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

/** A managed Whombat's push: its kind and opaque ref, or null. */
export function managedPush(payload: Record<string, unknown> | null): { kind: string; ref: string } | null {
  const w = payload?.w;
  if (!w || typeof w !== 'object') return null;
  const { kind, ref } = w as Record<string, unknown>;
  return typeof kind === 'string' && kind && typeof ref === 'string' && ref ? { kind, ref } : null;
}

/** A Whombat alert of either kind (anything else on the phone is left alone). */
export function isWhombatPush(payload: Record<string, unknown> | null): boolean {
  return !!managedPush(payload) || (typeof payload?.path === 'string' && payload.path !== '');
}

/** Epoch ms. iOS gives a delivered notification's date in seconds. */
export function epochMs(date: number): number {
  return date < 1e11 ? Math.round(date * 1000) : date;
}

/**
 * A delivered Whombat notification as the shade check sees it (`readInShade`), or null for anything else. Its tag is
 * the request's identifier, which iOS sets to the push's `apns-collapse-id` (the thread or approval), so dismissing
 * by tag removes exactly that notification.
 */
export function shadeEntry(n: { date: number; request: PushRequestLike }): ShadeNotification | null {
  const payload = pushPayload(n.request);
  const tag = n.request.identifier;
  const postedAt = epochMs(n.date);
  const managed = managedPush(payload);
  if (managed) return { tag, postedAt, kind: managed.kind, ref: managed.ref };
  const notificationId = payload?.notificationId;
  if (typeof notificationId !== 'string' || !notificationId) return null;
  const { burrow, path } = payload as Record<string, unknown>;
  return {
    tag,
    postedAt,
    notificationId,
    ...(typeof burrow === 'string' && burrow ? { burrow } : {}),
    ...(typeof path === 'string' && path ? { path } : {}),
  };
}
