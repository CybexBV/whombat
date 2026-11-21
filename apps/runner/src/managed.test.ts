import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CredentialMeta,
  ensureCredentialHome,
  writeCredentialMeta,
} from '@whombat/agent-runtime/providers';
import { describe, expect, it } from 'vitest';
import { managedTurnCredential } from './managed';

const meta: CredentialMeta = {
  v: 1,
  provider: 'claude',
  authMode: 'api_key',
  createdAt: '2026-09-25T10:00:00.000Z',
  expiresAt: null,
  verified: 'valid',
  verifiedAt: null,
  creatorAttested: false,
  login: null,
  signal: null,
};

const ctx = (trigger: string) =>
  ({ agent: { runtime: { provider: 'claude' } }, dispatch: { trigger }, credential: null }) as never;

describe('managed execution policy', () => {
  it('runs on the person’s one home for the provider, or refuses (no fallback, OP-09)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-runner-cred-'));
    // Nobody signed in yet; no root; a provider with no sign-in: refused.
    expect(await managedTurnCredential({ credentialsRoot: root }, ctx('dm'), 'claude')).toMatchObject({
      ok: false,
      code: 'provider.not_signed_in',
    });
    expect(await managedTurnCredential({}, ctx('dm'), 'claude')).toMatchObject({ ok: false });
    expect(await managedTurnCredential({ credentialsRoot: root }, ctx('dm'), 'local')).toMatchObject({
      ok: false,
    });
    // The person signs in: their request runs on their key (PI), their automation too (NA).
    const home = await ensureCredentialHome(root, 'claude');
    writeFileSync(join(home, 'api-key'), 'sk-ant-mara-key-00000000000000000000\n', { mode: 0o600 });
    await writeCredentialMeta(home, meta);
    expect(await managedTurnCredential({ credentialsRoot: root }, ctx('dm'), 'claude')).toMatchObject({
      ok: true,
      credential: { workflow: 'PI', home, env: { CLAUDE_CONFIG_DIR: join(home, 'config') } },
      owner: { account: 'person', provider: 'claude', authMode: 'api_key', home },
    });
    expect(await managedTurnCredential({ credentialsRoot: root }, ctx('automation'), 'claude')).toMatchObject(
      {
        ok: true,
        credential: { workflow: 'NA', home },
      },
    );
    const drift = async () =>
      ({
        ok: false,
        reason: 'version',
        explanation: 'drifted',
        expected: { version: 'a', sha256: null },
        found: { version: 'b', sha256: null },
      }) as const;
    expect(await managedTurnCredential({ credentialsRoot: root, drift }, ctx('dm'), 'claude')).toMatchObject({
      ok: false,
      code: 'provider.version_drift',
    });
  });
});
