import { describe, expect, it } from 'vitest';
import {
  drawOwnAddressLabel,
  OWN_ADDRESS_LOOKALIKE_WORDS,
  OWN_ADDRESS_RESERVED_PREFIXES,
  OWN_ADDRESS_RUDE_WORDS,
  OWN_ADDRESS_WORDS,
  OWN_ADDRESS_WORDS_RETIRED,
  ownAddressNameProblem,
} from './index.js';

describe('ownAddressNameProblem', () => {
  it('gives ordinary names', () => {
    for (const name of ['home', 'abc', 'john-home', 'box2', 'a1b', 'maple-otter-river', 'scrap', 'class'])
      expect(ownAddressNameProblem(name), name).toBeNull();
    expect(ownAddressNameProblem('a'.repeat(32))).toBeNull();
  });

  it('refuses what is not a name’s shape', () => {
    for (const name of [
      'xn--a',
      'a--b',
      '-a',
      'a-',
      '1abc',
      'ab',
      'a'.repeat(33),
      'Home',
      'home ',
      'ho_me',
      'home.box',
      '',
    ])
      expect(ownAddressNameProblem(name), name).toBe('invalid');
  });

  it('keeps reserved names, Whombat’s prefixes and rude words for nobody', () => {
    for (const name of [
      'box',
      'dev',
      'www',
      'api',
      'dusty',
      'hazel',
      'whombat',
      'whombat-x',
      'whombathome',
      'cybexhq',
    ])
      expect(ownAddressNameProblem(name), name).toBe('reserved');
    for (const name of ['shit', 'my-shit-box', 'f-uck'])
      expect(ownAddressNameProblem(name), name).toBe('reserved');
  });

  it('keeps names that pass for a sign-in page or that devices look up for nobody', () => {
    for (const name of [
      'secure',
      'verify',
      'autodiscover',
      'wpad',
      'mta-sts',
      'paypal',
      'paypallogin',
      'my-paypal',
      'apple-support',
      'apple',
      'ing',
      'ing-verify',
      'googledrive',
    ])
      expect(ownAddressNameProblem(name), name).toBe('reserved');
    // Only whole names and hyphen-parts: ordinary words that hold one stay free.
    for (const name of ['applesauce', 'ingrid', 'striped', 'pineapple', 'pingu', 'apple-gusto-sphinx'])
      expect(ownAddressNameProblem(name), name).toBeNull();
  });

  it('never refuses a drawn label', () => {
    for (const w of [...OWN_ADDRESS_WORDS, ...OWN_ADDRESS_WORDS_RETIRED]) {
      expect(OWN_ADDRESS_RUDE_WORDS.has(w), w).toBe(false);
      expect(
        OWN_ADDRESS_RESERVED_PREFIXES.filter((p) => w.startsWith(p)),
        w,
      ).toEqual([]);
    }
    // Reserved names are whole names, so a word that is one (`news`) is fine inside a label. Two words joined without
    // their hyphen must not spell a rude word either.
    const spelled = OWN_ADDRESS_WORDS.flatMap((a) =>
      OWN_ADDRESS_WORDS.filter((b) => OWN_ADDRESS_RUDE_WORDS.has(`${a}${b}`)).map((b) => `${a}-${b}`),
    );
    expect(spelled).toEqual([]);
    let i = 0;
    const random = (n: number) => (i++ * 7919) % n;
    for (let k = 0; k < 2_000; k++) expect(ownAddressNameProblem(drawOwnAddressLabel(random))).toBeNull();
  });
});
