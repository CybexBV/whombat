import { describe, expect, it } from 'vitest';
import { NewsBrowseView, newsBrowse, newsOpml, newsOpmlUrls, newsSourceKind } from './news.js';
import type { NewsSuggestionRow } from './news-suggestions.js';

const ROWS: NewsSuggestionRow[] = [
  { id: 'nl-a', country: 'NL', lang: 'nl', name: 'A', url: 'https://a.example.com/rss' },
  {
    id: 'nl-b',
    country: 'NL',
    regions: ['NL-NB'],
    where: 'Noord-Brabant',
    lang: 'nl',
    name: 'B',
    url: 'https://b.example.com/rss',
  },
  { id: 'nl-c', country: 'NL', regions: ['NL-ZH'], lang: 'nl', name: 'C', url: 'https://c.example.com/rss' },
  { id: 'nl-t', country: 'NL', lang: 'nl', topic: 'tech', name: 'T', url: 'https://t.example.com/rss' },
  { id: 'de-a', country: 'DE', lang: 'de', name: 'D', url: 'https://d.example.com/rss' },
];

describe('newsBrowse', () => {
  it('lists the place’s country, nearest first, with every country and what is on', () => {
    const view = newsBrowse({ place: { country: 'NL', region: 'NL-NB' }, on: new Set(['nl-t']) }, ROWS);
    expect(NewsBrowseView.parse(view)).toEqual(view);
    expect(view.country).toBe('NL');
    expect(view.countries).toEqual([
      { code: 'NL', sites: 4 },
      { code: 'DE', sites: 1 },
    ]);
    expect(view.sites.map((s) => s.id)).toEqual(['nl-b', 'nl-a', 'nl-t', 'nl-c']);
    expect(view.sites.find((s) => s.id === 'nl-t')).toMatchObject({
      topic: 'tech',
      on: true,
      near: 'country',
    });
    expect(view.sites.find((s) => s.id === 'nl-b')).toMatchObject({
      scope: 'region',
      where: 'Noord-Brabant',
    });
    expect(view.sites.find((s) => s.id === 'nl-c')).toMatchObject({ near: null, topic: 'news' });
  });

  it('lists another country without a place', () => {
    const view = newsBrowse({ country: 'DE', place: null, on: new Set() }, ROWS);
    expect(view.sites.map((s) => [s.id, s.near])).toEqual([['de-a', null]]);
    expect(newsBrowse({ place: null, on: new Set() }, ROWS)).toMatchObject({ country: null, sites: [] });
  });
});

describe('OPML', () => {
  it('reads each feed once, https, in order', () => {
    const opml = `<opml><body><outline text="x">
      <outline type="rss" text="One" xmlUrl="http://one.example.com/feed?a=1&amp;b=2"/>
      <outline xmlUrl='https://two.example.com/rss' text="Two"/>
      <outline xmlUrl="https://two.example.com/rss"/>
      <outline xmlUrl="not a url"/>
    </outline></body></opml>`;
    expect(newsOpmlUrls(opml)).toEqual([
      'https://one.example.com/feed?a=1&b=2',
      'https://two.example.com/rss',
    ]);
  });

  it('writes a list another reader takes and reads back', () => {
    const text = newsOpml([{ name: 'A & B', url: 'https://ab.example.com/rss?x=1&y=2' }]);
    expect(text).toContain('A &amp; B');
    expect(newsOpmlUrls(text)).toEqual(['https://ab.example.com/rss?x=1&y=2']);
  });
});

describe('newsSourceKind', () => {
  it('reads the kind from the feed’s address when it isn’t given', () => {
    expect(newsSourceKind({ url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx' })).toBe(
      'youtube',
    );
    expect(newsSourceKind({ url: 'https://www.reddit.com/r/selfhosted/.rss' })).toBe('reddit');
    expect(newsSourceKind({ url: 'https://mastodon.example.com/@someone.rss' })).toBe('mastodon');
    expect(newsSourceKind({ url: 'https://github.com/o/r/releases.atom' })).toBe('github');
    expect(newsSourceKind({ url: 'https://blog.example.com/feed' })).toBe('site');
    expect(newsSourceKind({ url: 'https://pod.example.com/feed', kind: 'podcast' })).toBe('podcast');
  });
});
