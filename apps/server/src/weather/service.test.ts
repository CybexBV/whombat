import { describe, expect, it } from 'vitest';
import { type OpenDataAnswer, useOpenDataForTests } from '../lib/open-data';
import type { Services } from '../services';
import { metForecastUrl, nextAskAt, WEATHER_RETRY_MS, WeatherService } from './service';
import { metAnswer } from './testing';

const MIN = 60_000;

function world(answer: (url: string, headers: Record<string, string>) => OpenDataAnswer) {
  let now = Date.parse('2026-11-26T08:13:00Z');
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const services = {
    clock: () => new Date(now),
    log: { warn: () => undefined },
    config: { NODE_ENV: 'test' },
  } as unknown as Services;
  useOpenDataForTests(services, async (url, headers) => {
    asked.push({ url, headers });
    return answer(url, headers);
  });
  return {
    services,
    asked,
    later: (ms: number) => {
      now += ms;
    },
    weather: new WeatherService(services, () => 0.5),
  };
}

const ok = (headers: Record<string, string> = {}): OpenDataAnswer => ({
  status: 200,
  headers: {
    expires: 'Thu, 26 Nov 2026 08:43:00 GMT',
    'last-modified': 'Thu, 26 Nov 2026 08:00:00 GMT',
    ...headers,
  },
  body: Buffer.from(JSON.stringify(metAnswer('2026-11-26T08:00:00Z'))),
});

describe('when MET is asked again', () => {
  const now = Date.parse('2026-11-26T08:13:00Z');

  it('is after its answer expires, never within 30 minutes, a few minutes later and never on the hour', () => {
    // MET's own expiry, later than 30 minutes: that, plus the jitter.
    const expires = now + 50 * MIN;
    expect(nextAskAt(now, expires, 0)).toBe(expires + 2 * MIN);
    expect(nextAskAt(now, expires, 0.999)).toBeLessThan(expires + 8 * MIN);
    // An expiry sooner than 30 minutes: 30 minutes.
    expect(nextAskAt(now, now + 5 * MIN, 0)).toBe(now + 32 * MIN);
    expect(nextAskAt(now, null, 0)).toBe(now + 32 * MIN);
    // Landing on the hour moves it on.
    const onTheHour = nextAskAt(Date.parse('2026-11-26T08:28:00Z'), null, 0);
    expect(new Date(onTheHour).getUTCMinutes()).not.toBe(0);
  });

  it('names the place to two decimals', () => {
    expect(metForecastUrl(52.37321, 4.89)).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=52.37&lon=4.89',
    );
  });
});

describe('the weather service', () => {
  it('asks once, as Whombat, and keeps the forecast until it expires', async () => {
    const w = world(() => ok());
    const first = await w.weather.forecast(52.37, 4.9);
    expect(first?.steps.length).toBeGreaterThan(50);
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]?.headers['user-agent']).toMatch(/^Whombat\/\S+ \(\+https:\/\/whombat\.com\)$/);
    expect(w.asked[0]?.headers['if-modified-since']).toBeUndefined();
    w.later(20 * MIN);
    await w.weather.forecast(52.37, 4.9);
    expect(w.asked).toHaveLength(1);
  });

  it('sends back Last-Modified, and keeps what it has on a 304', async () => {
    let status = 200;
    const w = world(() => (status === 200 ? ok() : { status: 304, headers: {}, body: Buffer.alloc(0) }));
    const first = await w.weather.forecast(52.37, 4.9);
    status = 304;
    w.later(40 * MIN);
    const again = await w.weather.forecast(52.37, 4.9);
    expect(w.asked).toHaveLength(2);
    expect(w.asked[1]?.headers['if-modified-since']).toBe('Thu, 26 Nov 2026 08:00:00 GMT');
    expect(again).toBe(first);
  });

  it('keeps the last forecast when MET fails, and tries again after ten minutes', async () => {
    let fail = false;
    const w = world(() => (fail ? { status: 503, headers: {}, body: Buffer.alloc(0) } : ok()));
    const first = await w.weather.forecast(52.37, 4.9);
    fail = true;
    w.later(40 * MIN);
    expect(await w.weather.forecast(52.37, 4.9)).toBe(first);
    w.later(WEATHER_RETRY_MS - MIN);
    await w.weather.forecast(52.37, 4.9);
    expect(w.asked).toHaveLength(2);
    w.later(2 * MIN);
    await w.weather.forecast(52.37, 4.9);
    expect(w.asked).toHaveLength(3);
  });

  it('is nothing when MET never answered, and asks once for many at a time', async () => {
    const w = world(() => ({ status: 500, headers: {}, body: Buffer.alloc(0) }));
    const all = await Promise.all([
      w.weather.forecast(1, 2),
      w.weather.forecast(1, 2),
      w.weather.forecast(1, 2),
    ]);
    expect(all).toEqual([null, null, null]);
    expect(w.asked).toHaveLength(1);
  });
});
