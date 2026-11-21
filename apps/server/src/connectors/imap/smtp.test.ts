import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeSmtp, startFakeSmtp } from '../../test/mail';
import { MAIL_CERT } from '../../test/self-signed';
import { MailError } from './errors';
import { nodemailerSmtp, type SmtpConnectOptions } from './smtp';

const user = 'jo@home.test';
const pass = 'app-password-1';
const short = { connectMs: 2_000, greetingMs: 2_000, socketMs: 2_000 };

function options(server: { port: number }, extra: Partial<SmtpConnectOptions> = {}): SmtpConnectOptions {
  return {
    address: '127.0.0.1',
    host: 'mail.home.test',
    port: server.port,
    security: 'tls',
    user,
    pass,
    ca: MAIL_CERT,
    timeouts: short,
    ...extra,
  };
}

async function failure(p: Promise<unknown>): Promise<MailError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailError);
  return err as MailError;
}

describe('SMTP over nodemailer (CM-22, CM-26)', () => {
  let tls: FakeSmtp;
  let starttls: FakeSmtp;
  let plain: FakeSmtp;

  beforeAll(async () => {
    [tls, starttls, plain] = await Promise.all([
      startFakeSmtp({ user, pass, security: 'tls', refuse: ['nobody@home.test'] }),
      startFakeSmtp({ user, pass, security: 'starttls' }),
      startFakeSmtp({ user, pass, security: 'plain' }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([tls.close(), starttls.close(), plain.close()]);
  });

  it('signs in over implicit TLS and over STARTTLS, checking the certificate against the host name', async () => {
    await nodemailerSmtp.verify(options(tls));
    await nodemailerSmtp.verify(options(starttls, { security: 'starttls' }));
    expect(tls.logins.at(-1)).toEqual({ user, ok: true });
    expect(starttls.logins.at(-1)).toEqual({ user, ok: true });
  });

  it('sends the raw message to the envelope’s recipients', async () => {
    const raw = Buffer.from('From: jo@home.test\r\nTo: mara@example.com\r\nSubject: Hi\r\n\r\nHello\r\n');
    const res = await nodemailerSmtp.send(
      options(tls),
      { from: user, to: ['mara@example.com', 'blind@example.com'] },
      raw,
    );
    expect(res).toEqual({ rejected: 0 });
    const taken = tls.messages.at(-1);
    expect(taken?.from).toBe(user);
    expect(taken?.to).toEqual(['mara@example.com', 'blind@example.com']);
    expect(taken?.raw).toContain('Subject: Hi');
  });

  it('counts recipients the server refused while taking it for the others', async () => {
    const raw = Buffer.from('From: jo@home.test\r\nSubject: Two\r\n\r\nx\r\n');
    const res = await nodemailerSmtp.send(
      options(tls),
      { from: user, to: ['mara@example.com', 'nobody@home.test'] },
      raw,
    );
    expect(res).toEqual({ rejected: 1 });
  });

  it('says which kind of failure, in words', async () => {
    const refused = await failure(nodemailerSmtp.verify(options(tls, { pass: 'wrong' })));
    expect(refused).toMatchObject({ side: 'smtp', reason: 'refused' });
    expect(refused.message).toContain('app password');

    const noTls = await failure(nodemailerSmtp.verify(options(plain, { security: 'starttls' })));
    expect(noTls.reason).toBe('no_tls');
    // The password never went out in plain text.
    expect(plain.logins).toEqual([]);

    const wrongName = await failure(nodemailerSmtp.verify(options(tls, { host: 'other.home.test' })));
    expect(wrongName.reason).toBe('certificate');

    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = await failure(nodemailerSmtp.verify(options({ port })));
    expect(unreachable.reason).toBe('unreachable');
    expect(unreachable.message).toBe(`Whombat couldn’t reach mail.home.test on port ${port}.`);
  });
});
