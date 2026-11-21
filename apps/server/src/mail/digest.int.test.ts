/**
 * Notification email (docs/decisions/essentials-people.md EP-15) against the real database, a memory mailer and a
 * fake clock (`runOnce(now)`): what stayed unread 30 minutes, one email an hour at most or a daily one at 08:00,
 * nothing in quiet time, nothing read, decided or removed, each item once.
 */
import { zonedInstant, zonedParts } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { updatePreferences } from '../commands/account';
import { markRead, sendMessage } from '../commands/messages';
import { accounts, approvals, notifications } from '../db/schema/index';
import { notify } from '../domain/notify';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { accountOf } from '../test/tokens';
import { EmailDigest } from './digest';

const t = useTestServer({ seed: true });
const MIN = 60_000;
let digest: EmailDigest;
let t0 = new Date();

beforeAll(() => {
  digest = new EmailDigest(t.services);
  t0 = new Date();
});

const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
const mailsTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

async function mention(author: string, who: string, text: string, conversationId = IDS.general) {
  const res = await t.commit(author, sendMessage, { conversationId, text });
  if (res.status !== 'ok') throw new Error('not posted');
  void who;
  return res.result.id;
}

async function prefs(who: string, over: Record<string, unknown>) {
  await updatePreferences(t.services, await accountOf(t.services, who), {
    notifications: {
      dndUntil: null,
      schedule: { enabled: false, start: '22:00', end: '08:00', days: [] },
      email: 'hourly',
      threadReplies: true,
      previews: true,
      ...over,
    },
  });
}

describe('the hourly email', () => {
  it('waits 30 minutes, sends one email with links, and marks what it sent', async () => {
    await mention(IDS.dusty, IDS.mara, '@Mara can you check the VAT rounding?');
    expect(await digest.runOnce(at(10))).toEqual({ emails: 0, items: 0 });
    expect(await digest.runOnce(at(31))).toEqual({ emails: 1, items: 1 });
    const [mail] = mailsTo('mara@burrowhq.example');
    expect(mail?.subject).toBe('Dusty mentioned you in general');
    expect(mail?.text).toContain('Hi Mara,');
    expect(mail?.text).toContain('  “@Mara can you check the VAT rounding?”');
    // A link to the message (the seeded room is a branch room without a pull request, one-agent.md OA-S28).
    expect(mail?.text).toMatch(/ {2}http:\/\/localhost:5180\/burrow-hq\/\S+#msg_/);
    expect(mail?.text).toContain('http://localhost:5180/burrow-hq/settings?tab=notifications');
    const [account] = await t.services.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, await accountOf(t.services, IDS.mara)));
    expect(account?.notificationsEmailedAt?.getTime()).toBe(at(31).getTime());
    // Each item once.
    expect(await digest.runOnce(at(32))).toEqual({ emails: 0, items: 0 });
  });

  it('at most one an hour', async () => {
    await mention(IDS.dusty, IDS.mara, '@Mara and the invoice numbers?');
    expect(await digest.runOnce(at(62))).toEqual({ emails: 0, items: 0 });
    expect(await digest.runOnce(at(92))).toEqual({ emails: 1, items: 1 });
    expect(mailsTo('mara@burrowhq.example')).toHaveLength(2);
  });

  it('leaves out what they read in the conversation or in the inbox', async () => {
    const id = await mention(IDS.dusty, IDS.mara, '@Mara the deck is up');
    const read = await t.commit(IDS.mara, markRead, { conversationId: IDS.general, messageId: id });
    expect(read.status).toBe('ok');
    await mention(IDS.dusty, IDS.mara, '@Mara one more');
    await t.services.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.principalId, IDS.mara));
    // An hour after the last email: only what she read holds it back.
    await digest.runOnce(at(155));
    expect(mailsTo('mara@burrowhq.example')).toHaveLength(2);
  });
});

