/**
 * ChatGPT sign-ins through Hermes in the sign-in executor (hermes-native.md HN-03): the same link and code, the login
 * staged under the Hermes root and moved into the person's own profile before the sign-in is recorded, the record alone
 * in the credential home, sign-out removing both; an OpenAI key stays a file. The plugin's steps stand in.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_KEY_FILE, credentialHomePath, readCredentialMeta } from './credential-home';
import { type DeviceDone, LocalSignInExecutor } from './signin-executor';

const FAKE_CHATGPT = fileURLToPath(new URL('./testing/fake-chatgpt-steps.mjs', import.meta.url));

function setup() {
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-chatgpt-signin-'));
  const root = join(base, 'credentials');
  const hermes = join(base, 'hermes');
  let resolveDone!: (d: DeviceDone) => void;
  const done = new Promise<DeviceDone>((r) => {
    resolveDone = r;
  });
  const executor = new LocalSignInExecutor({
    root,
    hermes: { root: hermes },
    commands: { chatgpt: [process.execPath, FAKE_CHATGPT] },
    onDeviceDone: (d) => resolveDone(d),
    fetch: async () => ({ status: 200 }),
  });
  // The person's profile is the Hermes root, Hermes's default profile (OP-08).
  const profile = hermes;
  const home = credentialHomePath(root, 'codex');
  const staged = () => readdirSync(join(hermes, 'signin')).filter((n) => n.startsWith('.staging-'));
  return { executor, done, hermes, profile, home, staged };
}

const target = {
  loginId: 'lgn_1',
  provider: 'codex' as const,
  authMode: 'chatgpt',
};

describe('ChatGPT sign-in through Hermes (HN-03)', () => {
  it('shows OpenAI’s link and code, then keeps Hermes’s login in the person’s profile and records it', async () => {
    const { executor, done, hermes, profile, home, staged } = setup();
    const started = await executor.startDevice(target);
    expect(started).toMatchObject({
      ok: true,
      device: { verificationUri: 'https://auth.openai.com/codex/device', userCode: 'FAKE-12345' },
    });
    const [staging] = staged();
    writeFileSync(join(hermes, 'signin', staging as string, '.fake-device'), 'approve');
    expect(await done).toEqual({ loginId: 'lgn_1', ok: true, login: null });
    expect(existsSync(join(profile, 'auth.json'))).toBe(true);
    // The record alone: no login, no Codex home.
    expect(readdirSync(home)).toEqual(['whombat-credential.json']);
    expect((await readCredentialMeta(home))?.authMode).toBe('chatgpt');
    expect(staged()).toEqual([]);
    // Signing out removes the record and Hermes's login.
    expect(await executor.logout('codex')).toEqual({ removed: true, authMode: 'chatgpt' });
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(profile, 'auth.json'))).toBe(false);
    await executor.close();
  });

  it('an expired code keeps nothing, anywhere', async () => {
    const { executor, done, hermes, profile, home, staged } = setup();
    await executor.startDevice(target);
    writeFileSync(join(hermes, 'signin', staged()[0] as string, '.fake-device'), 'expire');
    expect(await done).toMatchObject({ ok: false, state: 'expired', code: 'provider.login_expired' });
    expect(existsSync(join(profile, 'auth.json'))).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(staged()).toEqual([]);
    await executor.close();
  });

  it('a Codex access token goes into the profile through Hermes; an OpenAI key stays a file', async () => {
    const { executor, profile, home } = setup();
    const secret = { ...target, loginId: 'lgn_2', expiresAt: null, creatorAttested: true };
    expect(
      await executor.submitSecret({ ...secret, authMode: 'access_token', secret: 'aaa.bbb.ccc' }),
    ).toMatchObject({ ok: true });
    expect(existsSync(join(profile, 'auth.json'))).toBe(true);
    expect(readdirSync(home)).toEqual(['whombat-credential.json']);
    expect(
      await executor.submitSecret({ ...secret, authMode: 'access_token', secret: 'not-a-token' }),
    ).toMatchObject({ ok: false });
    expect(
      await executor.submitSecret({ ...secret, authMode: 'api_key', secret: 'sk-test-owner-key-0001' }),
    ).toMatchObject({ ok: true, verified: 'valid' });
    expect(readdirSync(home).sort()).toEqual([CLAUDE_KEY_FILE, 'whombat-credential.json']);
    await executor.close();
  });
});
