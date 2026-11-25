/**
 * Looks ahead's web (docs/decisions/looks-ahead.md): a search on the person's key, a page read as text with its links,
 * and the rule that a check reads only links it saw.
 */
import { AHEAD_PAGES_MAX, AHEAD_SEARCHES_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services';
import { findingWords } from './commands';
import {
  forgetSeen,
  sawLink,
  sawLinks,
  sawSource,
  sawSourceOf,
  seenOf,
  takePage,
  takeSearch,
  webClosed,
} from './seen';
import { senderName } from './turn';
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
  });
});

describe('what a check has seen', () => {
  it('reads only links it found, names only pages it read or found, and closes the web once it read mail', () => {
    const { services } = fakeServices(() => html(''));
    const seen = seenOf(services, 'dsp_1');
    expect(sawLink(seen, 'https://example.com/event')).toBe(false);
    sawLinks(seen, ['https://example.org/news/']);
    expect(sawLink(seen, 'https://example.org/news')).toBe(true);
    expect(sawLink(seen, 'https://example.org/news?who=john')).toBe(false);
    // A link it only saw is no source; a page it read is.
    expect(sawSourceOf(seen, 'https://example.org/news')).toBe(false);
    sawSource(seen, 'https://example.org/news');
    expect(sawSourceOf(seen, 'https://example.org/news/')).toBe(true);
    expect(webClosed(services, seen, services.clock())).toBe(false);
    seen.mailRead = true;
    expect(webClosed(services, seen, services.clock())).toBe(true);
    // A check begun before this server started may have read mail it doesn't know of.
    expect(webClosed(services, seenOf(services, 'dsp_3'), new Date(0))).toBe(true);
    forgetSeen(services, 'dsp_1');
    expect(sawLink(seenOf(services, 'dsp_1'), 'https://example.org/news')).toBe(false);
  });

  it('counts its searches and pages', () => {
    const { services } = fakeServices(() => html(''));
    const seen = seenOf(services, 'dsp_2');
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

  it('reads a page as text with its links, over https, following a redirect on the same site', async () => {
    const { services, asked } = fakeServices((url) =>
      url === 'https://example.com/old'
        ? html('', 301, { location: 'http://example.com/event' })
        : html(
            '<html><head><title>The Script</title><script>x()</script></head><body><p>Starts 20:45</p><a href="/tickets">Tickets</a></body></html>',
          ),
    );
    const page = await readPage(services, 'http://example.com/old', () => false);
    expect(asked.map((a) => a.url)).toEqual(['https://example.com/old', 'https://example.com/event']);
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

describe('what a finding may show', () => {
  it('the assistant’s words carry no link or picture, however they are spelt', () => {
    const words = findingWords(
      'It starts at **20:45**. See [here](https://evil.example.net/a) ![x](https://evil.example.net/p.png) ht*tps://evil.example.net/b www.evil.example.net mailto:a@b.example <b>bold</b>',
    );
    expect(words).toContain('It starts at 20:45.');
    expect(words).not.toMatch(/https?:|mailto:|www\.|evil/);
    expect(words).not.toMatch(/[[\]<>*]/);
    const phishing = findingWords(
      'Rebook at ziggodome-tickets.example.com or call 0900 123 4567, or mail help@x.example.',
    );
    expect(phishing).not.toMatch(/ziggodome-tickets|0900|123 4567|help@/);
    expect(findingWords('It starts at 20:45 on 14 December, not 20:00.')).toBe(
      'It starts at 20:45 on 14 December, not 20:00.',
    );
  });

  it('a mail is named by the site of its sender’s address, never by the name a sender chose', () => {
    expect(senderName('"Ticketmaster" <noreply@ticketmaster.example>')).toBe('ticketmaster.example');
    expect(senderName('"Ticketmaster – rebook at https://tm-rebook.example" <x@tm-rebook.example>')).toBe(
      'tm-rebook.example',
    );
    expect(senderName('noreply@ticketmaster.example')).toBe('ticketmaster.example');
    expect(senderName('Ticketmaster')).toBe('mail');
  });
});
