/**
 * The box's own mail server (Whombat hermes-engine.md HE-61; contracts CT-1308; hermes-engine-app.md AP-5405), for the
 * web and the phone: a community box sends email (what the person asked to hear about) through the person's own SMTP
 * server, optional. The person sets it, tests it (a message to their own email) and removes it; the password is sent once
 * and never shown again (`hasPassword`). A server set in the box's configuration (development's Mailpit) is read-only.
 *
 * `mailApi(session)` is the four ops; `mailView` turns `host.mail`'s answer into the section's row; `mailDraft` checks a
 * form before it is sent; `mailTestText` and `mailErrorText` are the words.
 */
import { interpolate } from '@whombat/core/i18n';
import {
  type HostMailOutput,
  type HostMailTestOutput,
  MAIL_DEFAULT_PORTS,
  MAIL_TEST_TEXT,
  type MailSecurity,
  type MailSettings,
  MailSettingsInput,
  type MailTest,
  type MailTestState,
  mailSettingsProblem,
} from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { MAIL_WORDS } from '../i18n/messages/hostManaged/mail';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

export type { HostMailOutput, MailSecurity, MailSettings, MailTest } from '@whombat/protocol/session';
export { MAIL_DEFAULT_PORTS } from '@whombat/protocol/session';

export interface MailApi {
  get(): Promise<HostMailOutput>;
  set(settings: MailSettingsInput): Promise<HostMailOutput>;
  /** A test to the person's own email: of `draft` without saving it, or of the stored settings. */
  test(draft?: MailSettingsInput): Promise<HostMailTestOutput>;
  remove(): Promise<HostMailOutput>;
}

export function mailApi(session: ApplianceSession): MailApi {
  return {
    get: () => sessionOps.hostMail(session),
    set: (settings) => sessionOps.hostMailSet(session, settings),
    test: (draft) => sessionOps.hostMailTest(session, draft ? { draft } : {}),
    remove: () => sessionOps.hostMailRemove(session),
  };
}

/** Every word of EMAIL, in a locale (English when none is given). */
export function mailText(locale?: string | null) {
  const w = clientTree(locale, MAIL_WORDS);
  return {
    ...w,
    security: w.security satisfies Record<MailSecurity, string>,
    lastTest: (text: string) => interpolate(w.lastTest, { text }),
    wentTo: (to: string) => interpolate(w.wentTo, { to }),
    errors: {
      'mail.in_config': w.errors.inConfig,
      'mail.not_set': w.errors.notSet,
      'mail.busy': w.errors.busy,
      failed: w.errors.failed,
    },
    /** One line per test result (the contracts' `MAIL_TEST_TEXT`, in this language). */
    tests: w.tests satisfies Record<MailTestState, string>,
  } as const;
}

export type MailText = ReturnType<typeof mailText>;

/** EMAIL's words in English. */
export const MAIL_TEXT: MailText = mailText('en');

export type MailAction = 'set_up' | 'test' | 'change' | 'remove';

/** The section's row: its dot, words and what can be done. */
export interface MailView {
  dot: 'ok' | 'warn' | 'bad' | 'mut';
  title: string;
  meta: string;
  /** The last test's line, when there was one. */
  test: string | null;
  actions: MailAction[];
}

/** The row for `host.mail`'s answer (null: not asked yet). */
export function mailView(answer: HostMailOutput | null, locale?: string | null): MailView | null {
  const T = mailText(locale);
  if (!answer) return null;
  const m = answer.mail;
  if (!m)
    return {
      dot: 'mut',
      title: T.offTitle,
      meta: T.offMeta,
      test: null,
      actions: ['set_up'],
    };
  const where = [m.from, `${m.host}:${m.port}`, T.security[m.security]].join(' · ');
  const config = m.source === 'config';
  const test = m.lastTest ? T.lastTest(mailTestText(m.lastTest, locale)) : config ? null : T.untested;
  const dot = !m.lastTest ? 'mut' : m.lastTest.state === 'sent' ? 'ok' : 'warn';
  return {
    dot,
    title: m.fromName ?? m.from,
    meta: config ? `${where}. ${T.fromConfig}` : where,
    test,
    actions: config ? ['test'] : ['test', 'change', 'remove'],
  };
}

