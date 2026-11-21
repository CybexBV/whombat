import { describe, expect, it } from 'vitest';
import { tabBarFit } from './tabBarFit';

describe('tabBarFit', () => {
  it.each([
    // Pixel 9, iPhone 17, iPhone 16 and 14: the usual margins and 11 px.
    [412, { margin: 10, size: 11 }],
    [402, { margin: 10, size: 11 }],
    [393, { margin: 10, size: 11 }],
    [390, { margin: 10, size: 11 }],
    // A little narrower: the margins give way first.
    [384, { margin: 4, size: 11 }],
    // iPhone mini or SE, Galaxy S: narrower margins and smaller words.
    [375, { margin: 4, size: 10.5 }],
    [360, { margin: 4, size: 10.5 }],
  ])('a %d-wide bar of five tabs gets %o', (width, fit) => {
    expect(tabBarFit(width, 5)).toEqual(fit);
  });

  it('keeps four tabs at the usual margins on the narrowest phone', () => {
    expect(tabBarFit(360, 4)).toEqual({ margin: 10, size: 11 });
  });
});
