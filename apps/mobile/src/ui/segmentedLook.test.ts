import { describe, expect, it } from 'vitest';
import { MOST_SEGMENTS, NARROWEST_CONTROL_WIDTH, segmentedLook, segmentLabelWidth } from './segmentedLook';

const labels = (...words: string[]) => words.map((label) => ({ label }));

describe('segmentedLook', () => {
  it('measures the narrowest iPhone (375pt) less its page and part sides', () => {
    expect(NARROWEST_CONTROL_WIDTH).toBe(311);
  });

  it('draws iOS segments when every label fits its share on one line', () => {
    expect(segmentedLook(labels('System', 'Light', 'Dark'))).toBe('segments');
    expect(segmentedLook(labels('Just watch', 'Ask me first', 'Go ahead'))).toBe('segments');
    expect(segmentedLook(labels('Last hour', '24 hours', '7 days', '30 days'))).toBe('segments');
    expect(segmentedLook(labels('1 h', '6 h', '24 h', '7 d', '30 d'))).toBe('segments');
  });

  it('draws iOS’s menu picker when one label would end in “…”', () => {
    expect(segmentedLook(labels('Always', 'When it matters', 'Off'))).toBe('menu');
    expect(segmentedLook(labels('Questions and problems', 'Problems only', 'Nothing'))).toBe('menu');
  });

  it('draws a menu for more than five choices, however short', () => {
    const six = labels('1', '2', '3', '4', '5', '6');
    expect(six).toHaveLength(MOST_SEGMENTS + 1);
    expect(segmentedLook(six)).toBe('menu');
  });

  it('decides on the width it is given', () => {
    const words = labels('Just watch', 'Ask me first', 'Go ahead');
    expect(segmentedLook(words, 420)).toBe('segments');
    expect(segmentedLook(words, 240)).toBe('menu');
  });

  it('counts wide letters wider than narrow ones', () => {
    expect(segmentLabelWidth('MMMM')).toBeGreaterThan(segmentLabelWidth('iiii') * 2);
    expect(segmentLabelWidth('')).toBe(0);
  });
});
