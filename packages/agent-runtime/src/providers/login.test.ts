/**
 * Sign-in drivers against stand-ins: the plugin's ChatGPT steps (HN-03) and a fake gh that reproduces what gh 2.101.0
 * was observed to print and write (PV-05). No real provider, no network, no credential of this machine.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_KEY_FILE,
  chatgptAccessTokenLogin,
  chatgptDeviceLogin,
  chatgptInstall,
  chatgptLoginFailure,
  chatgptRemove,
  claudeApiKeyLogin,
  claudeManagedSettings,
  credentialEnv,
  credentialHomePath,
  ensureCredentialHome,
  githubDeviceLogin,
  githubStatus,
  githubToken,
  githubTokenLogin,
  jwtExpiry,
  openaiApiKeyLogin,
  readCredentialMeta,
  recordRunSignal,
  verifyAnthropicKey,
  verifyOpenAIKey,
  writeCredentialMeta,
} from './index';

const FAKE_CHATGPT = fileURLToPath(new URL('./testing/fake-chatgpt-steps.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./testing/fake-gh.mjs', import.meta.url));

/** What a runner or server started from a shared .env might carry: none of it may reach a sign-in. */
const HOST_ENV = {
  PATH: process.env.PATH,
  HOME: '/home/operator',
  OPENAI_API_KEY: 'sk-operator',
  ANTHROPIC_API_KEY: 'sk-ant-operator',
  ANTHROPIC_AUTH_TOKEN: 'operator-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'operator-oauth',
  CODEX_HOME: '/home/operator/.codex',
  GH_TOKEN: 'gho_operator',
  GITHUB_TOKEN: 'ghs_operator',
  DATABASE_URL: 'postgres://x',
  WHOMBAT_MASTER_KEY: 'master',
  LANG: 'C.UTF-8',
};

