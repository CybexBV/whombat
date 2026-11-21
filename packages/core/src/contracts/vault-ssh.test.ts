/**
 * The Vault's SSH keys over REST and in the turn (docs/decisions/vault.md VT-S02…VT-S13, contracts 0.32.0; since 0.125 on
 * the agent's computer in its owner's turns, without relayed SSH tools, CT-1242).
 */
import { describe, expect, it } from 'vitest';
import { describeActivity } from '../domain/activity.js';
import {
  AddVaultSshServerBody,
  API_ENDPOINTS,
  api,
  CreateVaultEntryBody,
  GiveVaultKeyBody,
  MCP_TOOLS,
  ReplaceVaultSshKeyBody,
  SetVaultKeyServersBody,
  TrustVaultSshHostKeyBody,
  UpdateVaultSshServerBody,
  VAULT_ERROR_CODES,
  VAULT_ERROR_MESSAGES,
  VAULT_ERROR_STATUS,
  VAULT_LIMIT_MESSAGES,
  VaultContextEntry,
  VaultErrorDetails,
  VaultSshCheckResponse,
  VaultSshServerWriteResponse,
} from './index.js';

/** TEST ONLY: a throwaway ed25519 key (the one in `vault/ssh.test.ts`). */
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+QAAAIibQrhum0K4
bgAAAAtzc2gtZWQyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+Q
AAAECq5lZhxOthCAsMc3+7yD+sGL5dQ6MnR2zxpf5kgTmIdrBmrVrARUqTYfBxNry+DHEJ
+VGkRAsfW8i0duG7bwv5AAAABHRlc3QB
-----END OPENSSH PRIVATE KEY-----
`;
const FP = 'SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU';
const T = '2026-10-01T09:00:00.000Z';

const fieldsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => i.path.join('.'));

const entry = {
  id: 'vlt_deploykey',
  name: 'Deploy key',
  description: '',
  kind: 'ssh',
  url: null,
  auth: {
    type: 'ssh_key',
    keyType: 'ed25519',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILBmrVrARUqTYfBxNry+DHEJ+VGkRAsfW8i0duG7bwv5',
    fingerprint: 'SHA256:zibNZfkJQ795P2dUA9+2CmiONZBYBhGqzBdZj+lYkxY',
    origin: 'generated',
  },
  secret: { set: true, setAt: T },
  check: { status: 'unchecked', summary: 'No servers yet', checkedAt: null, toolCount: null },
  agentOn: false,
  serverCount: 1,
  lastUsedAt: null,
  createdAt: T,
  updatedAt: T,
  tools: [],
  key: null,
  recentUses: [],
  servers: [
    {
      id: 'vss_web1',
      name: 'web-1',
      host: 'web1.example.com',
      port: 22,
      username: 'deploy',
      hostKey: null,
      seenHostKey: { algorithm: 'ssh-ed25519', fingerprint: FP, seenAt: T },
      check: {
        status: 'unchecked',
        outcome: 'host_key_unconfirmed',
        summary: 'Host key not confirmed yet',
        checkedAt: T,
      },
      createdAt: T,
      updatedAt: T,
    },
  ],
};

describe('SSH key endpoints (VT-S03…VT-S07)', () => {
  it('are the eight new vault ops, on the entry’s path', () => {
    const routes = Object.fromEntries(
      API_ENDPOINTS.filter((e) =>
        [
          'vault.generateSshKey',
          'vault.replaceSshKey',
          'vault.addSshServer',
          'vault.updateSshServer',
          'vault.removeSshServer',
          'vault.checkSshServer',
          'vault.trustSshHostKey',
          'vault.setKeyServers',
        ].includes(e.id),
      ).map((e) => [e.id, `${e.method} ${e.path}`]),
    );
    expect(routes).toEqual({
      'vault.generateSshKey': 'POST /burrows/:burrow/vault/:entryId/ssh-key/generate',
      'vault.replaceSshKey': 'PUT /burrows/:burrow/vault/:entryId/ssh-key',
      'vault.addSshServer': 'POST /burrows/:burrow/vault/:entryId/servers',
      'vault.updateSshServer': 'PATCH /burrows/:burrow/vault/:entryId/servers/:serverId',
      'vault.removeSshServer': 'DELETE /burrows/:burrow/vault/:entryId/servers/:serverId',
      'vault.checkSshServer': 'POST /burrows/:burrow/vault/:entryId/servers/:serverId/check',
      'vault.trustSshHostKey': 'POST /burrows/:burrow/vault/:entryId/servers/:serverId/trust',
      'vault.setKeyServers': 'PUT /burrows/:burrow/vault/:entryId/key/servers',
    });
    expect(api.vault.addSshServer.status).toBe(201);
    expect(
      api.vault.updateSshServer.params.safeParse({ burrow: 'b', entryId: 'vlt_x', serverId: 'vss_1' })
        .success,
    ).toBe(true);
    expect(
      api.vault.updateSshServer.params.safeParse({ burrow: 'b', entryId: 'vlt_x', serverId: 'vln_1' })
        .success,
    ).toBe(false);
  });

  it('creates an ssh entry by generating or importing its key', () => {
    expect(
      CreateVaultEntryBody.parse({ name: 'Deploy key', kind: 'ssh', sshKey: { mode: 'generate' } }),
    ).toEqual({
      name: 'Deploy key',
      description: '',
      kind: 'ssh',
      sshKey: { mode: 'generate' },
    });
    expect(
      CreateVaultEntryBody.safeParse({
        name: 'Laptop key',
        kind: 'ssh',
        sshKey: { mode: 'import', privateKey: KEY, passphrase: 'correct horse' },
      }).success,
    ).toBe(true);
    expect(fieldsOf(CreateVaultEntryBody.safeParse({ name: 'x', kind: 'ssh' }))).toEqual(['sshKey']);
    expect(
      fieldsOf(
        CreateVaultEntryBody.safeParse({
          name: 'x',
          kind: 'ssh',
          sshKey: { mode: 'import', privateKey: 'ssh-ed25519 AAAA' },
        }),
      ),
    ).toEqual(['sshKey.privateKey']);
    expect(
      fieldsOf(
        CreateVaultEntryBody.safeParse({ name: 'x', kind: 'ssh', secret: KEY, sshKey: { mode: 'generate' } }),
      ),
    ).toEqual(['secret']);
    expect(
      fieldsOf(
        CreateVaultEntryBody.safeParse({
          name: 'x',
          kind: 'http',
          url: 'https://a.example.com',
          auth: { type: 'bearer' },
          secret: 't',
          sshKey: { mode: 'generate' },
        }),
      ),
    ).toEqual(['sshKey']);
    expect(ReplaceVaultSshKeyBody.safeParse({ privateKey: KEY }).success).toBe(true);
    expect(fieldsOf(ReplaceVaultSshKeyBody.safeParse({ privateKey: KEY, passphrase: '' }))).toEqual([
      'passphrase',
    ]);
    expect(fieldsOf(ReplaceVaultSshKeyBody.safeParse({ privateKey: '' }))).toEqual(['privateKey']);
  });

  it('adds and edits servers', () => {
    expect(
      AddVaultSshServerBody.parse({ name: 'web-1', host: ' web1.example.com ', username: 'deploy' }),
    ).toEqual({
      name: 'web-1',
      host: 'web1.example.com',
      port: 22,
      username: 'deploy',
    });
    expect(
      fieldsOf(
        AddVaultSshServerBody.safeParse({ name: 'Web 1', host: 'web1:22', port: 0, username: '1x' }),
      ).sort(),
    ).toEqual(['host', 'name', 'port', 'username']);
    expect(UpdateVaultSshServerBody.safeParse({}).success).toBe(false);
    expect(UpdateVaultSshServerBody.parse({ port: 2222 })).toEqual({ port: 2222 });
    expect(TrustVaultSshHostKeyBody.safeParse({ fingerprint: FP }).success).toBe(true);
    expect(
      TrustVaultSshHostKeyBody.safeParse({ fingerprint: 'lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU' })
        .success,
    ).toBe(false);
  });

  it('gives keys that cover all servers or some', () => {
    expect(GiveVaultKeyBody.parse({})).toEqual({});
    expect(GiveVaultKeyBody.parse({ servers: null })).toEqual({ servers: null });
    expect(GiveVaultKeyBody.parse({ servers: ['vss_web1'] }).servers).toEqual(['vss_web1']);
    expect(GiveVaultKeyBody.safeParse({ servers: [] }).success).toBe(false);
    expect(GiveVaultKeyBody.safeParse({ servers: ['vss_a', 'vss_a'] }).success).toBe(false);
    expect(SetVaultKeyServersBody.safeParse({ servers: null }).success).toBe(true);
    expect(SetVaultKeyServersBody.safeParse({}).success).toBe(false);
  });

  it('answers the entry, the server and the check', () => {
    expect(
      VaultSshServerWriteResponse.parse({ entry, eventId: 'evt_1', serverId: 'vss_web1' }).entry.servers,
    ).toHaveLength(1);
    const check = VaultSshCheckResponse.parse({
      entry,
      result: {
        serverId: 'vss_web1',
        outcome: 'host_key_unconfirmed',
        status: 'unchecked',
        summary: 'Host key not confirmed yet',
        hostKey: { algorithm: 'ssh-ed25519', fingerprint: FP },
        checkedAt: T,
      },
    });
    expect(check.eventId).toBeNull();
    expect(check.entry.servers[0]?.seenHostKey?.fingerprint).toBe(FP);
  });

  it('refuses with typed codes', () => {
    expect(VAULT_ERROR_CODES).toEqual(expect.arrayContaining(['server_name_taken', 'host_key_mismatch']));
    expect(VAULT_ERROR_STATUS.server_name_taken).toBe('conflict');
    expect(VAULT_ERROR_STATUS.host_key_mismatch).toBe('conflict');
    expect(VAULT_ERROR_MESSAGES.server_name_taken).toBe('This key already has a server with that name.');
    expect(VAULT_LIMIT_MESSAGES.servers).toBe('An SSH key can have at most 20 servers. Remove one first.');
    expect(
      VaultErrorDetails.parse({
        code: 'host_key_mismatch',
        hostKey: { algorithm: 'ssh-ed25519', fingerprint: FP },
      }).hostKey?.fingerprint,
    ).toBe(FP);
    expect(VaultErrorDetails.parse({ code: 'limit_reached', limit: 'servers', max: 20 }).limit).toBe(
      'servers',
    );
  });
});

describe('agents and SSH (VT-S12, CT-1242, CT-1243)', () => {
  it('lists the owner’s ssh entry with its covered servers, by name, target and readiness', () => {
    const listed = VaultContextEntry.parse({
      id: 'vlt_deploykey',
      name: 'Deploy key',
      description: 'Web servers.',
      kind: 'ssh',
      url: null,
      servers: [
        { name: 'web-1', target: 'deploy@web1.example.com:22', ready: true },
        { name: 'staging', target: 'deploy@staging.example.com:22', ready: false },
      ],
    });
    expect(listed.servers?.map((s) => s.name)).toEqual(['web-1', 'staging']);
    expect(listed.envNames).toEqual([]);
    expect(listed).not.toHaveProperty('key');
  });

  it('has no relayed SSH tools: ssh runs on the agent’s computer', () => {
    for (const name of ['ssh_exec', 'ssh_read_file', 'ssh_write_file', 'ssh_upload'])
      expect(MCP_TOOLS, name).not.toHaveProperty(name);
  });

  it('labels the Vault’s own tools in activity as a private Vault entry', () => {
    const base = { kind: 'whombat' as const, object: null, exitCode: null, failure: null, keyNeeded: null };
    expect(describeActivity({ ...base, tool: 'whombat.vault_add_server', status: 'done' }).title).toBe(
      'Used a private Vault entry',
    );
    expect(describeActivity({ ...base, tool: 'browser_vault', status: 'running' }).title).toBe(
      'Using a private Vault entry',
    );
  });
});
