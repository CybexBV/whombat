/**
 * 1Password as a connection (docs/decisions/onepassword-sync.md): its catalog entry, the use `vault` and the check kind
 * `onepassword`, the form's one question, and what agents never get from it.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_CONNECTABLE,
  CATALOG_USES,
  CatalogCheck,
  CatalogEntry,
  catalogEntry,
  defaultConnectionLabel,
  fieldProblem,
  fieldsFor,
  handleFor,
  hasRequestTool,
  isAgentConnection,
  isGatewayConnection,
  isVaultSyncConnection,
  ONEPASSWORD_ENTRIES_CHOICES,
  ONEPASSWORD_ENTRIES_FIELD,
  ONEPASSWORD_VAULT_FIELD,
  resolveBaseUrl,
} from './connections-catalog.js';

const onepassword = () => {
  const e = catalogEntry('onepassword');
  if (!e) throw new Error('no onepassword entry');
  return e;
};

describe('the 1Password entry', () => {
  it('is connectable, named as the spec says, and used only by the Vault’s sync', () => {
    const e = onepassword();
    expect(CATALOG_CONNECTABLE.some((x) => x.id === 'onepassword')).toBe(true);
    expect(e.name).toBe('1Password');
    expect(e.description).toBe('Keep a 1Password vault and your Vault in step, both ways.');
    expect(CATALOG_USES).toContain('vault');
    expect(e.use).toBe('vault');
    expect(isVaultSyncConnection(e)).toBe(true);
    expect(isVaultSyncConnection('onepassword')).toBe(true);
    expect(isAgentConnection(e)).toBe(false);
    expect(isGatewayConnection(e)).toBe(false);
    for (const id of ['fusebox', 'tracker', 'homeassistant', 'newer_service'])
      expect(isVaultSyncConnection(id), id).toBe(false);
  });

  it('signs in with a service account token and is checked by its own check kind, never by a request', () => {
    const e = onepassword();
    expect(e.signIn.map((m) => [m.kind, m.label])).toEqual([['token', 'Service account token']]);
    const token = e.signIn[0];
    expect(token?.kind === 'token' && token.secretLabel).toBe('Service account token');
    expect(token?.kind === 'token' && token.secretHelp).toMatch(/read and write only the vault/);
    expect(e.check).toEqual({ kind: 'onepassword' });
    expect(CatalogCheck.safeParse({ kind: 'onepassword' }).success).toBe(true);
    expect(e.baseUrl).toBe('onepassword:');
    expect(resolveBaseUrl(e, {})).toBeNull();
    expect(e.request).toBeNull();
    expect(e.tools).toEqual([]);
    expect(hasRequestTool(e, 'token')).toBe(false);
  });

  it('asks the vault (from the token’s answer) and what happens to the entries already in the Vault', () => {
    const e = onepassword();
    expect(fieldsFor(e, 'token').map((f) => [f.id, f.kind, f.label])).toEqual([
      [ONEPASSWORD_VAULT_FIELD, 'select', 'Vault'],
      [ONEPASSWORD_ENTRIES_FIELD, 'select', 'Your Vault entries'],
    ]);
    const [vault, entries] = fieldsFor(e, 'token');
    expect(vault).toMatchObject({ fromService: true, required: true });
    expect(vault?.options).toBeUndefined();
    expect(entries?.default).toBe('put');
    expect(entries?.options).toEqual([
      { value: 'put', label: 'Also put them in this 1Password vault' },
      { value: 'keep', label: 'Keep them only in Whombat' },
    ]);
    expect(entries?.options).toEqual([...ONEPASSWORD_ENTRIES_CHOICES]);
    if (!entries || !vault) throw new Error('fields');
    expect(fieldProblem(entries, 'keep')).toBeNull();
    expect(fieldProblem(entries, 'both')).toMatch(/Pick one of the choices/);
    // The vault comes from the service: nobody is asked to type it.
    expect(fieldProblem(vault, '')).toBeNull();
  });

  it('says what happens in its guide and help: a vault for Whombat, both ways, settings stay', () => {
    const e = onepassword();
    expect(e.guide).toMatch(/vault in 1Password for Whombat/);
    expect(e.guide).toMatch(/read and write only that vault/);
    expect(e.guide).toMatch(/both ways/);
    expect(e.guide).toMatch(/own settings stay/);
    expect(e.guide).toMatch(/passwords you give Whombat go into that vault/);
    expect(e.guide).toMatch(/assistant doesn’t use this connection/);
  });

  it('is one per Whombat: its label is its name', () => {
    expect(defaultConnectionLabel(onepassword(), { vault: 'abc' })).toBe('1Password');
    expect(handleFor('onepassword', [])).toBe('onepassword');
  });

  it('is a valid catalog entry', () => {
    expect(CatalogEntry.safeParse(onepassword()).success).toBe(true);
  });
});
