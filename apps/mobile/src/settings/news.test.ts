import { describe, expect, it } from 'vitest';
import {
  browseSiteLine,
  chosenSourceLine,
  newsChipHas,
  newsChipLabel,
  newsChips,
  newsCountText,
  newsFullTextFor,
  newsIdsMoved,
  newsImportText,
  newsMax,
  sourceInitials,
} from './news';

const breda = { country: 'NL', region: 'NL-NB', regionName: 'Noord-Brabant' };

describe('Settings → News and weather on the phone', () => {
  it('counts the sources against 30, or 12 on a Whombat before browsing', () => {
    expect(newsMax(true)).toBe(30);
    expect(newsMax(false)).toBe(12);
    expect(newsCountText(5, 30)).toBe('5 of 30');
    expect(newsFullTextFor(12)).toContain('12');
  });

  it('marks a source with the letters its name starts with', () => {
    expect(sourceInitials('NOS Nieuws')).toBe('NOS');
    expect(sourceInitials('RTL Nieuws')).toBe('RTL');
    expect(sourceInitials('NU.nl')).toBe('NU');
    expect(sourceInitials('Omroep Brabant')).toBe('OB');
    expect(sourceInitials('Tweakers')).toBe('T');
    expect(sourceInitials('r/worldnews')).toBe('RW');
    expect(sourceInitials('@whombat')).toBe('W');
    expect(sourceInitials('')).toBe('•');
  });

  it('says what each source is and whom it is for', () => {
    expect(
      chosenSourceLine({ id: 'nl-nos', url: 'https://feeds.nos.nl/nosnieuwsalgemeen', own: false }, breda),
    ).toMatch(/ · national$/);
    expect(
      chosenSourceLine(
        { id: 'nl-omroep-brabant', url: 'https://www.omroepbrabant.nl/rss', own: false },
        breda,
      ),
    ).toBe('Noord-Brabant · regional');
    expect(
      chosenSourceLine(
        {
          id: 'own-abc',
          url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0123456789012345678901',
          own: true,
        },
        breda,
      ),
    ).toBe('YouTube · added by you');
    expect(
      chosenSourceLine({ id: 'own-def', url: 'https://www.at5.nl/feeds/nieuws.xml', own: true }, null),
    ).toBe('Website · added by you');
    // A suggestion this app doesn't know (a newer box's table): its feed's host.
    expect(chosenSourceLine({ id: 'zz-new', url: 'https://www.example.com/rss', own: false }, null)).toBe(
      'example.com',
    );
  });

  it('moves a source up or down, and nowhere past either end', () => {
    const chosen = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(newsIdsMoved(chosen, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(newsIdsMoved(chosen, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(newsIdsMoved(chosen, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(newsIdsMoved(chosen, 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(newsIdsMoved(chosen, 'x', 1)).toEqual(['a', 'b', 'c']);
  });

  it('offers only the chips that have sites, in the web’s order', () => {
    const sites = [
      { near: 'region' as const, scope: 'region' as const, topic: 'news' as const },
      { near: 'country' as const, scope: 'country' as const, topic: 'news' as const },
      { near: 'country' as const, scope: 'country' as const, topic: 'tech' as const },
      { near: null, scope: 'region' as const, topic: 'news' as const },
    ];
    expect(newsChips(sites)).toEqual(['all', 'near', 'national', 'tech']);
    expect(newsChips([])).toEqual([]);
    expect(sites.filter((s) => newsChipHas('near', s))).toHaveLength(1);
    expect(sites.filter((s) => newsChipHas('national', s))).toHaveLength(1);
    expect(sites.filter((s) => newsChipHas('all', s))).toHaveLength(4);
    expect(['all', 'near', 'national', 'tech'].map((c) => newsChipLabel(c as never))).toEqual([
      'All',
      'Near you',
      'National',
      'Tech',
    ]);
  });

  it('says whom a suggested site is for', () => {
    expect(browseSiteLine({ scope: 'country', topic: 'news' })).toBe('National');
    expect(browseSiteLine({ scope: 'country', topic: 'tech' })).toBe('Tech');
    expect(browseSiteLine({ scope: 'region', topic: 'news', where: 'Noord-Brabant' })).toBe(
      'Noord-Brabant · regional',
    );
    expect(browseSiteLine({ scope: 'region', topic: 'news' })).toBe('Regional');
  });

  it('says what an import did', () => {
    const one = { id: 'own-a', name: 'A', url: 'https://a.example.com/rss', own: true };
    expect(newsImportText({ added: [one], skipped: [] })).toBe('One source added.');
    expect(newsImportText({ added: [one, one], skipped: [{ url: 'x', problem: 'y' }] })).toBe(
      '2 sources added. 1 couldn’t be added.',
    );
    expect(newsImportText({ added: [], skipped: [{ url: 'x', problem: 'y' }] })).toBe('1 couldn’t be added.');
    expect(newsImportText({ added: [], skipped: [] })).toBe('0 sources added.');
  });
});
