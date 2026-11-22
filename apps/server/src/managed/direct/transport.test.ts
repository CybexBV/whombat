/** Which of the person's passkeys a session can confirm with: by how it came and from which page. */
import { describe, expect, it } from 'vitest';
import { type SessionTransport, stepUpPasskeysHere } from './transport';

const HOSTED = { origins: ['https://app.whombat.test', 'android:apk-key-hash:abc'] };
const HOST = 'maple-otter-river.box.whombat.test';
const page = (origin: string, secureContext = true): SessionTransport => ({
  via: 'direct',
  network: 'door',
  tls: true,
  page: { origin, secureContext },
});

describe('stepUpPasskeysHere', () => {
  it('uses the hosted app’s passkeys in the apps and through the relay', () => {
    expect(stepUpPasskeysHere({ via: 'relay' }, HOSTED, HOST)).toBe('hosted');
    expect(stepUpPasskeysHere({ via: 'direct', network: 'lan', tls: false, page: null }, HOSTED, HOST)).toBe(
      'hosted',
    );
    expect(stepUpPasskeysHere(undefined, HOSTED, HOST)).toBe('hosted');
  });

  it('uses the box’s own passkeys on a page at its own address', () => {
    expect(stepUpPasskeysHere(page(`https://${HOST}`), HOSTED, HOST)).toBe('box');
  });

  it('uses none on another page, a page without a secure context, or a box without an address', () => {
    expect(stepUpPasskeysHere(page('https://box.tail0000.ts.net'), HOSTED, HOST)).toBeNull();
    expect(stepUpPasskeysHere(page(`https://${HOST}`, false), HOSTED, HOST)).toBeNull();
    expect(stepUpPasskeysHere(page(`https://${HOST}`), HOSTED, null)).toBeNull();
    // A box with no hosted relying party (a community box away from its Tailscale page).
    expect(stepUpPasskeysHere({ via: 'relay' }, null, null)).toBeNull();
  });
});
