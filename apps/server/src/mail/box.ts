/**
 * The person's own mail server (hermes-engine.md HE-61, HE-S224…HE-S229; contracts 1.1.0 `session/mail.ts`, CT-1308): a
 * box without control sends its own email (notification email) through an SMTP server the person names in Settings. One server per box, in `appliance_state.mail_settings`; its password sealed apart under the master key
 * (`mail_password_enc`), write-only (`hasPassword`), never in an answer, a log or a receipt (the ops are `secret`).
 *
 * - **Where mail goes:** the box's configuration (`SMTP_URL`, development's Mailpit) wins and is read-only
 *   (`source: 'config'`, `mail.in_config`); else the person's settings (`source: 'settings'`); else nothing is sent.
 * - **Encryption:** `tls` (TLS from the first byte) or `starttls` (required, never opportunistic: a server that doesn't
 *   offer it is a `tls_failed`, not a plain-text session), TLS 1.2 or later with a certificate that verifies for the
 *   host name; `none` only without a login (`mailSettingsProblem`), for a relay on the person's network.
 * - **The test** goes to the person's own email only, so the op can't mail anyone else; one at a time
 *   (`mail.busy`); a test of the stored settings is kept as their `lastTest`, a draft's isn't.
 * - Every change is a signed appliance event (`mail.set`, `mail.removed`) naming the server and the sender, never the
 *   login.
 */
import { isIP } from 'node:net';
import {
  MAIL_TEST_MESSAGE,
  type MailSettings,
  type MailSettingsInput,
  type MailTest,
  type MailTestState,
  mailSettingsProblem,
} from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { externalEffect } from '../commit/scope';
import { MailError, mailErrorOf, mailFailureText } from '../connectors/imap/errors';
import { applianceState, type BoxMailSettings } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import { appendApplianceEvent } from '../managed/audit';
import type { Services } from '../services';
import type { MailTransport } from './mailer';

const STATE_ID = 1;
/** The sealed password's binding (`custody.seal`). */
const PASSWORD_AAD = 'whombat/mail-password/v1';
/** How long a test may take, all in all (connect, greeting, TLS, login, the message). */
const TEST_TIMEOUT_MS = 20_000;

/** Tests only: a certificate authority to trust and where a host name connects (an in-process SMTP server). */
export interface BoxMailNet {
  ca?: string;
  connectTo?: (host: string) => string;
}
const nets = new WeakMap<Services, BoxMailNet>();

/** Tests only: the fake SMTP server's CA and address. Refused outside `NODE_ENV=test`. */
export function useBoxMailNetForTests(services: Services, net: BoxMailNet): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The mail network seam is for tests only.');
  nets.set(services, net);
}

/** One server's connection details (stored or a draft). */
interface Server {
  host: string;
  port: number;
  security: MailSettings['security'];
  username: string | null;
  password: string | null;
  from: string;
  fromName: string | null;
}

/** `"Name" <address>` as a header, or the address alone. */
export function fromHeader(server: Pick<Server, 'from' | 'fromName'>): string {
  return server.fromName ? `"${server.fromName}" <${server.from}>` : `Whombat <${server.from}>`;
}

/** A test's failure as the contract's states (`MAIL_TEST_STATES`), with our own words for the person (never the server's). */
export function mailTestOutcome(
  err: unknown,
  host: string,
  port: number,
): { state: MailTestState; detail: string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'EENVELOPE')
    return { state: 'refused', detail: `${host} refused the sender or the recipient.` };
  const failure = err instanceof MailError ? err : mailErrorOf(err, 'smtp', host, port);
  const state: MailTestState =
    failure.reason === 'refused'
      ? 'auth_failed'
      : failure.reason === 'unreachable' || failure.reason === 'timeout'
        ? 'unreachable'
        : failure.reason === 'certificate' || failure.reason === 'no_tls'
          ? 'tls_failed'
          : 'failed';
  return { state, detail: mailFailureText('smtp', failure.reason, host, port) };
}

export class BoxMail {
  /** The stored server (undefined until read from the database). */
  private cached: { settings: BoxMailSettings; password: string | null } | null | undefined;
  private transportFor: { key: string; transport: MailTransport } | null = null;
  private testing = false;

  constructor(private readonly services: Services) {}

  /** Reads the stored server (the runtime's start; also on first use). */
  async load(): Promise<void> {
    const [row] = await this.services.db
      .select({ settings: applianceState.mailSettings, password: applianceState.mailPasswordEnc })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    this.cached = row?.settings
      ? {
          settings: row.settings,
          password: row.password ? this.services.custody.open(PASSWORD_AAD, row.password) : null,
        }
      : null;
    this.transportFor = null;
  }

