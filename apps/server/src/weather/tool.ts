/**
 * `weather_forecast` (docs/decisions/weather-news.md): MET Norway's forecast where this Whombat is (its place, or its
 * time zone's guess), in its own time zone; or, given `place`, for that town looked up on OpenStreetMap first, in the
 * time zone nearest it. In a Looks ahead check another place is asked only while the web is open and by public words
 * (`aheadPlaceAllowed`); the forecast may then be a finding's source. What it answers goes to the agent, never the chat.
 */
import {
  type Place,
  timeZoneNear,
  WEATHER_WORDS,
  type WeatherForecastInput,
  type WeatherForecastOutput,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { burrows } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import { aheadPlaceAllowed, aheadSawWeather } from '../looks-ahead/turn';
import type { ToolContext } from '../mcp/tools';
import { placeFinderFor } from '../place/nominatim';
import { placeOfBurrow } from '../place/store';
import { weatherFor } from './service';
import { weatherToolOutput } from './view';

type Input = z.output<typeof WeatherForecastInput>;

/** What the agent hears when there is no forecast to give (to the agent, never the chat). */
export const WEATHER_TOOL_TEXT = {
  noPlace:
    'This Whombat doesn’t know where it is yet: the person sets it in Settings → This Whombat → Place (or tells you the town, and you set it with settings_change place.set).',
  notFound: 'OpenStreetMap doesn’t know a place by that name: try the town’s name, or a bigger town nearby.',
  unavailable: 'MET Norway’s forecast can’t be read just now. Try again in a while.',
} as const;

const DEFAULT_DAYS = 3;

export async function weatherForecastTool(ctx: ToolContext, input: Input): Promise<WeatherForecastOutput> {
  const { services, dispatch } = ctx;
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, ctx.burrowId));
  if (!burrow) return { status: 'no_place', message: WEATHER_TOOL_TEXT.noPlace };
  let place: Place | null;
  let timeZone = burrow.timeZone;
  if (input.place) {
    if (dispatch.trigger === 'ahead') await aheadPlaceAllowed(services, dispatch, input.place);
    try {
      [place = null] = await placeFinderFor(services).find({ query: input.place });
    } catch (err) {
      if (err instanceof ApiError) return { status: 'unavailable', message: err.message };
      throw err;
    }
    if (!place) return { status: 'no_place', message: WEATHER_TOOL_TEXT.notFound };
    timeZone = timeZoneNear(place.lat, place.lon, place.country) ?? timeZone;
  } else {
    place = placeOfBurrow(burrow);
    if (!place) return { status: 'no_place', message: WEATHER_TOOL_TEXT.noPlace };
  }
  const forecast = await weatherFor(services).forecast(place.lat, place.lon);
  if (!forecast) return { status: 'unavailable', message: WEATHER_TOOL_TEXT.unavailable };
  const out = weatherToolOutput(place, forecast, services.clock(), timeZone, input.days ?? DEFAULT_DAYS);
  if (out.status === 'ok') aheadSawWeather(services, dispatch);
  else if (out.status === 'unavailable') return { status: 'unavailable', message: WEATHER_WORDS.problem };
  return out;
}
