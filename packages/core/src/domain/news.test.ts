import { describe, expect, it } from 'vitest';
import {
  isOwnNewsSource,
  NEWS_SOURCES_MAX,
  NewsAddSiteBody,
  NewsFeedUrl,
  NewsSetSourcesBody,
  NewsSourceId,
  NewsSourcesView,
  newsSiteAddress,
  newsSuggestion,
  newsSuggestionsFor,
  ownNewsSourceId,
} from './news.js';
import { NEWS_SUGGESTIONS } from './news-suggestions.js';

const ids = (place: Parameters<typeof newsSuggestionsFor>[0]) => newsSuggestionsFor(place).map((s) => s.id);

describe('the suggested news sites', () => {
  it('put the region’s first, then the country’s, its all-news sites before its topics', () => {
    const brabant = newsSuggestionsFor({ country: 'NL', region: 'NL-NB' });
    expect(brabant.slice(0, 2).map((s) => [s.id, s.near])).toEqual([
      ['nl-omroep-brabant', 'region'],
      ['nl-nos', 'country'],
    ]);
    expect(brabant.slice(1).every((s) => s.near === 'country')).toBe(true);
    const firstTopic = brabant.findIndex((s) => s.topic);
    expect(firstTopic).toBeGreaterThan(1);
    expect(brabant.slice(firstTopic).every((s) => s.topic)).toBe(true);
    expect(ids({ country: 'NL', region: 'NL-ZH' }).slice(0, 3)).toEqual([
      'nl-rijnmond',
      'nl-omroep-west',
      'nl-nos',
    ]);
  });

  it('suggest only the country’s own where the region has none or isn’t known', () => {
    const country = newsSuggestionsFor({ country: 'NL' });
    expect(country[0]?.id).toBe('nl-nos');
    expect(country.every((s) => s.near === 'country')).toBe(true);
    expect(ids({ country: 'NL', region: 'NL-FL' })).toEqual(ids({ country: 'NL' }));
  });

  it('match an area where the region is too large', () => {
    const liege = newsSuggestionsFor({ country: 'BE', region: 'BE-WAL', area: 'BE-WLG' });
    expect(liege[0]).toMatchObject({ id: 'be-rtbf-liege', near: 'area', lang: 'fr' });
    expect(liege.map((s) => s.id)).not.toContain('be-rtbf-namur');
    expect(ids({ country: 'BE', region: 'BE-BRU' }).slice(0, 2)).toEqual(['be-rtbf-bruxelles', 'be-bruzz']);
  });

  it('may serve several regions with one site', () => {
    expect(ids({ country: 'SE', region: 'SE-H' })[0]).toBe('se-svt-smaland');
    expect(ids({ country: 'SE', region: 'SE-G' })[0]).toBe('se-svt-smaland');
    expect(ids({ country: 'CA', region: 'CA-NU' })[0]).toBe('ca-cbc-north');
  });

  it('cover the countries the research checked, and none without a place', () => {
    for (const country of [
      'NL',
      'BE',
      'DE',
      'AT',
      'GB',
      'IE',
      'FR',
      'CH',
      'DK',
      'SE',
      'NO',
      'IT',
      'CA',
      'AU',
      'US',
      'NZ',
      'ES',
      'PT',
      'PL',
      'CZ',
      'FI',
      'EE',
      'LV',
      'LT',
      'GR',
      'CY',
      'MT',
      'SI',
      'SK',
      'HR',
      'HU',
      'RO',
      'BG',
      'IS',
    ])
      expect([country, ids({ country }).length > 0]).toEqual([country, true]);
    expect(ids({ country: 'DE', region: 'DE-BY' }).slice(0, 2)).toEqual([
      'de-tagesschau-by',
      'de-tagesschau',
    ]);
    expect(ids({ country: 'AT', region: 'AT-6' })[0]).toBe('at-orf-steiermark');
    expect(ids({ country: 'GB', region: 'GB-SCT' }).slice(0, 2)).toEqual(['gb-bbc-scotland', 'gb-bbc']);
    expect(ids({ country: 'US', region: 'US-CA' })[0]).toBe('us-ca-calmatters');
    expect(ids({ country: 'JP' })).toEqual([]);
    expect(ids(null)).toEqual([]);
  });

  it('are https feeds of their own, never a personal-use reader’s or Yle’s', () => {
    const seen = new Set<string>();
    for (const row of NEWS_SUGGESTIONS) {
      expect([row.id, NewsSourceId.safeParse(row.id).success, isOwnNewsSource(row.id)]).toEqual([
        row.id,
        true,
        false,
      ]);
      expect([row.id, NewsFeedUrl.safeParse(row.url).success]).toEqual([row.id, true]);
      expect(row.url).not.toMatch(/news\.google\.|yle\.fi/);
      for (const code of [...(row.regions ?? []), ...(row.areas ?? [])])
        expect(code.startsWith(`${row.country}-`)).toBe(true);
      // A regional site names where it is for; a country's doesn't.
      expect([row.id, !!row.where]).toEqual([row.id, !!(row.regions ?? row.areas)]);
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
    }
    expect(newsSuggestion('nl-nos')?.name).toBe('NOS Nieuws');
    expect(newsSuggestion('nope')).toBeUndefined();
  });
});

