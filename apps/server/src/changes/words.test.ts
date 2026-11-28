import { describe, expect, it } from 'vitest';
import { changeWords } from './words';

describe('a change’s words', () => {
  it('names the service, the versions and the host, in English and Dutch', () => {
    const version = { k: 'version' as const, name: 'Immich', from: '2.3.0', to: '2.4.0' };
    expect(changeWords(version)).toContain('2.4.0');
    expect(changeWords(version, 'nl')).toContain('2.4.0');
    expect(changeWords(version, 'nl')).not.toBe(changeWords(version));
    const route = {
      k: 'route' as const,
      via: 'proxy' as const,
      host: 'photos.example.com',
      from: 'http://10.100.0.11:2283',
      to: 'http://10.100.0.12:2283',
    };
    expect(changeWords(route)).toContain('photos.example.com');
    expect(changeWords(route)).toContain('10.100.0.12');
  });

  it('says a route switched off without the mark, and a kernel with the restart', () => {
    const off = changeWords({
      k: 'route',
      via: 'tunnel',
      host: 'a.example.com',
      from: 'http://10.100.0.1',
      to: 'off:http://10.100.0.1',
    });
    expect(off).not.toContain('off:');
    expect(off).toContain('a.example.com');
    expect(changeWords({ k: 'restart', kernel: '6.12.1' })).toContain('6.12.1');
  });

  it('counts the parts of a settings change and keeps to the length', () => {
    const words = changeWords({
      k: 'settings',
      service: 'OPNsense',
      parts: [
        { part: 'filter', added: 2, removed: 0, changed: 1 },
        { part: 'not-a-part', added: 1, removed: 0, changed: 0 },
      ],
    });
    expect(words).toContain('OPNsense');
    expect(words).toContain('2');
    expect(
      changeWords({ k: 'images', names: ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)], count: 9 })
        .length,
    ).toBeLessThanOrEqual(300);
  });
});
