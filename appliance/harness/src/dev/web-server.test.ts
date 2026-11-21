import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'web-server-'));

describe('hosted UI web server (IN-48, Whombat AG-14/MR-65)', () => {
  it('serves the app shell on /connect/google and never prints the query string', async () => {
    const dist = tmp();
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
    writeFileSync(join(dist, '_headers'), '/*\n  Referrer-Policy: no-referrer\n');
    mkdirSync(join(dist, 'assets'));
    mkdirSync(join(dist, '.well-known'));
    writeFileSync(join(dist, '.well-known', 'apple-app-site-association'), '{"webcredentials":{"apps":[]}}');
    const child = spawn(process.execPath, [join(import.meta.dirname, 'web-server.ts'), dist, '0'], {
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
      const code = '4/0AVGzR1secret-authorization-code';
      const state = 'oas_secret-state-value';
      const q = `code=${encodeURIComponent(code)}&state=${state}&scope=email`;
      const shell = await fetch(`http://127.0.0.1:${port}/connect/google?${q}`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await shell.text()).toContain('shell');
      // The iPhone app's associated-domains file has no extension and is JSON all the same.
      const aasa = await fetch(`http://127.0.0.1:${port}/.well-known/apple-app-site-association`);
      expect(aasa.status).toBe(200);
      expect(aasa.headers.get('content-type')).toBe('application/json');
      expect(await aasa.json()).toEqual({ webcredentials: { apps: [] } });
      // A missing asset and a malformed path go the other ways, still without a word.
      expect((await fetch(`http://127.0.0.1:${port}/assets/x.js?${q}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/%E0%A4%A?${q}`)).status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${port}/connect/google?${q}`, { method: 'POST' })).status).toBe(
        405,
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(out).not.toContain('secret');
      expect(out.trim().split('\n')).toHaveLength(1);
    } finally {
      child.kill();
    }
  });

  it('applies a path block of `_headers` to its files, replacing the `/*` value of the same header (IN-122)', async () => {
    const dist = tmp();
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
    mkdirSync(join(dist, 'sandbox'));
    writeFileSync(join(dist, 'sandbox', 'html-frame.html'), '<!doctype html><title>frame</title>');
    writeFileSync(
      join(dist, '_headers'),
      [
        '/*',
        "  Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
        '  Referrer-Policy: no-referrer',
        '/sandbox/*',
        "  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'",
        '',
      ].join('\n'),
    );
    const child = spawn(process.execPath, [join(import.meta.dirname, 'web-server.ts'), dist, '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
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
      const frame = await fetch(`http://127.0.0.1:${port}/sandbox/html-frame.html`);
      expect(frame.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
      expect(frame.headers.get('content-security-policy')).not.toContain("frame-ancestors 'none'");
      expect(frame.headers.get('referrer-policy')).toBe('no-referrer');
      // A client-side route under the prefix is the app shell: the `/*` headers only.
      const shell = await fetch(`http://127.0.0.1:${port}/sandbox/nothing-here`);
      expect(await shell.text()).toContain('shell');
      expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect((await fetch(`http://127.0.0.1:${port}/chat`)).headers.get('content-security-policy')).toContain(
        "frame-ancestors 'none'",
      );
    } finally {
      child.kill();
    }
  });
});
