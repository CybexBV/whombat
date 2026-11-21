import { describe, expect, it } from 'vitest';
import { managedEnvAllowed, sandboxEnv } from './sandbox';

describe('a managed task’s environment (MSB-18)', () => {
  it('is an allowlist: logins, tokens and cloud credentials never pass, listed or not', () => {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_VERTEX',
      'OPENAI_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'AZURE_CLIENT_SECRET',
      'RUNNER_TOKEN',
      'WHOMBAT_MASTER_KEY',
      'DATABASE_URL',
      'PGPASSWORD',
      'SSH_AUTH_SOCK',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
      'ACME_SERVICE_PASSWORD',
      'SOMETHING_ELSE',
    ])
      expect(managedEnvAllowed(key, new Set([key])), key).toBe(key === 'SOMETHING_ELSE');
    for (const key of [
      'PATH',
      'LANG',
      'LC_ALL',
      'WHOMBAT_MCP_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GIT_DIR',
    ])
      expect(managedEnvAllowed(key), key).toBe(true);
    // Claude Code names its own entrypoint; a value inherited from the host would mislabel requests.
    expect(managedEnvAllowed('CLAUDE_CODE_ENTRYPOINT')).toBe(false);
  });

  it('keeps only the runner’s own git settings in GIT_CONFIG_*', () => {
    const mounted = () => true;
    const ours = sandboxEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' },
      mounted,
    );
    expect(ours).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper' });
    const smuggled = sandboxEnv(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: x' },
      mounted,
    );
    expect(Object.keys(smuggled).filter((k) => k.startsWith('GIT_CONFIG'))).toEqual([]);
  });
});
