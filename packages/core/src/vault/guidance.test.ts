/**
 * Entries switched off for the agent (Whombat vault.md VT-G01…VT-G05, contracts 0.33.0, CT-208; since 0.125 only the
 * turn person's own, CT-1243).
 */
import { describe, expect, it } from 'vitest';
import { DispatchContext, VaultDispatchContext, VaultUnheldEntry } from '../contracts/index.js';
import { VAULT_FAILURE_TEXT, VAULT_UNHELD_MAX, vaultNoServerText, vaultUnheldAskLine } from './index.js';

const sshUnheld = {
  id: 'vlt_server',
  name: 'Server Access Key',
  description: 'Root on the Hetzner box.',
  kind: 'ssh',
  site: null,
} as const;

describe('VaultDispatchContext.unheld (VT-G02)', () => {
  it('defaults to []', () => {
    expect(VaultDispatchContext.parse({ entries: [] }).unheld).toEqual([]);
  });

  it('carries the person’s own entries switched off for the agent, by name and kind', () => {
    const vault = VaultDispatchContext.parse({
      entries: [],
      unheld: [
        sshUnheld,
        { id: 'vlt_shop', name: 'Shop', description: '', kind: 'login', site: 'shop.example' },
        { id: 'vlt_api', name: 'API', description: '', kind: 'http', site: null },
        { id: 'vlt_ha', name: 'Home', description: '', kind: 'mcp', site: null },
      ],
    });
    expect(vault.unheld.map((e) => e.kind)).toEqual(['ssh', 'login', 'http', 'mcp']);
    expect(vault.unheld[1]?.site).toBe('shop.example');
  });

  it('never carries a secret entry, nor a secret field, nor an owner', () => {
    expect(VaultUnheldEntry.safeParse({ ...sshUnheld, kind: 'secret' }).success).toBe(false);
    const parsed = VaultUnheldEntry.parse({ ...sshUnheld, secret: 'hunter2', ownerFirstName: 'John' });
    expect(parsed).not.toHaveProperty('secret');
    expect(parsed).not.toHaveProperty('ownerFirstName');
  });

  it('holds at most VAULT_UNHELD_MAX', () => {
    expect(VAULT_UNHELD_MAX).toBe(20);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...sshUnheld, id: `vlt_${i}` }));
    expect(VaultDispatchContext.safeParse({ entries: [], unheld: many(20) }).success).toBe(true);
    expect(VaultDispatchContext.safeParse({ entries: [], unheld: many(21) }).success).toBe(false);
  });

  it('rides on DispatchContext.vault, which holds no tool list', () => {
    expect(DispatchContext.shape.vault.parse({ entries: [], tools: ['vault_request'] })).toEqual({
      entries: [],
      unheld: [],
    });
  });
});

describe('unheld entries read (VT-G03)', () => {
  it('as switched off by the person, with where to switch it on', () => {
    const line = vaultUnheldAskLine({
      personFirstName: 'John',
      entryName: 'Server Access Key',
      agentName: 'Dusty',
    });
    expect(line.startsWith('John switched you off')).toBe(true);
    expect(line).toContain('“Dusty can use this”');
    expect(line).toContain('“Server Access Key”');
  });
});

describe('no_server names the servers (VT-G04)', () => {
  it('lists the key’s servers, or says there are none', () => {
    expect(vaultNoServerText(['web-1', 'nas'])).toContain('web-1, nas');
    expect(vaultNoServerText([]).startsWith(VAULT_FAILURE_TEXT.no_server)).toBe(true);
    expect(vaultNoServerText(['web-1'], { canAdd: true })).toContain('vault_add_server');
  });
});
