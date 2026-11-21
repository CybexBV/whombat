import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifySignInSocket } from './signin-socket';

const dir = mkdtempSync(join(tmpdir(), 'wb-runner-sock-'));
const path = join(dir, 'signin.sock');
const server = createServer();
await new Promise<void>((r) => server.listen(path, () => r()));
afterAll(() => server.close());

describe('the sign-in socket check (review I-1, MR-34)', () => {
  it('accepts a socket its directory’s owner created in a directory only they can write', () => {
    chmodSync(dir, 0o711);
    expect(() => verifySignInSocket(path)).not.toThrow();
    expect(() => verifySignInSocket(path, process.getuid?.())).not.toThrow();
  });

  it('refuses a directory others may write, a file that is no socket, another uid and a missing socket', () => {
    chmodSync(dir, 0o777);
    expect(() => verifySignInSocket(path)).toThrow(/writable by others/);
    chmodSync(dir, 0o711);
    const plain = join(dir, 'plain');
    writeFileSync(plain, '');
    expect(() => verifySignInSocket(plain)).toThrow(/not a socket/);
    expect(() => verifySignInSocket(path, (process.getuid?.() ?? 0) + 1)).toThrow(/server’s user/);
    expect(() => verifySignInSocket(join(dir, 'missing.sock'))).toThrow(/missing/);
  });
});
