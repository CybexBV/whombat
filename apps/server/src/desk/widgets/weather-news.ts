/**
 * What the `weather` and `news` widgets read (docs/decisions/weather-news.md; desk-display.md): the burrow's place and
 * its forecast, and the headlines of the news sites it reads. One read per burrow for every widget of either kind; the
 * forecast and the feeds keep their own pace (`WeatherService`, `NewsReader`), so a read here costs MET and the sites
 * nothing while what they gave is fresh. A read never throws for a site or MET that can't be reached: the view says so.
 */
import { NEWS_HEADLINES_MAX } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../../db/schema/index';
import { newsSourcesOf } from '../../news/commands';
import { mergeHeadlines, newsFor } from '../../news/reader';
import type { NewsRead } from '../../news/view';
import { placeOfBurrow } from '../../place/store';
import type { Services } from '../../services';
import { weatherFor } from '../../weather/service';
import type { WeatherRead } from '../../weather/view';

/** The widgets' reads are kept this long before they are made again from what the services keep. */
export const WEATHER_KEEP_MS = 2 * 60_000;
export const NEWS_KEEP_MS = 60_000;

/** The burrow's place and its forecast (null when MET never answered). */
export async function readWeather(services: Services, burrowId: string): Promise<WeatherRead> {
  const [row] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  const place = row ? placeOfBurrow(row) : null;
  if (!place) return { place: null, forecast: null };
  return { place, forecast: await weatherFor(services).forecast(place.lat, place.lon) };
}

/** The headlines of the news sites the burrow reads, newest first. */
export async function readNews(services: Services, burrowId: string): Promise<NewsRead> {
  const [row] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  const sources = row ? newsSourcesOf(row) : [];
  if (sources.length === 0) return { sources: 0, headlines: [], anyRead: false };
  const read = await newsFor(services).read(sources);
  return {
    sources: sources.length,
    headlines: mergeHeadlines(read, NEWS_HEADLINES_MAX),
    anyRead: read.some((r) => r.ok),
  };
}
