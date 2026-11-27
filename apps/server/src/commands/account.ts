/**
 * Account-level and private per-viewer writes: preferences (theme, avatar motion), push devices and live activities,
 * notification read state. They run through `pipeline.transactAccount` (one transaction, outbox, hooks)
 * but are not burrow actions, so they are not signed into a burrow's audit log.
 */
import {
  AssistantPreferences,
  ChatPreferences,
  DEFAULT_PREFERENCES,
  NotificationPreferences,
  newId,
  normalizeLocaleTag,
  type Preferences,
} from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accounts, devices, liveActivities, notifications } from '../db/schema/index';
import { publishNotificationsRead, unreadNotifications } from '../domain/notification-read';
import { clearReadThreads } from '../domain/notify';
import { notifyLocaleChanged } from '../i18n/locale';
import { ApiError, notFound } from '../lib/errors';
import { webPushEndpointProblem } from '../push/webpush';
import type { Services } from '../services';

export async function updatePreferences(
  services: Services,
  accountId: string,
  patch: Partial<Preferences>,
): Promise<Preferences> {
  return services.pipeline.transactAccount(async (tx, session) => {
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    if (!row) throw notFound('Account');
    const next: Preferences = { ...DEFAULT_PREFERENCES, ...row.preferences };
    const localeUpdated = patch.locale !== undefined;
    if (patch.theme !== undefined) next.theme = patch.theme;
    if (patch.timeZone !== undefined) next.timeZone = patch.timeZone;
    if (patch.locale !== undefined) {
      next.locale = patch.locale === null ? null : (normalizeLocaleTag(patch.locale) ?? null);
    }
    // Replaced whole (CT-82): the toggle and the “Don’t ask again” topics (assistant-guides.md AG-12).
    if (patch.assistant !== undefined)
      next.assistant = AssistantPreferences.parse({
        suggestions: patch.assistant.suggestions,
        dontAsk: [...new Set(patch.assistant.dontAsk)],
      });
    // Replaced whole too (CT-175): Do not disturb, quiet hours, email and thread replies (essentials-people.md EP-14).
    if (patch.notifications !== undefined)
      next.notifications = NotificationPreferences.parse({
        ...patch.notifications,
        schedule: { ...patch.notifications.schedule, days: [...new Set(patch.notifications.schedule.days)] },
      });
    // Replaced whole too: when threads settle by themselves (docs/decisions/chat-settle.md).
    if (patch.chat !== undefined) next.chat = ChatPreferences.parse(patch.chat);
    await tx.update(accounts).set({ preferences: next }).where(eq(accounts.id, accountId));
    if (localeUpdated) {
      session.after(async () => {
        notifyLocaleChanged(services, accountId, next.locale ?? null);
      });
    }
    return next;
  });
}

export interface DeviceInput {
  platform: 'android' | 'ios' | 'web';
  provider: 'fcm' | 'apns' | 'webpush';
  token: string;
  webPush?: { p256dh: string; auth: string };
  name?: string;
  liveActivityToken?: string;
}

/** A web push endpoint is a URL the server POSTs to: only browsers' push services (SSRF, security-fixes.md). */
function assertPushEndpoint(services: Services, provider: DeviceInput['provider'], token: string): void {
  if (provider !== 'webpush') return;
  const problem = webPushEndpointProblem(services.config, token);
  if (problem)
    throw new ApiError('validation_failed', 'That isn’t a web push subscription endpoint.', {
      fields: { token: [problem] },
    });
}

export async function registerDevice(services: Services, accountId: string, input: DeviceInput) {
  assertPushEndpoint(services, input.provider, input.token);
  return services.pipeline.transactAccount(async (tx) => {
    const now = services.clock();
    const [row] = await tx
      .insert(devices)
      .values({
        id: newId('device'),
        accountId,
        platform: input.platform,
        provider: input.provider,
        token: input.token,
        webPush: input.webPush ?? null,
        name: input.name ?? null,
        liveActivityToken: input.liveActivityToken ?? null,
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [devices.accountId, devices.token],
        set: {
          platform: input.platform,
          provider: input.provider,
          webPush: input.webPush ?? null,
          name: input.name ?? null,
          liveActivityToken: input.liveActivityToken ?? null,
          lastSeenAt: now,
        },
      })
      .returning();
    if (!row) throw new Error('device upsert failed');
    return row;
  });
}

async function ownDevice(services: Services, accountId: string, deviceId: string) {
  const [row] = await services.db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.accountId, accountId)));
  if (!row) throw notFound('Device');
  return row;
}

export async function updateDevice(
  services: Services,
  accountId: string,
  deviceId: string,
  patch: { token?: string; liveActivityToken?: string },
) {
  const device = await ownDevice(services, accountId, deviceId);
  if (patch.token) assertPushEndpoint(services, device.provider, patch.token);
  return services.pipeline.transactAccount(async (tx) => {
    const [row] = await tx
      .update(devices)
      .set({
        ...(patch.token ? { token: patch.token } : {}),
        ...(patch.liveActivityToken !== undefined ? { liveActivityToken: patch.liveActivityToken } : {}),
        lastSeenAt: services.clock(),
      })
      .where(eq(devices.id, deviceId))
      .returning();
    if (!row) throw notFound('Device');
    return row;
  });
}

export async function removeDevice(services: Services, accountId: string, deviceId: string): Promise<void> {
  await ownDevice(services, accountId, deviceId);
  await services.pipeline.transactAccount(async (tx) => {
    await tx.delete(devices).where(eq(devices.id, deviceId));
  });
}

export async function registerLiveActivity(
  services: Services,
  accountId: string,
  deviceId: string,
  input: { kind: 'run' | 'approval'; refId: string; pushToken: string },
): Promise<void> {
  await ownDevice(services, accountId, deviceId);
  await services.pipeline.transactAccount(async (tx) => {
    await tx
      .insert(liveActivities)
      .values({ deviceId, kind: input.kind, refId: input.refId, pushToken: input.pushToken })
      .onConflictDoUpdate({
        target: [liveActivities.deviceId, liveActivities.kind, liveActivities.refId],
        set: { pushToken: input.pushToken },
      });
  });
}

/**
 * Marks some or all of a principal's notifications read; returns what is still unread. Their other devices hear what
 * was read (`notification.read`, review-features.md RF-05).
 */
export async function markNotificationsRead(
  services: Services,
  principalId: string,
  which: { ids: string[] } | { all: true },
): Promise<number> {
  return services.pipeline.transactAccount(async (tx, session) => {
    const now = services.clock();
    const filters = [eq(notifications.principalId, principalId), isNull(notifications.readAt)];
    if ('ids' in which) filters.push(inArray(notifications.id, which.ids));
    const marked = await tx
      .update(notifications)
      .set({ readAt: now })
      .where(and(...filters))
      .returning({ id: notifications.id });
    const n = await unreadNotifications(tx, principalId);
    if (marked.length) {
      await publishNotificationsRead(
        session,
        principalId,
        'ids' in which ? { ids: marked.map((r) => r.id) } : { before: now },
        n,
      );
      // The phone's notifications of the threads read, on a managed Whombat (RF-09).
      const readIds = marked.map((r) => r.id);
      session.after(async () => {
        await clearReadThreads(services, principalId, readIds).catch((err) =>
          services.log.warn({ err: String(err) }, 'could not clear read threads'),
        );
      });
    }
    return n;
  });
}
