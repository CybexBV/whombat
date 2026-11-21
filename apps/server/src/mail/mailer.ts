/**
 * Outgoing email: the digest. Every message goes to the person's own mail server when one is set (`BoxMail`), else to
 * `SMTP_URL` (Mailpit on :51025, UI :58025, in development; without it nothing is sent) when it is reachable; delivery
 * never blocks or fails the request. Only in development is the whole message also logged; elsewhere the log line
 * names the recipient only.
 */
import nodemailer from 'nodemailer';
import { externalEffect } from '../commit/scope';
import type { Config } from '../config';
import type { Logger } from '../services';
import { LOGO_CID, LOGO_PNG_BASE64 } from './logo';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Keeps messages in memory (tests read what was sent from here). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    await externalEffect('mail.send', async () => {
      this.sent.push(message);
    });
  }
  last(to?: string): MailMessage | undefined {
    const list = to ? this.sent.filter((m) => m.to === to) : this.sent;
    return list[list.length - 1];
  }
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
}

export interface MailTransport {
  sendMail(message: MailMessage & { from: string; attachments?: MailAttachment[] }): Promise<unknown>;
}

/** The logo the HTML template shows (`cid:`), attached inline when the HTML uses it (email-templates.md ET-02). */
export function inlineParts(message: MailMessage): MailAttachment[] {
  return message.html?.includes(`cid:${LOGO_CID}`)
    ? [
        {
          filename: 'whombat.png',
          content: Buffer.from(LOGO_PNG_BASE64, 'base64'),
          contentType: 'image/png',
          cid: LOGO_CID,
        },
      ]
    : [];
}

function smtpTransport(config: Config): MailTransport | null {
  return config.NODE_ENV !== 'test' && config.SMTP_URL
    ? nodemailer.createTransport(
        {
          url: config.SMTP_URL,
          connectionTimeout: config.SMTP_TIMEOUT_MS,
          greetingTimeout: config.SMTP_TIMEOUT_MS,
          socketTimeout: config.SMTP_TIMEOUT_MS * 2,
        },
        { from: config.MAIL_FROM },
      )
    : null;
}

/**
 * `transport` overrides the SMTP transport (tests); `null` sends nothing. `outgoing`, read per message: the person's own
 * mail server and its sender (`BoxMail`, hermes-engine.md HE-S225), which takes the message instead when set.
 */
export function createMailer(
  config: Config,
  logger: () => Logger,
  transport: MailTransport | null = smtpTransport(config),
  outgoing: () => { transport: MailTransport; from: string } | null = () => null,
): Mailer {
  const logBodies = config.NODE_ENV === 'development';
  return {
    async send(message) {
      // Mail can't be taken back: an effect of whatever command sends it (CS-01).
      await externalEffect('mail.send', async () => {
        logger().info(
          logBodies ? { to: message.to, subject: message.subject, body: message.text } : { to: message.to },
          'email',
        );
        const own = outgoing();
        const smtp = own?.transport ?? transport;
        if (!smtp) return;
        const attachments = inlineParts(message);
        smtp
          .sendMail({
            from: own?.from ?? config.MAIL_FROM,
            ...message,
            ...(attachments.length ? { attachments } : {}),
          })
          .catch((err: unknown) => {
            logger().warn({ err: String(err), to: message.to }, 'SMTP delivery failed');
          });
      });
    },
  };
}