describe('a news site the person adds', () => {
  it('is read over https, with https put in front of a bare name', () => {
    expect(newsSiteAddress(' omroepbrabant.nl ')).toBe('https://omroepbrabant.nl/');
    expect(newsSiteAddress('https://www.example.com/feed.xml#top')).toBe('https://www.example.com/feed.xml');
    expect(newsSiteAddress('HTTPS://Example.COM/rss')).toBe('https://example.com/rss');
    for (const bad of [
      'http://example.com/rss',
      'ftp://example.com',
      'https://user:pw@example.com/rss',
      'localhost',
      'https://example.com/a b',
      '',
    ])
      expect([bad, newsSiteAddress(bad)]).toEqual([bad, null]);
    expect(NewsAddSiteBody.safeParse({ url: 'example.com' }).success).toBe(true);
    expect(NewsAddSiteBody.safeParse({ url: 'http://example.com' }).success).toBe(false);
  });

  it('gets an id of its own, the same for the same feed', () => {
    const id = ownNewsSourceId('https://www.example.com/feed.xml');
    expect(id).toBe(ownNewsSourceId('https://www.example.com/feed.xml'));
    expect(id).not.toBe(ownNewsSourceId('https://www.example.com/feed.xml?x=1'));
    expect(NewsSourceId.safeParse(id).success).toBe(true);
    expect(isOwnNewsSource(id)).toBe(true);
  });
});

describe('choosing the news sites', () => {
  it('takes each id once and at most twelve', () => {
    expect(NewsSetSourcesBody.safeParse({ ids: ['nl-nos', 'nl-omroep-brabant'] }).success).toBe(true);
    expect(NewsSetSourcesBody.safeParse({ ids: ['nl-nos', 'nl-nos'] }).success).toBe(false);
    const many = NEWS_SUGGESTIONS.slice(0, NEWS_SOURCES_MAX + 1).map((s) => s.id);
    expect(NewsSetSourcesBody.safeParse({ ids: many }).success).toBe(false);
    expect(NewsSetSourcesBody.safeParse({ ids: [] }).success).toBe(true);
  });

  it('reads back what Settings shows', () => {
    const view = {
      place: { name: 'Breda', lat: 51.59, lon: 4.78, country: 'NL', region: 'NL-NB', guessed: false },
      chosen: [
        { id: 'nl-nos', name: 'NOS Nieuws', url: 'https://feeds.nos.nl/nosnieuwsalgemeen', own: false },
        {
          id: ownNewsSourceId('https://www.example.com/feed.xml'),
          name: 'Example',
          url: 'https://www.example.com/feed.xml',
          own: true,
          problem: 'Couldn’t read it just now',
        },
      ],
      suggestions: newsSuggestionsFor({ country: 'NL', region: 'NL-NB' }).filter((s) => s.id !== 'nl-nos'),
    };
    expect(NewsSourcesView.parse(view)).toEqual(view);
  });
});
