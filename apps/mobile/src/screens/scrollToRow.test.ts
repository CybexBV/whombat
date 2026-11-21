import { describe, expect, it, vi } from 'vitest';
import { type RowList, scrollToRow } from './scrollToRow';

const listOf = (rows: number, scrollToIndex: RowList['scrollToIndex'] = vi.fn()) => ({
  props: { data: Array.from({ length: rows }) },
  scrollToIndex,
});

describe('scrollToRow', () => {
  it('scrolls to a row the list has', () => {
    const list = listOf(5);
    expect(scrollToRow(list, { index: 4, viewPosition: 0.3, animated: false })).toBe(true);
    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 4, viewPosition: 0.3, animated: false });
  });

  it('skips a row the list no longer has', () => {
    const list = listOf(5);
    expect(scrollToRow(list, { index: 5 })).toBe(false);
    expect(scrollToRow(list, { index: -1 })).toBe(false);
    expect(scrollToRow(listOf(0), { index: 0 })).toBe(false);
    expect(scrollToRow({ props: {}, scrollToIndex: list.scrollToIndex }, { index: 0 })).toBe(false);
    expect(scrollToRow(null, { index: 0 })).toBe(false);
    expect(list.scrollToIndex).not.toHaveBeenCalled();
  });

  it('counts the rows when it is called, not when it was planned', () => {
    const list = listOf(5);
    const later = () => scrollToRow(list, { index: 4 });
    list.props.data = Array.from({ length: 2 });
    expect(later()).toBe(false);
  });

  it('keeps a throwing list from ending the app', () => {
    const list = listOf(3, () => {
      throw new Error('scrollToIndex out of range');
    });
    expect(scrollToRow(list, { index: 1 })).toBe(false);
  });
});
