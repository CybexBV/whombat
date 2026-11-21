import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv, loadRunnerConfig } from './config';

describe('runner config', () => {
  it('puts workspaces and sign-ins under WHOMBAT_HOME, and task cgroups in the user manager by default', () => {
    const home = homedir();
    const cfg = loadRunnerConfig({});
    expect(cfg.WHOMBAT_HOME).toBe(join(home, '.whombat'));
    expect(cfg.WHOMBAT_WORKSPACES).toBe(join(home, '.whombat', 'workspaces'));
    expect(cfg.WHOMBAT_CREDENTIALS_ROOT).toBe(join(home, '.whombat', 'credentials'));
    expect(cfg.WHOMBAT_SANDBOX_CGROUP).toBe('systemd-user');

    const custom = loadRunnerConfig({ WHOMBAT_HOME: '/srv/whombat', WHOMBAT_SANDBOX_CGROUP: 'delegated' });
    expect(custom.WHOMBAT_WORKSPACES).toBe('/srv/whombat/workspaces');
    expect(custom.WHOMBAT_CREDENTIALS_ROOT).toBe('/srv/whombat/credentials');
    expect(custom.WHOMBAT_SANDBOX_CGROUP).toBe('delegated');
    // An explicit WHOMBAT_WORKSPACES and WHOMBAT_CREDENTIALS_ROOT still win.
    const set = loadRunnerConfig({
      WHOMBAT_HOME: '/srv/whombat',
      WHOMBAT_WORKSPACES: '/data/ws',
      WHOMBAT_CREDENTIALS_ROOT: '/persist/credentials',
    });
    expect(set.WHOMBAT_WORKSPACES).toBe('/data/ws');
    expect(set.WHOMBAT_CREDENTIALS_ROOT).toBe('/persist/credentials');
    expect(() => loadRunnerConfig({ WHOMBAT_HOME: 'whombat' })).toThrow(/WHOMBAT_HOME/);
  });

  it('rejects an invalid server url', () => {
    expect(() => loadRunnerConfig({ WHOMBAT_SERVER_URL: 'nope' })).toThrow(/WHOMBAT_SERVER_URL/);
  });

  it('takes only its own settings from the shared .env, never the server’s secrets', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-runner-env-')), '.env');
    writeFileSync(
      file,
      [
        'PORT=4400',
        'RUNNER_TOKEN=runner-secret',
        'WHOMBAT_SANDBOX_CGROUP=delegated',
        'WHOMBAT_WORKSPACES=/srv/whombat/workspaces',
        'WHOMBAT_CLAUDE_PATH=/opt/claude',
        'DATABASE_URL=postgres://whombat:whombat@localhost:55432/whombat',
        'WHOMBAT_MASTER_KEY=bWFzdGVy',
        'SMTP_URL=smtp://user:pass@localhost:51025',
        'GITHUB_WEBHOOK_SECRET=whsec',
        'GITHUB_CLIENT_SECRET=oauth-secret',
        'GITHUB_APP_PRIVATE_KEY=pem',
        'VAPID_PRIVATE_KEY=vapid',
      ].join('\n'),
    );
    const env: Record<string, string | undefined> = { WHOMBAT_SANDBOX_CGROUP: 'systemd-user' };
    loadDotEnv(file, env);
    expect(env).toEqual({
      PORT: '4400',
      RUNNER_TOKEN: 'runner-secret',
      // What the runner's own environment says wins over the file.
      WHOMBAT_SANDBOX_CGROUP: 'systemd-user',
      WHOMBAT_WORKSPACES: '/srv/whombat/workspaces',
      WHOMBAT_CLAUDE_PATH: '/opt/claude',
    });
    // A missing file is fine.
    loadDotEnv(join(tmpdir(), 'wb-no-such-dir', '.env'), env);
  });

  it('reads WHOMBAT_ENV_FILE (the production env file), keeping only its own keys', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-runner-env-')), 'production.env');
    writeFileSync(
      file,
      [
        'WHOMBAT_SERVER_URL=http://127.0.0.1:4410',
        'RUNNER_TOKEN_FILE=/home/x/.config/whombat/runner-token',
        'WHOMBAT_MASTER_KEY_FILE=/home/x/.config/whombat/master-key',
        'DATABASE_URL=postgres://whombat:secret@127.0.0.1:55440/whombat',
      ].join('\n'),
    );
    const env: Record<string, string | undefined> = { WHOMBAT_ENV_FILE: file };
    loadDotEnv(undefined, env);
    expect(env).toEqual({
      WHOMBAT_ENV_FILE: file,
      WHOMBAT_SERVER_URL: 'http://127.0.0.1:4410',
      RUNNER_TOKEN_FILE: '/home/x/.config/whombat/runner-token',
    });
    expect(() => loadDotEnv(undefined, { WHOMBAT_ENV_FILE: join(tmpdir(), 'wb-missing.env') })).toThrow(
      /WHOMBAT_ENV_FILE: .* does not exist/,
    );
  });

  it('reads RUNNER_TOKEN_FILE and refuses loose, missing or doubled tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-runner-token-'));
    const file = join(dir, 'runner-token');
    writeFileSync(file, 'a-long-random-runner-token-0123456789\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    expect(loadRunnerConfig({ RUNNER_TOKEN_FILE: file }).RUNNER_TOKEN).toBe(
      'a-long-random-runner-token-0123456789',
    );
    expect(() => loadRunnerConfig({ RUNNER_TOKEN_FILE: file, RUNNER_TOKEN: 'x' })).toThrow(/not both/);
    expect(() => loadRunnerConfig({ RUNNER_TOKEN_FILE: join(dir, 'nope') })).toThrow(/cannot read/);
    expect(() => loadRunnerConfig({ RUNNER_TOKEN_FILE: 'runner-token' })).toThrow(/absolute path/);
    chmodSync(file, 0o644);
    expect(() => loadRunnerConfig({ RUNNER_TOKEN_FILE: file })).toThrow(/chmod 600/);
  });

  it('takes a 0440 runner-token from a private systemd credentials directory (MR-74)', () => {
    const creds = mkdtempSync(join(tmpdir(), 'wb-runner-creds-'));
    const file = join(creds, 'runner-token');
    writeFileSync(file, 'a-long-random-runner-token-0123456789\n');
    chmodSync(file, 0o440);
    chmodSync(creds, 0o550);
    expect(loadRunnerConfig({ CREDENTIALS_DIRECTORY: creds }).RUNNER_TOKEN).toBe(
      'a-long-random-runner-token-0123456789',
    );
    // Others may open the directory: the mode rule holds.
    chmodSync(creds, 0o755);
    expect(() => loadRunnerConfig({ CREDENTIALS_DIRECTORY: creds })).toThrow(/chmod 600/);
  });
});
