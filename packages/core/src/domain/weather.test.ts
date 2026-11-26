import { describe, expect, it } from 'vitest';
import {
  temperatureIn,
  WEATHER_SYMBOL_BASES,
  WeatherSymbol,
  weatherSymbolParts,
  weatherSymbolText,
  weatherUnitsFor,
  windFrom,
  windIn,
} from './weather.js';

describe('the weather symbols', () => {
  it('are MET’s forty-one, each with its words', () => {
    expect(WEATHER_SYMBOL_BASES).toHaveLength(41);
    for (const base of WEATHER_SYMBOL_BASES) expect(weatherSymbolText(base)).toMatch(/^[A-Z][a-z ]+$/);
  });

  it('split into their base and time of day', () => {
    expect(weatherSymbolParts('partlycloudy_night')).toEqual({ base: 'partlycloudy', time: 'night' });
    expect(weatherSymbolParts('lightssleetshowersandthunder_polartwilight')).toEqual({
      base: 'lightssleetshowersandthunder',
      time: 'polartwilight',
    });
    expect(weatherSymbolParts('rain')).toEqual({ base: 'rain', time: null });
    expect(weatherSymbolParts('meteorshower_day')).toEqual({ base: null, time: 'day' });
    expect(weatherSymbolText('clearsky_day')).toBe('Clear sky');
    expect(weatherSymbolText('meteorshower')).toBe('');
  });

  it('take one MET adds later, and nothing that isn’t one', () => {
    expect(WeatherSymbol.safeParse('meteorshower_day').success).toBe(true);
    expect(WeatherSymbol.safeParse('Rain').success).toBe(false);
    expect(WeatherSymbol.safeParse('rain_evening').success).toBe(false);
  });
});

describe('the units', () => {
  it('are metric except in the United States', () => {
    expect(weatherUnitsFor('NL')).toEqual({ temperature: 'C', wind: 'm/s' });
    expect(weatherUnitsFor('US')).toEqual({ temperature: 'F', wind: 'mph' });
    expect(weatherUnitsFor(null)).toEqual({ temperature: 'C', wind: 'm/s' });
  });

  it('turn MET’s figures into them', () => {
    expect(temperatureIn('C', 3.14)).toBe(3.1);
    expect(temperatureIn('F', 100)).toBe(212);
    expect(temperatureIn('F', -40)).toBe(-40);
    expect(windIn('m/s', 4.26)).toBe(4.3);
    expect(windIn('mph', 10)).toBe(22.4);
    expect(windFrom(0)).toBe('N');
    expect(windFrom(225)).toBe('SW');
    expect(windFrom(350)).toBe('N');
    expect(windFrom(-90)).toBe('W');
  });
});
