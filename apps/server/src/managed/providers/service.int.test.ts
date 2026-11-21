/**
 * Provider sign-in from a remote browser (docs/managed/provider-login.md), against stand-ins for the plugin's ChatGPT
 * steps on Hermes (hermes-native.md HN-03) and gh 2.101.0: key entry, device codes, expiry tracking, gating, account binding,
 * credential-home isolation, logout, the signed audit trail (never a secret), `appliance.status` rows and
 * organization credentials. The CLIs run in the runner's sign-in executor (`SignInWorker`), which takes each step
 * from the server over the real loopback runner protocol (PV-12). No real provider, network or credential.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialHomePath, recordRunSignal } from '@whombat/agent-runtime/providers';
import { SignInWorker } from '@whombat/runner/signin';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, applianceEvents, principals } from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import { verifyApplianceChain } from '../audit';
import type { SessionPrincipal } from '../trust';
import { type ProviderLoginService, providerLogins } from './service';

const FAKES = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), 'wb-logins-'));
const hermesRoot = mkdtempSync(join(tmpdir(), 'wb-logins-hermes-'));
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, RUNNER_TOKEN: 'signin-test-runner-token' },
});

let status = 200;
const fetched: string[] = [];
let svc: ProviderLoginService;
const who: Record<string, SessionPrincipal> = {};

let worker: SignInWorker;
beforeAll(async () => {
  svc = providerLogins(t.services, { drift: async () => null });
  worker = new SignInWorker({
    serverUrl: t.baseUrl,
    token: 'signin-test-runner-token',
    root,
    hermes: { root: hermesRoot },
    commands: {
      chatgpt: [process.execPath, join(FAKES, 'fake-chatgpt-steps.mjs')],
      gh: join(FAKES, 'fake-gh.mjs'),
      claude: join(FAKES, 'fake-claude.mjs'),
    },
    verifyFetch: async (url) => {
      fetched.push(url);
      return { status };
    },
  });
  worker.start();
  for (const name of ['mara'] as const) {
    const [p] = await t.services.db.select().from(principals).where(eq(principals.id, IDS[name]));
    const [account] = await t.services.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, p?.accountId as string));
    who[name] = {
      peerId: `peer-${name}`,
      publicKey: '00',
      endpoint: null,
      account: account as SessionPrincipal['account'],
      authzGeneration: 0,
    };
  }
});

afterAll(() => worker.stop());

const mara = () => who.mara as SessionPrincipal;
const acc = (p: SessionPrincipal) => p.account?.id as string;
const events = () => t.services.db.select().from(applianceEvents).orderBy(applianceEvents.seq);

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('key entry', () => {
  it('Codex API key: stored only in the account’s home, checked for free, audited without the key', async () => {
    const started = await svc.start(mara(), { provider: 'codex', authMode: 'api_key' });
    expect(started).toMatchObject({ state: 'awaiting_secret', device: null });
    const key = 'sk-test-mara-key-0000000001';
    const done = await svc.submit(mara(), { loginId: started.loginId, secret: key });
    expect(done).toMatchObject({ state: 'completed', verified: 'valid', error: null });
    expect(fetched.at(-1)).toBe('https://api.openai.com/v1/models');
    const home = join(root, 'codex');
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, 'api-key'), 'utf8').trim()).toBe(key);
    // No staging directory is left behind.
    expect(readdirSync(root).filter((n) => n.startsWith('.staging'))).toEqual([]);
    const signedIn = (await events()).filter((e) => e.type === 'provider.signed_in');
    expect(signedIn.at(-1)).toMatchObject({ actorAccountId: acc(mara()) });
    expect(signedIn.at(-1)?.payload).toMatchObject({
      provider: 'codex',
      authMode: 'api_key',
      verified: 'valid',
    });
    expect(JSON.stringify(await events())).not.toContain(key);
    expect(JSON.stringify(done)).not.toContain(key);
    expect((await verifyApplianceChain(t.services.db, t.services.custody)).ok).toBe(true);
  });

  it('a key the provider refuses is not kept; an unreachable check keeps it as “unverified”', async () => {
    status = 401;
    const a = await svc.start(mara(), { provider: 'claude', authMode: 'api_key' });
    const refused = await svc.submit(mara(), {
      loginId: a.loginId,
      secret: 'sk-ant-api03-wrongwrongwrongwrong',
    });
    expect(refused).toMatchObject({ state: 'failed', error: { code: 'provider.secret_invalid' } });
    expect(existsSync(join(root, 'claude'))).toBe(false);
    status = 503;
    const b = await svc.start(mara(), { provider: 'claude', authMode: 'api_key' });
    const kept = await svc.submit(mara(), {
      loginId: b.loginId,
      secret: 'sk-ant-api03-maramaramaramaramara',
    });
    expect(kept).toMatchObject({ state: 'completed', verified: 'unverified' });
    expect(readFileSync(join(root, 'claude', 'api-key'), 'utf8').trim()).toBe(
      'sk-ant-api03-maramaramaramaramara',
    );
    status = 200;
  });

  it('a Codex access token needs its creator’s word and an expiry (≤ 90 days), and is tracked', async () => {
    const a = await svc.start(mara(), { provider: 'codex', authMode: 'access_token' });
    await expect(svc.submit(mara(), { loginId: a.loginId, secret: 'aaa.bbb.ccc' })).rejects.toMatchObject({
      extra: { details: { code: 'provider.token_creator_required' } },
    });
    await expect(
      svc.submit(mara(), { loginId: a.loginId, secret: 'aaa.bbb.ccc', creatorAttested: true }),
    ).rejects.toMatchObject({ extra: { details: { code: 'provider.token_expiry_required' } } });
    const far = new Date(t.services.clock().getTime() + 120 * 86400_000).toISOString();
    await expect(
      svc.submit(mara(), {
        loginId: a.loginId,
        secret: 'aaa.bbb.ccc',
        creatorAttested: true,
        expiresAt: far,
      }),
    ).rejects.toMatchObject({ extra: { details: { code: 'provider.token_expiry_required' } } });
    const soon = new Date(t.services.clock().getTime() + 30 * 86400_000).toISOString();
    const done = await svc.submit(mara(), {
      loginId: a.loginId,
      secret: 'aaa.bbb.ccc',
      creatorAttested: true,
      expiresAt: soon,
    });
    expect(done).toMatchObject({ state: 'completed', verified: 'unverified' });
    const [row] = (await svc.list(mara())).signIns.filter((s) => s.provider === 'codex');
    expect(row).toMatchObject({ authMode: 'access_token', expiresAt: soon, state: 'ready' });
    // Hermes's own credential, in Mara's profile (HN-03).
    expect(existsSync(join(hermesRoot, 'auth.json'))).toBe(true);
  });
});

describe('device code (ChatGPT through Hermes, HN-03)', () => {
  const staged = () => readdirSync(join(hermesRoot, 'signin')).filter((n) => n.startsWith('.staging-'));

  it('the same link and code; Hermes’s login lands in the person’s profile, the record beside it', async () => {
    const started = await svc.start(mara(), { provider: 'codex', authMode: 'chatgpt' });
    expect(started).toMatchObject({
      state: 'awaiting_user',
      device: { verificationUri: 'https://auth.openai.com/codex/device', userCode: 'FAKE-12345' },
    });
    writeFileSync(join(hermesRoot, 'signin', staged()[0] as string, '.fake-device'), 'approve');
    await until(() => svc.status(mara(), { loginId: started.loginId }).state === 'completed');
    const row = (await svc.list(mara())).signIns.find((s) => s.provider === 'codex');
    expect(row).toMatchObject({ authMode: 'chatgpt', state: 'ready' });
    expect(existsSync(join(hermesRoot, 'auth.json'))).toBe(true);
    expect(readdirSync(join(root, 'codex'))).toEqual(['whombat-credential.json']);
    expect(staged()).toEqual([]);
    // Signing out takes Hermes's login with it.
    expect(await svc.logout(mara(), { provider: 'codex' })).toEqual({ removed: true });
    expect(existsSync(join(hermesRoot, 'auth.json'))).toBe(false);
  });

  it('an expired code says so and keeps nothing', async () => {
    const started = await svc.start(mara(), { provider: 'codex', authMode: 'chatgpt' });
    writeFileSync(join(hermesRoot, 'signin', staged()[0] as string, '.fake-device'), 'expire');
    await until(() => svc.status(mara(), { loginId: started.loginId }).state === 'expired');
    expect(existsSync(join(root, 'codex'))).toBe(false);
    expect(existsSync(join(hermesRoot, 'auth.json'))).toBe(false);
  });
});

describe('device code (GitHub)', () => {
  it('relays the code to the browser, completes when approved, and knows the login', async () => {
    const started = await svc.start(mara(), { provider: 'github', authMode: 'device' });
    expect(started).toMatchObject({
      state: 'awaiting_user',
      device: { verificationUri: 'https://github.com/login/device', userCode: 'ABCD-1234' },
    });
    const staging = readdirSync(root).find((n) => n.startsWith('.staging-github'));
    writeFileSync(join(root, staging as string, '.fake-device'), 'approve');
    await until(() => svc.status(mara(), { loginId: started.loginId }).state === 'completed');
    const gh = (await svc.list(mara())).signIns.find((s) => s.provider === 'github');
    expect(gh).toMatchObject({ authMode: 'device', login: 'octo', state: 'ready' });
  });

  it('reports expiry and cancellation', async () => {
    const a = await svc.start(mara(), { provider: 'github', authMode: 'device' });
    const staging = readdirSync(root).find((n) => n.startsWith('.staging-github'));
    writeFileSync(join(root, staging as string, '.fake-device'), 'expire');
    await until(() => svc.status(mara(), { loginId: a.loginId }).state === 'expired');
    const b = await svc.start(mara(), { provider: 'github', authMode: 'device' });
    expect(svc.cancel(mara(), { loginId: b.loginId }).state).toBe('cancelled');
    // Neither changed the sign-in she has.
    expect((await svc.list(mara())).signIns.find((s) => s.provider === 'github')).toMatchObject({
      authMode: 'device',
      login: 'octo',
      state: 'ready',
    });
  });
});

describe('policy and gating', () => {
  it('a person’s own subscription is permitted (SUB-01); Claude signs in in its console; no Agent SDK sign-in', async () => {
    // ChatGPT: the device code flow starts for the person's own account.
    const device = await svc.start(mara(), { provider: 'codex', authMode: 'chatgpt' });
    expect(device).toMatchObject({ state: 'awaiting_user', device: { userCode: expect.any(String) } });
    expect(svc.cancel(mara(), { loginId: device.loginId }).state).toBe('cancelled');
    // Claude subscription: permitted; it signs in in Claude Code's own sign-in in a console (CT-71), not a login.
    await expect(
      svc.start(mara(), { provider: 'claude', authMode: 'subscription_cli' }),
    ).rejects.toMatchObject({
      extra: { details: { code: 'provider.login_unavailable' } },
      message: expect.stringContaining('Claude Code’s own sign-in'),
    });
    await expect(
      svc.start(mara(), { provider: 'claude', authMode: 'subscription_sdk' }),
    ).rejects.toMatchObject({
      extra: { details: { code: 'provider.login_unavailable' } },
      message: expect.stringContaining('not through the Agent SDK'),
    });
    const modes = (await svc.list(mara())).modes;
    expect(modes.find((m) => m.provider === 'codex' && m.authMode === 'chatgpt')).toMatchObject({
      available: true,
    });
    expect(modes.find((m) => m.provider === 'claude' && m.authMode === 'subscription_cli')).toMatchObject({
      available: true,
      reason: null,
    });
    expect(modes.find((m) => m.provider === 'claude' && m.authMode === 'api_key')).toMatchObject({
      available: true,
    });
  });
});

describe('account binding and isolation', () => {
  it('appliance.status has the person’s rows, GitHub not among them', async () => {
    const all = await svc.statusRows(mara());
    expect(all.some((r) => r.provider === 'claude' && r.state === 'ready')).toBe(true);
    expect(all.every((r) => r.provider !== 'github')).toBe(true);
  });

  it('the last run’s signal comes through the runner’s list (CT-50 `CredentialMeta.signal`)', async () => {
    // Signed in to Codex again (the ChatGPT test signed out).
    const a = await svc.start(mara(), { provider: 'codex', authMode: 'api_key' });
    await svc.submit(mara(), { loginId: a.loginId, secret: 'sk-test-mara-key-0000000002' });
    const home = credentialHomePath(root, 'codex');
    await recordRunSignal(home, { state: 'quota_exhausted', until: '2099-01-01T00:00:00.000Z' });
    expect((await svc.statusRows(mara())).find((r) => r.provider === 'codex')).toMatchObject({
      state: 'quota_exhausted',
    });
    await recordRunSignal(home, null);
    expect((await svc.statusRows(mara())).find((r) => r.provider === 'codex')).toMatchObject({
      state: 'ready',
    });
  });

  it('logout removes the home (no CLI runs on it, SUB-41) and Hermes’s login, and is audited', async () => {
    expect(await svc.logout(mara(), { provider: 'codex' })).toEqual({ removed: true });
    expect(existsSync(join(root, 'codex'))).toBe(false);
    expect(existsSync(join(hermesRoot, 'auth.json'))).toBe(false);
    expect((await events()).at(-1)).toMatchObject({
      type: 'provider.signed_out',
      actorAccountId: acc(mara()),
      payload: { provider: 'codex', authMode: 'api_key' },
    });
    expect(await svc.logout(mara(), { provider: 'codex' })).toEqual({ removed: false });
    // Signing out of Codex never touched her other sign-ins.
    expect(existsSync(join(root, 'claude', 'api-key'))).toBe(true);
    expect((await svc.statusRows(mara())).find((r) => r.provider === 'codex')).toMatchObject({
      state: 'not_signed_in',
    });
  });
});

describe('the Claude sign-in console through the runner (CT-71)', () => {
  it('the runner runs it and reports output and the exit (signin.console); the server keeps the output', async () => {
    const started = await svc.consoleStart(mara(), {
      provider: 'claude',
      authMode: 'subscription_cli',
      cols: 80,
      rows: 24,
    });
    expect(started.state).toBe('running');
    let text = '';
    let cursor = 0;
    await until(async () => {
      const r = await svc.consoleRead(mara(), started.consoleId, { cursor, waitMs: 1000 });
      text += Buffer.from(r.data, 'base64').toString('utf8');
      cursor = r.next;
      return text.includes('Paste code here');
    }, 20_000);
    await svc.consoleWrite(mara(), started.consoleId, { seq: 1, data: 'good\r' });
    await until(
      async () =>
        (await svc.consoleRead(mara(), started.consoleId, { cursor, waitMs: 1000 })).console.state !==
        'running',
      20_000,
    );
    expect((await svc.list(mara())).consoles[0]).toMatchObject({
      consoleId: started.consoleId,
      state: 'completed',
    });
    expect((await svc.list(mara())).signIns).toContainEqual(
      expect.objectContaining({ provider: 'claude', authMode: 'subscription_cli' }),
    );
    await until(async () =>
      (await events()).some(
        (e) => e.type === 'provider.signed_in' && e.payload.authMode === 'subscription_cli',
      ),
    );
    await svc.logout(mara(), { provider: 'claude' });
  });
});
