import { describe, expect, it } from 'vitest';
import { PAGE_GUIDE, PAGE_STYLE_ID, PAGE_THEME_VARIABLES, withPageStyle } from './page.js';

describe('withPageStyle', () => {
  it('goes right after a leading doctype', () => {
    const out = withPageStyle('<!-- hi --><!DOCTYPE html><html><body>x</body></html>', 'a{b:c}');
    expect(
      out.startsWith(`<!-- hi --><!DOCTYPE html><style id="${PAGE_STYLE_ID}">a{b:c}</style><html>`),
    ).toBe(true);
  });

  it('gives a fragment a doctype, then goes first', () => {
    expect(withPageStyle('<p>x</p>', 'a{b:c}')).toBe(
      `<!doctype html><style id="${PAGE_STYLE_ID}">a{b:c}</style><p>x</p>`,
    );
  });

  it('can never close its own element', () => {
    expect(withPageStyle('<p>x</p>', 'a{b:"</style><script>"}')).not.toContain('</style><script>');
  });
});

describe('PAGE_GUIDE', () => {
  it('names every theme variable', () => {
    for (const name of PAGE_THEME_VARIABLES) expect(PAGE_GUIDE).toContain(name);
  });
});
