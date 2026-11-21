import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv, credentialPaths, identityEnv, toolchainConfigPaths } from './index';
import { findBwrap } from './sandbox';

/** What a runner process may hold: its own secrets, the server's (shared .env), and the person's credentials. */
const HOST_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/owner',
  LANG: 'C.UTF-8',
  RUNNER_TOKEN: 'runner-secret',
  WHOMBAT_MASTER_KEY: 'master',
  WHOMBAT_MCP_TOKEN: 'stale',
  DATABASE_URL: 'postgres://db',
  GH_TOKEN: 'gho_owner',
  GITHUB_TOKEN: 'ghp_owner',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
  GIT_ASKPASS: '/usr/bin/askpass',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: 'store',
  OPENAI_API_KEY: 'sk-openai',
};

describe('a turn’s environment', () => {
  it('is the allowlist with no credential helpers, no tokens and no SSH agent, plus the identity and MCP token', () => {
    const env = agentEnv({
      env: HOST_ENV,
      login: (key) => key === 'OPENAI_API_KEY',
      extra: identityEnv({ name: 'Dusty', email: 'dusty@agents.burrow-hq.whombat.com' }),
      mcpToken: 'wat_1',
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-openai',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_AUTHOR_NAME: 'Dusty',
      WHOMBAT_MCP_TOKEN: 'wat_1',
    });
    for (const key of [
      'RUNNER_TOKEN',
      'WHOMBAT_MASTER_KEY',
      'DATABASE_URL',
      'GH_TOKEN',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
    ])
      expect(env[key], key).toBeUndefined();
  });

  it('takes no forbidden variable from the extras, whatever is passed', () => {
    const env = agentEnv({
      env: HOST_ENV,
      extra: {
        GH_TOKEN: 'sneaky',
        GIT_DIR: '/w/.git',
        GIT_SSH_COMMAND: 'ssh -i key',
        GIT_CONFIG_VALUE_0: 'store',
        GIT_CEILING_DIRECTORIES: '/w',
        MY_FLAG: '1',
      },
      pass: ['GITHUB_TOKEN', 'SSH_AUTH_SOCK'],
    });
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_DIR', 'GIT_SSH_COMMAND'])
      expect(env[key], key).toBeUndefined();
    expect(env).toMatchObject({ GIT_CONFIG_VALUE_0: '', GIT_CEILING_DIRECTORIES: '/w', MY_FLAG: '1' });
  });
});

describe('what a turn’s sandbox denies and re-opens', () => {
  it('lists the operator’s credential paths and Whombat’s own directory, where the environment moved them too', () => {
    const paths = credentialPaths({
      home: '/home/owner',
      whombatHome: '/srv/whombat',
      env: { CODEX_HOME: '/data/codex', KUBECONFIG: '/data/kube/a:/data/kube/b', DOCKER_CONFIG: 'relative' },
    });
    for (const p of ['.config', '.ssh', '.git-credentials', '.codex', '.claude.json', '.aws'])
      expect(paths, p).toContain(`/home/owner/${p}`);
    for (const p of ['/data/codex', '/data/kube/a', '/data/kube/b', '/srv/whombat'])
      expect(paths, p).toContain(p);
    expect(paths.some((p) => p.includes('relative'))).toBe(false);
    expect(paths).not.toContain('/home/owner');
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('re-opens toolchain settings in the denied config directories (mise’s shims read them)', () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-toolchain-'));
    const xdg = mkdtempSync(join(tmpdir(), 'wb-toolchain-xdg-'));
    mkdirSync(join(home, '.config', 'mise'), { recursive: true });
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    mkdirSync(join(xdg, 'rtx'));
    expect(toolchainConfigPaths({ home, env: { XDG_CONFIG_HOME: xdg } })).toEqual([
      join(home, '.config', 'mise'),
      join(xdg, 'rtx'),
    ]);
  });

  it('finds bubblewrap on PATH or through WHOMBAT_BWRAP', () => {
    const bin = mkdtempSync(join(tmpdir(), 'wb-sandbox-bin-'));
    const bwrap = join(bin, 'bwrap');
    writeFileSync(bwrap, '#!/bin/sh\nexit 0\n');
    chmodSync(bwrap, 0o755);
    expect(findBwrap({ PATH: `/nowhere:${bin}` })).toBe(bwrap);
    expect(findBwrap({ PATH: '/nowhere', WHOMBAT_BWRAP: bwrap })).toBe(bwrap);
    expect(findBwrap({ PATH: bin, WHOMBAT_BWRAP: '/nope/bwrap' })).toBeNull();
  });
});
