/**
 * The box's mail server without a box (fixture mode, the fake managed world, the phone's demo world, tests;
 * hermes-engine-app.md AP-5405): `host.mail*` as the runtime answers them (CT-1308). The password is kept and never
 * answered (`hasPassword`); a test goes to the person's own email and reports `sent`, or `unreachable` for
 * a server whose name has `unreachable` in it and `auth_failed` for the password `wrong` (so a journey can show both).
 */
import { MAIL_SETTINGS } from '@whombat/fixtures';
import {
  type HostMailOutput,
  HostMailSetInput,
  HostMailTestInput,
  type MailSettings,
  type MailSettingsInput,
  type MailTest,
} from '@whombat/protocol/session';

export interface FakeMail {
  /** One op as the runtime answers it, in HTTP terms; null for an op that isn't mail's. */
  call(op: string, input: unknown, who: { email: string }): { status: number; body: unknown } | null;
  settings(): MailSettings | null;
}

export function createFakeMail(
  initial: 'none' | 'set' | 'config' = 'none',
  now: () => Date = () => new Date(),
): FakeMail {
  let stored: (MailSettings & { password: string | null }) | null =
    initial === 'none'
      ? null
      : { ...MAIL_SETTINGS, source: initial === 'config' ? 'config' : 'settings', password: 'saved' };
  const view = (): HostMailOutput => {
    if (!stored) return { mail: null };
    const { password: _, ...mail } = stored;
    return { mail };
  };
  const refuse = (status: number, code: string, message: string) => ({
    status,
    body: { error: { code, message, details: { code } } },
  });
  const testOf = (s: MailSettingsInput & { password?: string | null }, to: string): MailTest => ({
    state: s.host.includes('unreachable') ? 'unreachable' : s.password === 'wrong' ? 'auth_failed' : 'sent',
    at: now().toISOString(),
    to,
    detail: null,
  });
  return {
    call(op, input, who) {
      if (!op.startsWith('host.mail')) return null;
      switch (op) {
        case 'host.mail':
          return { status: 200, body: view() };
        case 'host.mail.set': {
          if (stored?.source === 'config') return refuse(409, 'mail.in_config', 'Set in the configuration.');
          const parsed = HostMailSetInput.safeParse(input);
          if (!parsed.success)
            return { status: 422, body: { error: { code: 'validation_failed', message: 'Not valid.' } } };
          const s = parsed.data;
          // `password` absent keeps the stored one; null clears it (a server without a login).
          const password = s.password === undefined ? (stored?.password ?? null) : s.password;
          stored = {
            source: 'settings',
            host: s.host,
            port: s.port,
            security: s.security,
            username: s.username,
            hasPassword: password !== null,
            from: s.from,
            fromName: s.fromName ?? null,
            updatedAt: now().toISOString(),
            lastTest: null,
            password,
          };
          return { status: 200, body: view() };
        }
        case 'host.mail.test': {
          const parsed = HostMailTestInput.safeParse(input ?? {});
          if (!parsed.success)
            return { status: 422, body: { error: { code: 'validation_failed', message: 'Not valid.' } } };
          const draft = parsed.data.draft;
          if (draft) {
            const password = draft.password === undefined ? (stored?.password ?? null) : draft.password;
            return { status: 200, body: { test: testOf({ ...draft, password }, who.email) } };
          }
          if (!stored) return refuse(409, 'mail.not_set', 'No mail server.');
          const test = testOf(stored, who.email);
          stored = { ...stored, lastTest: test };
          return { status: 200, body: { test } };
        }
        case 'host.mail.remove':
          if (stored?.source === 'config') return refuse(409, 'mail.in_config', 'Set in the configuration.');
          stored = null;
          return { status: 200, body: { mail: null } };
        default:
          return null;
      }
    },
    settings: () => view().mail,
  };
}
