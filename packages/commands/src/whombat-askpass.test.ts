/** ssh's askpass for a kept password (vault-simplify.md VLT-42): only ssh's own prompt, for that alias and user. */
import { describe, expect, it } from 'vitest';
import { askpassAnswer } from './whombat-askpass.mjs';

const files: Record<string, string> = {
  'wbpw1.invalid': JSON.stringify({ user: 'root', password: 'Kept-Passw0rd' }),
  'wbpw2.invalid': 'not json',
};
const read = (alias: string) => {
  const f = files[alias];
  if (f === undefined) throw new Error('ENOENT');
  return f;
};

describe('whombat-askpass', () => {
  it('answers ssh’s password prompt for a server with a kept password', () => {
    expect(askpassAnswer("root@wbpw1.invalid's password: ", read)).toBe('Kept-Passw0rd');
    expect(askpassAnswer("root@wbpw1.invalid's password:", read)).toBe('Kept-Passw0rd');
  });

  it('gives nothing to any other question', () => {
    // Another user, an alias without a file, a broken file.
    expect(askpassAnswer("admin@wbpw1.invalid's password: ", read)).toBeNull();
    expect(askpassAnswer("root@wbpw9.invalid's password: ", read)).toBeNull();
    // An alias without `.invalid` is a host name someone could answer to, never one of Whombat's.
    expect(askpassAnswer("root@wbpw1's password: ", read)).toBeNull();
    expect(askpassAnswer("root@wbpw2.invalid's password: ", read)).toBeNull();
    // A real host instead of Whombat's alias, a key's passphrase, text a server sends (keyboard-interactive).
    expect(askpassAnswer("root@192.168.1.20's password: ", read)).toBeNull();
    expect(askpassAnswer("Enter passphrase for key '/run/whombat/keys/ssh/abc': ", read)).toBeNull();
    expect(askpassAnswer("(root@host) Password for root@wbpw1.invalid's password: ", read)).toBeNull();
    expect(askpassAnswer('Password: ', read)).toBeNull();
  });
});