describe('what goes in and what holds it back', () => {
  it('a needs-you item goes in while the request waits, not once someone decided it', async () => {
    const draft = {
      burrowId: TEST_BURROW_ID,
      principalId: IDS.mara,
      kind: 'needs_you' as const,
      actorId: IDS.dusty,
      where: 'Deploy feat/invoice-pdf to staging',
      text: 'Deploy feat/invoice-pdf to staging?',
      link: { type: 'approval' as const, number: 12 },
      approvalId: 'apr_staging-482',
      createdAt: new Date(),
    };
    await notify(t.services, [draft]);
    await t.services.db
      .update(approvals)
      .set({ state: 'declined' })
      .where(eq(approvals.id, 'apr_staging-482'));
    await digest.runOnce(at(160));
    expect(mailsTo('mara@burrowhq.example')).toHaveLength(2);
    await t.services.db
      .update(approvals)
      .set({ state: 'pending' })
      .where(eq(approvals.id, 'apr_staging-482'));
    await digest.runOnce(at(161));
    const mail = mailsTo('mara@burrowhq.example').at(-1);
    expect(mail?.subject).toBe('Needs you · Deploy feat/invoice-pdf to staging');
    expect(mail?.text).toContain('  http://localhost:5180/burrow-hq/log?approval=12');
  });

  it('nothing during Do not disturb; it goes once DND ended; nothing when email is off', async () => {
    await prefs(IDS.mara, { dndUntil: at(230).toISOString() });
    await mention(IDS.dusty, IDS.mara, '@Mara lunch?');
    expect((await digest.runOnce(at(225))).emails).toBe(0);
    expect(await digest.runOnce(at(231))).toEqual({ emails: 1, items: 1 });
    await prefs(IDS.mara, { email: 'off' });
    await mention(IDS.dusty, IDS.mara, '@Mara and dinner?');
    expect((await digest.runOnce(at(300))).emails).toBe(0);
  });

  it('nothing in quiet hours', async () => {
    await prefs(IDS.mara, {
      schedule: {
        enabled: true,
        start: '00:00',
        end: '00:00',
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      },
    });
    expect((await digest.runOnce(at(400))).emails).toBe(0);
  });
});

describe('the daily email', () => {
  it('goes at 08:00 in the person’s zone, once that day', async () => {
    await prefs(IDS.mara, { email: 'daily' });
    await updatePreferences(t.services, await accountOf(t.services, IDS.mara), {
      timeZone: 'Europe/Amsterdam',
    });
    const sent = mailsTo('mara@burrowhq.example').length;
    const tomorrow = zonedParts(new Date(Date.now() + 24 * 3600_000), 'Europe/Amsterdam');
    const before = zonedInstant(tomorrow, '07:55', 'Europe/Amsterdam');
    const after = zonedInstant(tomorrow, '08:05', 'Europe/Amsterdam');
    // The mentions are posted at moments of tomorrow, so the day's look-back holds the first whatever the time is now.
    const original = t.services.clock;
    const postAt = async (when: Date, text: string) => {
      t.services.clock = () => new Date(when);
      try {
        await mention(IDS.dusty, IDS.mara, text);
      } finally {
        t.services.clock = original;
      }
    };
    await postAt(new Date(after.getTime() - 3600_000), '@Mara the board deck');
    await digest.runOnce(before);
    expect(mailsTo('mara@burrowhq.example')).toHaveLength(sent);
    await digest.runOnce(after);
    expect(mailsTo('mara@burrowhq.example')).toHaveLength(sent + 1);
    expect(mailsTo('mara@burrowhq.example').at(-1)?.text).toContain('You get this once a day');
    await postAt(new Date(after.getTime() + 3600_000), '@Mara and the budget');
    await digest.runOnce(new Date(after.getTime() + 2 * 3600_000));
    expect(mailsTo('mara@burrowhq.example')).toHaveLength(sent + 1);
  });
});
