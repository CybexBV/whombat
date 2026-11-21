import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headersFor, parseHeadersFile } from './headers-file.ts';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'embed-server-'));

/** The shape of whombat-app's `dist-embed/_headers` (FD-46). */
const HEADERS = `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src http://127.0.0.1:4600; frame-ancestors *
  Cross-Origin-Resource-Policy: cross-origin
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
/embed/v1/widget.js
  Cache-Control: public, max-age=300
/embed/v1/frame.html
  Cache-Control: public, max-age=300
/embed/v1/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

describe('_headers (FD-46)', () => {
  it('applies every matching block in order, prefixes and exact paths, and detaches with !', () => {
    const blocks = parseHeadersFile(`${HEADERS}/embed/v1/frame.html\n  ! Referrer-Policy\n  X-Extra: 1\n`);
    expect(headersFor(blocks, '/embed/v1/widget.js')).toMatchObject({
      'cache-control': 'public, max-age=300',
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(headersFor(blocks, '/embed/v1/assets/frame.abc.js')['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    const frame = headersFor(blocks, '/embed/v1/frame.html');
    expect(frame['referrer-policy']).toBeUndefined();
    expect(frame['x-extra']).toBe('1');
    expect(frame['content-security-policy']).toContain('frame-ancestors *');
    expect(headersFor(blocks, '/embed/v1/widget.jsx')['cache-control']).toBeUndefined();
  });
});

describe('embed server (IN-54)', () => {
  it('serves files with their headers, 404s everything else and prints only its listen line', async () => {
    const dist = tmp();
    writeFileSync(join(dist, '_headers'), HEADERS);
    mkdirSync(join(dist, 'embed/v1/assets'), { recursive: true });
    writeFileSync(join(dist, 'embed/v1/widget.js'), '/* loader */');
    writeFileSync(join(dist, 'embed/v1/frame.html'), '<!doctype html><title>frame</title>');
    writeFileSync(join(dist, 'embed/v1/assets/frame.0123.js'), '/* frame */');
    const child = spawn(process.execPath, [join(import.meta.dirname, 'embed-server.ts'), dist, '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 10_000);
        child.stdout.on('data', () => {
          const m = /on 127\.0\.0\.1:(\d+)/.exec(out);
          if (m?.[1]) {
            clearTimeout(t);
            resolve(Number(m[1]));
          }
        });
      });
      const base = `http://127.0.0.1:${port}`;
      const q = '?page=https%3A%2F%2Fcustomer.example%2Fsecret-page';
      const widget = await fetch(`${base}/embed/v1/widget.js${q}`);
      expect(widget.status).toBe(200);
      expect(widget.headers.get('content-type')).toContain('text/javascript');
      expect(widget.headers.get('cache-control')).toBe('public, max-age=300');
      expect(widget.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      const frame = await fetch(`${base}/embed/v1/frame.html`);
      expect(frame.headers.get('content-security-policy')).toContain('frame-ancestors *');
      expect(frame.headers.get('x-frame-options')).toBeNull();
      expect(await frame.text()).toContain('frame');
      const asset = await fetch(`${base}/embed/v1/assets/frame.0123.js`, { method: 'HEAD' });
      expect(asset.headers.get('cache-control')).toContain('immutable');
      for (const p of ['/', '/_headers', '/embed/v1/', '/embed/v1/missing.js', '/index.html', '/../_headers'])
        expect((await fetch(`${base}${p}${q}`)).status, p).toBe(404);
      expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
      expect((await fetch(`${base}/embed/v1/widget.js`, { method: 'POST' })).status).toBe(405);
      await new Promise((r) => setTimeout(r, 200));
      expect(out).not.toContain('secret');
      expect(out.trim().split('\n')).toHaveLength(1);
    } finally {
      child.kill();
    }
  });
});
