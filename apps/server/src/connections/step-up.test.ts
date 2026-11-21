import { describe, expect, it } from 'vitest';
import { insufficientScopeOf } from '../mcp/client-pool';
import { mcpSignInScope } from './oauth';
import { allowMoreHref, missingScopes } from './step-up';

describe('asking for more in the middle of a task (step-up)', () => {
  it('reads the scopes an insufficient_scope challenge names, and nothing else', () => {
    expect(insufficientScopeOf('Bearer error="insufficient_scope", scope="user:read dns.write"')).toEqual([
      'user:read',
      'dns.write',
    ]);
    expect(insufficientScopeOf('Bearer scope="a b", error=insufficient_scope')).toEqual(['a', 'b']);
    expect(insufficientScopeOf('Bearer error="invalid_token", scope="a"')).toBeNull();
    expect(insufficientScopeOf('Bearer error="insufficient_scope"')).toBeNull();
    expect(insufficientScopeOf(null)).toBeNull();
  });

  it('asks the server’s scope, the entry’s list and a reconnect’s, once each, offline_access left to the registration', () => {
    expect(mcpSignInScope('user:read account:read', ['dns.write', 'user:read', 'offline_access'])).toBe(
      'user:read account:read dns.write',
    );
    expect(mcpSignInScope(null, [])).toBeNull();
  });

  it('counts as missing only what the connection doesn’t hold', () => {
    expect(
      missingScopes(['user:read', 'dns.read', 'dns.write', 'offline_access'], {
        scopes: ['user:read', 'dns.read'],
      }),
    ).toEqual(['dns.write']);
    expect(allowMoreHref({ id: 'cloudflare' }, 'con_1')).toBe(
      '/settings?tab=connections&connection=cloudflare&id=con_1',
    );
  });
});
