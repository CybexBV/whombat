/**
 * Contracts 0.112.0 (Whombat vault-self-serve.md VS-01…VS-14; CT-780…CT-787): the agent runs a person's Vault in their
 * turn — `vault_save`, `vault_add_server`, `Message.vaultSaved`, the new audit lines, the agent's row and the guidance.
 * One agent since 0.123.0 (OA-09): one set of rules, one row.
 */
import { describe, expect, it } from 'vitest';
import {
  inputJsonSchema,
  MCP_TOOLS,
  mcpRequiredKey,
  mcpToolPersonalOnly,
  PERSONAL_ONLY_TOOL_NAMES,
  WHOMBAT_TOOL_NAMES,
} from '../contracts/mcp.js';
import {
  VAULT_ADD_SERVER_OUTCOMES,
  VAULT_SAVE_KINDS,
  VaultAddServerInput,
  VaultAddServerOutput,
  VaultSaveInput,
  VaultSaveOutput,
} from '../contracts/mcp-vault.js';
import { EVENT_TYPES } from '../domain/audit.js';
import { MESSAGE_VAULT_SAVES_MAX, Message, MessageVaultSave, VAULT_BLANKED } from '../domain/message.js';
import {
  isVaultActivityTool,
  parseVaultSshAddress,
  VAULT_AGENT_ACCESS,
  VAULT_AUDIT_EVENT_TYPES,
  VAULT_FAILURE_TEXT,
  VAULT_PRIVATE_ENTRY,
  VAULT_SAVED_INTRO,
  VAULT_SELF_SERVE_TOOL_NAMES,
  vaultAgentAccessCopy,
  vaultAuditText,
  vaultNoServerText,
  vaultSavedIntro,
  vaultSavedLine,
  vaultUnheldAskLine,
} from './index.js';

const T = '2026-10-21T09:00:00.000Z';

