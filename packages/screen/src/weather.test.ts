import {
  WEATHER_SYMBOL_BASES,
  WEATHER_SYMBOLS,
  WEATHER_TIMES_OF_DAY,
  weatherSymbolParts,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { weatherSign, weatherSymbolBase } from './weather';

describe('the weather’s signs', () => {
  it('read every symbol MET sends as core does, and know every base', () => {
    for (const base of WEATHER_SYMBOL_BASES) {
      const times = WEATHER_SYMBOLS[base][1] ? WEATHER_TIMES_OF_DAY : ([null] as const);
      for (const time of times) {
        const code = time ? `${base}_${time}` : base;
        expect(weatherSymbolBase(code).base).toBe(weatherSymbolParts(code).base);
        expect(weatherSymbolBase(code).night).toBe(weatherSymbolParts(code).time === 'night');
        // A known base is never drawn as the plain cloud of one it doesn't know, except cloudy itself.
        const sign = weatherSign(code);
        if (base !== 'cloudy') expect(sign).not.toEqual(weatherSign('notasymbol'));
      }
    }
  });

  it('draw the sun by day, the moon by night, and a polar twilight’s sun as the day’s', () => {
    expect(weatherSign('clearsky_day')).toMatchObject({ sky: 'sun', cloud: 'none' });
    expect(weatherSign('clearsky_night')).toMatchObject({ sky: 'moon', cloud: 'none' });
    expect(weatherSign('fair_polartwilight')).toMatchObject({ sky: 'sun', cloud: 'small' });
    expect(weatherSign('partlycloudy_night')).toMatchObject({ sky: 'moon', cloud: 'big' });
  });

  it('say what falls, how much, and the flash', () => {
    expect(weatherSign('lightrain')).toMatchObject({ sky: null, fall: 'rain', amount: 1, thunder: false });
    expect(weatherSign('heavyrainshowersandthunder_day')).toMatchObject({
      sky: 'sun',
      fall: 'rain',
      amount: 3,
      thunder: true,
    });
    expect(weatherSign('lightssleetshowersandthunder_night')).toMatchObject({
      sky: 'moon',
      fall: 'sleet',
      amount: 1,
    });
    expect(weatherSign('lightssnowshowersandthunder_day')).toMatchObject({ fall: 'snow', thunder: true });
    expect(weatherSign('snow')).toMatchObject({ fall: 'snow', amount: 2 });
    expect(weatherSign('fog')).toMatchObject({ fog: true, fall: null });
  });

  it('draw a plain cloud for a symbol MET adds later', () => {
    expect(weatherSign('tornado_day')).toEqual({
      sky: null,
      cloud: 'big',
      fall: null,
      amount: 2,
      thunder: false,
      fog: false,
    });
  });
});
