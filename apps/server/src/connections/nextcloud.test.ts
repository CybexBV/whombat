import { describe, expect, it } from 'vitest';
import { nextcloudPollUrl } from './nextcloud';

describe('Nextcloud login: where to poll (SG-15d)', () => {
  it('polls the path Nextcloud named on the address Whombat uses, whatever scheme or host it named', () => {
    expect(nextcloudPollUrl('https://cloud.example.com', 'https://cloud.example.com/login/v2/poll')).toBe(
      'https://cloud.example.com/login/v2/poll',
    );
    // A proxy without overwriteprotocol / overwritehost.
    expect(
      nextcloudPollUrl('https://cloud.example.com', 'http://10.0.0.5:8080/index.php/login/v2/poll'),
    ).toBe('https://cloud.example.com/index.php/login/v2/poll');
  });

  it('keeps the address’s own path, and the place of a path under it', () => {
    expect(
      nextcloudPollUrl('https://home.test/nextcloud', 'http://home.test/nextcloud/index.php/login/v2/poll'),
    ).toBe('https://home.test/nextcloud/index.php/login/v2/poll');
    // A proxy that strips its prefix: Nextcloud names the path without it.
    expect(nextcloudPollUrl('https://home.test/nc/', 'http://backend/index.php/login/v2/poll')).toBe(
      'https://home.test/nc/index.php/login/v2/poll',
    );
  });

  it('refuses anything that isn’t a poll path', () => {
    expect(nextcloudPollUrl('https://cloud.example.com', 'https://evil.example/collect')).toBeNull();
    expect(
      nextcloudPollUrl('https://cloud.example.com', 'https://cloud.example.com/login/v2/poll/x'),
    ).toBeNull();
    expect(nextcloudPollUrl('https://cloud.example.com', 'not a url')).toBeNull();
  });

  it('never leaves the address, whatever the path holds', () => {
    const url = nextcloudPollUrl(
      'https://cloud.example.com',
      'https://evil.example/%2F%2Fevil/login/v2/poll',
    );
    expect(new URL(url ?? '').origin).toBe('https://cloud.example.com');
  });
});
