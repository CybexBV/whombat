/**
 * `news_headlines` (docs/decisions/weather-news.md): the newest headlines of the news sources the person turned on, read
 * by this Whombat (`NewsReader`), each with its source, local time and link, and no one source more than its share of
 * them. `query` keeps those with all its words from every headline read, here: nothing the agent asks goes out. In a
 * Looks ahead check a headline's link may then be read and named as a source.
 */
import { NEWS_HEADLINES_MAX, type NewsHeadlinesInput, type NewsHeadlinesOutput } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { burrows } from '../db/schema/index';
import { aheadSawHeadlines } from '../looks-ahead/turn';
import type { ToolContext } from '../mcp/tools';
import { localIso } from '../weather/forecast';
import { newsSourcesOf } from './commands';
import { mergeHeadlines, newsFor, newsShare } from './reader';

type Input = z.output<typeof NewsHeadlinesInput>;

/** What the agent hears when there are no headlines to give (to the agent, never the chat). */
export const NEWS_TOOL_TEXT = {
  none: 'No news source is on: the person turns them on in Settings → News and weather, or asks you (settings_read news.sources or news.browse, then settings_change news.setSources).',
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
  const limit = input.limit ?? DEFAULT_LIMIT;
  // With words to look for, every headline read that has them; without, the newest, no source past its share.
  const found = input.query
    ? mergeHeadlines(read, NEWS_HEADLINES_MAX * sources.length).filter((h) => matches(h.title, input.query))
    : mergeHeadlines(read, limit, newsShare(limit, sources.length));
  const headlines = found.slice(0, limit).map((h) => ({
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
