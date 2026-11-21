import { describe, expect, it } from 'vitest';
import { sheetOffersButtons } from './needsYou';

const listed = [{ id: 'apr:12' }, { id: 'look:nas' }];

describe('an item’s sheet', () => {
  it('offers its buttons while the Inbox lists the item', () => {
    expect(sheetOffersButtons('apr:12', listed, false)).toBe(true);
  });

  it('offers nothing more once the item left: an answer that may have gone through is never sent again', () => {
    expect(sheetOffersButtons('apr:13', listed, false)).toBe(false);
  });

  it('keeps them while a button is on its way, or before the Inbox is read', () => {
    expect(sheetOffersButtons('apr:13', listed, true)).toBe(true);
    expect(sheetOffersButtons('apr:13', undefined, false)).toBe(true);
  });
});
