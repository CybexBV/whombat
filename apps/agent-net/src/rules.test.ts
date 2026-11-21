/**
 * The commands' wall (one-person.md OP-07, OP-S106): public on every port but 25, the agent's own services on
 * 127.0.0.1:20000–20099, never this host, private space or metadata unless the person allowed it, a production server
 * only once a person said yes.
 */
import { describe, expect, it } from 'vitest';
import { decide, EMPTY_POLICY, inAny, parseV4Cidr, type WallPolicy } from './rules';

const host = { hostAddresses: ['192.168.1.20'], deny: ['8.8.8.0/24'] };
const policy = (over: Partial<WallPolicy> = {}): WallPolicy => ({ ...EMPTY_POLICY, ...over });
const ok = (address: string, port: number, p: WallPolicy = policy()) => decide(address, port, p, host).ok;

describe('the commands’ wall', () => {
  it('lets public TCP through on every port but 25, never the deny list', () => {
    expect(ok('93.184.216.34', 443)).toBe(true);
    expect(ok('93.184.216.34', 22)).toBe(true);
    expect(ok('93.184.216.34', 25)).toBe(false);
    expect(ok('8.8.8.8', 53)).toBe(false);
    expect(ok('::1', 80)).toBe(false);
  });

  it('opens the agent’s own services on this host’s loopback, and nothing else of it', () => {
    expect(ok('127.0.0.1', 20000)).toBe(true);
    expect(ok('127.0.0.1', 20099)).toBe(true);
    expect(ok('127.0.0.1', 20100)).toBe(false);
    expect(ok('127.0.0.1', 4400)).toBe(false);
    expect(ok('127.0.0.2', 20000)).toBe(false);
    expect(ok('192.168.1.20', 22, policy({ lan: true }))).toBe(false);
  });

  it('reaches private space only as the person allowed: a home network, or the local network', () => {
    expect(ok('10.0.0.5', 5432)).toBe(false);
    expect(ok('10.0.0.5', 5432, policy({ homeNetworks: ['10.0.0.0/24'] }))).toBe(true);
    expect(ok('10.0.1.5', 5432, policy({ homeNetworks: ['10.0.0.0/24'] }))).toBe(false);
    expect(ok('192.168.1.30', 22, policy({ lan: true }))).toBe(true);
    expect(ok('192.168.1.30', 25, policy({ lan: true }))).toBe(false);
    expect(ok('169.254.169.254', 80, policy({ lan: true }))).toBe(false);
    expect(ok('100.100.100.200', 80, policy({ lan: true }))).toBe(false);
  });

  it('keeps a production server closed until an opening, on its port or every port', () => {
    const closed = policy({ production: ['93.184.216.34'] });
    expect(ok('93.184.216.34', 22, closed)).toBe(false);
    const once = { ...closed, open: [{ address: '93.184.216.34', port: 22 }] };
    expect(ok('93.184.216.34', 22, once)).toBe(true);
    expect(ok('93.184.216.34', 443, once)).toBe(false);
    const all = { ...closed, open: [{ address: '93.184.216.34', port: null }] };
    expect(ok('93.184.216.34', 443, all)).toBe(true);
    expect(ok('93.184.216.34', 25, all)).toBe(false);
    // An opening never reaches what the rest of the wall keeps out.
    expect(ok('10.9.9.9', 22, policy({ open: [{ address: '10.9.9.9', port: 22 }] }))).toBe(false);
  });

  it('uses the current policy and host facts even when their objects are reused', () => {
    const current = policy({ homeNetworks: ['10.2.0.0/16'] });
    const facts = { hostAddresses: [] as string[], deny: [] as string[] };
    const allowed = () => decide('10.2.3.4', 22, current, facts).ok;
    expect(allowed()).toBe(true);
    current.homeNetworks.splice(0);
    expect(allowed()).toBe(false);
    current.lan = true;
    expect(allowed()).toBe(true);
    current.production.push('10.2.0.0/16');
    expect(allowed()).toBe(false);
    current.open.push({ address: '10.2.3.4', port: 22 });
    expect(allowed()).toBe(true);
    facts.deny.push('10.2.3.0/24');
    expect(allowed()).toBe(false);
    facts.deny.splice(0);
    expect(allowed()).toBe(true);
    facts.hostAddresses.push('10.2.3.4');
    expect(allowed()).toBe(false);
    facts.hostAddresses.splice(0);
    current.open.splice(0);
    expect(allowed()).toBe(false);
  });

  it('keeps range boundaries, invalid entries and evicted entries independent of callers', () => {
    const networks = ['192.168.10.4/30', 'not an address', '::1/128'];
    for (const [address, expected] of [
      ['192.168.10.3', false],
      ['192.168.10.4', true],
      ['192.168.10.7', true],
      ['192.168.10.8', false],
      ['::1', false],
    ] as const)
      expect(inAny(address, networks)).toBe(expected);
    const parsed = parseV4Cidr(networks[0] as string);
    if (!parsed) throw new Error('no range');
    parsed[0] = 0;
    parsed[1] = 2 ** 32 - 1;
    expect(inAny('93.184.216.34', networks)).toBe(false);
    // More distinct ranges than the cache holds; old entries must still parse to the same result.
    for (let i = 0; i < 1200; i++) {
      const address = `10.${Math.floor(i / 256)}.${i % 256}.0`;
      expect(inAny(address, [`${address}/24`])).toBe(true);
    }
    expect(inAny('192.168.10.7', networks)).toBe(true);
    expect(inAny('192.168.10.8', networks)).toBe(false);
  });
});
