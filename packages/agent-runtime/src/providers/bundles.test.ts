import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bundledClaudeBinary,
  CLAUDE_BUNDLE,
  checkProviderDrift,
  claudeApiKeyLogin,
  claudeLoginStatus,
  claudeManagedSettings,
  compareToBundle,
  credentialEnv,
  ensureCredentialHome,
  managedAvailability,
  PROVIDER_BUNDLES,
  providerExecutable,
} from './index';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..');

describe('pinned bundles', () => {
  it('the npm packages are the pinned versions; Claude Code is the one pinned client (HN-04)', () => {
    expect(Object.keys(PROVIDER_BUNDLES)).toEqual(['claude']);
    expect(CLAUDE_BUNDLE.versionOutput).toBe(`${CLAUDE_BUNDLE.version} (Claude Code)`);
    // No library between Whombat and the binary (SUB-02, SUB-10).
    expect(CLAUDE_BUNDLE.packages).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    expect(JSON.stringify(manifest)).not.toContain('claude-agent-sdk');
    for (const b of CLAUDE_BUNDLE.binaries)
      expect(manifest.optionalDependencies[`@anthropic-ai/claude-code-${b.platform}`]).toBe(
        CLAUDE_BUNDLE.version,
      );
    // No Codex CLI ships with Whombat: ChatGPT runs on Hermes's own provider.
    expect(JSON.stringify(manifest)).not.toContain('@openai/codex');
  });

  it.skipIf(!bundledClaudeBinary())(
    'the Claude Code installed with Whombat is the pinned binary, and what runs without WHOMBAT_CLAUDE_PATH',
    async () => {
      expect(providerExecutable('claude', { PATH: '/usr/bin:/bin' })).toBe(bundledClaudeBinary());
      expect(await checkProviderDrift('claude', { PATH: '/usr/bin:/bin' })).toEqual({ ok: true });
    },
    30_000,
  );
});

describe('drift check', () => {
  const installed = {
    path: '/nix/store/x-claude/bin/claude',
    versionOutput: CLAUDE_BUNDLE.versionOutput,
    sha256: CLAUDE_BUNDLE.binaries[0]?.binarySha256 ?? null,
  };

  it('reports another version, another binary, a missing one, an unpinned platform', () => {
    expect(
      compareToBundle(CLAUDE_BUNDLE, { ...installed, versionOutput: '9.9.9 (Claude Code)' }, 'linux-x64'),
    ).toMatchObject({ ok: false, reason: 'version' });
    expect(
      compareToBundle(CLAUDE_BUNDLE, { ...installed, sha256: 'f'.repeat(64) }, 'linux-x64'),
    ).toMatchObject({ ok: false, reason: 'digest' });
    expect(
      compareToBundle(CLAUDE_BUNDLE, { path: null, versionOutput: null, sha256: null }, 'linux-x64'),
    ).toMatchObject({ ok: false, reason: 'missing' });
    expect(compareToBundle(CLAUDE_BUNDLE, installed, null)).toMatchObject({
      ok: false,
      reason: 'unpinned_platform',
    });
    expect(compareToBundle(CLAUDE_BUNDLE, installed, 'linux-x64')).toEqual({ ok: true });
  });
});

describe('managed availability (pinned runtime only, never a login)', () => {
  it('reports a missing or unpinned runtime, and a release pin that disagrees with this build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-avail-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, `#!/bin/sh\necho "${CLAUDE_BUNDLE.versionOutput}"\n`);
    chmodSync(fake, 0o755);
    // The right version string, but not the published binary.
    expect(
      await managedAvailability('claude', { PATH: '/usr/bin:/bin', WHOMBAT_CLAUDE_PATH: fake }),
    ).toMatchObject({ ok: false, kind: 'error' });
    expect(
      await managedAvailability('claude', {
        PATH: '/usr/bin:/bin',
        WHOMBAT_CLAUDE_PATH: join(dir, 'missing'),
      }),
    ).toMatchObject({ ok: false, kind: 'missing' });
    expect(
      await checkProviderDrift('claude', {
        PATH: '/usr/bin:/bin',
        WHOMBAT_CLAUDE_PATH: fake,
        WHOMBAT_PROVIDER_PINS: 'claude=9.9.9',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'version',
      explanation: expect.stringContaining('pins Claude Code 9.9.9'),
    });
  });
});

