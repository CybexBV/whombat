/** The phone and a box's own address (own-address.md): its passkeys' RP ID, its route first, its record from a link. */
import { createRegistry, ownAddressRoute, ownAddressToKeep, parseLocalLink } from '@whombat/client/managed';
import { localLinkFor } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { addressRecord, communityRecord, PHONE_COMMUNITY_TEXT, readBoxAddress } from './community';

vi.mock('../../modules/whombat-passkeys', () => ({
  WhombatPasskeys: { supported: () => false },
  passkeyFailureCode: () => 'failed',
}));
vi.mock('./config', () => ({ UI_ORIGINS: ['https://app.whombat.com'] }));

const { passkeyRpIdFor } = await import('./passkeys');

const BOX = '12D3KooWQ3BpNQUAmF3wTbNsGDk2RJhC9k1H7rpu97Vb2Q6hRfmQ';
const HOST = 'maple-otter-river.box.whombat.app';

describe('the RP ID per box', () => {
  it('is the box’s own host for a box with an own address, the hosted UI’s for the account', () => {
    expect(passkeyRpIdFor({ host: HOST })).toBe(HOST);
    expect(passkeyRpIdFor(null)).toBe('app.whombat.com');
    // Anything that isn't an own-address host never becomes an RP ID.
    expect(passkeyRpIdFor({ host: 'evil.example.com' })).toBe('app.whombat.com');
  });
});

describe('a device link with o= (design §7.3)', () => {
  const link = localLinkFor({
    kind: 'device',
    appliance: BOX,
    secret: 'A'.repeat(32),
    routes: [{ way: 'lan', socket: 'ws://192.168.1.20:4480/v1/direct', web: 'http://192.168.1.20:4480/' }],
    own: `https://${HOST}/`,
  });

  it('opens at the address and keeps it on the record, apart from the ways a welcome replaces', () => {
    const parsed = parseLocalLink(link);
    expect(parsed?.own).toBe(`https://${HOST}/`);
    const record = communityRecord(parsed as NonNullable<typeof parsed>, false);
    expect(record.ownAddress).toBe(`https://${HOST}/`);
    expect(record.direct?.lan).toEqual(['192.168.1.20']);
  });

  it('dials wss://<host>/v1/direct first', () => {
    expect(ownAddressRoute(`https://${HOST}/`)?.socket).toBe(`wss://${HOST}/v1/direct`);
    expect(ownAddressRoute('https://app.whombat.com/')).toBeNull();
    expect(ownAddressRoute(null)).toBeNull();
  });
});

describe('own names at <name>.whombat.app (4.16)', () => {
  const NEW = 'home.whombat.app';

  it('a chosen name is a box’s own host: its passkeys, its route and a typed address', () => {
    expect(passkeyRpIdFor({ host: NEW })).toBe(NEW);
    expect(ownAddressRoute(`https://${NEW}/`)?.socket).toBe(`wss://${NEW}/v1/direct`);
    expect(ownAddressRoute('https://home2.whombat.app/')?.web).toBe('https://home2.whombat.app/');
    // A zone itself is never a box.
    expect(ownAddressRoute('https://box.whombat.app/')).toBeNull();
    expect(readBoxAddress('Home.Whombat.app')).toEqual({ host: NEW, port: 443 });
    expect(addressRecord({ host: NEW, port: 443 }, BOX).ownAddress).toBe(`https://${NEW}/`);
  });

  it('the phone’s record follows the box’s current address from its status', () => {
    const store = new Map<string, string>();
    const registry = createRegistry('acc_mara', {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    });
    const link = parseLocalLink(
      localLinkFor({
        kind: 'device',
        appliance: BOX,
        secret: 'A'.repeat(32),
        routes: [],
        own: `https://${HOST}/`,
      }),
    );
    registry.put(communityRecord(link as NonNullable<typeof link>, true));
    // What ApplianceRoot does with `ownAddress.status` once the connection opens (and the About screen with its status).
    const seen = (own: { host: string; url: string } | null) => {
      const k = registry.get(BOX);
      const url = ownAddressToKeep(k?.ownAddress, own);
      if (k && url) registry.put({ ...k, ownAddress: url });
      return url;
    };
    expect(seen({ host: NEW, url: `https://${NEW}/` })).toBe(`https://${NEW}/`);
    expect(registry.get(BOX)?.ownAddress).toBe(`https://${NEW}/`);
    // The same again, or no address in the answer: nothing is written.
    expect(seen({ host: NEW, url: `https://${NEW}/` })).toBeNull();
    expect(seen(null)).toBeNull();
    expect(registry.get(BOX)?.ownAddress).toBe(`https://${NEW}/`);
  });

  it('typed addresses are explained with the new kind of name', () => {
    expect(PHONE_COMMUNITY_TEXT.start.placeholder).toBe('name.whombat.app');
  });
});