/** The paths of a failed parse's issues. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return (result.error?.issues ?? []).map((i) => i.path.join('.'));
}

describe('vault_save’s input (CT-780; VS-04…VS-06)', () => {
  const newLogin = {
    kind: 'login',
    name: 'Plex',
    address: 'https://app.plex.tv',
    username: 'john@example.com',
    secret: 'hunter2',
  } as const;

  it('takes the three kinds, a new entry with name and address, made false by default', () => {
    expect(VAULT_SAVE_KINDS).toEqual(['login', 'token', 'basic']);
    const parsed = VaultSaveInput.parse(newLogin);
    expect(parsed.made).toBe(false);
    expect(VaultSaveInput.safeParse({ ...newLogin, kind: 'ssh' }).success).toBe(false);
    expect(
      VaultSaveInput.safeParse({
        kind: 'token',
        name: 'Cloudflare',
        address: 'https://api.cloudflare.com',
        secret: 't',
      }).success,
    ).toBe(true);
    expect(VaultSaveInput.safeParse({ ...newLogin, kind: 'basic', made: true }).success).toBe(true);
  });

  it('keeps the secret exactly as written', () => {
    expect(VaultSaveInput.parse({ ...newLogin, secret: '  pa ss  ' }).secret).toBe('  pa ss  ');
    expect(VaultSaveInput.safeParse({ ...newLogin, secret: '' }).success).toBe(false);
    expect(VaultSaveInput.safeParse({ ...newLogin, secret: 'x'.repeat(8001) }).success).toBe(false);
  });

  it('needs a name and an address for a new entry, and a username for login and basic', () => {
    const { name: _n, address: _a, username: _u, ...bare } = newLogin;
    expect(issuePaths(VaultSaveInput.safeParse(bare)).sort()).toEqual(['address', 'name', 'username']);
    expect(
      issuePaths(VaultSaveInput.safeParse({ ...bare, kind: 'basic', name: 'API', address: 'https://x.io' })),
    ).toEqual(['username']);
    expect(
      VaultSaveInput.safeParse({ ...bare, kind: 'token', name: 'API', address: 'https://x.io' }).success,
    ).toBe(true);
    expect(VaultSaveInput.safeParse({ ...newLogin, address: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('gives a saved entry a new secret without an address, a name or made', () => {
    const replace = { kind: 'login', entry: 'vlt_plex', secret: 'new-one', username: 'john' } as const;
    expect(VaultSaveInput.safeParse(replace).success).toBe(true);
    // An entry by its id only since 0.125 (CT-1242): its 8-letter key named bridged tools.
    expect(VaultSaveInput.safeParse({ ...replace, entry: 'abcdefgh' }).success).toBe(false);
    expect(issuePaths(VaultSaveInput.safeParse({ ...replace, address: 'https://evil.example' }))).toEqual([
      'address',
    ]);
    expect(issuePaths(VaultSaveInput.safeParse({ ...replace, name: 'Plex' }))).toEqual(['name']);
    expect(issuePaths(VaultSaveInput.safeParse({ ...replace, made: true }))).toEqual(['made']);
    expect(VaultSaveInput.safeParse({ ...replace, entry: 'Plex' }).success).toBe(false);
  });

  it('describes the fields for the model', () => {
    const properties = (
      inputJsonSchema('vault_save') as { properties: Record<string, { description?: string }> }
    ).properties;
    expect(properties.secret?.description).toContain('exactly as the person wrote it');
    expect(properties.made?.description).toContain('a password you made yourself');
    expect(properties.kind?.description).toMatch(
      /login.*browser.*token.*Bearer.*basic.*username and password/,
    );
  });

  it('answers the entry, whether it was new and how many messages were blanked, or a refusal', () => {
    const ok = { status: 'ok', entryId: 'vlt_plex', name: 'Plex', created: true, blanked: 2 } as const;
    expect(VaultSaveOutput.parse(ok)).toEqual(ok);
    expect(VaultSaveOutput.safeParse({ ...ok, blanked: -1 }).success).toBe(false);
    expect(
      VaultSaveOutput.parse({
        status: 'failed',
        reason: 'invalid_request',
        message: 'That isn’t in a message here.',
      }).status,
    ).toBe('failed');
    expect(VaultSaveOutput.parse({ status: 'blocked', eventId: 'evt_1', message: 'x' }).status).toBe(
      'blocked',
    );
  });
});

describe('vault_add_server’s input and answer (CT-781; VS-09…VS-11)', () => {
  it('reads a host or IP with an optional port, 22 by default', () => {
    expect(parseVaultSshAddress('Web1.Example.com')).toEqual({
      host: 'web1.example.com',
      hostKind: 'name',
      port: 22,
    });
    expect(parseVaultSshAddress(' 192.168.1.20:2222 ')).toMatchObject({ host: '192.168.1.20', port: 2222 });
    expect(parseVaultSshAddress('[2001:db8::7]:2200')).toMatchObject({ hostKind: 'ipv6', port: 2200 });
    expect(parseVaultSshAddress('2001:db8::7')).toMatchObject({ hostKind: 'ipv6', port: 22 });
    for (const bad of ['', 'root@10.0.0.5', 'ssh://web1', 'web1:0', 'web1:65536', 'web1:22x', '[::1', 'a b'])
      expect(parseVaultSshAddress(bad), bad).toBeNull();
  });

  it('takes an address, and optionally the key, a user, a name and a password once', () => {
    expect(VaultAddServerInput.safeParse({ address: '10.0.0.5' }).success).toBe(true);
    const full = VaultAddServerInput.parse({
      entry: 'vlt_servers',
      address: 'nas.lan:2222',
      username: 'admin',
      name: 'NAS',
      password: ' secret with spaces ',
    });
    expect(full.password).toBe(' secret with spaces ');
    expect(VaultAddServerInput.safeParse({ address: 'x'.repeat(261) }).success).toBe(false);
    expect(VaultAddServerInput.safeParse({ address: '10.0.0.5', password: '' }).success).toBe(false);
    expect(VaultAddServerInput.safeParse({ address: '10.0.0.5', password: 'x'.repeat(1025) }).success).toBe(
      false,
    );
    expect(VaultAddServerInput.safeParse({ address: '10.0.0.5', name: '-bad' }).success).toBe(false);
    expect(VaultAddServerInput.safeParse({ address: '10.0.0.5', username: 'root user' }).success).toBe(false);
    const user = VaultAddServerInput.safeParse({ address: 'root@10.0.0.5' });
    expect(user.success).toBe(false);
    expect(user.error?.issues[0]?.message).toContain('username');
    const properties = (
      inputJsonSchema('vault_add_server') as { properties: Record<string, { description?: string }> }
    ).properties;
    expect(properties.entry?.description).toContain('one SSH key or none');
    // Ignored since 3.14: it points the agent at the card.
    expect(properties.password?.description).toContain('vault_ask');
  });

  it('answers the server and how it went; the public key line only when the server refused the key', () => {
    expect(VAULT_ADD_SERVER_OUTCOMES).toEqual(['signed_in', 'key_added', 'key_refused', 'already']);
    const ok = {
      status: 'ok',
      entryId: 'vlt_servers',
      entryName: 'Servers',
      server: 'nas',
      target: 'root@10.0.0.5:22',
      outcome: 'signed_in',
      publicKey: null,
    } as const;
    expect(VaultAddServerOutput.parse(ok)).toEqual(ok);
    const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample whombat-abcdefgh';
    expect(VaultAddServerOutput.safeParse({ ...ok, outcome: 'key_refused', publicKey: line }).success).toBe(
      true,
    );
    expect(VaultAddServerOutput.safeParse({ ...ok, outcome: 'key_refused' }).success).toBe(false);
    expect(VaultAddServerOutput.safeParse({ ...ok, outcome: 'key_added', publicKey: line }).success).toBe(
      false,
    );
    expect(
      VaultAddServerOutput.parse({
        status: 'failed',
        reason: 'host_key_changed',
        message: VAULT_FAILURE_TEXT.host_key_changed,
      }).status,
    ).toBe('failed');
  });
});

describe('the two tools (CT-782; VS-12, VS-14)', () => {
  it('are Vault tools for a turn for a person that need no catalog key', () => {
    expect([...VAULT_SELF_SERVE_TOOL_NAMES]).toEqual(['vault_save', 'vault_add_server']);
    for (const name of VAULT_SELF_SERVE_TOOL_NAMES) {
      expect(MCP_TOOLS[name], name).toMatchObject({
        name,
        requiredKey: null,
        readOnly: false,
        personal: true,
      });
      expect(mcpToolPersonalOnly(name), name).toBe(true);
      expect(PERSONAL_ONLY_TOOL_NAMES, name).toContain(name);
      expect(WHOMBAT_TOOL_NAMES, name).not.toContain(name);
      expect(inputJsonSchema(name), name).toMatchObject({ type: 'object' });
    }
    expect(mcpRequiredKey('vault_save', {})).toBeNull();
    expect(MCP_TOOLS.vault_save.description).toContain('room only they read');
    expect(MCP_TOOLS.vault_save.description).toContain('Never repeat the secret');
    expect(MCP_TOOLS.vault_add_server.description).not.toContain('ssh_exec');
    expect(MCP_TOOLS.vault_add_server.description).toContain('first time it connects');
  });

  it('read as Vault activity', () => {
    for (const name of VAULT_SELF_SERVE_TOOL_NAMES) {
      expect(isVaultActivityTool(name), name).toBe(true);
      expect(isVaultActivityTool(`whombat.${name}`), name).toBe(true);
      expect(isVaultActivityTool(`mcp__whombat__${name}`), name).toBe(true);
    }
    expect(isVaultActivityTool('post_message')).toBe(false);
  });
});

describe('Message.vaultSaved (CT-783; VS-07, VS-11)', () => {
  const message = {
    id: 'msg_1',
    conversationId: 'cnv_dm',
    authorId: 'prn_john',
    createdAt: T,
    editedAt: null,
    text: `My Plex password is ${VAULT_BLANKED}`,
    mentions: [],
    card: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  };
  const saved = {
    entryId: 'vlt_plex',
    name: 'Plex',
    kind: 'login',
    how: 'saved',
    server: null,
    at: T,
  } as const;

  it('blanks with six bullets', () => {
    expect(VAULT_BLANKED).toBe('•'.repeat(6));
  });

  it('is optional, and holds at most five', () => {
    expect(Message.parse(message).vaultSaved).toBeUndefined();
    expect(Message.parse({ ...message, vaultSaved: [saved] }).vaultSaved).toEqual([saved]);
    expect(MESSAGE_VAULT_SAVES_MAX).toBe(5);
    expect(Message.safeParse({ ...message, vaultSaved: Array(6).fill(saved) }).success).toBe(false);
    expect(MessageVaultSave.safeParse({ ...saved, how: 'kept' }).success).toBe(false);
  });

  it('reads as one line per item', () => {
    const line = vaultSavedLine(saved);
    expect(line).toContain('Saved to your Vault');
    expect(line).toContain('· Plex');
    const once = vaultSavedLine({ name: 'Servers', how: 'used_once', server: 'web-1' });
    expect(once).toContain('“Servers”');
    expect(once).toContain('web-1');
    expect(once).toContain('not kept');
  });
});

describe('audit (CT-784; VS-02, VS-07)', () => {
  it('signs a saved entry as a Vault event, neutrally', () => {
    expect(EVENT_TYPES['vault.entry.saved']).toBe('Vault');
    expect(Object.keys(EVENT_TYPES)).not.toContain('vault.keys.own_given');
    expect(VAULT_AUDIT_EVENT_TYPES['entry.saved']).toBe('vault.entry.saved');
    expect(vaultAuditText('entry.saved')).toBe(`Saved ${VAULT_PRIVATE_ENTRY}`);
  });
});

describe('the agent’s row and the Vault’s intro (CT-786; VS-03, VS-08; OA-09)', () => {
  it('says the agent can use it, On or Off, with a hint for each (CT-1240)', () => {
    expect([...VAULT_AGENT_ACCESS]).toEqual(['on', 'off']);
    const copy = vaultAgentAccessCopy('Dusty');
    expect(copy.title).toBe('Dusty can use this');
    expect(copy.choices).toEqual({ on: 'On', off: 'Off' });
    for (const choice of VAULT_AGENT_ACCESS) expect(copy.hints[choice], choice).toContain('Dusty');
  });

  it('says saving from chat hides it in the message, and what the AI service saw', () => {
    expect(VAULT_SAVED_INTRO).toContain('{agent}');
    const intro = vaultSavedIntro('Dusty');
    expect(intro).toContain('Dusty');
    expect(intro).not.toContain('{agent}');
    expect(intro).toContain('hides it');
    expect(intro).toContain('AI service');
  });
});

describe('what the agent is told (CT-785; VS-09, VS-12, VS-13)', () => {
  it('reads an entry switched off as switched off by the person', () => {
    const facts = { personFirstName: 'John', entryName: 'Server Access Key', agentName: 'Dusty' };
    const line = vaultUnheldAskLine(facts);
    expect(line.startsWith('John switched you off')).toBe(true);
    expect(line).toContain('“Dusty can use this”');
    expect(line).toContain('“Server Access Key”');
  });

  it('answers an unknown server with vault_add_server when the agent can add it', () => {
    const named = vaultNoServerText(['web-1', 'nas'], { canAdd: true });
    expect(named).toContain('add it with vault_add_server');
    expect(named).toContain('web-1, nas');
    const none = vaultNoServerText([], { canAdd: true });
    expect(none).toContain('vault_add_server');
    expect(none).not.toContain('use one of');
    expect(vaultNoServerText(['web-1']).startsWith(VAULT_FAILURE_TEXT.no_server)).toBe(true);
  });
});
