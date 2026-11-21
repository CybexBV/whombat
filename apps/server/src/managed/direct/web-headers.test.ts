/** The direct listener frames only the HTML preview frame, on the app's own pages, under the frame's own policy. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIRECT_HEADERS, headersFor, SANDBOX_POLICY } from './web';

describe('the preview frame on the box’s own page', () => {
  it('may be framed by the app itself, and nothing else on the page may', () => {
    const frame = headersFor('/sandbox/html-frame.html');
    expect(frame['x-frame-options']).toBe('SAMEORIGIN');
    expect(frame['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(frame['content-security-policy']).toContain("connect-src 'none'");
    expect(frame['cross-origin-resource-policy']).toBe('cross-origin');
    expect(headersFor('/sandbox/html-frame.js')['cross-origin-resource-policy']).toBe('cross-origin');
    for (const path of ['/', '/index.html', '/assets/app-1a2b.js', '/sandboxes'])
      expect(headersFor(path)).toBe(DIRECT_HEADERS);
  });

  it('lets the frame load the Mermaid runtime, and no other asset', () => {
    expect(headersFor('/assets/mermaid.min-Ab_12-c.js')['cross-origin-resource-policy']).toBe('cross-origin');
    expect(headersFor('/assets/mermaid.min-Ab12.js')['x-frame-options']).toBe('DENY');
    expect(headersFor('/assets/mermaid-other.js')).toBe(DIRECT_HEADERS);
  });

  it('lets the frame load the page set viewer’s script, and nothing next to it', () => {
    expect(headersFor('/assets/pages-runtime-Ab_12-c.js')['cross-origin-resource-policy']).toBe(
      'cross-origin',
    );
    expect(headersFor('/assets/pages-runtime-Ab12.js')['x-frame-options']).toBe('DENY');
    for (const path of [
      '/assets/pages-runtime.js',
      '/assets/pages-runtime-Ab12.js.map',
      '/pages-runtime-Ab12.js',
    ])
      expect(headersFor(path)).toBe(DIRECT_HEADERS);
  });

  it('uses the policy the frame page carries itself', () => {
    const page = readFileSync(
      new URL('../../../../web/public/sandbox/html-frame.html', import.meta.url),
      'utf8',
    );
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page)?.[1];
    expect(`${meta}; frame-ancestors 'self'`).toBe(SANDBOX_POLICY);
  });
});
