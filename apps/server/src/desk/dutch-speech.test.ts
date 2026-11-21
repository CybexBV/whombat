import { VOICE_TTS_TEXT_MAX } from '@whombat/control-contracts/local';
import { describe, expect, it } from 'vitest';
import { dutchNumber, dutchSpeechText, speechLanguage } from './dutch-speech';

describe('the language an answer is in (DK-T22)', () => {
  it('hears Dutch, English loanwords and all', () => {
    expect(speechLanguage('Ja, pve-02 draait prima. De backup van vannacht was om 03:00 klaar.')).toBe('nl');
    expect(speechLanguage('De schijf van blackbox is bijna vol. Zal ik de oude snapshots opruimen?')).toBe(
      'nl',
    );
    expect(speechLanguage('Plex is weer online.')).toBe('nl');
  });

  it('hears English, and takes English for nothing, ties and names alone', () => {
    expect(speechLanguage('Yes, pve-02 is fine. The backup ran at 03:00 and took 14 minutes.')).toBe('en');
    expect(speechLanguage('')).toBe('en');
    expect(speechLanguage('pve-02 blackbox the-falcon')).toBe('en');
    // “is”, “in”, “was”, “over” are both languages' words: they decide nothing.
    expect(speechLanguage('Plex is in.')).toBe('en');
  });
});

describe('Dutch numbers (DK-T23)', () => {
  it('are one word below a million, with the diaeresis where the joining needs it', () => {
    expect(dutchNumber(0)).toBe('nul');
    expect(dutchNumber(1)).toBe('één');
    expect(dutchNumber(12)).toBe('twaalf');
    expect(dutchNumber(21)).toBe('eenentwintig');
    expect(dutchNumber(22)).toBe('tweeëntwintig');
    expect(dutchNumber(23)).toBe('drieëntwintig');
    expect(dutchNumber(81)).toBe('eenentachtig');
    expect(dutchNumber(100)).toBe('honderd');
    expect(dutchNumber(101)).toBe('honderdeen');
    expect(dutchNumber(1200)).toBe('duizendtweehonderd');
    expect(dutchNumber(2026)).toBe('tweeduizendzesentwintig');
  });

  it('name millions and billions apart, and past that read the digits', () => {
    expect(dutchNumber(1_000_000)).toBe('één miljoen');
    expect(dutchNumber(2_500_000)).toBe('twee miljoen vijfhonderdduizend');
    expect(dutchNumber(3_000_000_001)).toBe('drie miljard één');
    expect(dutchNumber(1_000_000_000_000)).toBe('één nul nul nul nul nul nul nul nul nul nul nul nul');
  });
});

describe('a Dutch answer as it is said (DK-T23)', () => {
  it('writes out percentages, degrees, units and decimals', () => {
    expect(dutchSpeechText('De processor staat op 12 % en het geheugen op 61%.')).toBe(
      'De processor staat op twaalf procent en het geheugen op eenenzestig procent.',
    );
    expect(dutchSpeechText('Je hebt nog 1,2 TB vrij.')).toContain('één komma twee terabyte');
    expect(dutchSpeechText('Nog 1.2TB vrij.')).toContain('één komma twee terabyte');
    expect(dutchSpeechText('Het is 21,5 °C binnen en -3° buiten.')).toContain(
      'eenentwintig komma vijf graden binnen en min drie graden',
    );
    expect(dutchSpeechText('Hij gebruikt 450 W, vandaag 3,05 kWh.')).toContain(
      'vierhonderdvijftig watt, vandaag drie komma nul vijf kilowattuur',
    );
    expect(dutchSpeechText('Er staan 1.234 bestanden en 1.234,5 MB.')).toContain(
      'duizendtweehonderdvierendertig bestanden en duizendtweehonderdvierendertig komma vijf megabyte',
    );
  });

  it('says times the way people do', () => {
    expect(dutchSpeechText('Klaar om 03:00.')).toBe('Klaar om drie uur.');
    expect(dutchSpeechText('om 14:30')).toBe('om half drie');
    expect(dutchSpeechText('om 14:15')).toBe('om kwart over twee');
    expect(dutchSpeechText('om 14:45')).toBe('om kwart voor drie');
    expect(dutchSpeechText('om 12:30')).toBe('om half één');
    expect(dutchSpeechText('om 09:05')).toBe('om negen uur vijf');
  });

  it('spells short names before digits and reads a leading zero digit by digit', () => {
    expect(dutchSpeechText('Is pve-02 oké?')).toBe('Is P V E nul twee oké?');
    expect(dutchSpeechText('PVE-01 en sda1')).toBe('P V E nul één en S D A één');
    expect(dutchSpeechText('vm-104 draait')).toBe('V M honderdvier draait');
    expect(dutchSpeechText('NODE-3 en node-3')).toBe('N O D E drie en node drie');
  });

  it('turns hyphens between words into spaces, ranges into “tot” and versions into “punt”', () => {
    expect(dutchSpeechText('the-falcon is weer online')).toBe('the falcon is weer online');
    expect(dutchSpeechText('Dat duurt 2-3 minuten.')).toBe('Dat duurt twee tot drie minuten.');
    expect(dutchSpeechText('versie 2.0.1')).toBe('versie twee punt nul punt één');
  });

  it('stays within what the voice service takes, cut after a whole sentence', () => {
    const long = `${'Alles draait prima op vierentwintig servers. '.repeat(20)}Klaar.`;
    const said = dutchSpeechText(long);
    expect([...said].length).toBeLessThanOrEqual(VOICE_TTS_TEXT_MAX);
    expect(said.endsWith('servers.')).toBe(true);
  });
});
