import { describe, expect, it } from 'vitest';
import {
  isHashedMailbox,
  MAIL_ID_MAX,
  messageIdOf,
  parseMessageId,
  parseThreadId,
  resolveMailbox,
  threadIdOf,
  threadRoot,
} from './ids';

describe('IMAP message ids (CM-24)', () => {
  it('round-trips the folder, UIDVALIDITY and UID', () => {
    const ref = { mailbox: 'INBOX', uidValidity: '1700000000', uid: 42 };
    const id = messageIdOf(ref);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseMessageId(id)).toEqual(ref);
    expect(Buffer.from(id, 'base64url').toString()).toBe('INBOX\u00001700000000\u000042');
  });

  it('keeps folder names with any characters', () => {
    const ref = { mailbox: 'Clients/Ünïcode “quotes”', uidValidity: '7', uid: 4294967295 };
    expect(parseMessageId(messageIdOf(ref))).toEqual(ref);
  });

  it('hashes a folder name too long for an id, and finds it again among the folders', () => {
    const long = `Projects/${'very long folder name '.repeat(10)}`;
    const id = messageIdOf({ mailbox: long, uidValidity: '9', uid: 1 });
    expect(id.length).toBeLessThanOrEqual(MAIL_ID_MAX);
    const ref = parseMessageId(id);
    expect(ref && isHashedMailbox(ref.mailbox)).toBe(true);
    expect(resolveMailbox(ref?.mailbox ?? '', ['INBOX', long])).toBe(long);
    expect(resolveMailbox(ref?.mailbox ?? '', ['INBOX'])).toBeNull();
  });

  it('refuses what isn’t one of its ids', () => {
    expect(parseMessageId('18c2b3a4f5e6d7c8')).toBeNull(); // a Gmail id
    expect(parseMessageId(Buffer.from('INBOX\u00000\u00001').toString('base64url'))).toBeNull(); // UIDVALIDITY 0
    expect(parseMessageId(Buffer.from('INBOX\u00001\u0000x').toString('base64url'))).toBeNull();
    expect(parseMessageId('not base64!')).toBeNull();
  });
});

describe('IMAP thread ids (CM-24, CM-M02)', () => {
  const message = { mailbox: 'INBOX', uidValidity: '5', uid: 9 };

  it('is the References root, else In-Reply-To, else the own Message-ID', () => {
    expect(threadRoot({ references: '<a@x> <b@x>', inReplyTo: '<b@x>', messageId: '<c@x>' })).toBe('<a@x>');
    expect(threadRoot({ references: null, inReplyTo: '<b@x>', messageId: '<c@x>' })).toBe('<b@x>');
    expect(threadRoot({ messageId: '<c@x>' })).toBe('<c@x>');
    expect(threadRoot({})).toBeNull();
  });

  it('names its folder and root, the same for every message of the thread', () => {
    const a = threadIdOf(message, '<root@x>');
    const b = threadIdOf({ ...message, uid: 10 }, '<root@x>');
    expect(a).toBe(b);
    expect(parseThreadId(a)).toEqual({ kind: 'root', mailbox: 'INBOX', root: '<root@x>' });
  });

  it('is the message alone without a root, or with one too long for an id', () => {
    expect(parseThreadId(threadIdOf(message, null))).toEqual({ kind: 'message', message });
    const long = `<${'x'.repeat(300)}@x>`;
    const id = threadIdOf(message, long);
    expect(id.length).toBeLessThanOrEqual(MAIL_ID_MAX);
    expect(parseThreadId(id)).toEqual({ kind: 'message', message });
  });

  it('never reads a message id as a thread id', () => {
    expect(parseThreadId(messageIdOf(message))).toBeNull();
  });
});
