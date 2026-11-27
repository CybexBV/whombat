import { readFileSync } from 'node:fs';
import { NEWS_FEED_ITEMS_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { feedLinksOf, POST_HEADLINE_MAX, pageTitleOf, parseFeed, plainText } from './feeds';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-11-26T08:00:00Z');

/** RSS 2.0 as a public broadcaster writes it: CDATA with markup, an entity, a relative link, a section without a date. */
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Omroep Voorbeeld &amp; Co</title>
    <link>https://news.example.com/</link>
    <item>
      <title><![CDATA[Bridge closed <b>all weekend</b> for repairs]]></title>
      <link>https://news.example.com/a/1</link>
      <pubDate>Thu, 26 Nov 2026 07:19:00 +0100</pubDate>
      <description><![CDATA[<p>Article text that is never kept.</p>]]></description>
      <media:content url="https://news.example.com/a/1.jpg"/>
    </item>
    <item>
      <title>Region North</title>
      <link>https://news.example.com/region/north</link>
    </item>
    <item>
      <title>Trains &amp; buses: strike on Monday</title>
      <link>/a/2</link>
      <dc:date>2026-11-26T06:42:00Z</dc:date>
    </item>
    <item>
      <title>Stamped in the future</title>
      <guid isPermaLink="true">https://news.example.com/a/3</guid>
      <pubDate>Thu, 26 Nov 2026 09:46:00 GMT</pubDate>
    </item>
    <item>
      <title>No link at all</title>
      <guid isPermaLink="false">abc-123</guid>
      <pubDate>Thu, 26 Nov 2026 06:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

/** RSS 1.0 (RDF), as ORF and NDR write it. */
const RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.com/"><title>Landesnachrichten</title></channel>
  <item rdf:about="https://rdf.example.com/story/7">
    <title>Schnee auf der Autobahn</title>
    <link>https://rdf.example.com/story/7</link>
    <dc:date>2026-11-26T07:18:00+01:00</dc:date>
  </item>
</rdf:RDF>`;

/** Atom, as VRT and WDR write it: a self link before the page's, an HTML title escaped once more. */
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Nieuws</title>
  <entry>
    <title type="html">Storm &amp;amp; regen op komst</title>
    <link rel="self" href="https://atom.example.com/api/1"/>
    <link rel="alternate" type="text/html" href="https://atom.example.com/nieuws/1"/>
    <published>2026-11-26T07:00:00+01:00</published>
    <updated>2026-11-26T07:28:00+01:00</updated>
  </entry>
  <entry>
    <title>Only updated</title>
    <link href="https://atom.example.com/nieuws/2"/>
    <updated>2026-11-25T16:51:00Z</updated>
  </entry>
</feed>`;

describe('a news feed', () => {
  it('gives RSS 2.0’s headlines, newest first, without markup, pictures or article text', () => {
    const feed = parseFeed(RSS, 'https://news.example.com/rss', NOW);
    expect(feed?.kind).toBe('rss');
    expect(feed?.title).toBe('Omroep Voorbeeld & Co');
    expect(feed?.items).toEqual(
      [
        // Ahead of now: taken as now.
        { title: 'Stamped in the future', link: 'https://news.example.com/a/3', at: NOW },
        {
          title: 'Bridge closed all weekend for repairs',
          link: 'https://news.example.com/a/1',
          at: Date.parse('2026-11-26T06:19:00Z'),
        },
        {
          title: 'Trains & buses: strike on Monday',
          link: 'https://news.example.com/a/2',
          at: Date.parse('2026-11-26T06:42:00Z'),
        },
      ].sort((a, b) => b.at - a.at),
    );
    expect(JSON.stringify(feed)).not.toMatch(/Article text|jpg/);
  });

  it('gives RSS 1.0’s and Atom’s', () => {
    const rdf = parseFeed(RDF, 'https://rdf.example.com/news.xml', NOW);
    expect(rdf).toMatchObject({ kind: 'rdf', title: 'Landesnachrichten' });
    expect(rdf?.items).toEqual([
      {
        title: 'Schnee auf der Autobahn',
        link: 'https://rdf.example.com/story/7',
        at: Date.parse('2026-11-26T06:18:00Z'),
      },
    ]);
    const atom = parseFeed(ATOM, 'https://atom.example.com/feed', NOW);
    expect(atom?.kind).toBe('atom');
    expect(atom?.items[0]).toEqual({
      title: 'Storm & regen op komst',
      link: 'https://atom.example.com/nieuws/1',
      at: Date.parse('2026-11-26T06:00:00Z'),
    });
    expect(atom?.items[1]?.link).toBe('https://atom.example.com/nieuws/2');
  });

  it('is nothing when the text isn’t a feed', () => {
    expect(parseFeed('<html><head><title>Hi</title></head></html>', 'https://example.com/', NOW)).toBeNull();
    expect(parseFeed('{"items": []}', 'https://example.com/', NOW)).toBeNull();
    expect(parseFeed('', 'https://example.com/', NOW)).toBeNull();
  });

  it('keeps at most thirty headlines, and only http and https links', () => {
    const items = Array.from(
      { length: 40 },
      (_, i) =>
        `<item><title>Story ${i}</title><link>${i === 0 ? 'javascript:alert(1)' : `https://example.com/${i}`}</link><pubDate>${new Date(NOW - i * 60_000).toUTCString()}</pubDate></item>`,
    );
    const feed = parseFeed(`<rss><channel>${items.join('')}</channel></rss>`, 'https://example.com/', NOW);
    expect(feed?.items).toHaveLength(NEWS_FEED_ITEMS_MAX);
    expect(feed?.items.some((i) => i.title === 'Story 0')).toBe(false);
  });

  it('headlines a post without a title by the start of its own words', () => {
    const mastodon = parseFeed(fixture('mastodon.rss'), 'https://social.example.com/@townhall.rss', NOW);
    const [long, short] = mastodon?.items ?? [];
    expect(long?.title.startsWith('The library on #MainStreet opens late on Friday')).toBe(true);
    expect(long?.title.length).toBeLessThanOrEqual(POST_HEADLINE_MAX);
    expect(long?.title.endsWith('…')).toBe(true);
    expect(short?.title).toBe('Bins go out a day later next week.');
    // A post that is only a picture has nothing to say.
    expect(mastodon?.items).toHaveLength(2);
    const bluesky = parseFeed(fixture('bluesky.rss'), 'https://bsky.app/profile/did:plc:x/rss', NOW);
    expect(bluesky?.items[0]).toMatchObject({
      title: 'Polls close at eight tonight. Results as they come in on our site.',
      at: Date.parse('2026-11-26T06:33:00Z'),
    });
  });

  it('knows a podcast by the iTunes namespace or an item’s audio', () => {
    expect(parseFeed(fixture('podcast.rss'), 'https://feeds.example.com/p.xml', NOW)?.audio).toBe(true);
    const audioOnly = `<rss><channel><title>Talk</title><item><title>One</title><link>https://example.com/1</link><pubDate>Thu, 26 Nov 2026 05:00:00 GMT</pubDate><enclosure type="audio/mpeg" url="https://example.com/1.mp3"/></item></channel></rss>`;
    expect(parseFeed(audioOnly, 'https://example.com/feed', NOW)?.audio).toBe(true);
    expect(parseFeed(RSS, 'https://news.example.com/rss', NOW)?.audio).toBe(false);
    expect(
      parseFeed(fixture('youtube-videos.xml'), 'https://www.youtube.com/feeds/videos.xml', NOW)?.audio,
    ).toBe(false);
  });

  it('leaves out the last item of a feed read only in part, which was cut short', () => {
    const whole = fixture('podcast.rss');
    const cut = whole.slice(0, whole.indexOf('2026-11-25.mp3'));
    const items = parseFeed(cut, 'https://feeds.example.com/p.xml', NOW, { truncated: true })?.items;
    expect(items?.map((i) => i.link)).toEqual(['https://radio.example.com/morning/2026-11-26']);
  });

  it('cuts a long headline and keeps it on one line', () => {
    expect(plainText('A\n  very\tlong   one', 10)).toBe('A very lo…');
    expect(plainText('<i>Hi</i> &amp; bye')).toBe('Hi & bye');
  });
});

describe('a news site’s page', () => {
  const page = `<!doctype html><html><head>
    <title> Omroep Voorbeeld | Nieuws </title>
    <link rel="stylesheet" href="/s.css">
    <link rel="alternate" type="application/rss+xml" title="Nieuws" href="/rss">
    <link rel="alternate" type="application/atom+xml" href="https://news.example.com/atom">
    <link rel="alternate" type="application/rss+xml" href="http://news.example.com/plain">
  </head><body></body></html>`;

  it('names its feeds, absolute and https only', () => {
    expect(feedLinksOf(page, 'https://news.example.com/')).toEqual([
      'https://news.example.com/rss',
      'https://news.example.com/atom',
    ]);
    expect(feedLinksOf('<html></html>', 'https://news.example.com/')).toEqual([]);
  });

  it('has its own title', () => {
    expect(pageTitleOf(page)).toBe('Omroep Voorbeeld | Nieuws');
    expect(pageTitleOf('<html></html>')).toBeNull();
  });
});
