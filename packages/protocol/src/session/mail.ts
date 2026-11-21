/**
 * Mail through the owner's own server (Whombat hermes-engine.md HE-56, HE-61; CT-1308): a community box has no control to
 * send mail through, so an owner may give it an SMTP server of their own (Settings → This Whombat), optional. The box
 * sends invites and notification email through it (`Bootstrap.capabilities.emailNotifications` follows); without one it
 * sends none and invites go by link.
 *
 * The password goes to the box once (`host.mail.set`, a `secret` op) and stays there: no answer carries it
 * (`MailSettings.hasPassword`), no log or receipt, and the signed appliance log names the server and the from address
 * only. A box whose configuration sets mail (development's Mailpit, `SMTP_URL`) shows it as `source: 'config'` and
 * refuses changes (`mail.in_config`).
 */
import { Email, Timestamp } from '@whombat/core/domain';
import { AccountId } from '@whombat/core/ids';
import { z } from 'zod';

/**
 * How the box talks to the server: `tls` (TLS from the first byte, usually port 465), `starttls` (plain, then
 * `STARTTLS`, required — usually 587), `none` (no encryption: a relay on the owner's network, without a login).
 */
export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export const MailSecurity = z.enum(MAIL_SECURITY);
export type MailSecurity = z.infer<typeof MailSecurity>;

/** The usual port for each, which the app fills in. */
export const MAIL_DEFAULT_PORTS: Readonly<Record<MailSecurity, number>> = Object.freeze({
  tls: 465,
  starttls: 587,
  none: 25,
});

/** The server: a host name (`smtp.example.org`), an IPv4 address, or an IPv6 address without brackets. */
export const MailHost = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)*|[0-9a-f:.]+)$/);
export const MailPort = z.number().int().min(1).max(65_535);
/** The login name the server asks for (often the address itself). */
export const MailUsername = z.string().trim().min(1).max(254);
/** The login's password or app password. Never in an answer, a log or a receipt. */
export const MailPassword = z.string().min(1).max(512);
/** The name mail shows as from (“Lumio Whombat”); absent: “Whombat”. One line, no angle brackets or quotes. */
export const MailFromName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\p{Cf}<>"]+$/u);

/**
 * What the box sends with (`host.mail.set`, and a draft for `host.mail.test`). `password`: absent keeps the stored one
 * (`hasPassword`), `null` removes it. No login without encryption: `security: 'none'` takes no `username` or `password`
 * (`mailSettingsProblem`).
 */
const MailSettingsFields = z.strictObject({
  host: MailHost,
  port: MailPort,
  security: MailSecurity,
  username: MailUsername.nullable(),
  password: MailPassword.nullable().optional(),
  from: Email,
  fromName: MailFromName.nullable().optional(),
});

/** Why settings can't be used as they are, or null: `login_without_tls` — a user name or password with `none`. */
export function mailSettingsProblem(s: {
  security: MailSecurity;
  username: string | null;
  password?: string | null;
}): 'login_without_tls' | null {
  return s.security === 'none' && (s.username !== null || (s.password ?? null) !== null)
    ? 'login_without_tls'
    : null;
}

export const MailSettingsInput = MailSettingsFields.superRefine((s, ctx) => {
  if (mailSettingsProblem(s))
    ctx.addIssue({ code: 'custom', path: ['security'], message: 'A login needs tls or starttls.' });
});
export type MailSettingsInput = z.infer<typeof MailSettingsInput>;

/**
 * How a test went: `sent` (the server took the message), `unreachable` (no answer: the name didn't resolve, refused,
 * timed out), `tls_failed` (the secure connection failed: wrong `security` for the port, a bad certificate),
 * `auth_failed` (the server refused the login), `refused` (it refused the sender or the recipient), `failed` (anything
 * else; `detail` says what).
 */
