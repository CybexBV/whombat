/**
 * `connections.catalog` on a box without a secure address: an entry whose every sign-in must come back to the box says
 * why before anyone starts it (whombat-link.md); entries with another way in stay available.
 */
import { CATALOG, OAuthSignInKind } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { useBoxPageAsApp } from '../config';
import { catalogStatus } from './views';

function services(page: string) {
  const config = { WHOMBAT_APP_URL: undefined, NODE_ENV: 'production' as const };
  useBoxPageAsApp(config, () => page);
  return {
    config,
    tracker: { drivers: { list: () => [{}] } },
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  } as never;
}

const onlyOAuth = CATALOG.filter(
  (e) => e.signIn.length > 0 && e.signIn.every((m) => OAuthSignInKind.safeParse(m.kind).success),
);
const otherWay = CATALOG.filter((e) => e.signIn.some((m) => !OAuthSignInKind.safeParse(m.kind).success));

describe('the catalog and the return address', () => {
  it('a box on plain HTTP: OAuth-only entries need a secure address, the rest are unchanged', async () => {
    expect(onlyOAuth.length).toBeGreaterThan(0);
    const { entries } = await catalogStatus(services('http://192.168.1.20:4480/'));
    for (const e of onlyOAuth) {
      const s = entries.find((x) => x.catalogId === e.id);
      expect(s, e.id).toMatchObject({ available: false, reason: 'needs_secure_address' });
    }
    for (const e of otherWay) {
      const s = entries.find((x) => x.catalogId === e.id);
      expect(s?.reason, e.id).not.toBe('needs_secure_address');
    }
    // Dropbox's app section still shows, so its app can be set up ahead.
    expect(entries.find((x) => x.catalogId === 'dropbox')?.app?.configured).toBe(false);
  });

  it('a box with a secure address lists no such reason', async () => {
    const { entries } = await catalogStatus(services('https://quiet-otter-lamp.box.whombat.app/'));
    expect(entries.some((x) => x.reason === 'needs_secure_address')).toBe(false);
    expect(entries.find((x) => x.catalogId === 'dropbox')?.reason).toBe('app_not_configured');
  });
});
