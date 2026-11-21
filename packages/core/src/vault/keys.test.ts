/**
 * An entry switched on for the agent in the person's turns (Whombat agent-computer.md AC-11, AC-30…AC-34; since 0.125
 * without tiers or delivery, CT-1240…CT-1244; since 3.0 for the agent's commands, CT-1532): what reaches the commands,
 * its variables, the turn's context and the per-turn use.
 */
import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import { MCP_TOOLS } from '../contracts/mcp.js';
import { VAULT_MCP_TOOLS } from '../contracts/mcp-vault.js';
import { DispatchContext, TurnKeys } from '../contracts/runner.js';
import {
  AddVaultSshServerBody,
  GiveVaultKeyBody,
  SetVaultKeyEnvNameBody,
  UpdateVaultSshServerBody,
  VaultContextEntry,
  VaultDispatchContext,
} from '../contracts/vault.js';
import {
  defaultVaultEnvName,
  isVaultActivityTool,
  VAULT_KEYS_COPY,
  VAULT_KEYS_DIR,
  VAULT_SSH_PRODUCTION_COPY,
  VaultKeyView,
  vaultEnvNameProblem,
  vaultKeyDeliverable,
  vaultKeyEnvNames,
  vaultRotateNotice,
  vaultTurnUseWhat,
} from './index.js';

describe('an entry switched on for the agent (CT-1240)', () => {
  it('has no tier or delivery: when, which servers, which variable', () => {
    const key = VaultKeyView.parse({ givenAt: '2026-10-02T09:00:00.000Z', servers: null, envName: null });
    expect(Object.keys(key).sort()).toEqual(['envName', 'givenAt', 'servers']);
    expect(VaultKeyView.safeParse({ givenAt: '2026-10-02T09:00:00.000Z' }).success).toBe(false);
    expect(key).not.toHaveProperty('agentId');
  });

  it('reaches the agent’s commands only as an API’s value or an SSH key', () => {
    for (const kind of ['http', 'ssh'] as const) expect(vaultKeyDeliverable({ kind }), kind).toBe(true);
    for (const kind of ['mcp', 'login', 'secret'] as const)
      expect(vaultKeyDeliverable({ kind }), kind).toBe(false);
    expect(VAULT_KEYS_DIR).toBe('/run/whombat/keys');
  });

  it('is switched on with servers or a variable, and the variable changed later', () => {
    expect(GiveVaultKeyBody.parse({})).toEqual({});
    expect(GiveVaultKeyBody.parse({ envName: 'CF_TOKEN' })).toEqual({ envName: 'CF_TOKEN' });
    expect(GiveVaultKeyBody.safeParse({ envName: 'PATH' }).success).toBe(false);
    expect(GiveVaultKeyBody.parse({ tier: 'ask', delivery: 'whombat' })).toEqual({});
    expect(SetVaultKeyEnvNameBody.parse({ envName: 'GRAFANA' })).toEqual({ envName: 'GRAFANA' });
    expect(SetVaultKeyEnvNameBody.safeParse({}).success).toBe(false);
    expect(api.vault.setKeyEnvName).toMatchObject({ id: 'vault.setKeyEnvName', method: 'PUT' });
    expect(api.vault).not.toHaveProperty('setKeyDelivery');
  });
});

describe('environment variables (AC-31)', () => {
  it('take capital letters, digits and _, and never Whombat’s own names', () => {
    for (const ok of ['CLOUDFLARE_API_TOKEN', '_X', 'A', `A${'B'.repeat(63)}`, 'GITHUB_TOKEN', 'MY_PATH'])
      expect(vaultEnvNameProblem(ok), ok).toBeNull();
    for (const bad of ['', 'lower', '1ABC', 'A-B', 'A B', `A${'B'.repeat(64)}`])
      expect(vaultEnvNameProblem(bad), bad).not.toBeNull();
    for (const reserved of [
      'PATH',
      'HOME',
      'TMPDIR',
      'SSH_AUTH_SOCK',
      'LD_PRELOAD',
      'LC_ALL',
      'WHOMBAT_TOKEN',
    ])
      expect(vaultEnvNameProblem(reserved), reserved).toContain(reserved);
  });

  it('default from the entry’s name', () => {
    expect(defaultVaultEnvName('Cloudflare API token')).toBe('CLOUDFLARE_API_TOKEN');
    expect(defaultVaultEnvName('GitHub · deploy')).toBe('GITHUB_DEPLOY');
    expect(defaultVaultEnvName('  Café  crème! ')).toBe('CAFE_CREME');
    expect(defaultVaultEnvName('1Password')).toBe('VAULT_1PASSWORD');
    expect(defaultVaultEnvName('Path')).toBe('VAULT_PATH');
    expect(defaultVaultEnvName('Whombat token')).toBe('VAULT_WHOMBAT_TOKEN');
    expect(defaultVaultEnvName('—')).toBe('VAULT_SECRET');
    expect(defaultVaultEnvName('x'.repeat(100))).toHaveLength(64);
    for (const name of ['a', 'Ünïcödé', '9', 'ld preload', 'lc all', 'x'.repeat(200)])
      expect(vaultEnvNameProblem(defaultVaultEnvName(name)), name).toBeNull();
  });

  it('are one per API value, or a username and a password for basic auth; none for the other kinds', () => {
    expect(vaultKeyEnvNames('CF', { kind: 'http', auth: { type: 'bearer' } })).toEqual(['CF']);
    expect(vaultKeyEnvNames('CF', { kind: 'http', auth: { type: 'header' } })).toEqual(['CF']);
    expect(vaultKeyEnvNames('API', { kind: 'http', auth: { type: 'basic' } })).toEqual([
      'API_USERNAME',
      'API_PASSWORD',
    ]);
    expect(vaultKeyEnvNames('SITE', { kind: 'login', auth: { type: 'form' } })).toEqual([]);
    expect(vaultKeyEnvNames('S', { kind: 'secret', auth: null })).toEqual([]);
    expect(vaultKeyEnvNames('K', { kind: 'ssh', auth: { type: 'ssh_key' } })).toEqual([]);
    expect(vaultKeyEnvNames('M', { kind: 'mcp', auth: { type: 'bearer' } })).toEqual([]);
  });
});