const calls = (home: string) =>
  readFileSync(join(home, '.fake-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> });

function root() {
  return mkdtempSync(join(tmpdir(), 'wb-cred-'));
}

describe('credential homes', () => {
  it('are <root>/<provider>, one per provider, private (OP-09)', async () => {
    const r = root();
    const home = await ensureCredentialHome(r, 'codex');
    expect(home).toBe(join(r, 'codex'));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(r).mode & 0o777).toBe(0o700);
    expect(() => credentialHomePath(r, 'gemini' as never)).toThrow();
    expect(() => credentialHomePath('relative', 'codex')).toThrow();
  });

  it('keep metadata without secrets and record run signals', async () => {
    const home = await ensureCredentialHome(root(), 'codex');
    await writeCredentialMeta(home, {
      v: 1,
      provider: 'codex',
      authMode: 'api_key',
      createdAt: '2026-09-25T10:00:00.000Z',
      expiresAt: null,
      verified: 'valid',
      verifiedAt: '2026-09-25T10:00:00.000Z',
      creatorAttested: false,
      login: null,
      signal: null,
    });
    await recordRunSignal(
      home,
      { state: 'quota_exhausted', until: '2026-09-25T13:00:00.000Z' },
      new Date('2026-09-25T11:00:00Z'),
    );
    expect((await readCredentialMeta(home))?.signal).toEqual({
      state: 'quota_exhausted',
      at: '2026-09-25T11:00:00.000Z',
      until: '2026-09-25T13:00:00.000Z',
    });
    await recordRunSignal(home, null);
    expect((await readCredentialMeta(home))?.signal).toBeNull();
    expect(statSync(join(home, 'whombat-credential.json')).mode & 0o777).toBe(0o600);
  });
});

describe('ChatGPT sign-in through Hermes (the plugin’s steps standing in, HN-03)', () => {
  const steps = { command: [process.execPath, FAKE_CHATGPT], hostEnv: HOST_ENV };
  const staging = () => {
    const home = join(root(), 'signin', '.staging-test');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  };

  it('device code: the link and code as Hermes reports them, the login in the staging home, no host login', async () => {
    const home = staging();
    const login = chatgptDeviceLogin({ steps, home, now: () => new Date('2026-10-25T10:00:00Z') });
    expect(await login.code).toEqual({
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'FAKE-12345',
      expiresAt: '2026-10-25T10:15:00.000Z',
    });
    writeFileSync(join(home, '.fake-device'), 'approve');
    expect(await login.done).toEqual({ ok: true });
    expect(existsSync(join(home, 'auth.json'))).toBe(true);
    for (const call of calls(home)) {
      expect(call.env.HERMES_HOME).toBe(home);
      // An empty HOME of its own, and none of the host's logins.
      expect(call.env.HOME).not.toBe('/home/operator');
      for (const k of ['OPENAI_API_KEY', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'DATABASE_URL'])
        expect(call.env[k], k).toBeUndefined();
    }
    // The step's scratch directory doesn't outlive it.
    expect(readdirSync(home).filter((n) => n.startsWith('.step-'))).toEqual([]);
  });

  it('says why a code expired, was refused, or never came', async () => {
    for (const [control, reason] of [
      ['expire', 'expired'],
      ['deny', 'failed'],
    ] as const) {
      const home = staging();
      const login = chatgptDeviceLogin({ steps, home });
      await login.code;
      writeFileSync(join(home, '.fake-device'), control);
      expect(await login.done).toMatchObject({ ok: false, reason });
    }
    for (const [control, reason] of [
      ['disabled', 'disabled'],
      ['network', 'network'],
    ] as const) {
      const home = staging();
      writeFileSync(join(home, '.fake-device'), control);
      const login = chatgptDeviceLogin({ steps, home });
      await expect(login.code).rejects.toThrow();
      expect(await login.done).toMatchObject({ ok: false, reason });
    }
    const login = chatgptDeviceLogin({ steps, home: staging() });
    await login.code;
    login.cancel();
    expect(await login.done).toMatchObject({ ok: false, reason: 'cancelled' });
    const missing = chatgptDeviceLogin({ steps: { command: ['/nonexistent/python'] }, home: staging() });
    expect(await missing.done).toMatchObject({ ok: false, reason: 'missing' });
    expect(chatgptLoginFailure('busy').message).toMatch(/OpenAI/);
  });

  it('moves the staged login into the profile, signs out, and keeps a token only on stdin', async () => {
    const home = staging();
    const profile = join(root(), 'profiles', 'acc_mara');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    expect(await chatgptAccessTokenLogin(steps, home, 'not-a-jwt')).toMatchObject({ ok: false });
    expect(await chatgptAccessTokenLogin(steps, home, 'aaa.bbb.ccc')).toEqual({ ok: true });
    expect(calls(home).every((c) => !JSON.stringify(c).includes('aaa.bbb.ccc'))).toBe(true);
    await chatgptInstall(steps, home, profile);
    expect(existsSync(join(profile, 'auth.json'))).toBe(true);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    await expect(chatgptInstall(steps, home, profile)).rejects.toThrow(/install/);
    expect(await chatgptRemove(steps, profile, home)).toEqual({ removed: true });
    expect(await chatgptRemove(steps, profile, home)).toEqual({ removed: false });
  });

  it('an OpenAI API key is a private file of its home, no step run', async () => {
    const home = await ensureCredentialHome(root(), 'codex');
    expect(await openaiApiKeyLogin(home, ' sk-test-owner-key-0001\n')).toEqual({ ok: true });
    expect(readFileSync(join(home, CLAUDE_KEY_FILE), 'utf8')).toBe('sk-test-owner-key-0001\n');
    expect(statSync(join(home, CLAUDE_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(await openaiApiKeyLogin(home, 'two words')).toMatchObject({ ok: false });
    expect(await credentialEnv(home, 'codex', 'api_key')).toEqual({});
    // A ChatGPT login is Hermes's, in the profile: nothing of the home goes to a turn.
    expect(await credentialEnv(home, 'codex', 'chatgpt')).toEqual({});
  });

  it('reads a JWT’s expiry without trusting anything else in it', () => {
    const t = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    expect(jwtExpiry(t({ exp: 1_900_000_000 }))?.toISOString()).toBe('2030-03-17T17:46:40.000Z');
    expect(jwtExpiry(t({ exp: 'soon' }))).toBeNull();
    expect(jwtExpiry('garbage')).toBeNull();
  });
});

describe('GitHub sign-in (fake gh 2.101.0)', () => {
  const setup = async () => {
    const home = await ensureCredentialHome(root(), 'github');
    return { home, o: { command: FAKE_GH, home, hostEnv: HOST_ENV } };
  };

  it('device flow: relays the code, stores the token in the person’s own home (never a keyring)', async () => {
    const { home, o } = await setup();
    const login = githubDeviceLogin({ ...o, now: () => new Date('2026-09-25T10:00:00Z') });
    expect(await login.code).toEqual({
      verificationUri: 'https://github.com/login/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-09-25T10:15:00.000Z',
    });
    writeFileSync(join(home, '.fake-device'), 'approve');
    expect(await login.done).toEqual({ ok: true });
    expect(await githubStatus(o)).toEqual({ signedIn: true, login: 'octo' });
    expect(await githubToken(o)).toBe('gho_fakeDeviceToken');
    const [first] = calls(home);
    expect(first?.argv).toContain('--insecure-storage');
    expect(first?.env.GH_CONFIG_DIR).toBe(home);
    expect(first?.env.GH_TOKEN).toBeUndefined();
    expect(first?.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('token: through stdin; a refused token is reported and nothing is kept', async () => {
    const { home, o } = await setup();
    expect(await githubTokenLogin(o, 'ghp_bad_token')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Bad credentials'),
    });
    expect(await githubToken(o)).toBeNull();
    expect(await githubTokenLogin(o, 'github_pat_ok')).toEqual({ ok: true });
    expect(await githubToken(o)).toBe('github_pat_ok');
    for (const call of calls(home)) expect(JSON.stringify(call.argv)).not.toContain('github_pat_ok');
  });
});

describe('Claude API key', () => {
  it('is stored 0600 in the person’s home and becomes that turn’s only login', async () => {
    const home = await ensureCredentialHome(root(), 'claude');
    expect(await claudeApiKeyLogin(home, 'not-a-key')).toMatchObject({ ok: false });
    expect(await claudeApiKeyLogin(home, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toEqual({ ok: true });
    expect(statSync(join(home, CLAUDE_KEY_FILE)).mode & 0o777).toBe(0o600);
    // No secret in the environment (the managed sandbox passes none): Claude Code reads the key via apiKeyHelper.
    expect(await credentialEnv(home, 'claude', 'api_key')).toEqual({
      CLAUDE_CONFIG_DIR: join(home, 'config'),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(claudeManagedSettings(home)).toEqual({
      apiKeyHelper: `cat '${join(home, 'api-key')}'`,
      env: { DISABLE_UPDATES: '1' },
    });
    await expect(credentialEnv(home, 'claude', 'subscription_sdk')).rejects.toThrow();
  });
});

describe('Claude subscription home (SUB-03)', () => {
  it('runs the CLI with the home’s config dir and never opens what the CLI keeps there', async () => {
    const home = await ensureCredentialHome(root(), 'claude');
    // What `claude auth login` leaves behind, unreadable to anyone (Whombat included, by design).
    mkdirSync(join(home, 'config'), { mode: 0o700 });
    writeFileSync(join(home, 'config', '.credentials.json'), '{"not":"read"}', { mode: 0o000 });
    expect(await credentialEnv(home, 'claude', 'subscription_cli')).toEqual({
      CLAUDE_CONFIG_DIR: join(home, 'config'),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    // No key helper: the CLI uses its own login in CLAUDE_CONFIG_DIR.
    expect(claudeManagedSettings(home, 'subscription_cli')).toEqual({ env: { DISABLE_UPDATES: '1' } });
    // A config dir that is a link (somewhere else's login) is refused.
    const other = await ensureCredentialHome(root(), 'claude');
    symlinkSync(join(home, 'config'), join(other, 'config'));
    await expect(credentialEnv(other, 'claude', 'subscription_cli')).rejects.toThrow('not a directory');
  });
});

describe('free key checks', () => {
  const fetchWith = (status: number | 'throw') => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (status === 'throw') throw new Error('offline');
      return { status };
    };
    return { f, seen };
  };

  it('list models (no model call); 401 is invalid, anything else unverified', async () => {
    const ok = fetchWith(200);
    expect(await verifyAnthropicKey('sk-ant-x', ok.f)).toEqual({ result: 'valid' });
    expect(ok.seen[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(ok.seen[0]?.init.method).toBe('GET');
    expect(ok.seen[0]?.init.redirect).toBe('error');
    expect((await verifyOpenAIKey('sk-x', fetchWith(401).f)).result).toBe('invalid');
    expect((await verifyOpenAIKey('sk-x', fetchWith(403).f)).result).toBe('unverified');
    expect((await verifyOpenAIKey('sk-x', fetchWith('throw').f)).result).toBe('unverified');
    const openai = fetchWith(200);
    await verifyOpenAIKey('sk-x', openai.f);
    expect(openai.seen[0]?.url).toBe('https://api.openai.com/v1/models');
  });
});
