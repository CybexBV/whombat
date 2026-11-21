import { describe, expect, it } from 'vitest';
import { kioskUrl, ssoStartUrl } from './accounts';
import { describeAgent } from '../features/settings/UsersPage';
import { ssoErrorText } from '../features/auth/LoginPage';

describe('accounts', () => {
  it('builds kiosk links with the token in the fragment', () => {
    expect(kioskUrl('rk_abc', 'https://hub.example')).toBe('https://hub.example/kiosk#rk_abc');
  });
  it('starts single sign-on with the return path', () => {
    expect(ssoStartUrl('/servers/a?tab=guests')).toBe('/api/v1/auth/oidc/start?next=%2Fservers%2Fa%3Ftab%3Dguests');
    expect(ssoStartUrl('/', true)).toBe('/api/v1/auth/oidc/start?next=%2F&reauth=1');
  });
  it('names browsers', () => {
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0')).toBe('Firefox on Linux');
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Safari on macOS');
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge on Windows');
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS');
    expect(describeAgent('')).toBe('Unknown browser');
  });
  it('explains single sign-on refusals', () => {
    expect(ssoErrorText('no_role', 'Authentik')).toBe('Your Authentik account has no Rackoon role. Ask an admin.');
    expect(ssoErrorText('something new', 'Authentik')).toBe('Signing in with Authentik failed. Try again.');
  });
});
