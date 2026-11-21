/**
 * An SMTP server in this process for the Email (IMAP) tests (smtp-server): implicit TLS or STARTTLS with the
 * `mail.home.test` certificate, one account, and the messages it took (envelope and raw bytes).
 */
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { MAIL_CERT, MAIL_KEY } from './self-signed';

export interface TakenMessage {
  from: string;
  to: string[];
  raw: string;
}

export interface FakeSmtp {
  port: number;
  messages: TakenMessage[];
  /** Sign-ins tried (refused ones too). */
  logins: { user: string; ok: boolean }[];
  close(): Promise<void>;
}

export async function startFakeSmtp(options: {
  user: string;
  pass: string;
  /** `tls`: implicit TLS; `starttls`: plain until STARTTLS; `plain`: no TLS at all (offered nothing). */
  security: 'tls' | 'starttls' | 'plain';
  /** Recipients it refuses at RCPT TO. */
  refuse?: string[];
}): Promise<FakeSmtp> {
  const messages: TakenMessage[] = [];
  const logins: FakeSmtp['logins'] = [];
  const server = new SMTPServer({
    secure: options.security === 'tls',
    key: MAIL_KEY,
    cert: MAIL_CERT,
    logger: false,
    disabledCommands: options.security === 'plain' ? ['STARTTLS'] : [],
    allowInsecureAuth: options.security === 'plain',
    onAuth(auth, _session, callback) {
      const ok = auth.username === options.user && auth.password === options.pass;
      logins.push({ user: auth.username ?? '', ok });
      if (ok) return callback(null, { user: auth.username });
      const err = Object.assign(new Error('Invalid username or password'), { responseCode: 535 });
      return callback(err);
    },
    onRcptTo(address, _session, callback) {
      if (options.refuse?.includes(address.address.toLowerCase()))
        return callback(Object.assign(new Error('No such user'), { responseCode: 550 }));
      return callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        messages.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  // A client that drops the connection mid-handshake (a certificate it refused) is not the test's failure.
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    messages,
    logins,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
