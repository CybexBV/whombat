import { describe, expect, it } from 'vitest';
import { layoutThreads } from './layout';

describe('layoutThreads', () => {
  it('keeps a thread level with its block when there is room, and puts lost anchors last', () => {
    const { placed } = layoutThreads([
      { id: 'lost', anchorPos: null, anchorTop: null, height: 80 },
      { id: 'low', anchorPos: 2000, anchorTop: 1200, height: 100 },
      { id: 'high', anchorPos: 100, anchorTop: 340, height: 100 },
    ]);
    expect(placed).toEqual([
      { id: 'high', top: 340 },
      { id: 'low', top: 1200 },
      { id: 'lost', top: 1316 },
    ]);
  });
});
