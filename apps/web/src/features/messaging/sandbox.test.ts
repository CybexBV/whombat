import { describe, expect, it } from 'vitest';
import {
  type DiagramTheme,
  escapeHtml,
  FRAME_MAX_HEIGHT,
  FRAME_MIN_HEIGHT,
  frameHeight,
  frameReady,
  htmlFileName,
  mermaidDocument,
  SANDBOX_FLAGS,
} from './sandbox';

const THEME: DiagramTheme = {
  dark: false,
  background: '#fffdf9',
  node: '#f1ece4',
  text: '#221d18',
  line: '#6e655c',
  accent: '#7d6353',
  secondary: '#ece5da',
  font: '"Bricolage Grotesque", system-ui, sans-serif',
};

describe('the preview frame protocol (AP-320)', () => {
  it('gives the frame scripts and nothing else', () => {
    expect(SANDBOX_FLAGS).toBe('allow-scripts');
  });

  it('knows the frame’s readiness (AP-5348)', () => {
    expect(frameReady({ type: 'whombat.ready' })).toBe(true);
    for (const junk of [null, 'whombat.ready', { type: 'whombat.height', height: 9 }])
      expect(frameReady(junk)).toBe(false);
  });

  it('reads only height reports, clamped to the message’s limits', () => {
    expect(frameHeight({ type: 'whombat.height', height: 412.2 })).toBe(413);
    expect(frameHeight({ type: 'whombat.height', height: 12 })).toBe(FRAME_MIN_HEIGHT);
    expect(frameHeight({ type: 'whombat.height', height: 1e9 })).toBe(FRAME_MAX_HEIGHT);
    expect(frameHeight({ type: 'whombat.height', height: 90 }, 80, 900)).toBe(90);
    for (const junk of [
      null,
      'x',
      { type: 'whombat.html', html: '' },
      { type: 'whombat.height', height: '9' },
    ])
      expect(frameHeight(junk)).toBeNull();
    expect(frameHeight({ type: 'whombat.height', height: Number.NaN })).toBeNull();
    expect(frameHeight({ type: 'whombat.height', height: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('names downloads after the page title', () => {
    expect(htmlFileName('Burrow Billing — logo')).toBe('burrow-billing-logo.html');
    expect(htmlFileName('Café  Crème!')).toBe('cafe-creme.html');
    expect(htmlFileName(null)).toBe('page.html');
    expect(htmlFileName('???')).toBe('page.html');
  });
});

describe('mermaidDocument (AP-323)', () => {
  it('escapes the source, loads the runtime from this origin and starts in strict mode', () => {
    const doc = mermaidDocument(
      'graph TD\n  A["</pre><script>alert(1)</script>"] --> B',
      'http://localhost/assets/mermaid.js',
      THEME,
    );
    expect(doc).toContain(escapeHtml('A["</pre><script>alert(1)</script>"]'));
    expect(doc).not.toContain('<script>alert(1)');
    expect(doc).toContain('<script src="http://localhost/assets/mermaid.js"></script>');
    expect(doc).toContain('"securityLevel":"strict"');
    expect(doc).toContain('"startOnLoad":false');
    expect(doc).toContain('"primaryTextColor":"#221d18"');
  });

  it('keeps theme values from closing the style or script they sit in', () => {
    const doc = mermaidDocument('graph TD; A', '/m.js', {
      ...THEME,
      text: 'red</style><script>x()</script>',
    });
    expect(doc.match(/<\/style>/g)).toHaveLength(1);
    expect(doc).not.toContain('<script>x()');
  });
});

describe('the bundled Mermaid runtime', () => {
  it('shows the source when the runtime can’t load', () => {
    const doc = mermaidDocument('graph TD; A', '/missing.js', THEME);
    expect(doc).toContain("typeof mermaid==='undefined'");
    expect(doc).toContain("classList.add('source')");
  });
});