/**
 * With nothing but the person's credential home, the real pinned CLIs find the login — no key in the environment,
 * offline (an empty network namespace), no model call, a made-up key (never a real credential).
 *
 * The machine's Claude Code policy is hidden too (a mount namespace with an empty `/etc/claude-code`): its
 * `managed-settings.json` outranks every home and `--settings`, and a developer machine's sets a gateway token in its
 * `env`, which made the CLI say an empty subscription home is signed in.
 */
const claudeBin = providerExecutable('claude', {});
const canIsolate = spawnSync('unshare', ['-rnm', 'true']).status === 0;
/** A script that runs its arguments with an empty, read-only `/etc/claude-code`; run it inside `unshare -rnm`. */
function withoutHostPolicy(dir: string): string {
  const script = join(dir, 'without-host-policy.sh');
  writeFileSync(
    script,
    '#!/bin/sh\nif [ -d /etc/claude-code ]; then mount -t tmpfs -o ro none /etc/claude-code || exit 97; fi\nexec "$@"\n',
  );
  chmodSync(script, 0o755);
  return script;
}
describe.skipIf(!canIsolate || !existsSync(claudeBin))(
  'a sign-in works from the home alone (real pinned CLIs)',
  () => {
    it(`Claude Code ${CLAUDE_BUNDLE.version} reads the key through apiKeyHelper and refuses to update`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wb-home-only-'));
      const home = await ensureCredentialHome(root, 'claude');
      expect(await claudeApiKeyLogin(home, 'sk-ant-api03-NOTAREALKEY000000000000000000')).toEqual({
        ok: true,
      });
      const env = await credentialEnv(home, 'claude', 'api_key');
      const settings = JSON.stringify(claudeManagedSettings(home));
      const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      const isolated = ['-rnm', withoutHostPolicy(root)];
      const status = spawnSync(
        'unshare',
        [
          ...isolated,
          'env',
          '-i',
          `PATH=/usr/bin:/bin`,
          `HOME=${home}`,
          ...vars,
          claudeBin,
          '--settings',
          settings,
          'auth',
          'status',
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(JSON.parse(status.stdout)).toMatchObject({ loggedIn: true, apiKeySource: 'apiKeyHelper' });
      const update = spawnSync(
        'unshare',
        [
          ...isolated,
          'env',
          '-i',
          `PATH=/usr/bin:/bin`,
          `HOME=${home}`,
          ...vars,
          claudeBin,
          '--settings',
          settings,
          'update',
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(update.stdout + update.stderr).toContain('Updates are disabled by your administrator');
    }, 60_000);

    it(`Claude Code ${CLAUDE_BUNDLE.version} says a subscription home without a sign-in isn’t signed in (auth status, SUB-03)`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'wb-home-only-'));
      const home = await ensureCredentialHome(root, 'claude');
      await credentialEnv(home, 'claude', 'subscription_cli');
      // The CLI as `claudeLoginStatus` runs it (its arguments, its environment), inside the isolation above.
      const command = join(root, 'claude-isolated.sh');
      writeFileSync(
        command,
        `#!/bin/sh\nexec unshare -rnm '${withoutHostPolicy(root)}' '${claudeBin}' "$@"\n`,
      );
      chmodSync(command, 0o755);
      expect(await claudeLoginStatus({ command, home, host: { PATH: '/usr/bin:/bin' } })).toEqual({
        loggedIn: false,
        authMethod: 'none',
        apiProvider: 'firstParty',
        subscription: false,
      });
    }, 60_000);
  },
);
