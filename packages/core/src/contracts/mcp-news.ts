/**
 * The news for the agent (Whombat weather-news.md): the latest headlines from the news sites the person turned on, read
 * by this Whombat like a feed reader. Spread into `MCP_TOOLS` (`./mcp`); read-only, no key. Nothing the agent asks goes
 * out: `query` filters what was read.
 */
import { z } from 'zod';
import { NEWS_HEADLINES_MAX } from '../domain/news.js';
import type { McpTool } from './mcp.js';

export const NewsHeadlinesInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(NEWS_HEADLINES_MAX)
    .optional()
    .describe('How many headlines, newest first: 1 to 30 (default 10)'),
  query: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .optional()
    .describe('Only headlines with these words (looked for here; nothing is sent out)'),
});
export type NewsHeadlinesInput = z.input<typeof NewsHeadlinesInput>;

/** A headline: its site, its words, when it was published (local time with its offset) and its link. */
export const NewsHeadlineItem = z.object({
  source: z.string(),
  title: z.string(),
  at: z.string(),
  link: z.string(),
});
export type NewsHeadlineItem = z.infer<typeof NewsHeadlineItem>;

export const NewsHeadlinesOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    headlines: z.array(NewsHeadlineItem),
    /** Each site that is on, and whether it could be read just now. */
    sources: z.array(z.object({ name: z.string(), read: z.boolean() })),
  }),
  /** No news site is on (the person turns them on in Settings → This Whombat → News). */
  z.object({ status: z.literal('none'), message: z.string() }),
  /** None of the sites could be read just now. */
  z.object({ status: z.literal('unavailable'), message: z.string() }),
]);
export type NewsHeadlinesOutput = z.infer<typeof NewsHeadlinesOutput>;

export const NEWS_MCP_TOOLS = {
  news_headlines: {
    name: 'news_headlines',
    title: 'News headlines',
    description:
      'The latest headlines from the news sites the person turned on (local and national), newest first: each one’s site, words, time and link. Only headlines, no articles: open the link with your browser for more. status none: no site is on (the person chooses them in Settings → This Whombat → News, or asks you).',
    input: NewsHeadlinesInput,
    output: NewsHeadlinesOutput,
    requiredKey: null,
    readOnly: true,
  } satisfies McpTool<typeof NewsHeadlinesInput, typeof NewsHeadlinesOutput>,
} as const;
