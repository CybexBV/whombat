/**
 * Sending over SMTP (docs/decisions/connections-more.md CM-22, CM-26): nodemailer to the checked address with the host
 * name for TLS, implicit TLS (465) or a required STARTTLS (587), TLS 1.2 or later, signed in as the account. It never
 * reads a file or a URL for a message (`disableFileAccess`, `disableUrlAccess`): the message is the bytes Whombat built.
 * The EHLO name is `[127.0.0.1]`, as Thunderbird sends, so the server's host name doesn't leave the box.
 */
import nodemailer from 'nodemailer';
import { mailErrorOf } from './errors';
import { MAIL_TIMEOUTS, type MailEndpoint, type MailTimeouts, serverNameOf } from './session';

export interface SmtpConnectOptions extends MailEndpoint {
  user: string;
  pass: string;
  timeouts?: Partial<MailTimeouts>;
  /** Tests only: a certificate authority to trust besides the system's. */
  ca?: string;
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
}

export interface SmtpClient {
  /** EHLO and AUTH (CM-22). Throws `MailError` (side `smtp`). */
  verify(o: SmtpConnectOptions): Promise<void>;
  /**
   * Sends `raw` to the envelope's recipients; how many of them the server refused while taking it for the others.
   * Throws `MailError` (side `smtp`) when it took it for nobody.
   */
  send(o: SmtpConnectOptions, envelope: SmtpEnvelope, raw: Buffer): Promise<{ rejected: number }>;
}

function transport(o: SmtpConnectOptions) {
  const t = { ...MAIL_TIMEOUTS, ...o.timeouts };
  const servername = serverNameOf(o.host);
  return nodemailer.createTransport({
    host: o.address,
    port: o.port,
    secure: o.security === 'tls',
    requireTLS: o.security === 'starttls',
    ignoreTLS: false,
    ...(servername ? { servername } : {}),
    name: '[127.0.0.1]',
    auth: { user: o.user, pass: o.pass },
    tls: {
      ...(servername ? { servername } : {}),
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(o.ca ? { ca: o.ca } : {}),
    },
    connectionTimeout: t.connectMs,
    greetingTimeout: t.greetingMs,
    socketTimeout: t.socketMs,
    dnsTimeout: 5_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}

export const nodemailerSmtp: SmtpClient = {
  async verify(o) {
    const t = transport(o);
    try {
      await t.verify();
    } catch (err) {
      throw mailErrorOf(err, 'smtp', o.host, o.port);
    } finally {
      t.close();
    }
  },
  async send(o, envelope, raw) {
    const t = transport(o);
    try {
      const info = await t.sendMail({ envelope: { from: envelope.from, to: [...envelope.to] }, raw });
      return { rejected: Array.isArray(info.rejected) ? info.rejected.length : 0 };
    } catch (err) {
      throw mailErrorOf(err, 'smtp', o.host, o.port);
    } finally {
      t.close();
    }
  },
};
