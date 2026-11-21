/**
 * Who a message notifies, through the real commit pipeline (docs/decisions/essentials-people.md EP-10…EP-14):
 * conversation levels (conversations.setNotify), mentions, `@channel` / `@here`, thread replies, DMs, direct
 * conversations, the edit entry point, quiet time holding push back, and the preferences that drive them.
 */
import type { PushPayload, RealtimeEvent } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updatePreferences } from '../commands/account';
import { sendMessage } from '../commands/messages';
import { messages, notifications } from '../db/schema/index';
import type { ControlPushOptions } from '../push/sender';
import { presenceFor } from '../realtime/presence-tracker';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { accountOf, sessionFor } from '../test/tokens';
import { messageDedupKey, notifyForMessage } from './message-notify';
import { notify } from './notify';

const t = useTestServer({ seed: true, app: true });
const B = '/api/v1/burrows/burrow-hq';
const cookies: Record<string, string> = {};
const pushes: { to: string[]; payload: PushPayload; options: ControlPushOptions | undefined }[] = [];
const meFrames: { topic: string; event: RealtimeEvent }[] = [];

beforeAll(async () => {
  cookies[IDS.mara] = (await sessionFor(t.services, IDS.mara)).cookie;
  // Every push the server would send, with or without a device (the managed hook is the first thing notify calls).
  t.services.push.control = async (to, payload, options) => {
    pushes.push({ to: [...to], payload, options });
  };
  t.services.bus.onFrame((f) => {
    if (f.topic.startsWith('me:')) meFrames.push({ topic: f.topic, event: f.event });
  });
});

beforeEach(() => {
  pushes.length = 0;
  meFrames.length = 0;
});

const call = (who: string, method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: object) =>
  t.api.inject({
    method,
    url: url.startsWith('/me') ? `/api/v1${url}` : `${B}${url}`,
    headers: { cookie: cookies[who] as string },
    ...(payload ? { payload } : {}),
  });

