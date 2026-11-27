import { NEWS_FEED_KEEP_S } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  OPEN_DATA_MAX_BYTES,
  type OpenDataAnswer,
  type OpenDataOptions,
  useOpenDataForTests,
} from '../lib/open-data';
import type { Services } from '../services';
import { findFeed } from './discover';
import {
  eachLimited,
  mergeHeadlines,
  NEWS_READ_WORDS,
  NEWS_READS_AT_ONCE,
  NEWS_RETRY_MS,
  NewsReader,
  newsShare,
} from './reader';

const MIN = 60_000;

function world(answer: (url: string) => OpenDataAnswer | Promise<OpenDataAnswer>) {
  let now = Date.parse('2026-11-26T08:00:00Z');
  const asked: { url: string; headers: Record<string, string>; options: OpenDataOptions | undefined }[] = [];
  const services = {
    clock: () => new Date(now),
    log: { warn: () => undefined },
    config: { NODE_ENV: 'test' },
  } as unknown as Services;
  useOpenDataForTests(services, async (url, headers, options) => {
    asked.push({ url, headers, options });
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

describe('thirty sources', () => {
  it('give each source a fair share of a list, and one source all of it', () => {
    const items = (prefix: string, n: number, newest: number) =>
      Array.from({ length: n }, (_, i) => ({
        title: `${prefix} ${i}`,
        link: `https://${prefix}.example/${i}`,
        at: newest - i,
      }));
    const busy = { source: { id: 'own-busy', name: 'Busy' }, items: items('busy', 20, 100) };
    const calm = { source: { id: 'own-calm', name: 'Calm' }, items: items('calm', 3, 50) };
    const out = mergeHeadlines([busy, calm], 6, 3);
    expect(out.map((h) => h.source)).toEqual(['Busy', 'Busy', 'Busy', 'Calm', 'Calm', 'Calm']);
    expect(newsShare(30, 1)).toBe(30);
    expect(newsShare(30, 2)).toBe(15);
    expect(newsShare(30, 30)).toBe(3);
    expect(newsShare(10, 30)).toBe(3);
  });

  it('are read a few at a time, each answer in its place', async () => {
    let running = 0;
    let most = 0;
    const out = await eachLimited(
      Array.from({ length: 30 }, (_, i) => i),
      NEWS_READS_AT_ONCE,
      async (i) => {
        running++;
        most = Math.max(most, running);
        await Promise.resolve();
        running--;
        return i * 2;
      },
    );
    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
    expect(most).toBe(NEWS_READS_AT_ONCE);
  });
});

describe('the news reader', () => {
  it('reads only the first part of a long feed, its newest items', async () => {
    const w = world(() => ({
      ...xml(
        200,
        `<rss><channel><item><title>New</title><link>https://a.example.com/1</link><pubDate>Thu, 26 Nov 2026 07:00:00 GMT</pubDate></item><item><title>Cut sh`,
      ),
      truncated: true,
    }));
    const [read] = await new NewsReader(w.services).read([SITE_A]);
    expect(read).toMatchObject({ ok: true, items: [{ title: 'New' }] });
    expect(w.asked[0]?.options?.keepFirst).toBe(OPEN_DATA_MAX_BYTES);
  });

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
      kind: 'site',
    });
    expect(await findFeed(w.services, 'https://www.example.com/rss')).toEqual({
      url: 'https://www.example.com/rss',
      name: 'Site',
      kind: 'site',
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
