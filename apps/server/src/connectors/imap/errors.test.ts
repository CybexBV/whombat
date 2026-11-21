/**
 * Mail refusals read from the server's answer, never quoted (connection-signin.md SG-18): the errors as imapflow 2.5 and
 * nodemailer raise them (`authenticationFailed`, `serverResponseCode`, `response`; `EAUTH`, `responseCode`, `response`).
 */
import { describe, expect, it } from 'vitest';
import { isMicrosoftMailHost, mailErrorOf } from './errors';

/** imapflow's refused sign-in: a tagged NO, its response code, the line as text. */
function imapRefusal(code: string | null, response: string) {
  return Object.assign(new Error('Command failed'), {
    responseStatus: 'NO',
    authenticationFailed: true,
    ...(code ? { serverResponseCode: code } : {}),
    response,
  });
}

/** nodemailer's refused AUTH. */
function smtpRefusal(responseCode: number, response: string) {
  return Object.assign(new Error(`Invalid login: ${response}`), {
    code: 'EAUTH',
    command: 'AUTH PLAIN',
    responseCode,
    response,
  });
}

describe('mail refusals (SG-18)', () => {
  it('says what Gmail wants when it asks for an app password, on either side', () => {
    const imap = mailErrorOf(
      imapRefusal(
        'ALERT',
        'A2 NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)',
      ),
      'imap',
      'imap.gmail.com',
      993,
    );
    const smtp = mailErrorOf(
      smtpRefusal(
        534,
        '534-5.7.9 Application-specific password required. Learn more at https://support.google.com',
      ),
      'smtp',
      'smtp.gmail.com',
      465,
    );
    for (const err of [imap, smtp]) {
      expect(err.reason).toBe('refused');
      expect(err.message).toContain('app password');
      expect(err.message).toContain('myaccount.google.com/apppasswords');
      expect(err.message).not.toContain('support.google.com');
    }
  });

  it('asks for a sign-in in a browser without calling the password wrong', () => {
    const imap = mailErrorOf(
      imapRefusal(
        'ALERT',
        'A2 NO [ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)',
      ),
      'imap',
      'imap.gmail.com',
      993,
    );
    expect(imap.reason).toBe('web_sign_in');
    expect(imap.message).toContain('Gmail');
    expect(imap.message).toContain('web browser');
    const smtp = mailErrorOf(
      smtpRefusal(
        534,
        '534-5.7.14 <https://accounts.google.com/signin/continue> Please log in via your web browser and then try again.',
      ),
      'smtp',
      'smtp.example.org',
      587,
    );
    expect(smtp.reason).toBe('web_sign_in');
    expect(smtp.message).not.toContain('accounts.google.com');
  });

  it('says to contact the provider for CONTACTADMIN, not to wait', () => {
    const err = mailErrorOf(
      Object.assign(imapRefusal('CONTACTADMIN', 'A2 NO [CONTACTADMIN] Account disabled'), {}),
      'imap',
      'mail.example.org',
      993,
    );
    expect(err.reason).toBe('contact_provider');
    expect(err.message).toContain('contact your mail provider');
    expect(err.message).not.toContain('disabled');
    // The temporary ones stay busy.
    expect(
      mailErrorOf(imapRefusal('UNAVAILABLE', 'A2 NO [UNAVAILABLE] Try later'), 'imap', 'h', 993).reason,
    ).toBe('busy');
  });

  it('tells Outlook and Microsoft 365 apart: no password works there', () => {
    expect(isMicrosoftMailHost('outlook.office365.com')).toBe(true);
    expect(isMicrosoftMailHost('smtp-mail.outlook.com')).toBe(true);
    expect(isMicrosoftMailHost('outlook.office.com')).toBe(true);
    expect(isMicrosoftMailHost('imap.example.org')).toBe(false);
    expect(isMicrosoftMailHost('notoutlook.com')).toBe(false);
    const err = mailErrorOf(imapRefusal(null, 'A2 NO LOGIN failed.'), 'imap', 'outlook.office365.com', 993);
    expect(err.reason).toBe('refused');
    expect(err.message).toContain('Connect Microsoft 365 instead');
  });

  it('keeps the usual words for any other refused password', () => {
    const err = mailErrorOf(
      imapRefusal('AUTHENTICATIONFAILED', 'A2 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)'),
      'imap',
      'imap.example.org',
      993,
    );
    expect(err.reason).toBe('refused');
    expect(err.message).toContain('refused the password');
    expect(err.message).not.toContain('Invalid credentials');
  });
});
