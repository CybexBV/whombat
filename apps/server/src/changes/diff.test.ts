import { describe, expect, it } from 'vitest';
import {
  containerState,
  diffContainers,
  diffServer,
  diffService,
  mergeFacts,
  nextServerState,
  nextServiceState,
} from './diff';

describe('a service’s changes', () => {
  it('sets the first read and tells a version that moved, ignoring a leading v', () => {
    const first = nextServiceState(null, { version: '2.3.0' });
    expect(diffService('Immich', null, first)).toEqual([]);
    const same = nextServiceState(first, { version: 'v2.3.0' });
    expect(diffService('Immich', first, same)).toEqual([]);
    const moved = nextServiceState(first, { version: '2.4.0' });
    expect(diffService('Immich', first, moved)).toEqual([
      { kind: 'version', subject: '', fact: { k: 'version', name: 'Immich', from: '2.3.0', to: '2.4.0' } },
    ]);
  });

  it('keeps the last read for what a read couldn’t see', () => {
    const first = nextServiceState(null, { version: '1.0', firmware: { AP: '6.6.1' } });
    const blind = nextServiceState(first, { version: null, firmware: null });
    expect(blind).toEqual(first);
    expect(diffService('UniFi', first, blind)).toEqual([]);
  });

  it('tells firmware of devices both reads saw, and many as one', () => {
    const before = nextServiceState(null, { firmware: { AP: '6.6.1', Switch: '7.1' } });
    const one = nextServiceState(before, { firmware: { AP: '6.6.2', Switch: '7.1', New: '1.0' } });
    expect(diffService('UniFi', before, one).map((d) => d.fact)).toEqual([
      { k: 'firmware', device: 'AP', from: '6.6.1', to: '6.6.2' },
    ]);
    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [n, '1']));
    const all = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [n, '2']));
    const burst = diffService(
      'UniFi',
      nextServiceState(null, { firmware: many }),
      nextServiceState(null, { firmware: all }),
    );
    expect(burst).toHaveLength(1);
    expect(burst[0]?.fact).toMatchObject({ k: 'firmwares', count: 5, to: '2' });
  });

  it('tells routes added, removed, changed and switched off', () => {
    const before = nextServiceState(null, {
      routes: {
        via: 'proxy',
        map: { 'a.example.com': 'http://10.100.0.1:80', 'b.example.com': 'http://10.100.0.2' },
      },
    });
    const after = nextServiceState(before, {
      routes: {
        via: 'proxy',
        map: { 'a.example.com': 'http://10.100.0.12:80', 'c.example.com': 'off:http://10.100.0.3' },
      },
    });
    const facts = diffService('NPM', before, after).map((d) => d.fact);
    expect(facts).toEqual([
      {
        k: 'route',
        via: 'proxy',
        host: 'a.example.com',
        from: 'http://10.100.0.1:80',
        to: 'http://10.100.0.12:80',
      },
      { k: 'route', via: 'proxy', host: 'b.example.com', from: 'http://10.100.0.2', to: null },
      { k: 'route', via: 'proxy', host: 'c.example.com', from: null, to: 'off:http://10.100.0.3' },
    ]);
  });
});