async function post(authorId: string, conversationId: string, text: string, threadRootId?: string) {
  const res = await t.commit(authorId, sendMessage, {
    conversationId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error(`not posted: ${res.status}`);
  return res.result.id;
}

/** Notification rows of a message: `principal:kind`. */
async function rowsOf(messageId: string) {
  const rows = await t.services.db
    .select()
    .from(notifications)
    .where(eq(notifications.dedupKey, messageDedupKey(messageId)));
  return rows.map((r) => `${r.principalId}:${r.kind}`).sort();
}

describe('conversations.setNotify (EP-10)', () => {
  it('sets the viewer’s own level, tells their other devices, shows in lists and detail; null is the default', async () => {
    const room = IDS.pr482;
    const res = await call(IDS.mara, 'PUT', `/conversations/${room}/notify`, { notify: 'all' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ conversationId: room, notify: 'all' });
    expect(meFrames).toContainEqual({
      topic: `me:${IDS.mara}`,
      event: { type: 'conversation.notify', conversationId: room, notify: 'all' },
    });
    const detail = (await call(IDS.mara, 'GET', `/conversations/${room}`)).json();
    expect(detail.notify).toBe('all');
    expect(detail.summary.notify).toBe('all');
    const boot = (await call(IDS.mara, 'GET', '/bootstrap')).json();
    expect(boot.sidebar.branchRooms.find((c: { id: string }) => c.id === room).notify).toBe('all');
    const back = await call(IDS.mara, 'PUT', `/conversations/${room}/notify`, { notify: null });
    expect(back.json()).toEqual({ conversationId: room, notify: 'mentions' });
  });

  it('tells the web what works here (EP-16): email with SMTP, web push with VAPID keys', async () => {
    const boot = (await call(IDS.mara, 'GET', '/bootstrap')).json();
    expect(boot.capabilities).toEqual({ emailNotifications: true, webPush: false });
  });
});

describe('who a message notifies (EP-11, EP-12, EP-13)', () => {
  it('`all` gets every reply and agent update, the default only mentions, `none` nothing', async () => {
    await call(IDS.mara, 'PUT', `/conversations/${IDS.general}/notify`, { notify: 'none' });
    expect(await rowsOf(await post(IDS.dusty, IDS.general, '@Mara can you check the deck?'))).toEqual([]);
    await call(IDS.mara, 'PUT', `/conversations/${IDS.general}/notify`, { notify: null });
    const plain = await post(IDS.dusty, IDS.general, 'Lunch at noon?');
    expect(await rowsOf(plain)).toEqual([]);
    const mention = await post(IDS.dusty, IDS.general, '@Mara can you check the deck?');
    expect(await rowsOf(mention)).toEqual([`${IDS.mara}:mention`]);
  });
  it('an agent’s message notifies by the people’s levels', async () => {
    await call(IDS.mara, 'PUT', `/conversations/${IDS.general}/notify`, { notify: 'all' });
    const id = await post(IDS.dusty, IDS.general, 'I summarized the incident');
    expect(await rowsOf(id)).toEqual([`${IDS.mara}:agent_update`]);
    await call(IDS.mara, 'PUT', `/conversations/${IDS.general}/notify`, { notify: null });
  });

  it('a thread reply reaches the people in the thread, unless they turned thread replies off', async () => {
    const root = await post(IDS.mara, IDS.incidents, 'Staging is slow again');
    const first = await post(IDS.dusty, IDS.incidents, 'Looking', root);
    expect(await rowsOf(first)).toEqual([`${IDS.mara}:reply`]);
    const accountId = await accountOf(t.services, IDS.mara);
    await updatePreferences(t.services, accountId, {
      notifications: {
        dndUntil: null,
        schedule: { enabled: false, start: '22:00', end: '08:00', days: ['mon'] },
        email: 'hourly',
        threadReplies: false,
        previews: true,
      },
    });
    const next = await post(IDS.dusty, IDS.incidents, 'Found it: the cache', root);
    expect(await rowsOf(next)).toEqual([]);
    await updatePreferences(t.services, accountId, {
      notifications: {
        dndUntil: null,
        schedule: { enabled: false, start: '22:00', end: '08:00', days: [] },
        email: 'hourly',
        threadReplies: true,
        previews: true,
      },
    });
  });

  it('an agent’s DM message is an agent update for its person (default `all`); `mentions` mutes it', async () => {
    const id = await post(IDS.dusty, IDS.dmDusty, 'Here are the three receipts.');
    expect(await rowsOf(id)).toEqual([`${IDS.mara}:agent_update`]);
    const [row] = await t.services.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, messageDedupKey(id)));
    expect(row).toMatchObject({ where: 'Direct', messageId: id });
    await call(IDS.mara, 'PUT', `/conversations/${IDS.dmDusty}/notify`, { notify: 'mentions' });
    expect(await rowsOf(await post(IDS.dusty, IDS.dmDusty, 'One more.'))).toEqual([]);
  });

  it('an edit that adds a mention tells that person once, and nobody else again (the edit entry point)', async () => {
    const id = await post(IDS.dusty, IDS.general, 'Deck is ready');
    expect(await rowsOf(id)).toEqual([]);
    // R2's edit changes the text and mentions, then calls the entry point with the added ones.
    await t.services.db
      .update(messages)
      .set({ text: 'Deck is ready @Mara', mentions: [IDS.mara] })
      .where(eq(messages.id, id));
    const burrow = { id: TEST_BURROW_ID, slug: 'burrow-hq' };
    await notifyForMessage(t.services, { burrow, messageId: id, addedMentions: [IDS.mara] });
    await notifyForMessage(t.services, { burrow, messageId: id, addedMentions: [IDS.mara] });
    expect(await rowsOf(id)).toEqual([`${IDS.mara}:mention`]);
  });
});

