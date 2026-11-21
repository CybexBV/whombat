/** The phone and a box's own address (own-address.md): its passkeys' RP ID, its route first, its record from a link. */
import { ownAddressRoute, parseLocalLink } from '@whombat/client/managed';
import { localLinkFor } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { communityRecord } from './community';

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
