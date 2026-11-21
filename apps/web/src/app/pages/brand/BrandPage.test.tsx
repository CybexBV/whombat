import { describe, expect, it } from 'vitest';
import { brandAsset } from './brandAssets';

describe('/brand', () => {
  it('refuses a path outside the package', () => {
    expect(() => brandAsset('svg/nope.svg')).toThrow('no brand asset svg/nope.svg');
  });
});
