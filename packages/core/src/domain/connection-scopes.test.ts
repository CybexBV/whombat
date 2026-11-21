import { describe, expect, it } from 'vitest';
import { scopeListWords, scopeWords } from './connection-scopes.js';
import { catalogEntry, catalogSignIn } from './connections-catalog.js';

describe('scopeWords', () => {
  it('says what a scope lets Whombat do', () => {
    expect(scopeWords('dns.write')).toBe('change DNS');
    expect(scopeWords('argotunnel.read')).toBe('see tunnels');
    expect(scopeWords('cache.purge')).toBe('purge cache');
    expect(scopeWords('registrar-domains.admin')).toBe('manage domain registrations');
    expect(scopeWords('files:write')).toBe('change files');
    expect(scopeWords('workers-kv-storage.write')).toBe('change workers KV storage');
  });

  it('lists a few, then how many more', () => {
    expect(scopeListWords(['dns.write'])).toBe('change DNS');
    expect(scopeListWords(['dns.write', 'argotunnel.write'])).toBe('change DNS and change tunnels');
    expect(scopeListWords(['a.read', 'b.read', 'c.read', 'd.read', 'e.read', 'f.read'])).toBe(
      'see a, see b, see c, see d and 2 more',
    );
  });
});

describe('Cloudflare’s sign-in', () => {
  const entry = catalogEntry('cloudflare');
  const method = entry ? catalogSignIn(entry, 'mcp_oauth') : null;
  const scopes = method?.kind === 'mcp_oauth' ? (method.scopes ?? []) : [];
  const never = method?.kind === 'mcp_oauth' ? (method.scopesNever ?? []) : [];

  it('asks for DNS and tunnels, never the registrar, members, tokens or account settings', () => {
    expect(scopes).toEqual(expect.arrayContaining(['dns.write', 'argotunnel.write', 'zone.read']));
    for (const s of [
      'registrar-domains.admin',
      'memberships.write',
      'account-api-tokens.write',
      'account-settings.write',
    ]) {
      expect(scopes).not.toContain(s);
      expect(never).toContain(s);
    }
  });
});