export const MAIL_TEST_STATES = [
  'sent',
  'unreachable',
  'tls_failed',
  'auth_failed',
  'refused',
  'failed',
] as const;
export const MailTestState = z.enum(MAIL_TEST_STATES);
export type MailTestState = z.infer<typeof MailTestState>;

/** A test's result: sent to `to` (the testing owner's own email). `detail`: what the server said, for owners. */
export const MailTest = z.object({
  state: MailTestState,
  at: Timestamp,
  to: Email,
  detail: z.string().max(500).nullable(),
});
export type MailTest = z.infer<typeof MailTest>;

/**
 * The mail server as owners see it. `source`: `settings` (an owner set it here) or `config` (the box's configuration;
 * read-only). `hasPassword` instead of the password. `lastTest`: the last test of these settings, null before one (or
 * after a change).
 */
export const MailSettings = z.object({
  source: z.enum(['settings', 'config']),
  host: MailHost,
  port: MailPort,
  security: MailSecurity,
  username: MailUsername.nullable(),
  hasPassword: z.boolean(),
  from: Email,
  fromName: MailFromName.nullable(),
  updatedAt: Timestamp.nullable(),
  lastTest: MailTest.nullable(),
});
export type MailSettings = z.infer<typeof MailSettings>;

/* The session ops ------------------------------------------------------------------------------------------- */

export const HostMailInput = z.strictObject({});
/** The mail server, or null when the box has none (it sends no mail). */
export const HostMailOutput = z.object({ mail: MailSettings.nullable() });
export type HostMailOutput = z.infer<typeof HostMailOutput>;

/** Set or replace the server (a `secret` op: it may carry the password). Answers the settings as stored. */
export const HostMailSetInput = MailSettingsInput;

/**
 * Send one test message to the asking owner's own email (never anyone else's): with `draft`, those settings without
 * saving them (`password` absent: the stored one); without, the stored settings (`mail.not_set` when there are none). A
 * `secret` op (a draft may carry the password). The answer is the result whatever it was; a test of the stored settings
 * is kept as their `lastTest`.
 */
export const HostMailTestInput = z.strictObject({ draft: MailSettingsInput.optional() });
export const HostMailTestOutput = z.object({ test: MailTest });
export type HostMailTestOutput = z.infer<typeof HostMailTestOutput>;

/** Remove the server: the box sends no more mail. Destructive. Answers `{mail: null}`. */
export const HostMailRemoveInput = z.strictObject({});

/** The mail ops' refusals in `error.details.code` (described in `APP_ERROR_CODES`). */
export const MAIL_ERROR_CODES = ['mail.in_config', 'mail.not_set', 'mail.busy'] as const;
export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

/* Words the box itself sends --------------------------------------------------------------------------------------- */

/** The test message (concise-replies: short and plain). */
export const MAIL_TEST_MESSAGE = Object.freeze({
  subject: 'Your Whombat can send email',
  text: 'This is a test from your Whombat. If you can read it, email works.',
});

/** One line per test result, for the owner who tested. */
export const MAIL_TEST_TEXT: Readonly<Record<MailTestState, string>> = Object.freeze({
  sent: 'Sent. Check your inbox.',
  unreachable: 'Whombat couldn’t reach that mail server. Check the server and port.',
  tls_failed: 'The secure connection didn’t work. Try the other security setting.',
  auth_failed: 'The mail server didn’t accept the user name or password.',
  refused: 'The mail server refused the message. Check the from address.',
  failed: 'Sending didn’t work. The details say why.',
});

/* The signed appliance log ----------------------------------------------------------------------------------------- */

/**
 * Payload of the signed `mail.set` and `mail.removed` appliance events: who, and where mail goes — never the user name or
 * password. `server` is null for `mail.removed`.
 */
export const MailAuditPayload = z.object({
  byAccountId: AccountId,
  server: z.object({ host: MailHost, port: MailPort, security: MailSecurity, from: Email }).nullable(),
});
export type MailAuditPayload = z.infer<typeof MailAuditPayload>;
