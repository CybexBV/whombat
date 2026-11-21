import { type ImapServerSettings, imapProviderFor, imapProviderHint } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { ApiError, InvalidRequestError } from './http/errors';
import {
  draftFromSettings,
  hintLinks,
  hintLinkText,
  imapAvailable,
  imapConnection,
  imapConnectProblem,
  imapFailureReason,
  looksLikeEmail,
  mailAccountLine,
  mailCheckName,
  settingsFromDraft,
  withSecurity,
} from './imap';

const FASTMAIL: ImapServerSettings = {
  imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
  smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
  username: null,
};

const refused = (reason: string, message = '') =>
  new ApiError(409, 'bad_request', message, null, 'connectors.imapConnect', {}, { reason });

describe('the address and the account (CM-19, CM-20)', () => {
  it('is looked up once it has a domain with a dot', () => {
    expect(looksLikeEmail('mara@fastmail')).toBe(false);
    expect(looksLikeEmail(' mara@fastmail.com ')).toBe(true);
  });

  it('is offered where the Whombat has it, one account per person', () => {
    expect(imapAvailable({})).toBe(false);
    expect(imapAvailable({ imap: { available: true } })).toBe(true);
    const mail = { id: 'con_mail', provider: 'imap' } as never;
    expect(imapConnection({ connections: [{ id: 'con_g', provider: 'google' } as never, mail] })).toBe(mail);
  });

  it('says what a connected account uses, or that it needs a new password', () => {
    expect(
      mailAccountLine({ status: 'active', mail: { imapHost: 'a.b', smtpHost: 'c.d', username: 'mara' } }),
    ).toContain('a.b and c.d');
    expect(mailAccountLine({ status: 'active', mail: null })).toBe('Connected');
    expect(mailAccountLine({ status: 'needs_reauth', mail: null })).toContain('password');
  });

  it('names a check by the server it is about', () => {
    expect([mailCheckName({ side: 'imap' }), mailCheckName({ side: 'smtp' }), mailCheckName({})]).toEqual([
      'Receiving',
      'Sending',
      'Mail',
    ]);
  });
});

describe('the server fields', () => {
  it('move the port with the security only while it is the usual one', () => {
    const draft = draftFromSettings(FASTMAIL);
    expect(withSecurity(draft, 'smtp', 'starttls').smtpPort).toBe('587');
    expect(withSecurity({ ...draft, imapPort: '1993' }, 'imap', 'starttls').imapPort).toBe('1993');
  });

  it('turn into settings, or say what is wrong under each field', () => {
    const draft = draftFromSettings(FASTMAIL);
    expect(settingsFromDraft({ ...draft, username: ' mara ' }).settings).toEqual({
      ...FASTMAIL,
      username: 'mara',
    });
    const wrong = settingsFromDraft({ ...draft, imapHost: '', smtpPort: '70000', smtpHost: 'smtp fast' });
    expect(Object.keys(wrong.errors ?? {}).sort()).toEqual(['imapHost', 'smtpHost', 'smtpPort']);
  });
});

describe('a refused connect (CM-22)', () => {
  it('puts the IMAP side refusing the password under the password', () => {
    const problem = imapConnectProblem(refused('imap_refused', 'The mail server refused the password.'));
    expect(problem).toMatchObject({ message: null, openServers: false });
    expect(problem.fields.password).toContain('refused the password');
  });

  it('opens the server fields for the rest, with the server’s sentence', () => {
    for (const reason of [
      'imap_unreachable',
      'smtp_unreachable',
      'smtp_refused',
      'not_allowed',
      'certificate',
    ]) {
      const problem = imapConnectProblem(
        refused(reason, 'Whombat couldn’t reach smtp.example.com on port 587.'),
      );
      expect(imapFailureReason(refused(reason))).toBe(reason);
      expect(problem.openServers).toBe(true);
      expect(problem.message).toContain('smtp.example.com');
    }
  });

  it('has the contracts’ words when the server sends none', () => {
    expect(imapConnectProblem(refused('smtp_unreachable')).message).toContain('couldn’t reach');
    expect(imapConnectProblem(new Error('offline')).message).toContain('Try again');
  });

  it('puts field errors under their fields', () => {
    const problem = imapConnectProblem(
      new InvalidRequestError('connectors.imapConnect', 'body', {
        email: ['Enter your email address.'],
        'settings.smtp.port': ['Too big.'],
      }),
    );
    expect(Object.keys(problem.fields).sort()).toEqual(['email', 'smtpPort']);
    expect(problem.openServers).toBe(true);
  });
});

describe('a provider’s hint (CM-21)', () => {
  it('links to the connection to use instead, or the provider’s page', () => {
    const hint = {
      name: 'iCloud',
      text: 'Make an app password.',
      url: 'https://account.apple.com',
      useInstead: null,
    };
    expect(hintLinkText(hint)).toContain('iCloud');
    expect(hintLinkText({ ...hint, useInstead: 'google' })).toContain('Google');
    expect(hintLinkText({ ...hint, url: null })).toBeNull();
  });

  it('shows both links where a hint has both: Gmail’s Google connection and its app password (SG-18d)', () => {
    const gmail = imapProviderHint(imapProviderFor('mara@gmail.com') as never);
    const links = hintLinks(gmail);
    expect(links.instead).toMatchObject({ connection: 'google', text: 'Connect Google instead' });
    expect(links.page?.url).toContain('myaccount.google.com/apppasswords');
    expect(links.page?.text).toContain('app password');
    const icloud = hintLinks({
      name: 'iCloud Mail',
      text: '…',
      url: 'https://account.apple.com',
      useInstead: null,
    });
    expect([icloud.instead, icloud.page?.text]).toEqual([null, 'Open iCloud Mail']);
    expect(hintLinks({ name: 'Proton Mail', text: '…', url: null, useInstead: null })).toEqual({
      instead: null,
      page: null,
    });
  });
});
