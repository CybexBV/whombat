/** A community Whombat on the phone (AP-5470…AP-5475): the record a link leaves, its addresses and the words. */
import { COMMUNITY_TEXT, readLocalLink } from '@whombat/client/managed';
import { COMMUNITY_APPLIANCE, DEVICE_LINK, DIRECT_ADDRESSES } from '@whombat/fixtures';
import { directRoutesFor } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  addressRecord,
  boxAddressOrigin,
  COMMUNITY_ORG,
  communityNotificationsView,
  communityRecord,
  linkAddresses,
  onLocalNetwork,
  PHONE_COMMUNITY_TEXT,
  readBoxAddress,
  scannedLocalLink,
} from './community';

describe('a community box on this phone', () => {
  it('keeps the PeerId the link names as its pin and its device id, with the link’s ways', () => {
    const link = readLocalLink(DEVICE_LINK.link);
    if (!link) throw new Error('fixture link');
    const record = communityRecord(link, true, 'acc_mara');
    expect(record).toMatchObject({
      device: COMMUNITY_APPLIANCE,
      peerId: COMMUNITY_APPLIANCE,
      orgId: COMMUNITY_ORG,
      pinSource: 'add-link',
      enrolled: true,
      accountId: 'acc_mara',
    });
    // The first session tries the link's ways in its order, local network first, all of them on Android.
    expect(directRoutesFor(record.direct, { secureOnly: false }).map((r) => r.socket)).toEqual(
      link.routes.map((r) => r.socket),
    );
  });

  it('reads the addresses as a welcome has them', () => {
    const a = linkAddresses(DIRECT_ADDRESSES.routes);
    expect(a.port).toBe(DIRECT_ADDRESSES.port);
    expect(a.lan).toEqual(DIRECT_ADDRESSES.lan);
    expect(a.tailscale).toBe(DIRECT_ADDRESSES.tailscale);
  });

  it('takes a scanned device link, and says when a code isn’t one', () => {
    const read = scannedLocalLink(DEVICE_LINK.link);
    expect('link' in read && read.link.kind).toBe('device');
    expect(scannedLocalLink('https://app.whombat.com/auth/verify#token=x')).toEqual({
      problem: PHONE_COMMUNITY_TEXT.join.bad,
    });
  });

  it('says there are no phone notifications, with nothing to turn on', () => {
    const v = communityNotificationsView();
    expect(v.title).toBe(COMMUNITY_TEXT.push.phoneTitle);
    expect(v.action).toBeNull();
  });
});

describe('joining at a typed address (LNK-08)', () => {
  it('reads an own address or a Tailscale name, with or without https:// and a port', () => {
    expect(readBoxAddress('  https://Maple-Otter-River.box.whombat.app/ ')).toEqual({
      host: 'maple-otter-river.box.whombat.app',
      port: 443,
    });
    // A bare Tailscale name is the box's direct port, where it serves that name.
    expect(readBoxAddress('home.tail1234.ts.net')).toEqual({ host: 'home.tail1234.ts.net', port: 4480 });
    // The address the box's page shows, port included.
    expect(readBoxAddress('https://home.tail1234.ts.net:4480/')).toEqual({
      host: 'home.tail1234.ts.net',
      port: 4480,
    });
    expect(readBoxAddress('home.tail1234.ts.net:8443')).toEqual({ host: 'home.tail1234.ts.net', port: 8443 });
    expect(readBoxAddress('http://home.example.com')).toBeNull();
    expect(readBoxAddress('home')).toBeNull();
    expect(readBoxAddress('home.example.com/path')).toBeNull();
    expect(readBoxAddress('home.example.com:')).toBeNull();
    expect(readBoxAddress('home.example.com:0')).toBeNull();
    expect(readBoxAddress('home.example.com:99999')).toBeNull();
    expect(readBoxAddress('home.example.com:44:80')).toBeNull();
  });

  it('pins the PeerId the box named there and dials the address, port included', () => {
    const own = addressRecord({ host: 'maple-otter-river.box.whombat.app', port: 443 }, COMMUNITY_APPLIANCE);
    expect(own).toMatchObject({
      device: COMMUNITY_APPLIANCE,
      peerId: COMMUNITY_APPLIANCE,
      orgId: COMMUNITY_ORG,
    });
    expect(own.enrolled).toBe(false);
    expect(own.ownAddress).toBe('https://maple-otter-river.box.whombat.app/');
    expect(own.direct?.routes[0]?.socket).toBe('wss://maple-otter-river.box.whombat.app/v1/direct');
    const typed = readBoxAddress('home.tail1234.ts.net');
    if (!typed) throw new Error('address');
    expect(boxAddressOrigin(typed)).toBe('https://home.tail1234.ts.net:4480');
    const tailnet = addressRecord(typed, COMMUNITY_APPLIANCE);
    expect(tailnet.ownAddress).toBeUndefined();
    expect(tailnet.direct).toMatchObject({
      port: 4480,
      tailscale: 'home.tail1234.ts.net',
      routes: [
        {
          way: 'tailscale',
          socket: 'wss://home.tail1234.ts.net:4480/v1/direct',
          web: 'https://home.tail1234.ts.net:4480/',
        },
      ],
    });
  });

  // The address a box without a secure address shows on its screen, for the claim on this network.
  it('reads an address on this network, on the direct port unless one is typed', () => {
    expect(readBoxAddress(' 10.100.1.20 ')).toEqual({ host: '10.100.1.20', port: 4480 });
    expect(readBoxAddress('10.100.1.20:8080')).toEqual({ host: '10.100.1.20', port: 8080 });
    expect(readBoxAddress('10.100.1.256')).toBeNull();
    expect(readBoxAddress('10.100.1')).toBeNull();
    expect(readBoxAddress('10.100.01.20')).toBeNull();
    expect(onLocalNetwork({ host: '10.100.1.20', port: 4480 })).toBe(true);
    expect(onLocalNetwork({ host: 'home.tail1234.ts.net', port: 4480 })).toBe(false);
  });

  it('dials an address on this network in plain HTTP, its Noise session inside', () => {
    const typed = readBoxAddress('10.100.1.20');
    if (!typed) throw new Error('address');
    expect(boxAddressOrigin(typed)).toBe('http://10.100.1.20:4480');
    const lan = addressRecord(typed, COMMUNITY_APPLIANCE);
    expect(lan.ownAddress).toBeUndefined();
    expect(lan.direct).toEqual({
      port: 4480,
      lan: ['10.100.1.20'],
      tailscale: null,
      routes: [{ way: 'lan', socket: 'ws://10.100.1.20:4480/v1/direct', web: 'http://10.100.1.20:4480/' }],
    });
  });

  it('has no price and nothing to buy on the first screen', () => {
    const words = JSON.stringify(PHONE_COMMUNITY_TEXT);
    expect(words).not.toMatch(/€|price|subscri|buy|sign up/i);
  });
});
