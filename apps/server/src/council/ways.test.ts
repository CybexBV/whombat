import { describe, expect, it } from 'vitest';
import { councilWays, setCouncilWays } from './ways';

describe('where the builder sends its pictures', () => {
  it('puts the address on T3 Code’s own network first', () => {
    const owner = {};
    setCouncilWays(owner, () => [
      { way: 'lan', web: 'http://192.168.1.20:4480/' },
      { way: 'lan', web: 'http://10.100.0.40:4480/' },
      { way: 'tailscale', web: 'https://home.tail1234.ts.net:4480/' },
    ]);
    expect(councilWays(owner, 'http://10.100.0.235:3773')).toEqual([
      'http://10.100.0.40:4480',
      'http://192.168.1.20:4480',
      'https://home.tail1234.ts.net:4480',
    ]);
    expect(councilWays(owner, 'http://thetitan.tail1234.ts.net:3773')[0]).toBe(
      'https://home.tail1234.ts.net:4480',
    );
  });

  it('has none where the box gave none', () => {
    expect(councilWays({}, 'http://10.0.0.1:3773')).toEqual([]);
  });
});
