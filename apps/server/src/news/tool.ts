/**
 * `news_headlines` (docs/decisions/weather-news.md): the newest headlines of the news sites the person turned on, read
 * by this Whombat (`NewsReader`), each with its site, local time and link. `query` keeps those with all its words, here:
 * nothing the agent asks goes out. In a Looks ahead check a headline's link may then be read and named as a source.
 */
import { NEWS_HEADLINES_MAX, type NewsHeadlinesInput, type NewsHeadlinesOutput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { burrows } from '../db/schema/index';
import { aheadSawHeadlines } from '../looks-ahead/turn';
import type { ToolContext } from '../mcp/tools';
import { localIso } from '../weather/forecast';
import { newsSourcesOf } from './commands';
import { mergeHeadlines, newsFor } from './reader';

type Input = z.output<typeof NewsHeadlinesInput>;

/** What the agent hears when there are no headlines to give (to the agent, never the chat). */
export const NEWS_TOOL_TEXT = {
  none: 'No news site is on: the person turns them on in Settings → This Whombat → News, or asks you (settings_read news.sources, then settings_change news.setSources).',
  unavailable: 'None of the news sites could be read just now. Try again in a while.',
} as const;

const DEFAULT_LIMIT = 10;

/** Whether a headline has every word of the query (case and accents aside). */
function matches(title: string, query: string | undefined): boolean {
  if (!query) return true;
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const words = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const text = fold(title);
  return words.every((w) => text.includes(w));
}

export async function newsHeadlinesTool(ctx: ToolContext, input: Input): Promise<NewsHeadlinesOutput> {
  const [burrow] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.burrowId));
  const sources = burrow ? newsSourcesOf(burrow) : [];
  if (sources.length === 0) return { status: 'none', message: NEWS_TOOL_TEXT.none };
  const read = await newsFor(ctx.services).read(sources);
  if (!read.some((r) => r.ok || r.items.length > 0))
    return { status: 'unavailable', message: NEWS_TOOL_TEXT.unavailable };
  const timeZone = burrow?.timeZone ?? 'UTC';
  const all = mergeHeadlines(read, NEWS_HEADLINES_MAX * sources.length);
  const headlines = all
    .filter((h) => matches(h.title, input.query))
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map((h) => ({
      source: h.source,
      title: h.title,
      at: localIso(Date.parse(h.at), timeZone),
      link: h.link,
    }));
  aheadSawHeadlines(
    ctx.services,
    ctx.dispatch,
    headlines.map((h) => h.link),
  );
  return { status: 'ok', headlines, sources: read.map((r) => ({ name: r.source.name, read: r.ok })) };
}