describe('a server’s changes', () => {
  const read = (over: Partial<Parameters<typeof nextServerState>[1]> = {}) => ({
    os: 'Debian GNU/Linux 13',
    kernel: '6.12.0',
    bootAt: '2026-11-20T03:00:00.000Z',
    updates: 12,
    ...over,
  });

  it('tells a restart with the kernel it came back with, and installed updates', () => {
    const before = nextServerState(null, read());
    expect(diffServer(null, before)).toEqual([]);
    // The boot time worked out from the uptime moves a little between reads: the same boot.
    const jitter = nextServerState(before, read({ bootAt: '2026-11-20T03:00:40.000Z' }));
    expect(diffServer(before, jitter)).toEqual([]);
    const after = nextServerState(
      before,
      read({ kernel: '6.12.1', bootAt: '2026-11-27T02:10:00.000Z', updates: 0 }),
    );
    expect(diffServer(before, after).map((d) => d.fact)).toEqual([
      { k: 'restart', kernel: '6.12.1' },
      { k: 'packages', count: 12 },
    ]);
  });

  it('tells installed updates only when none are left waiting, not when the count only fell', () => {
    const before = nextServerState(null, read({ updates: 12 }));
    const refreshed = nextServerState(before, read({ updates: 9 }));
    expect(diffServer(before, refreshed)).toEqual([]);
    expect(
      diffServer(refreshed, nextServerState(refreshed, read({ updates: 0 }))).map((d) => d.fact),
    ).toEqual([{ k: 'packages', count: 9 }]);
    const none = nextServerState(null, read({ updates: 0 }));
    expect(diffServer(none, nextServerState(none, read({ updates: 0 })))).toEqual([]);
  });

  it('doesn’t tell updates that appear, and tells a new system version', () => {
    const before = nextServerState(null, read({ updates: 0 }));
    const after = nextServerState(before, read({ updates: 5, os: 'Debian GNU/Linux 13.1' }));
    expect(diffServer(before, after).map((d) => d.fact)).toEqual([
      { k: 'os', from: 'Debian GNU/Linux 13', to: 'Debian GNU/Linux 13.1' },
    ]);
  });
});

describe('containers’ images', () => {
  it('tells another tag, and the same tag with another image when the ids are known', () => {
    const before = containerState([
      { name: 'web', image: 'nginx:1.27', imageId: 'sha256:aaaaaaaaaaaa1111' },
      { name: 'db', image: 'postgres:17', imageId: 'sha256:bbbbbbbbbbbb2222' },
      { name: 'old', image: 'redis' },
    ]);
    const after = containerState([
      { name: 'web', image: 'nginx:1.28', imageId: 'sha256:cccccccccccc3333' },
      { name: 'db', image: 'postgres:17', imageId: 'sha256:dddddddddddd4444' },
      { name: 'old', image: 'redis' },
      { name: 'new', image: 'grafana/grafana' },
    ]);
    expect(diffContainers(before, after).map((d) => d.fact)).toEqual([
      { k: 'image', name: 'web', from: 'nginx:1.27', to: 'nginx:1.28' },
      { k: 'image', name: 'db', from: 'postgres:17', to: 'postgres:17' },
    ]);
  });

  it('doesn’t tell an id that an older agent didn’t report', () => {
    const before = containerState([{ name: 'web', image: 'nginx' }]);
    const after = containerState([{ name: 'web', image: 'nginx', imageId: 'sha256:cccccccccccc3333' }]);
    expect(diffContainers(before, after)).toEqual([]);
  });
});

describe('a burst of the same item', () => {
  it('merges into one change, or goes when it was undone', () => {
    const a = { k: 'version' as const, name: 'Immich', from: '2.3', to: '2.4' };
    expect(mergeFacts(a, { ...a, from: '2.4', to: '2.5' })).toEqual({ ...a, to: '2.5' });
    expect(mergeFacts(a, { ...a, from: '2.4', to: '2.3' })).toBe('gone');
    expect(mergeFacts({ k: 'packages', count: 3 }, { k: 'packages', count: 2 })).toEqual({
      k: 'packages',
      count: 5,
    });
    expect(mergeFacts(a, { k: 'kernel', to: '6.12' })).toBeNull();
  });

  it('keeps two new images pulled under the same tag as one change', () => {
    const pull = { k: 'image' as const, name: 'app', from: 'app:latest', to: 'app:latest' };
    expect(mergeFacts(pull, pull)).toEqual(pull);
    const tag = { k: 'image' as const, name: 'app', from: 'app:1', to: 'app:latest' };
    expect(mergeFacts(tag, pull)).toEqual({ ...pull, from: 'app:1' });
    expect(mergeFacts(tag, { ...tag, from: 'app:latest', to: 'app:1' })).toBe('gone');
  });
});