describe('the turn’s Vault (CT-1241, CT-1243)', () => {
  it('lists only the turn person’s entries, never a secret', () => {
    const entry = VaultContextEntry.parse({
      id: 'vlt_cf',
      name: 'Cloudflare',
      description: '',
      kind: 'http',
      url: 'https://api.cloudflare.com/client/v4',
      envNames: ['CLOUDFLARE_API_TOKEN'],
    });
    expect(entry).not.toHaveProperty('applies');
    expect(entry).not.toHaveProperty('passHeld');
    const mcp = VaultContextEntry.parse({
      id: 'vlt_ha',
      name: 'Home Assistant',
      description: '',
      kind: 'mcp',
      url: 'http://192.168.1.10:8123/api/mcp',
      mcpServer: 'vault_abcdefgh',
    });
    expect(mcp.envNames).toEqual([]);
    expect(VaultContextEntry.safeParse({ ...mcp, mcpServer: 'ha' }).success).toBe(false);
    expect(VaultContextEntry.safeParse({ ...entry, kind: 'secret' }).success).toBe(false);
    expect(VaultDispatchContext.parse({ entries: [entry] }).unheld).toEqual([]);
    expect(DispatchContext.shape.vault).toBeDefined();
  });

  it('gives Hermes an MCP entry as a server of its own, with the tools that are on', () => {
    const keys = TurnKeys.parse({ files: [], env: [], entries: [] });
    expect(keys.mcpServers).toEqual([]);
    expect(TurnKeys.parse({ ...keys, needles: ['secret'] })).not.toHaveProperty('needles');
    const withMcp = TurnKeys.parse({
      files: [],
      env: [],
      entries: [],
      mcpServers: [
        {
          name: 'vault_abcdefgh',
          url: 'http://192.168.1.10:8123/api/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
          tools: ['HassTurnOn'],
        },
      ],
    });
    expect(withMcp.mcpServers[0]?.tools).toEqual(['HassTurnOn']);
  });

  it('records a use per turn, in words that say where', () => {
    expect(vaultTurnUseWhat('http', 'Dusty')).toContain('Dusty’s commands');
    expect(vaultTurnUseWhat('ssh', 'Dusty')).toContain('Dusty’s commands');
    expect(vaultTurnUseWhat('login', 'Dusty')).toContain('browser');
    expect(vaultTurnUseWhat('mcp', 'Dusty')).toContain('tools');
    expect(VAULT_KEYS_COPY).not.toHaveProperty('delivery');
    expect(VAULT_KEYS_COPY).not.toHaveProperty('swept');
  });
});

describe('Production servers (AC-11)', () => {
  it('are switched on the server', () => {
    expect(
      AddVaultSshServerBody.parse({
        name: 'web-1',
        host: 'web1.example.com',
        username: 'deploy',
        production: true,
      }).production,
    ).toBe(true);
    expect(
      AddVaultSshServerBody.parse({ name: 'web-1', host: 'web1.example.com', username: 'deploy' }).production,
    ).toBe(undefined);
    expect(UpdateVaultSshServerBody.parse({ production: false })).toEqual({ production: false });
    expect(VAULT_SSH_PRODUCTION_COPY.label).toBe('Production');
  });
});

describe('the relays and asks are gone (CT-1242)', () => {
  it('leaves only the two tools the agent runs a person’s Vault with', () => {
    expect(Object.keys(VAULT_MCP_TOOLS).sort()).toEqual(['vault_add_server', 'vault_save']);
    for (const gone of [
      'request_vault_key',
      'vault_request',
      'ssh_exec',
      'ssh_read_file',
      'ssh_write_file',
      'ssh_upload',
    ])
      expect(MCP_TOOLS, gone).not.toHaveProperty(gone);
    expect(isVaultActivityTool('mcp__whombat__vault_save')).toBe(true);
    expect(isVaultActivityTool('browser_vault')).toBe(true);
    expect(isVaultActivityTool('mcp__whombat__request_vault_key')).toBe(false);
  });
});

describe('switching an entry off (AC-34)', () => {
  it('tells the owner to rotate', () => {
    expect(
      vaultRotateNotice({ agentName: 'Banjo', entryName: 'Cloudflare', kind: 'http' }).action,
    ).toBeNull();
    expect(vaultRotateNotice({ agentName: 'Banjo', entryName: 'Deploy key', kind: 'ssh' }).action).toBe(
      'Generate a new key',
    );
    expect(vaultRotateNotice({ agentName: 'Banjo', entryName: 'Shop', kind: 'login' }).text).toMatch(
      /password on the website/,
    );
  });
});
