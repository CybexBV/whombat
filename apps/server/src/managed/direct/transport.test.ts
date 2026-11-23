/** Which of the person's passkeys a session can confirm with: by how it came and from which page. */
import { describe, expect, it } from 'vitest';
import { arrivalHost, type SessionTransport, stepUpPasskeysHere } from './transport';

const HOSTED = { origins: ['https://app.whombat.test', 'android:apk-key-hash:abc'] };
const HOST = 'maple-otter-river.box.whombat.test';
const OLD = 'home.whombat.test';
const page = (origin: string, secureContext = true): SessionTransport => ({
  via: 'direct',
  network: 'door',
  tls: true,
  page: { origin, secureContext },
});

describe('stepUpPasskeysHere', () => {
  it('uses the hosted app’s passkeys in the apps and through the relay', () => {
    expect(stepUpPasskeysHere({ via: 'relay' }, HOSTED, [HOST])).toBe('hosted');
    expect(
      stepUpPasskeysHere({ via: 'direct', network: 'lan', tls: false, page: null }, HOSTED, [HOST]),
    ).toBe('hosted');
    expect(stepUpPasskeysHere(undefined, HOSTED, [HOST])).toBe('hosted');
  });

  it('uses the box’s own passkeys on a page at its own address, the one it is leaving too', () => {
    expect(stepUpPasskeysHere(page(`https://${HOST}`), HOSTED, [HOST])).toBe('box');
    expect(stepUpPasskeysHere(page(`https://${OLD}`), HOSTED, [HOST, OLD])).toBe('box');
    expect(stepUpPasskeysHere(page(`https://${OLD}`), HOSTED, [HOST])).toBeNull();
  });

  it('uses none on another page, a page without a secure context, or a box without an address', () => {
    expect(stepUpPasskeysHere(page('https://box.tail0000.ts.net'), HOSTED, [HOST])).toBeNull();
    expect(stepUpPasskeysHere(page(`https://${HOST}`, false), HOSTED, [HOST])).toBeNull();
    expect(stepUpPasskeysHere(page(`https://${HOST}`), HOSTED, [])).toBeNull();
    // A box with no hosted relying party (a community box away from its Tailscale page).
    expect(stepUpPasskeysHere({ via: 'relay' }, null, [])).toBeNull();
  });
});

describe('arrivalHost', () => {
  it('is the TLS name of a door session, else its page’s host, and nothing for other ways in', () => {
    expect(
      arrivalHost({
        via: 'direct',
        network: 'door',
        tls: true,
        page: { origin: `https://${HOST}`, secureContext: true },
        host: OLD,
      }),
    ).toBe(OLD);
    expect(arrivalHost(page(`https://${HOST}`))).toBe(HOST);
    expect(arrivalHost({ via: 'direct', network: 'door', tls: true, page: null })).toBeNull();
    expect(arrivalHost({ via: 'direct', network: 'lan', tls: false, page: null, host: HOST })).toBeNull();
    expect(arrivalHost({ via: 'relay' })).toBeNull();
    expect(arrivalHost(undefined)).toBeNull();
  });
});
