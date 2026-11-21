import { describe, expect, it } from 'vitest';
import type { HostPort, HostService, PackageUpdate } from '../../api/types';
import { byText, matchesFilter, mergePorts, nextSort, portScope, serviceRank, serviceState, sortRows, updatesSummary } from './systemViews';

describe('sorting', () => {
  it('flips the same column and starts another at its natural direction', () => {
    expect(nextSort({ key: 'cpu', dir: 'desc' }, 'cpu', 'desc')).toEqual({ key: 'cpu', dir: 'asc' });
    expect(nextSort({ key: 'cpu', dir: 'desc' }, 'name', 'asc')).toEqual({ key: 'name', dir: 'asc' });
  });
  it('sorts stably in both directions', () => {
    const rows = [
      { n: 'b', v: 1 },
      { n: 'a', v: 2 },
      { n: 'c', v: 1 },
    ];
    expect(sortRows(rows, (x, y) => x.v - y.v, 'asc').map((r) => r.n)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, (x, y) => x.v - y.v, 'desc').map((r) => r.n)).toEqual(['a', 'b', 'c']);
  });
  it('compares names naturally', () => {
    expect(['nginx10', 'nginx9', 'Apache'].sort(byText)).toEqual(['Apache', 'nginx9', 'nginx10']);
  });
});

describe('filter', () => {
  it('needs every word, in any case', () => {
    expect(matchesFilter('sshd root /usr/sbin/sshd -D', 'SSHD root')).toBe(true);
    expect(matchesFilter('sshd root', 'sshd nginx')).toBe(false);
    expect(matchesFilter('anything', '  ')).toBe(true);
  });
});

describe('services', () => {
  it('ranks failed units first and words the state', () => {
    const s = (active: string, sub?: string): HostService => ({ name: 'x', active, sub });
    expect([s('active'), s('inactive'), s('failed'), s('activating')].map(serviceRank)).toEqual([2, 3, 0, 1]);
    expect(serviceState(s('active', 'running'))).toBe('active · running');
    expect(serviceState(s('failed', 'failed'))).toBe('failed');
  });
});

describe('ports', () => {
  it('knows the scope of an address', () => {
    expect(portScope({ address: '0.0.0.0' })).toBe('all');
    expect(portScope({ address: '::' })).toBe('all');
    expect(portScope({ address: '127.0.0.53' })).toBe('local');
    expect(portScope({ address: '10.0.0.7' })).toBe('address');
  });
  it('shows a socket on IPv4 and IPv6 once', () => {
    const p = (proto: string, address: string, port: number, pid?: number): HostPort => ({ proto, address, port, pid, process: 'sshd' });
    const out = mergePorts([p('tcp', '0.0.0.0', 22, 9), p('tcp6', '::', 22, 9), p('udp', '127.0.0.1', 53, 3), p('tcp', '10.0.0.7', 22, 9)]);
    expect(out.map((x) => `${x.proto} ${x.address}:${x.port}`)).toEqual(['tcp 0.0.0.0:22', 'udp 127.0.0.1:53', 'tcp 10.0.0.7:22']);
  });
});

describe('updates', () => {
  it('counts security updates', () => {
    const u = (name: string, security?: boolean): PackageUpdate => ({ name, new: '2', security });
    expect(updatesSummary([])).toBe('No pending updates');
    expect(updatesSummary([u('a')])).toBe('1 update');
    expect(updatesSummary([u('a', true), u('b'), u('c', true)])).toBe('3 updates · 2 security');
  });
});
