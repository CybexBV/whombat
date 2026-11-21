import { describe, expect, it } from 'vitest';
import { redactUrl } from './redact';

describe('redactUrl', () => {
  it('replaces credential query values and keeps everything else', () => {
    expect(redactUrl('/ws?burrow=burrow-hq&token=ws_abc')).toBe('/ws?burrow=burrow-hq&token=%5Bredacted%5D');
    expect(redactUrl('/cb?code=1&code=2&state=x&installation_id=7')).toBe(
      '/cb?code=%5Bredacted%5D&state=%5Bredacted%5D&installation_id=7',
    );
    expect(redactUrl('/ws?TOKEN=wt_abc')).not.toContain('wt_abc');
    // A join link opened on the server that serves the web app (AH-07).
    expect(redactUrl('/login?invite=inv_abc123&email=bob%40example.test')).toBe(
      '/login?invite=%5Bredacted%5D&email=bob%40example.test',
    );
  });

  it('leaves URLs without secrets untouched', () => {
    expect(redactUrl('/api/v1/health')).toBe('/api/v1/health');
    expect(redactUrl('/api/v1/burrows/hq/search?q=token%20rounding')).toBe(
      '/api/v1/burrows/hq/search?q=token%20rounding',
    );
  });
});
