/**
 * The credential of a managed turn (PV-04; one-person.md OP-09): the person's one home for the turn's provider, or a
 * refusal — and the providers then take their login from it alone. The "no fallback" test puts working sign-ins
 * everywhere else a careless implementation might look (another provider's home, an earlier per-account home, the
 * runner's environment) and checks none is used.
 */
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CredentialMeta,
  ensureCredentialHome,
  resolveTurnCredential,
  writeCredentialMeta,
} from './index';

const NOW = new Date('2026-09-25T12:00:00Z');

async function signIn(
  root: string,
  provider: 'claude' | 'codex',
  authMode: string,
  extra: Partial<CredentialMeta> = {},
) {
  const home = await ensureCredentialHome(root, provider);
  // A key is a file of the home; a ChatGPT login is Hermes's own, in the person's profile (HN-03): the record alone.
  if (authMode === 'api_key' || provider === 'claude')
    writeFileSync(join(home, 'api-key'), `sk-${provider}-key\n`, { mode: 0o600 });
  await writeCredentialMeta(home, {
    v: 1,
    provider,
    authMode,
    createdAt: NOW.toISOString(),
    expiresAt: null,
    verified: 'valid',
    verifiedAt: NOW.toISOString(),
    creatorAttested: false,
    login: null,
    signal: null,
    ...extra,
  });
  return home;
}

const resolve = (root: string, provider: 'claude' | 'codex', trigger = 'dm', more = {}) =>
  resolveTurnCredential({ root, provider, trigger, now: NOW, ...more });

describe('resolveTurnCredential', () => {
  it('uses the provider’s one home: PI for the person’s asking, NA for their automations and outsiders’ input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    const home = await signIn(root, 'codex', 'api_key');
    expect(home).toBe(join(root, 'codex'));
    expect(await resolve(root, 'codex')).toMatchObject({
      ok: true,
      credential: { workflow: 'PI', home, authMode: 'api_key', env: {} },
    });
    for (const trigger of ['automation', 'schedule', 'feedback'])
      expect(await resolve(root, 'codex', trigger)).toMatchObject({
        ok: true,
        credential: { workflow: 'NA' },
      });
    // Nothing of Codex's is written into the home (HN-04).
    expect(readdirSync(home).sort()).toEqual(['api-key', 'whombat-credential.json']);
  });

  it('runs the person’s own subscription (SUB-01, SUB-04)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    const claudeHome = await signIn(root, 'claude', 'subscription_cli');
    const codexHome = await signIn(root, 'codex', 'chatgpt');
    expect(await resolve(root, 'claude')).toMatchObject({
      ok: true,
      credential: {
        authMode: 'subscription_cli',
        workflow: 'PI',
        home: claudeHome,
        // The CLI's own login lives (and is refreshed) in the config dir; no key, no helper.
        env: { CLAUDE_CONFIG_DIR: join(claudeHome, 'config'), DISABLE_AUTOUPDATER: '1' },
      },
    });
    expect(await resolve(root, 'codex')).toMatchObject({
      ok: true,
      credential: { authMode: 'chatgpt', home: codexHome, env: {} },
    });
  });

  it('never falls back: not to another provider’s home, an earlier per-account home or the runner’s key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    await signIn(root, 'claude', 'api_key');
    mkdirSync(join(root, 'acc_mara', 'codex'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'acc_mara', 'codex', 'api-key'), 'sk-old\n');
    process.env.OPENAI_API_KEY = 'sk-runner';
    try {
      const r = await resolve(root, 'codex');
      expect(r).toMatchObject({ ok: false, state: 'not_signed_in', code: 'provider.not_signed_in' });
      expect(r.ok ? '' : r.explanation).toContain('ChatGPT');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
    // A home that is a link counts as none.
    const linked = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    symlinkSync(join(root, 'claude'), join(linked, 'claude'));
    expect(await resolve(linked, 'claude')).toMatchObject({ ok: false, state: 'not_signed_in' });
  });

  it('refuses an excluded mode, drift and an expired token, each distinctly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    await signIn(root, 'claude', 'subscription_sdk');
    expect(await resolve(root, 'claude')).toMatchObject({
      ok: false,
      state: 'gated',
      code: 'managed.provider_excluded',
    });
    const r2 = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    await signIn(r2, 'codex', 'api_key');
    const drift = {
      ok: false as const,
      reason: 'version' as const,
      explanation: 'Claude Code is 2.1.303, but this release of Whombat runs 2.1.302.',
      expected: { version: '2.1.302', sha256: null },
      found: { version: '2.1.303', sha256: null },
    };
    expect(await resolve(r2, 'codex', 'dm', { drift })).toMatchObject({ ok: false, state: 'version_drift' });
    const r3 = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    await signIn(r3, 'codex', 'access_token', {
      creatorAttested: true,
      expiresAt: '2026-09-25T11:00:00.000Z',
    });
    expect(await resolve(r3, 'codex')).toMatchObject({ ok: false, state: 'auth_expired' });
    // Without the creator's attestation an access token doesn't run at all.
    const r4 = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    await signIn(r4, 'codex', 'access_token', { expiresAt: '2026-10-25T11:00:00.000Z' });
    expect(await resolve(r4, 'codex')).toMatchObject({ ok: false, code: 'managed.provider_gated' });
  });

  it('says what the last run learned about the sign-in until it clears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-turn-cred-'));
    await signIn(root, 'claude', 'subscription_cli', {
      signal: { state: 'quota_exhausted', at: '2026-09-25T10:00:00Z', until: '2026-09-25T13:00:00Z' },
    });
    const r = await resolve(root, 'claude');
    expect(r).toMatchObject({ ok: false, state: 'quota_exhausted', code: 'provider.quota_exhausted' });
    expect(r.ok ? '' : r.explanation).toMatch(/^Your Claude/);
  });
});