/**
 * One line for a test's result: the contracts' words (`failed` with the box's detail), and where a sent one went (the
 * person's own email).
 */
export function mailTestText(
  test: Pick<MailTest, 'state' | 'detail'> & { to?: string },
  locale?: string | null,
): string {
  const T = mailText(locale);
  const text = T.tests[test.state] ?? MAIL_TEST_TEXT[test.state];
  if (test.state === 'sent' && test.to) return `${text} ${T.wentTo(test.to)}`;
  return test.state === 'failed' && test.detail ? `${text} ${test.detail}` : text;
}

/** What a failed mail change says (`mail.*` by name). */
export function mailErrorText(error: unknown, locale?: string | null): string {
  const T = mailText(locale);
  const code = error instanceof OperationError ? error.code : null;
  return code && code in T.errors ? T.errors[code as keyof typeof T.errors] : T.errors.failed;
}

/** The form as people fill it in (strings; the password empty to keep the stored one). */
export interface MailForm {
  host: string;
  port: string;
  security: MailSecurity;
  username: string;
  password: string;
  from: string;
  fromName: string;
}

/** The form for settings (a new one: STARTTLS on 587, the person's email as the from address). */
export function mailForm(settings: MailSettings | null, ownerEmail = ''): MailForm {
  if (!settings)
    return {
      host: '',
      port: String(MAIL_DEFAULT_PORTS.starttls),
      security: 'starttls',
      username: '',
      password: '',
      from: ownerEmail,
      fromName: '',
    };
  return {
    host: settings.host,
    port: String(settings.port),
    security: settings.security,
    username: settings.username ?? '',
    password: '',
    from: settings.from,
    fromName: settings.fromName ?? '',
  };
}

export type MailProblem = keyof typeof MAIL_TEXT.problems;

/**
 * The form as `host.mail.set` takes it, or the first problem (`hasPassword`: a stored password the empty field keeps).
 * A user name needs a password, the one typed or the one kept; a login needs TLS or STARTTLS (`mailSettingsProblem`).
 */
export function mailDraft(
  form: MailForm,
  hasPassword: boolean,
): { ok: true; input: MailSettingsInput } | { ok: false; problem: MailProblem } {
  const port = Number(form.port.trim());
  const username = form.username.trim() || null;
  const password = form.password ? form.password : null;
  const draft = {
    host: form.host.trim(),
    port,
    security: form.security,
    username,
    ...(password !== null ? { password } : username === null ? { password: null } : {}),
    from: form.from.trim(),
    fromName: form.fromName.trim() || null,
  };
  if (!draft.host) return { ok: false, problem: 'host' };
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, problem: 'port' };
  if (mailSettingsProblem({ security: draft.security, username, password }))
    return { ok: false, problem: 'login_without_tls' };
  if (username !== null && password === null && !hasPassword) return { ok: false, problem: 'password' };
  const parsed = MailSettingsInput.safeParse(draft);
  if (parsed.success) return { ok: true, input: parsed.data };
  const field = parsed.error.issues[0]?.path[0];
  if (field === 'from') return { ok: false, problem: 'from' };
  if (field === 'fromName') return { ok: false, problem: 'fromName' };
  if (field === 'port') return { ok: false, problem: 'port' };
  return { ok: false, problem: 'host' };
}

/** The port a security choice usually uses, when the port shown is still another choice's default. */
export function mailPortFor(security: MailSecurity, port: string): string {
  const defaults = Object.values(MAIL_DEFAULT_PORTS).map(String);
  return !port.trim() || defaults.includes(port.trim()) ? String(MAIL_DEFAULT_PORTS[security]) : port;
}
