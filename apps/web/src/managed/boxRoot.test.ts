import { COMMUNITY_APPLIANCE, DIRECT_IDENTITY_UNCLAIMED } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { onThisMachine } from './BoxRoot';
import { boxIdentity, ownRoute } from './boxEnv';

describe('the box’s own page (AP-5322)', () => {
  it('talks to its own origin’s direct socket: plain on the local network, TLS on the Tailscale name', () => {
    expect(ownRoute({ protocol: 'http:', host: '192.168.1.20:4480' })).toEqual({
      way: 'lan',
      socket: 'ws://192.168.1.20:4480/v1/direct',
      web: 'http://192.168.1.20:4480/',
    });
    expect(ownRoute({ protocol: 'https:', host: 'whombat-r7m4.tail1234.ts.net:4480' })).toMatchObject({
      way: 'tailscale',
      socket: 'wss://whombat-r7m4.tail1234.ts.net:4480/v1/direct',
    });
  });

  it('offers the development sign-in only on the machine itself', () => {
    expect(onThisMachine('localhost')).toBe(true);
    expect(onThisMachine('127.0.0.1')).toBe(true);
    expect(onThisMachine('[::1]')).toBe(true);
    expect(onThisMachine('192.168.1.20')).toBe(false);
    expect(onThisMachine('whombat-r7m4.tail1234.ts.net')).toBe(false);
  });

  it('learns the box’s identity from the box, or nothing', async () => {
    const answering = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    // Its PeerId, and since 1.1 its edition and whether it is claimed (CT-1300; AP-5420).
    expect(await boxIdentity(answering(DIRECT_IDENTITY_UNCLAIMED))).toEqual(DIRECT_IDENTITY_UNCLAIMED);
    expect(await boxIdentity(answering({ v: 1, appliance: COMMUNITY_APPLIANCE }))).toEqual({
      v: 1,
      appliance: COMMUNITY_APPLIANCE,
    });
    expect(await boxIdentity(answering({ v: 2, appliance: COMMUNITY_APPLIANCE }))).toBeNull();
    expect(await boxIdentity(answering({}, 404))).toBeNull();
    expect(
      await boxIdentity((async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch),
    ).toBeNull();
  });
});
