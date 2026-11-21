import { describe, expect, it } from 'vitest';
import { inOrder, statusOrder } from './statusOrder';

type Item = { id: string; level: 'notWorking' | 'needsLook' | 'learning' | 'connected' };
const id = (i: Item) => i.id;
const level = (i: Item) => i.level;

describe('statusOrder', () => {
  it('sorts worst first when the list loads, keeping the order within a level', () => {
    const items: Item[] = [
      { id: 'a', level: 'connected' },
      { id: 'b', level: 'needsLook' },
      { id: 'c', level: 'notWorking' },
      { id: 'd', level: 'needsLook' },
    ];
    expect(statusOrder(items, id, level, null)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('keeps the order through a live update: new at the end, gone dropped', () => {
    const kept = ['c', 'b', 'd', 'a'];
    const items: Item[] = [
      { id: 'a', level: 'notWorking' },
      { id: 'b', level: 'connected' },
      { id: 'e', level: 'notWorking' },
      { id: 'c', level: 'connected' },
    ];
    expect(statusOrder(items, id, level, kept)).toEqual(['c', 'b', 'a', 'e']);
  });

  it('puts items in that order', () => {
    const items: Item[] = [
      { id: 'a', level: 'connected' },
      { id: 'b', level: 'connected' },
      { id: 'z', level: 'connected' },
    ];
    expect(inOrder(items, id, ['b', 'a']).map(id)).toEqual(['b', 'a', 'z']);
  });
});