  private async stored() {
    if (this.cached === undefined) await this.load();
    return this.cached ?? null;
  }

  /** The configuration's server (`SMTP_URL`), as the person sees it; null without one. */
  private configured(): (Server & { url: string }) | null {
    const url = this.services.config.SMTP_URL;
    if (!url) return null;
    try {
      const u = new URL(url);
      const from = /<([^>]+)>/.exec(this.services.config.MAIL_FROM)?.[1] ?? this.services.config.MAIL_FROM;
      const fromName = /^\s*"?([^"<]*?)"?\s*</.exec(this.services.config.MAIL_FROM)?.[1]?.trim() || null;
      const tls = u.protocol === 'smtps:';
      return {
        url,
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port) || (tls ? 465 : 25),
        security: tls ? 'tls' : 'none',
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        from,
        fromName,
      };
    } catch {
      return null;
    }
  }

  /** Whether this box sends email now (a configured or the person's server). */
  async available(): Promise<boolean> {
    return Boolean(this.services.config.SMTP_URL) || (await this.stored()) !== null;
  }

  /** The same from what is known now, without reading (the bootstrap's capabilities; the runtime loaded it at start). */
  availableNow(): boolean {
    return Boolean(this.services.config.SMTP_URL) || Boolean(this.cached);
  }

  /** `host.mail`: the server as the person sees it, or null. */
  async view(): Promise<MailSettings | null> {
    const config = this.configured();
    if (config)
      return {
        source: 'config',
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        hasPassword: config.password !== null,
        from: config.from,
        fromName: config.fromName,
        updatedAt: null,
        lastTest: null,
      };
    const stored = await this.stored();
    if (!stored) return null;
    const { lastTest, ...s } = stored.settings;
    return {
      source: 'settings',
      host: s.host,
      port: s.port,
      security: s.security,
      username: s.username,
      hasPassword: stored.password !== null,
      from: s.from,
      fromName: s.fromName,
      updatedAt: s.updatedAt,
      lastTest: (lastTest as MailTest | null) ?? null,
    };
  }

  private refuseInConfig(): void {
    if (this.services.config.SMTP_URL)
      throw new ApiError(
        'conflict',
        'This Whombat’s configuration sets its mail server, so it can’t be changed here.',
        { details: { code: 'mail.in_config' } },
      );
  }

  /** A draft or the input of `host.mail.set` with the stored password when it leaves it out. */
  private async serverOf(input: MailSettingsInput): Promise<Server> {
    const password =
      input.password === undefined ? ((await this.stored())?.password ?? null) : input.password;
    const server: Server = {
      host: input.host.toLowerCase(),
      port: input.port,
      security: input.security,
      username: input.username,
      password,
      from: input.from.toLowerCase(),
      fromName: input.fromName ?? null,
    };
    if (mailSettingsProblem(server) === 'login_without_tls')
      throw new ApiError(
        'validation_failed',
        'A login needs an encrypted connection: choose TLS or STARTTLS.',
        {
          fields: { security: ['A login needs an encrypted connection.'] },
        },
      );
    return server;
  }

  /** `host.mail.set` (the person): stores the server (the password sealed), signs `mail.set`, answers the settings. */
  async set(by: { accountId: string; endpointId: string }, input: MailSettingsInput): Promise<MailSettings> {
    this.refuseInConfig();
    const server = await this.serverOf(input);
    const now = this.services.clock();
    const settings: BoxMailSettings = {
      host: server.host,
      port: server.port,
      security: server.security,
      username: server.username,
      from: server.from,
      fromName: server.fromName,
      updatedAt: now.toISOString(),
      lastTest: null,
    };
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
      await tx
        .update(applianceState)
        .set({
          mailSettings: settings,
          mailPasswordEnc: server.password ? this.services.custody.seal(PASSWORD_AAD, server.password) : null,
          updatedAt: now,
        })
        .where(eq(applianceState.id, STATE_ID));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'mail.set',
        actorAccountId: by.accountId,
        endpointId: by.endpointId,
        payload: {
          byAccountId: by.accountId,
          server: { host: server.host, port: server.port, security: server.security, from: server.from },
        },
        at: now,
      });
    });
    this.cached = { settings, password: server.password };
    this.transportFor = null;
    return (await this.view()) as MailSettings;
  }

  /** `host.mail.remove` (the person): the box sends no more mail; signs `mail.removed`. */
  async remove(by: { accountId: string; endpointId: string }): Promise<null> {
    this.refuseInConfig();
    if (!(await this.stored())) return null;
    const now = this.services.clock();
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx
        .update(applianceState)
        .set({ mailSettings: null, mailPasswordEnc: null, updatedAt: now })
        .where(eq(applianceState.id, STATE_ID));
      await appendApplianceEvent(tx, this.services.custody, {
        type: 'mail.removed',
        actorAccountId: by.accountId,
        endpointId: by.endpointId,
        payload: { byAccountId: by.accountId, server: null },
        at: now,
      });
    });
    this.cached = null;
    this.transportFor = null;
    return null;
  }

  /**
   * `host.mail.test {draft?}` (the person): one test message to `to` — the person's own email — through the draft (the
   * stored password when it leaves it out) or the stored server (`mail.not_set` without one). Answers how it went
   * whatever happened; a test of the stored server is kept as its `lastTest`.
   */
  async test(to: string, draft: MailSettingsInput | undefined): Promise<MailTest> {
    const stored = await this.stored();
    let server: Server;
    if (draft) server = await this.serverOf(draft);
    else {
      const config = this.configured();
      if (config) server = config;
      else if (stored) server = { ...stored.settings, password: stored.password };
      else
        throw new ApiError('conflict', 'No mail server is set yet. Fill one in to test it.', {
          details: { code: 'mail.not_set' },
        });
    }
    if (this.testing)
      throw new ApiError('conflict', 'A mail test is running. Wait for it to end.', {
        details: { code: 'mail.busy' },
      });
    this.testing = true;
    let test: MailTest;
    try {
      // Mail can't be taken back (CS-01): the op's one external effect.
      test = await externalEffect('mail.test', () => this.send(server, to));
    } finally {
      this.testing = false;
    }
    if (!draft && !this.configured() && this.cached) {
      const settings = { ...this.cached.settings, lastTest: test };
      await this.services.pipeline.transactAccount(async (tx) => {
        await tx
          .update(applianceState)
          .set({ mailSettings: settings })
          .where(eq(applianceState.id, STATE_ID));
      });
      this.cached = { ...this.cached, settings };
    }
    return test;
  }

  private async send(server: Server, to: string): Promise<MailTest> {
    const at = () => this.services.clock().toISOString();
    const transport = this.transport(server, { connectMs: 10_000, socketMs: TEST_TIMEOUT_MS });
    try {
      await transport.sendMail({
        from: fromHeader(server),
        to,
        subject: MAIL_TEST_MESSAGE.subject,
        text: `${MAIL_TEST_MESSAGE.text}\n`,
      });
      return { state: 'sent', at: at(), to, detail: null };
    } catch (err) {
      const { state, detail } = mailTestOutcome(err, server.host, server.port);
      return { state, at: at(), to, detail };
    } finally {
      (transport as { close?: () => void }).close?.();
    }
  }

  /** A nodemailer transport for a server: TLS required as its `security` says, verified for its host name. */
  private transport(server: Server, t: { connectMs: number; socketMs: number }): MailTransport {
    const net = nets.get(this.services);
    const servername = isIP(server.host) ? undefined : server.host;
    return nodemailer.createTransport({
      host: net?.connectTo?.(server.host) ?? server.host,
      port: server.port,
      secure: server.security === 'tls',
      requireTLS: server.security === 'starttls',
      ignoreTLS: server.security === 'none',
      ...(servername ? { servername } : {}),
      name: '[127.0.0.1]',
      ...(server.username ? { auth: { user: server.username, pass: server.password ?? '' } } : {}),
      tls: {
        ...(servername ? { servername } : {}),
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ...(net?.ca ? { ca: net.ca } : {}),
      },
      connectionTimeout: t.connectMs,
      greetingTimeout: t.connectMs,
      socketTimeout: t.socketMs,
      dnsTimeout: 5_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    }) as unknown as MailTransport;
  }

  /**
   * Where the box's mail goes now (the mailer, each message): the person's server and its sender, or null for the
   * configuration's (`SMTP_URL`) or none. Kept until the settings change.
   */
  outgoing(): { transport: MailTransport; from: string } | null {
    if (this.services.config.SMTP_URL || !this.cached) return null;
    const server: Server = { ...this.cached.settings, password: this.cached.password };
    const key = `${server.host}:${server.port}:${server.security}:${server.username}:${this.cached.settings.updatedAt}`;
    if (this.transportFor?.key !== key)
      this.transportFor = { key, transport: this.transport(server, { connectMs: 15_000, socketMs: 30_000 }) };
    return { transport: this.transportFor.transport, from: fromHeader(server) };
  }
}
