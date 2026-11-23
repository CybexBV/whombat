/**
 * Email through Whombat Link on the runtime (docs/decisions/link-email.md), against a real database and the fake
 * manager: the owner's two choices (kept, signed `link.mail_set`, told to control whenever it knows the box), the
 * notification email going through Link as a count only when no mail server of the owner's own sends it, and notices in
 * fixed words by email too. Needs Postgres: the choices are kept in appliance_state and signed, and the digest claims
 * notification rows. One database, one box: the tests run in order.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { updatePreferences } from '../commands/account';
import { sendMessage } from '../commands/messages';
import { applianceEvents, applianceState } from '../db/schema/index';
import { EmailDigest, notificationCapabilities } from '../mail/digest';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { accountOf } from '../test/tokens';
import type { RequestAnswer } from './dispatcher';
import { RequestControl } from './dispatcher';
import { ManagerCallError } from './ports';
import { SECURITY_NOTICES } from './security-push';
import type { SessionPrincipal } from './trust';

// No mail server of the box's own: the notification email can only go through Link.
const m = useManagedRuntime({
  seed: true,
  env: { SMTP_URL: 'off' },
  prepare: (manager) => manager.setLink('off'),
});
let mara: SessionPrincipal;
let maraAccount: string;
let requestNo = 0;

beforeAll(async () => {
  const id = await m.enroll(IDS.mara);
  mara = await m.runtime.trust.identify(id.peerId, id.publicKey);
  maraAccount = await accountOf(m.t.services, IDS.mara);
  // The box's person: only theirs goes through Link.
  await m.t.services.db
    .update(applianceState)
    .set({ claimedByAccountId: maraAccount })
    .where(eq(applianceState.id, 1));
});

async function op(name: string, input: unknown = {}): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    mara,
    { id: `req-mail-${++requestNo}`, op: name, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

const signed = async () =>
  (
    await m.t.services.db
      .select({ payload: applianceEvents.payload })
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'link.mail_set'))
  ).map((r) => r.payload);

describe('the owner’s choices', () => {
  it('start with the offline email on and notifications by email off', async () => {
    expect(await op('reach.get')).toMatchObject({
      type: 'result',
      output: { link: { state: 'off', mail: { offline: true, notifications: false } } },
    });
  });

  it('are kept and signed with Link off, and control isn’t told while it doesn’t know the box', async () => {
    expect(await op('link.mail.set', { offline: false })).toMatchObject({
      type: 'result',
      output: { link: { mail: { offline: false, notifications: false } } },
    });
    expect(await signed()).toEqual([{ byAccountId: maraAccount, offline: false, notifications: false }]);
    expect(m.manager.mailChoices).toEqual([]);
    // The same choice again changes nothing and signs nothing.
    await op('link.mail.set', { offline: false });
    expect(await signed()).toHaveLength(1);
  });

  it('reach control once Link runs, once, and again after Link moved', async () => {
    m.manager.setLink('on', { label: 'quiet-otter-lamp' });
    await m.runtime.link.refresh();
    await m.runtime.linkEmail.tell();
    expect(m.manager.mailChoices).toEqual([{ offline: false, notifications: false }]);
    await m.runtime.linkEmail.tell();
    expect(m.manager.mailChoices).toHaveLength(1);
    m.manager.setLink('grace', { graceEndsAt: '2026-12-01T00:00:00.000Z' });
    await m.runtime.link.refresh();
    await m.runtime.linkEmail.tell();
    expect(m.manager.mailChoices).toHaveLength(2);
    m.manager.setLink('on', { label: 'quiet-otter-lamp' });
    await m.runtime.link.refresh();
    await m.runtime.linkEmail.tell();
  });

  it('a choice control didn’t take is told again at the next chance', async () => {
    const before = m.manager.mailChoices.length;
    m.manager.mailFail = new ManagerCallError('/v1/link/mail', 503, 'unavailable', 'away');
    await op('link.mail.set', { notifications: true });
    expect(m.manager.mailChoices).toHaveLength(before);
    m.manager.mailFail = null;
    await m.runtime.linkEmail.tell();
    expect(m.manager.mailChoices.at(-1)).toEqual({ offline: false, notifications: true });
  });
});

describe('what goes out through Link', () => {
  it('the box says it emails notifications once the owner chose it', () => {
    expect(notificationCapabilities(m.t.services).emailNotifications).toBe(true);
  });

  it('the notification email is a count and the page, never who or what', async () => {
    await updatePreferences(m.t.services, maraAccount, {
      notifications: {
        dndUntil: null,
        schedule: { enabled: false, start: '22:00', end: '08:00', days: [] },
        email: 'hourly',
        threadReplies: true,
        previews: true,
      },
    });
    const posted = await m.t.commit(IDS.dusty, sendMessage, {
      conversationId: IDS.general,
      text: '@Mara the secret plan for the VAT rounding',
    });
    expect(posted.status).toBe('ok');
    const digest = new EmailDigest(m.t.services);
    const result = await digest.runOnce(new Date(Date.now() + 31 * 60_000));
    expect(result.emails).toBe(1);
    const mail = m.manager.mails.at(-1);
    expect(mail).toMatchObject({ kind: 'waiting', count: result.items, cadence: 'hourly' });
    expect(mail?.path).toMatch(/^\/[a-z0-9-]+$/);
    expect(mail?.ref).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(JSON.stringify(mail)).not.toMatch(/secret|VAT|Dusty|general/);
    // Nothing went out by the box's own mail.
    expect(m.t.mailer.sent).toEqual([]);
  });

  it('a notice goes by email too, in its fixed words', async () => {
    const sent = m.manager.mails.length;
    await m.runtime.controlPush.security(
      [maraAccount],
      'passkey-enrolled:ep-test',
      SECURITY_NOTICES.passkeyEnrolled,
    );
    expect(m.manager.mails.slice(sent)).toEqual([
      expect.objectContaining({
        kind: 'notice',
        title: SECURITY_NOTICES.passkeyEnrolled.title,
        path: SECURITY_NOTICES.passkeyEnrolled.path,
      }),
    ]);
  });

  it('nothing goes once the owner turned it off, or Link is off', async () => {
    await op('link.mail.set', { notifications: false });
    const sent = m.manager.mails.length;
    await m.runtime.controlPush.security(
      [maraAccount],
      'passkey-enrolled:ep-2',
      SECURITY_NOTICES.passkeyEnrolled,
    );
    expect(m.manager.mails).toHaveLength(sent);
    expect(notificationCapabilities(m.t.services).emailNotifications).toBe(false);
    await op('link.mail.set', { notifications: true });
    await op('link.off');
    await m.runtime.controlPush.security(
      [maraAccount],
      'passkey-enrolled:ep-3',
      SECURITY_NOTICES.passkeyEnrolled,
    );
    expect(m.manager.mails).toHaveLength(sent);
    expect(notificationCapabilities(m.t.services).emailNotifications).toBe(false);
  });
});