describe('Do not disturb and quiet hours hold push back; the inbox still fills (EP-14)', () => {
  const quiet = async (who: string, over: { dndUntil?: string | null; quietNow?: boolean }) =>
    updatePreferences(t.services, await accountOf(t.services, who), {
      notifications: {
        dndUntil: over.dndUntil ?? null,
        schedule: over.quietNow
          ? {
              enabled: true,
              start: '00:00',
              end: '00:00',
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
            }
          : { enabled: false, start: '22:00', end: '08:00', days: [] },
        email: 'hourly',
        threadReplies: true,
        previews: true,
      },
    });

  it('DND: an inbox row and its realtime frame, no push; after it ends, push again', async () => {
    await quiet(IDS.mara, { dndUntil: new Date(Date.now() + 3600_000).toISOString() });
    const id = await post(IDS.dusty, IDS.general, '@Mara need you');
    expect(await rowsOf(id)).toContain(`${IDS.mara}:mention`);
    expect(
      meFrames.some((f) => f.topic === `me:${IDS.mara}` && f.event.type === 'notification.created'),
    ).toBe(true);
    expect(pushes.filter((p) => p.to.includes(IDS.mara))).toEqual([]);
    await quiet(IDS.mara, { dndUntil: new Date(Date.now() - 1000).toISOString() });
    await post(IDS.dusty, IDS.general, '@Mara still need you');
    expect(pushes.filter((p) => p.to.includes(IDS.mara))).toHaveLength(1);
  });

  it('quiet hours (all day here): no push, the row is there', async () => {
    await quiet(IDS.mara, { quietNow: true });
    const id = await post(IDS.dusty, IDS.general, '@Mara are you around?');
    expect(await rowsOf(id)).toContain(`${IDS.mara}:mention`);
    expect(pushes.filter((p) => p.to.includes(IDS.mara))).toEqual([]);
    await quiet(IDS.mara, {});
  });

  it('keeps the preferences whole, with their defaults, as the web reads them back', async () => {
    const res = await call(IDS.mara, 'PATCH', '/me/preferences', {
      notifications: {
        email: 'daily',
        schedule: { enabled: true, start: '22:00', end: '07:00', days: ['fri', 'fri'] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications).toEqual({
      dndUntil: null,
      schedule: { enabled: true, start: '22:00', end: '07:00', days: ['fri'] },
      email: 'daily',
      threadReplies: true,
      previews: true,
    });
    expect((await call(IDS.mara, 'GET', '/me/preferences')).json().notifications.email).toBe('daily');
    await quiet(IDS.mara, {});
  });
});

describe('push previews, one per thread, nothing while active (NT-14, NT-15, NT-17)', () => {
  const setPreviews = async (who: string, previews: boolean) =>
    updatePreferences(t.services, await accountOf(t.services, who), {
      notifications: {
        dndUntil: null,
        schedule: { enabled: false, start: '22:00', end: '08:00', days: [] },
        email: 'hourly',
        threadReplies: true,
        previews,
      },
    });
  const toMara = () => pushes.filter((p) => p.to.includes(IDS.mara));

  it('says who and where, the start of the text without code, grouped by thread', async () => {
    const id = await post(
      IDS.dusty,
      IDS.general,
      '@Mara the fix:\n```ts\nconst secret = 42;\n```\nworks **now**',
    );
    const [push] = toMara();
    expect(push?.payload.title).toBe('Dusty mentioned you in general');
    expect(push?.options).toEqual({
      group: `thread:${IDS.general}:main`,
      preview: { title: 'Dusty mentioned you in general', body: '@Mara the fix: (code) works now' },
    });
    expect(push?.payload.body).toBe('@Mara the fix: (code) works now');
    // The inbox row keeps the text as it was.
    const [row] = await t.services.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.dedupKey, messageDedupKey(id)), eq(notifications.principalId, IDS.mara)));
    expect(row?.text).toContain('const secret = 42;');

    pushes.length = 0;
    await post(IDS.dusty, IDS.general, 'Nice', id);
    expect(toMara()[0]?.options).toMatchObject({
      group: `thread:${IDS.general}:${id}`,
      preview: { title: 'Dusty replied in general', body: 'Nice' },
    });
  });

  it('an agent in its DM is just its name', async () => {
    await call(IDS.mara, 'PUT', `/conversations/${IDS.dmDusty}/notify`, { notify: null });
    await post(IDS.dusty, IDS.dmDusty, 'Done.\nAll three receipts are filed.');
    expect(toMara()[0]?.options?.preview).toEqual({
      title: 'Dusty',
      body: 'Done. All three receipts are filed.',
    });
  });

  it('previews off: the generic words, no preview', async () => {
    await setPreviews(IDS.mara, false);
    await post(IDS.dusty, IDS.general, '@Mara the launch date is Friday');
    const [push] = toMara();
    expect(push?.options).toEqual({ group: `thread:${IDS.general}:main` });
    expect(push?.payload).toMatchObject({ title: 'Whombat', body: 'Someone mentioned you' });
    expect(JSON.stringify(push)).not.toMatch(/launch|Friday/);
    await setPreviews(IDS.mara, true);
  });

  it('no push while the recipient is active; “needs you” still pushes; the inbox fills', async () => {
    const presence = presenceFor(t.services);
    presence.connect('test:mara', TEST_BURROW_ID, IDS.mara);
    try {
      const id = await post(IDS.dusty, IDS.general, '@Mara are you there?');
      expect(await rowsOf(id)).toContain(`${IDS.mara}:mention`);
      expect(toMara()).toEqual([]);
      await notify(t.services, [
        {
          burrowId: TEST_BURROW_ID,
          burrowSlug: 'burrow-hq',
          principalId: IDS.mara,
          kind: 'needs_you',
          actorId: IDS.dusty,
          where: '#general',
          text: 'Deploy to production',
          link: { type: 'pr', number: 482 } as never,
          createdAt: new Date(),
          group: 'approval:approval_x',
        },
      ]);
      expect(toMara()).toHaveLength(1);
      expect(toMara()[0]?.options).toEqual({
        group: 'approval:approval_x',
        preview: { title: 'Needs you · #general', body: 'Deploy to production' },
      });
    } finally {
      presence.disconnect('test:mara');
    }
    await post(IDS.dusty, IDS.general, '@Mara now?');
    expect(toMara()).toHaveLength(2);
  });
});
