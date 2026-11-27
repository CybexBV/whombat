/**
 * Settings → News and weather's own logic (app weather-news-apps.md): the limit by the Whombat's age, a source's mark
 * and line, Find more's chips, moving a source, and an OPML file's import.
 */
import type { NewsBrowseSite, NewsBrowseView, NewsChosenSource, Place } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  browseLine,
  chipHas,
  chosenLine,
  findAgainAddress,
  importWords,
  moveSource,
  newsChips,
  newsCountText,
  newsFullFor,
  newsMax,
  opmlPlan,
  placeSource,
  sourceInitials,
  sourceTone,
  suggestionLine,
} from './newsModel';

const BREDA: Place = {
  name: 'Breda',
  lat: 51.59,
  lon: 4.78,
  country: 'NL',
  region: 'NL-NB',
  regionName: 'Noord-Brabant',
  guessed: false,
};

const site = (over: Partial<NewsBrowseSite> & Pick<NewsBrowseSite, 'id'>): NewsBrowseSite => ({
  name: over.id,
  url: `https://${over.id}.example.com/rss`,
  lang: 'nl',
  topic: 'news',
  scope: 'country',
  near: 'country',
  on: false,
  ...over,
});

const chosen = (over: Partial<NewsChosenSource> & Pick<NewsChosenSource, 'id'>): NewsChosenSource => ({
  name: over.id,
  url: `https://${over.id}.example.com/rss`,
  own: false,
  ...over,
});

describe('how many sources', () => {
  it('takes 30, or 12 on a Whombat from before browsing, and says so', () => {
    expect(newsMax(true)).toBe(30);
    expect(newsMax(false)).toBe(12);
    expect(newsCountText(5, 30)).toBe('5 of 30');
    expect(newsFullFor(12)).toContain('12');
  });
});

describe('a source’s mark', () => {
  it('is its short name, or one or two first letters, never punctuation', () => {
    expect(sourceInitials('NOS Nieuws')).toBe('NOS');
    expect(sourceInitials('RTL Nieuws')).toBe('RTL');
    expect(sourceInitials('NU.nl')).toBe('NU');
    expect(sourceInitials('Omroep Brabant')).toBe('OB');
    expect(sourceInitials('Tweakers')).toBe('T');
    expect(sourceInitials('DutchNews.nl')).toBe('D');
    expect(sourceInitials('r/selfhosted')).toBe('S');
    expect(sourceInitials('@ernie')).toBe('E');
    expect(sourceInitials('L1 Nieuws')).toBe('L1');
    expect(sourceInitials('…')).toBe('?');
  });

  it('keeps one of the five tones for the same source', () => {
    expect(sourceTone('nl-nos')).toBe(sourceTone('nl-nos'));
    for (const id of ['a', 'nl-nos', 'own-x1', 'be-vrt']) expect(sourceTone(id)).toBeGreaterThanOrEqual(1);
    for (const id of ['a', 'nl-nos', 'own-x1', 'be-vrt']) expect(sourceTone(id)).toBeLessThanOrEqual(5);
  });
});

describe('the line under a source that is on', () => {
  const browse: NewsBrowseView = {
    country: 'NL',
    countries: [{ code: 'NL', sites: 2 }],
    sites: [
      site({ id: 'nl-nos' }),
      site({ id: 'nl-omroep-brabant', scope: 'region', near: 'region' }),
      site({ id: 'nl-omroep-gelderland', scope: 'region', near: null, where: 'Gelderland' }),
    ],
  };

  it('says what one the person added is', () => {
    const own = chosen({
      id: 'own-abc',
      own: true,
      url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012',
    });
    expect(chosenLine(own, { place: BREDA, browse })).toBe('YouTube · added by you');
    expect(chosenLine(chosen({ id: 'own-x', own: true }), { place: BREDA })).toBe('Website · added by you');
  });

  it('says whom a suggestion is for, from the box’s list', () => {
    const line = (id: string) => chosenLine(chosen({ id }), { place: BREDA, browse });
    expect(line('nl-nos')).toMatch(/^Netherlands · national$/);
    expect(line('nl-omroep-brabant')).toBe('Noord-Brabant · regional');
    expect(line('nl-omroep-gelderland')).toBe('Gelderland · regional');
  });

  it('falls back on the app’s own table, then the address', () => {
    expect(chosenLine(chosen({ id: 'nl-omroep-brabant' }), { place: BREDA })).toBe(
      'Noord-Brabant · regional',
    );
    expect(chosenLine(chosen({ id: 'nl-nos' }), { place: null })).toBe('Netherlands · national');
    expect(
      chosenLine(chosen({ id: 'xx-gone', url: 'https://www.gone.example.com/rss' }), { place: BREDA }),
    ).toBe('gone.example.com');
  });
});

