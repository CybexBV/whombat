/** The box's own mail server in both apps (AP-5405): the row, the form's checks and the fake the worlds use. */
import { MAIL_SETTINGS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { MAIL_TEXT, mailDraft, mailErrorText, mailForm, mailPortFor, mailTestText, mailView } from './mail';
import { createFakeMail } from './mail-fake';

const MARA = { email: 'mara@lumio.example.org' };

describe('EMAIL', () => {
  it('is off with Set up', () => {
    expect(mailView({ mail: null })?.actions).toEqual(['set_up']);
    expect(mailView(null)).toBeNull();
  });

  it('shows the server, the last test and Test, Change, Remove', () => {
    const v = mailView({ mail: { ...MAIL_SETTINGS, source: 'settings' } });
    expect(v?.title).toBe('Lumio Whombat');
    expect(v?.meta).toContain('smtp.lumio.example.org:587');
    expect(v?.dot).toBe('ok');
    expect(v?.actions).toEqual(['test', 'change', 'remove']);
  });

  it('a server from the configuration can only be tested', () => {
    expect(mailView({ mail: { ...MAIL_SETTINGS, source: 'config' } })?.actions).toEqual(['test']);
  });

  it('says a failed test with the server’s detail', () => {
    expect(mailTestText({ state: 'failed', detail: '554 nope' })).toContain('554 nope');
    expect(mailTestText({ state: 'sent', detail: null })).toContain('inbox');
    expect(mailTestText({ state: 'sent', detail: null, to: 'mara@lumio.example.org' })).toContain(
      'mara@lumio.example.org',
    );
    expect(mailTestText({ state: 'unreachable', detail: null, to: 'mara@lumio.example.org' })).not.toContain(
      'mara@lumio.example.org',
    );
  });

  it('says refusals by code', () => {
    expect(mailErrorText(new OperationError('host.mail.set', 409, 'mail.in_config', 'x'))).toBe(
      MAIL_TEXT.errors['mail.in_config'],
    );
    expect(mailErrorText(new Error('x'))).toBe(MAIL_TEXT.errors.failed);
  });
});

describe('the form', () => {
  const filled = {
    ...mailForm(null, 'mara@lumio.example.org'),
    host: 'smtp.lumio.example.org',
    username: 'whombat@lumio.example.org',
  };

  it('starts on STARTTLS, 587, from the person’s email', () => {
    expect(mailForm(null, 'mara@lumio.example.org')).toMatchObject({
      security: 'starttls',
      port: '587',
      from: 'mara@lumio.example.org',
    });
  });

  it('asks for a password with a user name, unless one is kept', () => {
    expect(mailDraft(filled, false)).toEqual({ ok: false, problem: 'password' });
    const kept = mailDraft(filled, true);
    expect(kept.ok && 'password' in kept.input).toBe(false);
    const typed = mailDraft({ ...filled, password: 'app-pass' }, false);
    expect(typed.ok && typed.input.password).toBe('app-pass');
  });

  it('refuses a login without encryption, a bad port and a bad from address', () => {
    expect(mailDraft({ ...filled, password: 'x', security: 'none' }, false)).toEqual({
      ok: false,
      problem: 'login_without_tls',
    });
    expect(mailDraft({ ...filled, password: 'x', port: '70000' }, false)).toEqual({
      ok: false,
      problem: 'port',
    });
    expect(mailDraft({ ...filled, password: 'x', from: 'nope' }, false)).toEqual({
      ok: false,
      problem: 'from',
    });
  });

  it('a server without a login clears the password', () => {
    const r = mailDraft({ ...filled, username: '', security: 'none', port: '25' }, true);
    expect(r.ok && r.input.password).toBeNull();
  });

  it('moves the port with the security while it is a default', () => {
    expect(mailPortFor('tls', '587')).toBe('465');
    expect(mailPortFor('tls', '2525')).toBe('2525');
  });
});

describe('the fake mail server', () => {
  it('keeps the password to itself, tests to the person and removes', () => {
    const mail = createFakeMail();
    const set = mail.call(
      'host.mail.set',
      {
        host: 'smtp.lumio.example.org',
        port: 587,
        security: 'starttls',
        username: 'w@lumio.example.org',
        password: 'p',
        from: 'w@lumio.example.org',
      },
      MARA,
    );
    expect(set?.status).toBe(200);
    expect(JSON.stringify(set?.body)).not.toContain('"password"');
    expect(mail.settings()?.hasPassword).toBe(true);
    const test = mail.call('host.mail.test', {}, MARA)?.body as { test: { state: string; to: string } };
    expect(test.test).toMatchObject({ state: 'sent', to: 'mara@lumio.example.org' });
    expect(mail.settings()?.lastTest?.state).toBe('sent');
    mail.call('host.mail.remove', {}, MARA);
    expect(mail.settings()).toBeNull();
    expect(mail.call('host.mail.test', {}, MARA)?.status).toBe(409);
  });
});
