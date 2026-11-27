/**
 * What a weather sign is made of (Whombat weather-news.md): MET Norway's symbol (`partlycloudy_night`, `heavyrain`)
 * read as a few parts the screen draws as its own line icons — the sun or the moon, a cloud, what falls, how much, a
 * flash, fog. Pure, so the drawing and the tests agree. A symbol this table doesn't know is a plain cloud.
 */
import { screenNumberText } from './words';

export type WeatherSky = 'sun' | 'moon';
export type WeatherFall = 'rain' | 'sleet' | 'snow';

export interface WeatherSign {
  /** The sun or the moon: alone (`cloud` none), with a small cloud, or peeking from behind the cloud. */
  sky: WeatherSky | null;
  cloud: 'none' | 'small' | 'big';
  fall: WeatherFall | null;
  /** Light, plain, heavy. */
  amount: 1 | 2 | 3;
  thunder: boolean;
  fog: boolean;
}

/** MET's bases the table knows (core `WEATHER_SYMBOLS`' keys, kept equal by a test). */
const KNOWN =
  /^(clearsky|fair|partlycloudy|cloudy|fog|(light|heavy)?s?(rain|sleet|snow)(showers)?(andthunder)?)$/;

/** A symbol's base and whether it's the night's (`_night`); a polar twilight's sun is drawn as the day's. */
export function weatherSymbolBase(symbol: string): { base: string; night: boolean } {
  const [base = '', time] = symbol.split('_');
  return { base, night: time === 'night' };
}

/** The parts of a sign for a symbol. */
export function weatherSign(symbol: string): WeatherSign {
  const { base, night } = weatherSymbolBase(symbol);
  const sky: WeatherSky = night ? 'moon' : 'sun';
  const plain: WeatherSign = { sky: null, cloud: 'big', fall: null, amount: 2, thunder: false, fog: false };
  if (!KNOWN.test(base)) return plain;
  if (base === 'clearsky') return { ...plain, sky, cloud: 'none' };
  if (base === 'fair') return { ...plain, sky, cloud: 'small' };
  if (base === 'partlycloudy') return { ...plain, sky };
  if (base === 'cloudy') return plain;
  if (base === 'fog') return { ...plain, fog: true };
  const fall: WeatherFall = base.includes('snow') ? 'snow' : base.includes('sleet') ? 'sleet' : 'rain';
  return {
    sky: base.includes('showers') ? sky : null,
    cloud: 'big',
    fall,
    amount: base.startsWith('light') ? 1 : base.startsWith('heavy') ? 3 : 2,
    thunder: base.endsWith('andthunder'),
    fog: false,
  };
}

/** Keep the true minus sign in temperatures and the locale's decimal separator in all weather figures. */
export function weatherAmountText(value: number, locale?: string | null): string {
  const amount = screenNumberText(Math.abs(value), locale);
  return value < 0 ? `−${amount}` : amount;
}
