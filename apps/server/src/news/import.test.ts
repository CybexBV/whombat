/**
 * Importing another reader's list (docs/decisions/weather-news.md): each address checked as adding one is, a few at a
 * time and within a time budget; already on and twice in the list pass without a word; the rest are skipped with why,
 * and once the room is used, without being read. The sites answer through the open-data seam.
 */
import {
  NEWS_SOURCES_MAX,
  NEWS_SUGGESTIONS,
  NEWS_WORDS,
  type NewsSource,
  ownNewsSourceId,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { type OpenDataAnswer, useOpenDataForTests } from '../lib/open-data';
import type { Services } from '../services';
import { checkImports, newsSourceOfFeed } from './import';

const rss = (title: string) =>
  `<rss><channel><title>${title}</title><item><title>Story</title><link>https://example.com/1</link><pubDate>Thu, 26 Nov 2026 07:00:00 GMT</pubDate></item></channel></rss>`;
const ok = (body: string): OpenDataAnswer => ({ status: 200, headers: {}, body: Buffer.from(body) });
const FULL = NEWS_WORDS.full.replace('{n}', String(NEWS_SOURCES_MAX));

function world(answer: (url: string) => OpenDataAnswer | Promise<OpenDataAnswer>) {
  const asked: string[] = [];
  const services = {
    clock: () => new Date('2026-11-26T08:00:00Z'),
    log: { warn: () => undefined },
    config: { NODE_ENV: 'test' },
  } as unknown as Services;
  useOpenDataForTests(services, async (url) => {
    asked.push(url);
    return answer(url);
  });
  return { services, asked };
}

const feeds = (url: string): OpenDataAnswer => {
  const name = /^https:\/\/([a-z]+)\.example\.com\/feed$/.exec(url)?.[1];
  return name && name !== 'gone'
    ? ok(rss(`${name} news`))
    : { status: 404, headers: {}, body: Buffer.alloc(0) };
};
const own = (name: string): NewsSource => {
  const url = `https://${name}.example.com/feed`;
  return { id: ownNewsSourceId(url), name: `${name} news`, url, kind: 'site' };
};
const NOS = NEWS_SUGGESTIONS.find((s) => s.id === 'nl-nos');

describe('importing another reader’s list', () => {
  it('adds what it can, passes over what is on or twice, and says why the rest can’t be', async () => {
    const w = world(feeds);
    const checked = await checkImports(
      w.services,
      [
        'https://one.example.com/feed',
        'https://one.example.com/feed#again',
        'https://two.example.com/feed',
        'ftp://three.example.com/feed',
        'https://gone.example.com/feed',
        NOS?.url ?? '',
      ],
      [own('two'), { id: 'nl-nos', name: 'NOS Nieuws', url: NOS?.url ?? '' }],
    );
    expect(checked).toEqual([
      { url: 'https://one.example.com/feed', source: own('one') },
      { url: 'https://one.example.com/feed#again', already: true },
      { url: 'https://two.example.com/feed', already: true },
      { url: 'ftp://three.example.com/feed', problem: NEWS_WORDS.notHttps },
      { url: 'https://gone.example.com/feed', problem: NEWS_WORDS.unreachable },
      { url: NOS?.url, already: true },
    ]);
    // What was plainly on already, or not https, wasn't read.
    expect(w.asked).toEqual(['https://one.example.com/feed', 'https://gone.example.com/feed']);
  });

  it('stops reading once the room is used, and skips the rest as full', async () => {
    const on = Array.from({ length: NEWS_SOURCES_MAX - 1 }, (_, i) => own(`held-${i}`));
    const w = world(feeds);
    const checked = await checkImports(
      w.services,
      ['https://gone.example.com/feed', 'https://one.example.com/feed', 'https://two.example.com/feed'],
      on,
      { atOnce: 1 },
    );
    expect(checked).toEqual([
      { url: 'https://gone.example.com/feed', problem: NEWS_WORDS.unreachable },
      { url: 'https://one.example.com/feed', source: own('one') },
      { url: 'https://two.example.com/feed', problem: FULL },
    ]);
    expect(w.asked).not.toContain('https://two.example.com/feed');
    const none = world(feeds);
    expect(await checkImports(none.services, ['https://one.example.com/feed'], [...on, own('last')])).toEqual(
      [{ url: 'https://one.example.com/feed', problem: FULL }],
    );
    expect(none.asked).toEqual([]);
  });

  it('answers in time, an address not read by then skipped as unreachable', async () => {
    const w = world((url) =>
      url.startsWith('https://slow.') ? new Promise<OpenDataAnswer>(() => {}) : feeds(url),
    );
    const checked = await checkImports(
      w.services,
      ['https://slow.example.com/feed', 'https://one.example.com/feed'],
      [],
      { atOnce: 1, budgetMs: 20 },
    );
    expect(checked).toEqual([
      { url: 'https://slow.example.com/feed', problem: NEWS_WORDS.unreachable },
      { url: 'https://one.example.com/feed', problem: NEWS_WORDS.unreachable },
    ]);
  });

  it('keeps a suggestion’s own id and name, and a source of the person’s own its kind', () => {
    expect(newsSourceOfFeed({ url: NOS?.url ?? '', name: 'Feed title', kind: 'site' })).toEqual({
      id: 'nl-nos',
      name: 'NOS Nieuws',
      url: NOS?.url,
      own: false,
    });
    expect(
      newsSourceOfFeed({ url: 'https://www.reddit.com/r/examplenews/.rss', name: '', kind: 'reddit' }),
    ).toMatchObject({ name: 'News', kind: 'reddit', own: true });
  });
});
