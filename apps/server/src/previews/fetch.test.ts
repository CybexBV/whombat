/**
 * The preview fetch's guard (docs/decisions/essentials-conversations.md EC-19): every refusal happens before a socket
 * is opened (IP literals up front, host names at resolution), so these run without a network. A local page is
 * fetched only with `allowPrivate` (tests and local mocks).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchPreview, previewUrlProblem } from './fetch';

const resolveTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];

describe('previewUrlProblem', () => {
  it('takes http and https on their standard ports only', () => {
    expect(previewUrlProblem('https://example.com/a')).toBeNull();
    expect(previewUrlProblem('http://example.com:80/a')).toBeNull();
    expect(previewUrlProblem('https://example.com:443/a')).toBeNull();
    expect(previewUrlProblem('https://example.com:8443/a')).toMatch(/port 8443/);
    expect(previewUrlProblem('http://example.com:443/a')).toMatch(/port 443/);
    expect(previewUrlProblem('ftp://example.com/a')).toMatch(/ftp/);
    expect(previewUrlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
    expect(previewUrlProblem('nonsense')).toMatch(/not a URL/);
  });
});

describe('fetchPreview refuses what isn’t public', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
  ])('%s', async (url) => {
    const res = await fetchPreview(url);
    expect(res.status).toBe('failed');
    expect(res.status === 'failed' && res.reason).toMatch(/^refused/);
  });

  it('a name that resolves to a private address', async () => {
    for (const address of ['127.0.0.1', '10.0.0.7', '::1', '169.254.169.254']) {
      const res = await fetchPreview('https://innocent.example/', { resolve: resolveTo(address) });
      expect(res).toMatchObject({ status: 'failed' });
      expect(res.status === 'failed' && res.reason).toMatch(/refused.*not a public address/);
    }
  });

  it('a port that isn’t the scheme’s own', async () => {
    const res = await fetchPreview('https://example.com:22/', { resolve: resolveTo('93.184.216.34') });
    expect(res).toMatchObject({ status: 'failed', reason: 'refused: port 22 is not a standard web port' });
  });
});

describe('fetchPreview of a local page (allowPrivate)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><head><meta property="og:title" content="Local page"><meta property="og:site_name" content="Here"></head></html>',
        );
      } else if (req.url === '/hop') {
        res.writeHead(302, { location: '/page' });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/away') {
        res.writeHead(301, { location: 'ftp://files.example/x' });
        res.end();
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"title":"no"}');
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<head><title>Big page</title></head><body>');
        res.end('x'.repeat(2 * 1024 * 1024));
      } else if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<title>late</title>');
        }, 500);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('reads the page and keeps the link as written through redirects', async () => {
    expect(await fetchPreview(`${base}/page`, { allowPrivate: true })).toEqual({
      status: 'ok',
      preview: { url: `${base}/page`, title: 'Local page', description: null, siteName: 'Here' },
    });
    const hopped = await fetchPreview(`${base}/hop`, { allowPrivate: true });
    expect(hopped).toMatchObject({ status: 'ok', preview: { url: `${base}/hop`, title: 'Local page' } });
  });

  it('checks every redirect target and stops after three', async () => {
    expect(await fetchPreview(`${base}/away`, { allowPrivate: true })).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/refused: ftp/),
    });
    expect(await fetchPreview(`${base}/loop`, { allowPrivate: true })).toMatchObject({
      status: 'failed',
      reason: 'more than 3 redirects',
    });
  });

  it('reads only HTML, only the start of a large page, and gives up on time', async () => {
    expect(await fetchPreview(`${base}/json`, { allowPrivate: true })).toMatchObject({ status: 'none' });
    expect(await fetchPreview(`${base}/big`, { allowPrivate: true })).toMatchObject({
      status: 'ok',
      preview: { title: 'Big page' },
    });
    expect(await fetchPreview(`${base}/missing`, { allowPrivate: true })).toMatchObject({
      status: 'failed',
      reason: 'answered 404',
    });
    expect(await fetchPreview(`${base}/slow`, { allowPrivate: true, deadlineMs: 100 })).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/^timeout/),
    });
  });
});
