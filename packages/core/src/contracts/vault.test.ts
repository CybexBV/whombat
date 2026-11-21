/**
 * The Vault's contract (docs/decisions/vault.md; since 0.125 without tiers, passes, delivery, Test sign-in or relays,
 * CT-1240…CT-1244): bodies, views, realtime and the runner context.
 */
import { describe, expect, it } from 'vitest';
import { describeActivity } from '../domain/activity.js';
import { EVENT_TYPES } from '../domain/audit.js';
import { DispatchTrigger } from '../domain/dispatch.js';
import { VaultEntryDetail } from '../vault/schemas.js';
import {
  AddVaultNetworkBody,
  API_ENDPOINTS,
  AuditCountsSchema,
  api,
  CreateVaultEntryBody,
  DispatchContext,
  MCP_TOOLS,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  SetVaultSecretBody,
  UpdateVaultEntryBody,
  VAULT_ERROR_CODES,
  VAULT_ERROR_MESSAGES,
  VAULT_ERROR_STATUS,
  VaultContextEntry,
  VaultDispatchContext,
} from './index.js';

const fieldsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => i.path.join('.'));

describe('Vault endpoints', () => {
  it('are burrow-scoped for entries and account-level for the home network list', () => {
    const vault = API_ENDPOINTS.filter((e) => e.id.startsWith('vault.'));
    expect(vault.map((e) => e.id).sort()).toEqual(
      [
        'vault.check',
        'vault.create',
        'vault.get',
        'vault.giveKey',
        'vault.list',
        'vault.remove',
        'vault.setSecret',
        'vault.setTotp',
        'vault.setTool',
        'vault.takeKey',
        'vault.update',
        'vault.uses',
        'vault.generateSshKey',
        'vault.replaceSshKey',
        'vault.addSshServer',
        'vault.updateSshServer',
        'vault.removeSshServer',
        'vault.checkSshServer',
        'vault.trustSshHostKey',
        'vault.setKeyEnvName',
        'vault.setKeyServers',
      ].sort(),
    );
    for (const e of vault) expect(e.path.startsWith('/burrows/:burrow/'), e.id).toBe(true);
    const networks = API_ENDPOINTS.filter((e) => e.id.startsWith('vaultNetworks.'));
    expect(networks.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /vault/networks',
      'POST /vault/networks',
      'DELETE /vault/networks/:networkId',
    ]);
    expect(api.vault.create.status).toBe(201);
    expect(api.vault).not.toHaveProperty('testSignIn');
    expect(Object.keys(api)).not.toContain('packs');
  });

  it('checks an entry’s fields for its template', () => {
    expect(
      CreateVaultEntryBody.parse({
        name: 'Home Assistant',
        kind: 'mcp',
        url: 'http://192.168.1.10:8123/api/mcp',
        auth: { type: 'bearer' },
        secret: 'eyJhbGciOi…',
      }).description,
    ).toBe('');
    expect(
      CreateVaultEntryBody.safeParse({
        name: 'Printer admin',
        kind: 'http',
        url: 'http://192.168.1.20',
        auth: { type: 'basic', username: 'admin' },
        secret: 'pw',
      }).success,
    ).toBe(true);
    expect(
      fieldsOf(CreateVaultEntryBody.safeParse({ name: 'Grafana', kind: 'http', url: 'https://g.example' })),
    ).toEqual(['auth']);
    expect(
      fieldsOf(
        CreateVaultEntryBody.safeParse({
          name: 'Grafana',
          kind: 'http',
          url: 'https://g.example',
          auth: { type: 'bearer' },
        }),
      ),
    ).toEqual(['secret']);
    expect(
      fieldsOf(
        CreateVaultEntryBody.safeParse({ name: 'X', kind: 'secret', url: 'https://x.example', secret: 's' }),
      ),
    ).toEqual(['kind', 'url']);
    // No new `secret` entry since 0.113 (CT-823).
    expect(fieldsOf(CreateVaultEntryBody.safeParse({ name: 'X', kind: 'secret', secret: 's' }))).toEqual([
      'kind',
    ]);
    expect(CreateVaultEntryBody.safeParse({ name: '', kind: 'secret', secret: 's' }).success).toBe(false);
    expect(
      CreateVaultEntryBody.safeParse({ name: 'x'.repeat(61), kind: 'secret', secret: 's' }).success,
    ).toBe(false);
    expect(
      CreateVaultEntryBody.safeParse({ name: 'x', kind: 'secret', secret: 's'.repeat(8001) }).success,
    ).toBe(false);
    expect(UpdateVaultEntryBody.safeParse({}).success).toBe(false);
    expect(UpdateVaultEntryBody.safeParse({ description: '' }).success).toBe(true);
  });

  it('adds a website login with its password, and replaces its username with the password (VT-D28)', () => {
    const login = {
      name: 'Shop admin',
      kind: 'login',
      url: 'https://shop.example.com/admin/login',
      auth: { type: 'form', username: 'mara@example.com' },
      secret: 'correct horse',
    };
    expect(CreateVaultEntryBody.parse(login).auth).toEqual(login.auth);
    // Hermes's credential vault finds the fields itself (CT-1240): selectors are dropped.
    expect(
      CreateVaultEntryBody.parse({ ...login, auth: { ...login.auth, passwordSelector: '#password' } }).auth,
    ).toEqual(login.auth);
    expect(fieldsOf(CreateVaultEntryBody.safeParse({ ...login, secret: undefined }))).toEqual(['secret']);
    expect(
      fieldsOf(CreateVaultEntryBody.safeParse({ ...login, auth: { type: 'basic', username: 'mara' } })),
    ).toEqual(['auth']);
    expect(
      fieldsOf(CreateVaultEntryBody.safeParse({ ...login, kind: 'http', auth: { ...login.auth } })),
    ).toEqual(['auth']);
    expect(UpdateVaultEntryBody.safeParse({ auth: login.auth }).success).toBe(true);
    expect(SetVaultSecretBody.parse({ value: 'new pw', username: 'mara@shop.example' }).username).toBe(
      'mara@shop.example',
    );
  });

  it('parses a login entry without a check of its own (CT-1240)', () => {
    const entry = VaultEntryDetail.parse({
      id: 'vlt_shop',
      name: 'Shop admin',
      description: '',
      kind: 'login',
      url: 'https://shop.example.com/admin/login',
      auth: { type: 'form', username: 'mara@example.com' },
      secret: { set: true, setAt: '2026-09-23T09:00:00.000Z' },
      check: { status: 'unchecked', summary: '', checkedAt: null },
      agentOn: true,
      lastUsedAt: null,
      createdAt: '2026-09-23T09:00:00.000Z',
      updatedAt: '2026-09-23T09:00:00.000Z',
      tools: [],
      key: { givenAt: '2026-09-23T09:00:00.000Z', servers: null, envName: null },
      recentUses: [],
    });
    expect(entry.totp).toEqual({ set: false, setAt: null });
    expect(entry).not.toHaveProperty('packs');
    expect(entry).not.toHaveProperty('packCount');
  });

  it('checks a home network as it is added', () => {
    expect(AddVaultNetworkBody.parse({ cidr: '192.168.1.0/24', ports: [80, 8123] })).toEqual({
      cidr: '192.168.1.0/24',
      ports: [80, 8123],
      note: '',
    });
    expect(fieldsOf(AddVaultNetworkBody.safeParse({ cidr: '10.0.0.0/8', ports: [80] }))).toEqual(['cidr']);
    expect(fieldsOf(AddVaultNetworkBody.safeParse({ cidr: '192.168.1.0/24', ports: [80, 80] }))).toEqual([
      'ports',
    ]);
  });

  it('has a status and message for every refusal', () => {
    for (const code of VAULT_ERROR_CODES) {
      expect(VAULT_ERROR_STATUS[code], code).toBeDefined();
      expect(VAULT_ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });

  it('reads an older server’s audit counts', () => {
    expect(
      AuditCountsSchema.parse({ all: 1, code: 0, asks: 0, keys: 0, messages: 1, blocked: 0 }).vault,
    ).toBe(0);
  });
});

describe('Vault realtime, runner and tools', () => {
  it('tells the owner an entry changed, on `me` only', () => {
    expect(RealtimeEvent.parse({ type: 'vault.updated', entryId: 'vlt_ha' })).toEqual({
      type: 'vault.updated',
      entryId: 'vlt_ha',
    });
    expect(RealtimeEvent.safeParse({ type: 'vault.updated', entryId: null }).success).toBe(true);
    expect(REALTIME_EVENT_TOPICS['vault.updated']).toEqual(['me']);
  });

  it('hands the turn its person’s entries, never a secret, and wakes no turn for a pass', () => {
    expect(DispatchTrigger.safeParse('vault_pass').success).toBe(false);
    const vault = VaultDispatchContext.parse({
      entries: [
        {
          id: 'vlt_ha',
          name: 'Home Assistant',
          description: 'Lights.',
          kind: 'mcp',
          url: 'http://192.168.1.10:8123/api/mcp',
          mcpServer: 'vault_abcdefgh',
        },
      ],
    });
    expect(vault.entries[0]?.mcpServer).toBe('vault_abcdefgh');
    expect(vault.entries[0]).not.toHaveProperty('applies');
    const login = VaultContextEntry.parse({
      id: 'vlt_shop',
      name: 'Shop admin',
      description: '',
      kind: 'login',
      url: 'https://shop.example.com/admin/login',
    });
    expect(login).toMatchObject({ kind: 'login', envNames: [] });
    expect(
      VaultDispatchContext.safeParse({ entries: [{ ...vault.entries[0], kind: 'secret' }] }).success,
    ).toBe(false);
    expect(DispatchContext.shape.vault.safeParse(undefined).success).toBe(false);
  });

  it('has no relayed tools: no vault_request, no bridged vt_* tools (CT-1242)', () => {
    expect(MCP_TOOLS).not.toHaveProperty('vault_request');
    const base = { kind: 'whombat' as const, object: null, exitCode: null, failure: null, keyNeeded: null };
    expect(describeActivity({ ...base, tool: 'whombat.vault_save', status: 'done' })).toEqual({
      title: 'Used a private Vault entry',
      detail: null,
      important: true,
    });
    expect(describeActivity({ ...base, tool: 'browser_vault', status: 'failed' }).title).toBe(
      'Couldn’t use a private Vault entry',
    );
    expect(
      describeActivity({ ...base, tool: 'whombat.vt_abcdefgh__HassTurnOn', status: 'done' }).title,
    ).not.toBe('Used a private Vault entry');
    expect(EVENT_TYPES['vault.used']).toBe('Vault');
  });

  it('parses a detail with its defaults', () => {
    expect(VaultEntryDetail.shape.toolsIgnored.parse(undefined)).toBe(0);
  });
});
