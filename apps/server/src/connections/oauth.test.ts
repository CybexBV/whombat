import { describe, expect, it } from 'vitest';
import { asksOfflineAccess, isLoopbackRedirect, registrationRefusedText, withOfflineAccess } from './oauth';

describe('MCP sign-in (SG-19)', () => {
  it('asks offline_access where the authorization server lists it and the scope lacks it', () => {
    expect(withOfflineAccess('openid', ['openid', 'offline_access'])).toBe('openid offline_access');
    expect(withOfflineAccess('read offline_access', ['offline_access'])).toBe('read offline_access');
    expect(withOfflineAccess('read', ['read'])).toBe('read');
    // No scope asked: none added (offline_access alone could narrow the grant).
    expect(withOfflineAccess(null, ['offline_access'])).toBeNull();
    expect(asksOfflineAccess('a offline_access')).toBe(true);
    expect(asksOfflineAccess('offline_accessor')).toBe(false);
    expect(asksOfflineAccess(undefined)).toBe(false);
  });

  it('tells a loopback redirect (a native client) from a web one', () => {
    expect(isLoopbackRedirect('http://localhost:4420/api/v1/connections/notion/callback')).toBe(true);
    expect(isLoopbackRedirect('http://127.0.0.1:4400/cb')).toBe(true);
    expect(isLoopbackRedirect('http://[::1]:4400/cb')).toBe(true);
    expect(isLoopbackRedirect('https://whombat.example.org/cb')).toBe(false);
    expect(isLoopbackRedirect('http://192.168.1.20:4400/cb')).toBe(false);
  });

  it('says an http address is why a server refused the registration', () => {
    expect(registrationRefusedText(['http://192.168.1.20:4400/cb'])).toContain('https address');
    expect(registrationRefusedText(['http://localhost:4420/cb'])).not.toContain('https');
    expect(registrationRefusedText(['https://whombat.example.org/cb'])).not.toContain('https');
  });
});
