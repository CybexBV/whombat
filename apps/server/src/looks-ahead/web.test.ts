/**
 * Looks ahead's web (docs/decisions/looks-ahead.md): a search on the person's key, a page read as text with its links,
 * and the rule that a check reads only links it saw.
 */
import { AHEAD_PAGES_MAX, AHEAD_SEARCHES_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services';
import { forgetSeen, linksIn, sawLink, sawLinks, seenOf, takePage, takeSearch } from './seen';
import {
  braveSearch,
  httpUrl,
  pageLinks,
  readPage,
  useAheadWebForTests,
  type WebAnswer,
  WebRefusal,
} from './web';

function fakeServices(answer: (url: string, headers: Record<string, string>) => WebAnswer) {
  const services = {
    config: { NODE_ENV: 'test' },
    clock: () => new Date('2026-12-13T15:00:00Z'),
  } as unknown as Services;
  const asked: { url: string; headers: Record<string, string> }[] = [];
  useAheadWebForTests(services, async (url, headers) => {
    asked.push({ url, headers });
    return answer(url, headers);
  });
  return { services, asked };
}

const html = (body: string, status = 200, headers: Record<string, string> = {}): WebAnswer => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body: Buffer.from(body),
});

describe('links', () => {
  it('keeps http(s) links, absolute, without their fragment', () => {
    expect(httpUrl('/tickets#top', 'https://example.com/a/')).toBe('https://example.com/tickets');
    expect(httpUrl('javascript:alert(1)')).toBeNull();
    expect(httpUrl('mailto:someone@example.com')).toBeNull();
    expect(
      pageLinks(
        '<a href="/x">x</a><a href=\'https://example.org/y\'>y</a><a href="#z">z</a>',
        'https://example.com/',
      ),
    ).toEqual(['https://example.com/x', 'https://example.org/y']);
    expect(linksIn('Tickets: https://tickets.example.com/order/1. Doors at 19:00')).toEqual([
      'https://tickets.example.com/order/1',
    ]);
  });
});

describe('what a check has seen', () => {
  it('starts with the event’s links, adds what it found, and reads nothing it made up', () => {
    const { services } = fakeServices(() => html(''));
    const seen = seenOf(services, 'dsp_1', () => 'Ziggo Dome https://example.com/event');
    expect(sawLink(seen, 'https://example.com/event')).toBe(true);
    expect(sawLink(seen, 'https://example.com/event?who=john')).toBe(false);
    sawLinks(seen, ['https://example.org/news/']);
    expect(sawLink(seen, 'https://example.org/news')).toBe(true);
    forgetSeen(services, 'dsp_1');
    expect(
      sawLink(
        seenOf(services, 'dsp_1', () => ''),
        'https://example.com/event',
      ),
    ).toBe(false);
  });

  it('counts its searches and pages', () => {
    const { services } = fakeServices(() => html(''));
    const seen = seenOf(services, 'dsp_2', () => '');
    for (let i = 0; i < AHEAD_SEARCHES_MAX; i++) expect(takeSearch(seen)).toBe(true);
    expect(takeSearch(seen)).toBe(false);
    for (let i = 0; i < AHEAD_PAGES_MAX; i++) expect(takePage(seen)).toBe(true);
    expect(takePage(seen)).toBe(false);
  });
});

describe('the search and the page', () => {
  it('searches Brave with the key in its header only, and gives titles, links and snippets', async () => {
    const { services, asked } = fakeServices(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'The Script <b>live</b>',
                url: 'https://example.com/the-script',
                description: 'Doors 19:00',
              },
              { title: 'Not a page', url: 'ftp://example.com/x', description: '' },
            ],
          },
        }),
      ),
    }));
    const results = await braveSearch(services, 'brave-key', 'The Script Ziggo Dome 14 December');
    expect(results).toEqual([
      { title: 'The Script live', url: 'https://example.com/the-script', snippet: 'Doors 19:00' },
    ]);
    expect(asked[0]?.url).toContain('q=The+Script+Ziggo+Dome+14+December');
    expect(asked[0]?.url).not.toContain('brave-key');
    expect(asked[0]?.headers['X-Subscription-Token']).toBe('brave-key');
  });

  it('says when the key has no searches left', async () => {
    const { services } = fakeServices(() => ({ status: 429, headers: {}, body: Buffer.from('') }));
    await expect(braveSearch(services, 'k', 'x y')).rejects.toBeInstanceOf(WebRefusal);
  });

  it('reads a page as text with its links, following a redirect on the same site', async () => {
    const { services } = fakeServices((url) =>
      url === 'http://example.com/event'
        ? html('', 301, { location: 'https://example.com/event' })
        : html(
            '<html><head><title>The Script</title><script>x()</script></head><body><p>Starts 20:45</p><a href="/tickets">Tickets</a></body></html>',
          ),
    );
    const page = await readPage(services, 'http://example.com/event', () => false);
    expect(page).toMatchObject({ url: 'https://example.com/event', title: 'The Script' });
    expect(page.text).toContain('Starts 20:45');
    expect(page.text).not.toContain('x()');
    expect(page.links).toEqual(['https://example.com/tickets']);
  });

  it('won’t follow a redirect to a site the check hasn’t seen', async () => {
    const { services } = fakeServices(() => html('', 302, { location: 'https://elsewhere.example.net/' }));
    await expect(readPage(services, 'https://example.com/', () => false)).rejects.toThrow('another site');
  });

  it('refuses pictures and files', async () => {
    const { services } = fakeServices(() => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([0x89, 0x50]),
    }));
    await expect(readPage(services, 'https://example.com/a.png', () => true)).rejects.toBeInstanceOf(
      WebRefusal,
    );
  });
});
