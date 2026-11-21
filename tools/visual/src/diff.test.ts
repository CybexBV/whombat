import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { cropPng, diffPng, maskPng } from './diff';

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) img.data.set(rgba, i * 4);
  return PNG.sync.write(img);
}

describe('cropPng / maskPng', () => {
  it('crops a region, clamped to the image', () => {
    const out = PNG.sync.read(cropPng(solid(10, 10, [1, 2, 3, 255]), { x: 6, y: 2, width: 10, height: 3 }));
    expect([out.width, out.height]).toEqual([4, 3]);
    expect([...out.data.subarray(0, 4)]).toEqual([1, 2, 3, 255]);
  });

  it('masks regions so they stop counting in a diff', () => {
    const a = solid(10, 10, [0, 0, 0, 255]);
    const b = solid(10, 10, [0, 0, 0, 255]);
    const bImg = PNG.sync.read(b);
    bImg.data.set([255, 255, 255, 255], (2 * 10 + 2) * 4);
    const changed = PNG.sync.write(bImg);
    expect(diffPng(a, changed).mismatched).toBe(1);
    const rect = { x: 1, y: 1, width: 3, height: 3 };
    expect(diffPng(maskPng(a, [rect]), maskPng(changed, [rect])).mismatched).toBe(0);
  });
});
