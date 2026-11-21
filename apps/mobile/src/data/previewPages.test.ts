import { describe, expect, it } from 'vitest';
import { KEPT_PAGES, keepPageHeight, keptPage, keptPageHeight } from './previewPages';

describe('the chat’s kept pages', () => {
  it('builds a page once per key and keeps the few asked for last', () => {
    let built = 0;
    const make = (key: string) => () => {
      built++;
      return `page ${key}`;
    };
    expect(keptPage('a', make('a'))).toBe('page a');
    expect(keptPage('a', make('a'))).toBe('page a');
    expect(built).toBe(1);
    for (let i = 0; i < KEPT_PAGES; i++) keptPage(`other ${i}`, make(String(i)));
    // `a` was asked for least recently: built again.
    keptPage('a', make('a'));
    expect(built).toBe(KEPT_PAGES + 2);
  });

  it('remembers the height a page said last', () => {
    expect(keptPageHeight('diagram')).toBeUndefined();
    keepPageHeight('diagram', 420);
    keepPageHeight('diagram', 480);
    expect(keptPageHeight('diagram')).toBe(480);
  });
});
