import { describe, expect, it } from 'vitest';
import { type DiagramTheme, mermaidDocument, mermaidDocumentWith, mermaidScriptElement } from './mermaid';

const THEME: DiagramTheme = {
  dark: false,
  background: '#fff',
  node: '#eee',
  text: '#111',
  line: '#777',
  accent: '#a50',
  secondary: '#ddd',
  font: 'sans-serif',
};

describe('a diagram page with its runtime element made once', () => {
  it('is the same page as made in one go', () => {
    const url = 'data:application/javascript;base64,QUJD';
    expect(mermaidDocumentWith('graph TD; A', mermaidScriptElement(url), THEME)).toBe(
      mermaidDocument('graph TD; A', url, THEME),
    );
  });

  it('escapes the runtime’s address in its element', () => {
    expect(mermaidScriptElement('/m.js?a="b"&c')).toBe('<script src="/m.js?a=&quot;b&quot;&amp;c"></script>');
  });
});
