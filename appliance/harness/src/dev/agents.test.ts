import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ports } from '../lib/paths.ts';
import { LIVE_PORT_SHIFT, liveEnv } from '../ship/live.ts';
import { scenarioEnv } from '../validate/scenario-groups.ts';
import type { EnvState } from './env.ts';
import {
  agentNetDir,
  agentNetEnv,
  agentsOf,
  directListenerEnv,
  hostLoginsUnset,
  runnerAgentEnv,
  runnerProblems,
  runnerSandboxEnv,
  runnerSummary,
  SIGN_IN_HOSTS,
} from './services.ts';

describe('agents in the dev environment: Hermes, the managed sandbox and the commands’ network (IN-38, IN-403)', () => {
  it('waits for the runner’s connection line and keeps its Hermes, provider and sandbox lines', () => {
    const log = [
      '[runner] managed · generation 2 (rnr_appliance_g2)',
      '[runner] managed · sandbox: bubblewrap /usr/bin/bwrap (nested), seccomp x64, systemd --user scope x-g2.scope (delegated)',
      '[runner] provider hermes: 0.22.5',
      '[runner] provider claude: 2.1.283 (Claude Code)',
      '[runner] provider codex: Hermes 0.22.5',
      '[runner] hermes · /nix/store/x-hermes-agent-0.22.5-whombat/bin/hermes · profiles in /x/hermes',
      '[runner] some other line',
    ].join('\n');
    expect(runnerSummary(log).ready).toBe(false);
    const done = runnerSummary(`${log}\n[runner] rnr_appliance_g2 → http://127.0.0.1:4721 · up to 4 turns\n`);
    expect(done.ready).toBe(true);
    expect(done.lines).toHaveLength(7);
    expect(done.lines[2]).toBe('provider hermes: 0.22.5');
    expect(runnerProblems(done.lines)).toEqual([]);
  });

  it('names what keeps turns away', () => {
    const problems = runnerProblems([
      'managed · sandbox unavailable: bwrap: setting up uid map: Permission denied — every live turn is refused',
      'provider hermes: not ready (missing: Hermes isn’t installed at /x/hermes.)',
    ]);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('missing');
  });

  it('starts the commands’ network only from a runtime checkout that has apps/agent-net', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-agent-net-'));
    try {
      expect(agentNetDir(root)).toBeNull();
      mkdirSync(join(root, 'apps', 'agent-net'), { recursive: true });
      expect(agentNetDir(root)).toBeNull();
      writeFileSync(join(root, 'apps', 'agent-net', 'package.json'), '{}');
      expect(agentNetDir(root)).toBe(join(root, 'apps', 'agent-net'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const env = agentNetEnv();
    expect(env.WHOMBAT_AGENT_NET_SOCKET).toMatch(/\/env\/run\/agent-net\.sock$/);
    expect(env.WHOMBAT_AGENT_NET_SERVICE_PORTS).toBe('20000-20099');
    expect(env).not.toHaveProperty('WHOMBAT_CONTAINERS_SOCKET');
  });

  it('gives the runner Hermes, its home and the agent’s where a box keeps them, and the managed sandbox in every mode', () => {
    const env = runnerAgentEnv('/nix/store/x-hermes/bin/hermes', false);
    expect(env.WHOMBAT_HERMES_BIN).toBe('/nix/store/x-hermes/bin/hermes');
    expect(env.WHOMBAT_HERMES_ROOT).toMatch(/\/env\/persist\/whombat\/hermes$/);
    expect(env.WHOMBAT_AGENT_HOME).toMatch(/\/env\/persist\/whombat\/agent\/home$/);
    expect(env.WHOMBAT_SANDBOX_CGROUP).toBe('systemd-user');
    expect(env).not.toHaveProperty('WHOMBAT_AGENTS');
    expect(env).not.toHaveProperty('WHOMBAT_AGENT_NET_SOCKET');
    expect(env).not.toHaveProperty('WHOMBAT_CONTAINERS_SOCKET');
    // The runner reaches the commands' network daemon on the socket the daemon was given.
    expect(runnerAgentEnv('/x/hermes', true).WHOMBAT_AGENT_NET_SOCKET).toBe(
      agentNetEnv().WHOMBAT_AGENT_NET_SOCKET,
    );
  });

  it('gives the runner its own slice, the sign-in hosts and the appliance’s paths', () => {
    // A set clients root: clientsRoot() then makes no directory or link of the default environment.
    const before = process.env.WB_MGD_CLIENTS_ROOT;
    process.env.WB_MGD_CLIENTS_ROOT = '/nonexistent/wb-clients';
    const env = runnerSandboxEnv();
    if (before === undefined) delete process.env.WB_MGD_CLIENTS_ROOT;
    else process.env.WB_MGD_CLIENTS_ROOT = before;
    expect(env.WHOMBAT_SANDBOX_RO_PATHS?.split(':')).toContain('/nonexistent/wb-clients');
    expect(env.WHOMBAT_SANDBOX_CGROUP).toBe('systemd-user');
    expect(env.WHOMBAT_SANDBOX_SLICE).toMatch(/^whombat_mgd_[0-9a-f]{10}\.slice$/);
    expect(env.WHOMBAT_SANDBOX_SLICE).not.toBe('whombat_tasks.slice');
    expect(env.WHOMBAT_SANDBOX_EGRESS_ALLOW?.split(',')).toEqual(expect.arrayContaining([...SIGN_IN_HOSTS]));
    expect(env.WHOMBAT_RUNNER_STATE).toMatch(/\/env\/runner$/);
    expect(env.WHOMBAT_WORKSPACES).toMatch(/\/env\/persist\/whombat\/workspaces$/);
    expect(env.WHOMBAT_SANDBOX_RO_PATHS?.split(':')).toContainEqual(
      expect.stringMatching(/\/env\/persist\/whombat\/clients$/),
    );
  });

  it('unsets the developer’s own provider logins', () => {
    const unset = hostLoginsUnset({
      ANTHROPIC_AUTH_TOKEN: 'x',
      ANTHROPIC_BASE_URL: 'x',
      CLAUDECODE: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      OPENAI_API_KEY: 'x',
      CODEX_HOME: '/x',
      PATH: '/usr/bin',
      HOME: '/home/x',
      WHOMBAT_HOME: '/x',
    });
    expect(Object.keys(unset).sort()).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDECODE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_HOME',
      'OPENAI_API_KEY',
    ]);
    expect(Object.values(unset).every((v) => v === undefined)).toBe(true);
  });

  it('restarts keep the mode dev/up recorded; older environments are scripted', () => {
    expect(agentsOf({ agents: 'live' } as EnvState)).toBe('live');
    expect(agentsOf({} as EnvState)).toBe('scripted');
  });
});

describe('the runtime’s direct listener (Whombat HE-50, IN-419)', () => {
  it('opens on loopback on a port of the stack’s own range, which the other environments shift', () => {
    expect(directListenerEnv()).toEqual({
      WHOMBAT_DIRECT_PORT: String(ports.direct),
      WHOMBAT_DIRECT_INTERFACES: 'loopback',
    });
    if (!process.env.WB_MGD_DIRECT_PORT) expect(ports.direct).toBe(4621);
    expect(Object.values(ports).filter((p) => p === ports.direct)).toHaveLength(1);
    const base = { home: '/h/mgd', container: 'whombat-mgd-pg', ports };
    expect(liveEnv(base).WB_MGD_DIRECT_PORT).toBe(String(ports.direct + LIVE_PORT_SHIFT));
    expect(scenarioEnv(base, 1).WB_MGD_DIRECT_PORT).toBe(String(ports.direct + 200));
  });
});