describe('Find more', () => {
  it('names a site by whom it is for, its topic and its language', () => {
    expect(browseLine(site({ id: 'a' }), BREDA)).toBe('National · Dutch');
    expect(browseLine(site({ id: 'b', scope: 'region', near: 'region' }), BREDA)).toBe(
      'Noord-Brabant · Dutch',
    );
    expect(browseLine(site({ id: 'c', topic: 'tech', lang: 'en' }), BREDA)).toBe('National · Tech · English');
    expect(browseLine(site({ id: 'd', scope: 'region', near: null }), BREDA)).toBe('Regional · Dutch');
  });

  it('names an older Whombat’s suggestion by how near it is', () => {
    const s = { id: 'nl-omroep-brabant', name: 'Omroep Brabant', url: 'https://x.example.com', lang: 'nl' };
    expect(suggestionLine({ ...s, near: 'region' }, BREDA)).toBe('Noord-Brabant · Dutch');
    expect(suggestionLine({ ...s, near: 'country' }, BREDA)).toBe('National · Dutch');
  });

  it('shows only the chips that have sites', () => {
    const sites = [
      site({ id: 'a' }),
      site({ id: 'b', scope: 'region', near: 'region' }),
      site({ id: 'c', topic: 'tech' }),
    ];
    expect(newsChips(sites)).toEqual(['all', 'near', 'national', 'tech']);
    expect(newsChips([])).toEqual([]);
    // Another country's: nothing is near.
    expect(newsChips([site({ id: 'x', near: null }), site({ id: 'y', topic: 'sport', near: null })])).toEqual(
      ['all', 'national', 'sport'],
    );
    expect(chipHas(site({ id: 'c', topic: 'tech' }), 'national')).toBe(false);
    expect(chipHas(site({ id: 'b', scope: 'region', near: 'area' }), 'near')).toBe(true);
  });
});

describe('moving a source', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves one up or down, and not past either end', () => {
    expect(moveSource(ids, 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveSource(ids, 'a', 1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveSource(ids, 'a', -1)).toEqual(ids);
    expect(moveSource(ids, 'd', 1)).toEqual(ids);
    expect(moveSource(ids, 'z', 1)).toEqual(ids);
  });

  it('puts a dragged one at its place among the others', () => {
    expect(placeSource(ids, 'a', 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(placeSource(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(placeSource(ids, 'b', 9)).toEqual(['a', 'c', 'd', 'b']);
  });
});

describe('importing another reader’s list', () => {
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="One" xmlUrl="https://one.example.com/rss"/>
    <outline text="Two" xmlUrl="http://two.example.com/feed"/>
    <outline text="Three" xmlUrl="https://three.example.com/atom.xml"/>
  </body></opml>`;

  it('sends what fits and counts what didn’t', () => {
    expect(opmlPlan(opml, 30)).toEqual({
      urls: [
        'https://one.example.com/rss',
        'https://two.example.com/feed',
        'https://three.example.com/atom.xml',
      ],
      left: 0,
      none: false,
    });
    expect(opmlPlan(opml, 2)).toMatchObject({ left: 1, none: false });
    expect(opmlPlan(opml, 0)).toMatchObject({ urls: [], left: 3 });
    expect(opmlPlan('<opml><body/></opml>', 30)).toMatchObject({ none: true });
  });

  it('says what was added and what wasn’t', () => {
    expect(importWords(1, 0)).toEqual(['One source added.']);
    expect(importWords(3, 2)).toEqual(['3 sources added.', '2 couldn’t be added.']);
    expect(importWords(0, 2)).toEqual(['2 couldn’t be added.']);
  });
});

describe('Find it again', () => {
  it('offers a site’s front page, and any other source as it is', () => {
    expect(findAgainAddress({ url: 'https://feeds.nos.nl/nosnieuwsalgemeen' })).toBe('https://nos.nl');
    expect(findAgainAddress({ url: 'https://www.dutchnews.nl/feed/' })).toBe('https://www.dutchnews.nl');
    const reddit = 'https://www.reddit.com/r/selfhosted/.rss';
    expect(findAgainAddress({ url: reddit })).toBe(reddit);
  });
});
