/**
 * Which Claude Code a turn runs (SUB-09, CT-73): an operator's pin, the manager's bundle (checked against its digest),
 * else the provider's own default; a client the manager should have installed and didn't refuses the turn. Claude Code
 * is the only client (hermes-native.md HN-A01): a Codex entry in the clients file is never resolved.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkClientPath, clientCommandSync, resolveClient } from '@whombat/agent-runtime/providers';
import { describe, expect, it } from 'vitest';
import { RunnerClients } from './clients';

// Plain path segments only: the contract's executable paths refuse a dotted segment (so not under ~/.cache).
const dir = mkdtempSync(join(/(^|\/)\./.test(tmpdir()) ? '/tmp' : tmpdir(), 'wb-runner-clients-'));
const exe = join(dir, 'claude-bundle');
writeFileSync(exe, 'the tested claude', { mode: 0o755 });
const sha = createHash('sha256').update('the tested claude').digest('hex');

function clientsFile(clients: unknown[]): string {
  const path = join(dir, `clients-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ v: 1, clients, channel: null }));
  return path;
}
const bundle = (path: string, sha256: string) => ({
  provider: 'claude',
  state: 'installed',
  installed: {
    version: '2.1.302',
    installedAt: '2026-09-26T10:00:00Z',
    executable: { path, sha256 },
    fixturesDigest: `sha256:${'c'.repeat(64)}`,
  },
  latest: null,
  progress: null,
  error: null,
});

describe('RunnerClients', () => {
  it('checks a bundle against its digest instead of the image’s pins', async () => {
    const legacy = async () => ({
      ok: false as const,
      reason: 'version' as const,
      explanation: 'image pin',
      expected: { version: 'x', sha256: null },
      found: { version: null, sha256: null },
    });
    const good = new RunnerClients({
      env: {},
      clientsFile: clientsFile([bundle(exe, sha)]),
      clientsRoot: dir,
      target: {},
    });
    expect(await good.drift(legacy)('claude')).toBeNull();
    const bad = new RunnerClients({
      env: {},
      clientsFile: clientsFile([bundle(exe, 'f'.repeat(64))]),
      clientsRoot: dir,
      target: {},
    });
    expect(await bad.drift(legacy)('claude')).toMatchObject({ ok: false, reason: 'digest' });
    const gone = new RunnerClients({
      env: {},
      clientsFile: clientsFile([bundle(join(dir, 'missing'), sha)]),
      clientsRoot: dir,
      target: {},
    });
    expect(await gone.drift(legacy)('claude')).toMatchObject({ ok: false, reason: 'missing' });
    // Not a bundle: the image's pins decide, as before.
    const pinned = new RunnerClients({ env: { WHOMBAT_CLAUDE_PATH: exe }, target: {} });
    expect(await pinned.drift(legacy)('claude')).toMatchObject({ explanation: 'image pin' });
  });
});

describe('which client executables may run at all (review CLI-1, CLI-4)', () => {
  // The manager's install root, and a directory the server's user could write (the reviewer's `/proc/self/cwd/evil`).
  const root = join(dir, 'clients');
  const elsewhere = join(dir, 'server-writable');
  mkdirSync(join(root, 'claude', '2.1.302'), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const installed = join(root, 'claude', '2.1.302', 'claude');
  writeFileSync(installed, 'the tested claude', { mode: 0o755 });
  const evil = join(elsewhere, 'evil');
  writeFileSync(evil, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
  const evilSha = createHash('sha256').update('#!/bin/sh\necho pwned\n').digest('hex');

  it('runs a bundle only from inside the clients root, for turns and sign-ins alike (repro sec-clients/runner.mts)', async () => {
    const options = { env: {}, clientsFile: clientsFile([bundle(evil, evilSha)]), clientsRoot: root };
    const target: NodeJS.ProcessEnv = {};
    const rc = new RunnerClients({ ...options, target });
    expect(await rc.prepare('claude')).toMatchObject({ ok: false, code: 'client.untrusted' });
    expect(target.WHOMBAT_CLAUDE_PATH).toBeUndefined();
    expect(clientCommandSync('claude', options)).toBeNull();
    // Through `/proc/self/cwd` or a link inside the root: the realpath decides.
    const viaProc = { ...options, clientsFile: clientsFile([bundle(`/proc/self/root${evil}`, evilSha)]) };
    expect(await resolveClient('claude', viaProc)).toMatchObject({ ok: false, code: 'client.untrusted' });
    symlinkSync(evil, join(root, 'claude', 'linked'));
    const viaLink = {
      ...options,
      clientsFile: clientsFile([bundle(join(root, 'claude', 'linked'), evilSha)]),
    };
    expect(await resolveClient('claude', viaLink)).toMatchObject({ ok: false, code: 'client.untrusted' });
    expect(clientCommandSync('claude', viaLink)).toBeNull();
    // No root configured: no bundle runs.
    expect(
      await resolveClient('claude', { env: {}, clientsFile: clientsFile([bundle(installed, sha)]) }),
    ).toMatchObject({
      ok: false,
      code: 'client.untrusted',
    });
  });

  it('never runs a Codex the manager still lists: Claude Code is the only client (HN-A01)', async () => {
    const codex = { ...bundle(installed, sha), provider: 'codex' };
    const options = { env: {}, clientsFile: clientsFile([codex]), clientsRoot: root };
    expect(await resolveClient('claude', options)).toMatchObject({ ok: false, code: 'client.not_installed' });
    expect(clientCommandSync('claude', options)).toBeNull();
  });

  it('runs the manager’s install, and a sign-in only with the digest it was installed with', async () => {
    const good = { env: {}, clientsFile: clientsFile([bundle(installed, sha)]), clientsRoot: root };
    expect(await resolveClient('claude', good)).toMatchObject({
      ok: true,
      source: 'bundle',
      path: installed,
    });
    expect(clientCommandSync('claude', good)).toBe(installed);
    const wrong = { ...good, clientsFile: clientsFile([bundle(installed, 'f'.repeat(64))]) };
    expect(clientCommandSync('claude', wrong)).toBeNull();
  });

  it('refuses a path any other user could change', () => {
    // A real shared temporary directory is essential here: this file's TMPDIR is private, so nothing beneath
    // it can be changed by another user even after opening the fixture's permissions. Leave that isolation intact.
    const accessible = mkdtempSync('/var/tmp/wb-client-access-');
    const open = join(accessible, 'open-root');
    mkdirSync(join(open, 'claude'), { recursive: true });
    writeFileSync(join(open, 'claude', 'claude'), 'x', { mode: 0o755 });
    // The test directory is private (0700): nothing below it is reachable by anyone else, whatever its mode.
    chmodSync(join(open, 'claude'), 0o777);
    expect(checkClientPath(join(open, 'claude', 'claude'), open)).toMatchObject({ ok: true });
    chmodSync(accessible, 0o755);
    chmodSync(open, 0o755);
    try {
      expect(checkClientPath(join(open, 'claude', 'claude'), open)).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/can be changed by other users/),
      });
      chmodSync(join(open, 'claude'), 0o755);
      chmodSync(join(open, 'claude', 'claude'), 0o775);
      expect(checkClientPath(join(open, 'claude', 'claude'), open)).toMatchObject({ ok: false });
      chmodSync(join(open, 'claude', 'claude'), 0o755);
      expect(checkClientPath(join(open, 'claude', 'claude'), open)).toMatchObject({ ok: true });
    } finally {
      chmodSync(accessible, 0o700);
      rmSync(accessible, { recursive: true, force: true });
    }
  });

  it('refuses turns and sign-ins when the clients file can’t be read, instead of falling back (repro apply2.mts)', async () => {
    const torn = join(dir, 'torn.json');
    writeFileSync(torn, '{"v":1,"clients":[{"provider":"claude","state":"insta');
    const options = { env: {}, clientsFile: torn, clientsRoot: root };
    expect(await resolveClient('claude', options)).toMatchObject({
      ok: false,
      code: 'client.status_unreadable',
    });
    expect(clientCommandSync('claude', options)).toBeNull();
    const wrongShape = join(dir, 'wrong.json');
    writeFileSync(wrongShape, JSON.stringify({ v: 1, clients: 'none' }));
    expect(await resolveClient('claude', { ...options, clientsFile: wrongShape })).toMatchObject({
      ok: false,
      code: 'client.status_unreadable',
    });
  });
});
