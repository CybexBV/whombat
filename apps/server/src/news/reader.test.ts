import { NEWS_FEED_KEEP_S } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { type OpenDataAnswer, useOpenDataForTests } from '../lib/open-data';
import type { Services } from '../services';
import { findFeed } from './discover';
import { mergeHeadlines, NEWS_READ_WORDS, NEWS_RETRY_MS, NewsReader } from './reader';

const MIN = 60_000;

function world(answer: (url: string) => OpenDataAnswer) {
  let now = Date.parse('2026-11-26T08:00:00Z');
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const services = {
    clock: () => new Date(now),
    log: { warn: () => undefined },
    config: { NODE_ENV: 'test' },
  } as unknown as Services;
  useOpenDataForTests(services, async (url, headers) => {
    asked.push({ url, headers });
    return answer(url);
  });
  return {
    services,
    asked,
    later: (ms: number) => {
      now += ms;
    },
  };
}

const xml = (status: number, body: string, headers: Record<string, string> = {}): OpenDataAnswer => ({
  status,
  headers,
  body: Buffer.from(body),
});
const rss = (...items: [string, string, string][]) =>
  `<rss><channel><title>Site</title>${items
    .map(([t, l, d]) => `<item><title>${t}</title><link>${l}</link><pubDate>${d}</pubDate></item>`)
    .join('')}</channel></rss>`;

const SITE_A = { id: 'nl-nos', name: 'NOS Nieuws', url: 'https://a.example.com/rss' };
const SITE_B = { id: 'own-x', name: 'Example', url: 'https://b.example.com/feed' };

describe('all sites’ headlines together', () => {
  it('come newest first, each once by link and by words', () => {
    const items = (pairs: [string, string, number][]) =>
      pairs.map(([title, link, at]) => ({ title, link, at }));
    const out = mergeHeadlines(
      [
        {
          source: SITE_A,
          items: items([
            ['Storm', 'https://x.example/1', 3],
            ['Same words', 'https://x.example/2', 1],
          ]),
        },
        {
          source: SITE_B,
          items: items([
            ['storm', 'https://y.example/9', 2],
            ['Other', 'https://x.example/1', 4],
            ['Same words', 'https://y.example/3', 5],
          ]),
        },
      ],
      10,
    );
    // “Storm” at x.example/1 is the same link as “Other”; the later “Same words” and “storm” are the same words.
    expect(out.map((h) => [h.source, h.title])).toEqual([
      ['Example', 'Same words'],
      ['Example', 'Other'],
      ['Example', 'storm'],
    ]);
    expect(out[0]?.at).toBe(new Date(5).toISOString());
    expect(
      mergeHeadlines(
        [
          {
            source: SITE_A,
            items: items([
              ['A', 'https://x.example/a', 1],
              ['B', 'https://x.example/b', 2],
            ]),
          },
        ],
        1,
      ),
    ).toHaveLength(1);
  });
});

describe('the news reader', () => {
  it('reads each site as Whombat, keeps it 15 minutes, then reads it again', async () => {
    const w = world(() =>
      xml(200, rss(['Storm', 'https://a.example.com/1', 'Thu, 26 Nov 2026 07:00:00 GMT'])),
    );
    const reader = new NewsReader(w.services);
    const [first] = await reader.read([SITE_A]);
    expect(first).toMatchObject({ ok: true, items: [{ title: 'Storm' }] });
    expect(w.asked[0]?.headers['user-agent']).toMatch(/^Whombat\//);
    expect(w.asked[0]?.headers.accept).toMatch(/rss\+xml/);
    await reader.read([SITE_A]);
    expect(w.asked).toHaveLength(1);
    w.later(NEWS_FEED_KEEP_S * 1000);
    await reader.read([SITE_A]);
    expect(w.asked).toHaveLength(2);
  });

  it('keeps what a site had when it fails, says why, and tries again after 5 minutes', async () => {
    let answer = xml(200, rss(['Storm', 'https://a.example.com/1', 'Thu, 26 Nov 2026 07:00:00 GMT']));
    const w = world(() => answer);
    const reader = new NewsReader(w.services);
    await reader.read([SITE_A]);
    answer = xml(301, '', { location: 'https://a.example.com/new' });
    w.later(NEWS_FEED_KEEP_S * 1000);
    const [moved] = await reader.read([SITE_A]);
    expect(moved).toMatchObject({ ok: false, items: [{ title: 'Storm' }] });
    expect(reader.problemOf(SITE_A.url)).toBe(NEWS_READ_WORDS.moved);
    // No redirect followed.
    expect(w.asked.map((a) => a.url)).toEqual([SITE_A.url, SITE_A.url]);
    answer = xml(200, '<html>not a feed</html>');
    w.later(NEWS_RETRY_MS - MIN);
    await reader.read([SITE_A]);
    expect(w.asked).toHaveLength(2);
    w.later(2 * MIN);
    await reader.read([SITE_A]);
    expect(reader.problemOf(SITE_A.url)).toBe(NEWS_READ_WORDS.notFeed);
    expect(reader.problemOf('https://never.example.com/')).toBeNull();
  });
});

describe('adding a news site', () => {
  const page = `<html><head><title>Example News</title><link rel="alternate" type="application/rss+xml" href="/rss"></head></html>`;
  const feed = rss(['Storm', 'https://example.com/1', 'Thu, 26 Nov 2026 07:00:00 GMT']);

  it('takes a feed as it is, and a page by the feed it names, https put in front', async () => {
    const w = world((url) =>
      url === 'https://example.com/'
        ? xml(301, '', { location: 'https://www.example.com/' })
        : url === 'https://www.example.com/'
          ? xml(200, page)
          : url === 'https://www.example.com/rss'
            ? xml(200, feed)
            : xml(404, ''),
    );
    expect(await findFeed(w.services, 'example.com')).toEqual({
      url: 'https://www.example.com/rss',
      name: 'Site',
    });
    expect(await findFeed(w.services, 'https://www.example.com/rss')).toEqual({
      url: 'https://www.example.com/rss',
      name: 'Site',
    });
  });

  it('refuses what isn’t a feed, http, and a redirect away from https', async () => {
    const w = world((url) =>
      url === 'https://plain.example.com/'
        ? xml(200, '<html><head><title>No feed</title></head></html>')
        : url === 'https://down.example.com/'
          ? xml(302, '', { location: 'http://down.example.com/' })
          : xml(500, ''),
    );
    const refusal = (typed: string) =>
      findFeed(w.services, typed).then(
        () => null,
        (err: { code: string; extra: { fields?: Record<string, string[]> } }) => [
          err.code,
          Object.keys(err.extra.fields ?? {}),
        ],
      );
    expect(await refusal('https://plain.example.com/')).toEqual(['validation_failed', ['url']]);
    expect(await refusal('http://plain.example.com/')).toEqual(['validation_failed', ['url']]);
    expect(await refusal('https://down.example.com/')).toEqual(['validation_failed', ['url']]);
    expect(await refusal('https://gone.example.com/')).toEqual(['validation_failed', ['url']]);
    // http was refused before anything was sent.
    expect(w.asked.some((a) => a.url.startsWith('http:'))).toBe(false);
  });
});
