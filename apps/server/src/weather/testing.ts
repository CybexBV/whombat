/**
 * Tests only: an answer shaped as MET Norway's Locationforecast 2.0 `complete` gives it (hourly steps for the first
 * 60 hours with their next hour, six and twelve hours; six-hourly steps after), with figures that follow a simple day
 * curve, so a test knows what each day must say.
 */

/** The temperature at an hour of the day (UTC): 2 °C at 04:00, 10 °C at 16:00. */
export const tempAt = (hourUtc: number) => 6 - 4 * Math.cos(((hourUtc - 4) / 24) * 2 * Math.PI);

/**
 * A MET answer from `from` (a whole hour, ISO) on: `days` days, rain of `rainPerHour` mm from 12:00 to 15:00 UTC (in the
 * six-hour steps, all of it in the 12:00 one).
 */
export function metAnswer(
  from: string,
  opts: { days?: number; rainPerHour?: number; updatedAt?: string } = {},
) {
  const start = Date.parse(from);
  const end = start + (opts.days ?? 9) * 24 * 3_600_000;
  const rain = opts.rainPerHour ?? 0.5;
  const series: unknown[] = [];
  for (let t = start; t < end; ) {
    const hourly = t - start < 60 * 3_600_000;
    const h = new Date(t).getUTCHours();
    const wet = h >= 12 && h < 15;
    const day = h >= 6 && h < 18;
    const sym = (base: string) =>
      base === 'cloudy' || base === 'rain' ? base : `${base}_${day ? 'day' : 'night'}`;
    series.push({
      time: new Date(t).toISOString().replace('.000', ''),
      data: {
        instant: {
          details: {
            air_temperature: Math.round(tempAt(h) * 10) / 10,
            wind_speed: 4.2,
            wind_speed_of_gust: 8.1,
            wind_from_direction: 225,
            relative_humidity: 81.5,
          },
        },
        ...(hourly
          ? {
              next_1_hours: {
                summary: { symbol_code: wet ? 'rain' : sym('partlycloudy') },
                details: { precipitation_amount: wet ? rain : 0, probability_of_precipitation: wet ? 80 : 5 },
              },
            }
          : {}),
        next_6_hours: {
          summary: { symbol_code: h >= 9 && h < 15 ? 'rain' : sym('fair') },
          details: {
            air_temperature_max: Math.round(Math.max(tempAt(h), tempAt((h + 6) % 24)) * 10) / 10,
            air_temperature_min: Math.round(Math.min(tempAt(h), tempAt((h + 6) % 24)) * 10) / 10,
            precipitation_amount: h === 12 ? 3 * rain : 0,
            probability_of_precipitation: h === 12 ? 80 : 10,
          },
        },
        next_12_hours: { summary: { symbol_code: 'cloudy' }, details: { probability_of_precipitation: 40 } },
      },
    });
    // After the hours, six-hour steps at 00, 06, 12 and 18 UTC, as MET gives them.
    const six = 6 * 3_600_000;
    t = t + 3_600_000 - start < 60 * 3_600_000 ? t + 3_600_000 : Math.floor(t / six) * six + six;
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [4.9, 52.37, 2] },
    properties: {
      meta: {
        updated_at: opts.updatedAt ?? new Date(start).toISOString().replace('.000', ''),
        units: { air_temperature: 'celsius', precipitation_amount: 'mm', wind_speed: 'm/s' },
      },
      timeseries: series,
    },
  };
}
