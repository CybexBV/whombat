/**
 * The integration examples in `examples/feedback/` must keep matching what Whombat generates and what the loader
 * implements: their snippets are the generated ones byte for byte (placeholders for the address and site id), and
 * their scripts use only the `WhombatFeedbackApi` methods, the ready event and the trigger attribute. The e2e suite
 * (`e2e/real`) also loads them against a real server.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  basicSnippet,
  customLauncherSnippet,
  type WhombatFeedbackApi,
  WIDGET_ATTRIBUTES,
  WIDGET_READY_EVENT,
} from '@whombat/core/feedback';
import { describe, expect, it } from 'vitest';

const EXAMPLES = resolve(import.meta.dirname, '../../../examples/feedback');
const PUBLIC_URL = 'https://whombat.example.com';
const SITE = 'fbs_REPLACEwithYourSiteId000';
const read = (file: string) => readFileSync(join(EXAMPLES, file), 'utf8');

const input = { publicUrl: PUBLIC_URL, siteId: SITE, theme: 'auto', position: 'bottom-right' } as const;

/** Every `WhombatFeedback` method an example calls (`feedback.open(`, `WhombatFeedback.setContext(`). */
function apiCalls(source: string): string[] {
  return [...source.matchAll(/\b(?:feedback|WhombatFeedback)\.([A-Za-z]+)\(/g)].map((m) => m[1] as string);
}

const API_METHODS: readonly (keyof WhombatFeedbackApi)[] = [
  'ready',
  'open',
  'close',
  'isOpen',
  'setContext',
  'destroy',
];

describe('examples/feedback', () => {
  it('plain-html and spa paste the generated basic snippet unchanged', () => {
    const snippet = basicSnippet({ ...input, launcher: 'floating', launcherLabel: 'Feedback' });
    expect(read('plain-html/index.html')).toContain(snippet);
    expect(read('spa/index.html')).toContain(snippet);
  });

  it('lumio uses the custom-launcher form of the generated snippet', () => {
    const custom = customLauncherSnippet({ ...input, launcher: 'custom', launcherLabel: 'Feedback' });
    const scriptTag = custom.slice(
      custom.indexOf('<script'),
      custom.indexOf('</script>') + '</script>'.length,
    );
    expect(read('lumio/index.html')).toContain(scriptTag);
    expect(read('lumio/index.html')).toContain(`${WIDGET_ATTRIBUTES.trigger}>Feedback</button>`);
  });

  it('scripts use only the frozen SDK surface', () => {
    for (const file of ['spa/app.js', 'lumio/feedback.js']) {
      const source = read(file);
      const calls = apiCalls(source);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) expect(API_METHODS, `${file}: ${call}`).toContain(call);
      expect(source).toContain(`'${WIDGET_READY_EVENT}'`);
    }
  });

  it('every page allows exactly the Whombat origin for scripts and frames, nothing inline', () => {
    for (const file of ['plain-html/index.html', 'spa/index.html', 'lumio/index.html']) {
      const html = read(file);
      const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
      expect(csp, file).toContain(`script-src 'self' ${PUBLIC_URL};`);
      expect(csp, file).toContain(`frame-src ${PUBLIC_URL};`);
      expect(csp, file).not.toContain('unsafe-inline');
      expect(csp, file).not.toMatch(/connect-src[^;]*whombat/);
      // No inline script or style anywhere.
      expect(html, file).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html, file).not.toMatch(/<style|\sstyle="/);
    }
  });

  it('the Lumio example sends a page name and a request id, never tokens or ids', () => {
    const source = read('lumio/feedback.js');
    expect(source).toMatch(/custom: \{ page: pageName\(location\.pathname\) \}/);
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
