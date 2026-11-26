/**
 * The news sites a Whombat reads (docs/decisions/weather-news.md): the person (`burrow.manage`), or the assistant for
 * them through its settings tools, turns suggested sites on and off (`setNewsSources`, by id: a suggestion's, or a site
 * of their own that is on now) and adds a site of their own that `news.addSite` checked (`addNewsSite`). Up to
 * `NEWS_SOURCES_MAX`. One `burrow.updated` (System) naming the sites, never their addresses; nothing when nothing
 * changed.
 */
import {
  NEWS_SOURCES_MAX,
  NEWS_WORDS,
  NewsSetSourcesBody,
  NewsSource,
  type NewsSource as NewsSourceT,
  newsSuggestion,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { burrowWhere } from '../commands/burrows';
import { type ApplyContext, defineCommand } from '../commit/types';
import { burrows } from '../db/schema/index';
import { ApiError } from '../lib/errors';

const manage = (attempt: string) => ({ keyId: 'burrow.manage' as const, attempt, where: null });

/** The sites a burrow row has on, in order. */
export function newsSourcesOf(burrow: { news: { sources: NewsSourceT[] } | null }): NewsSourceT[] {
  return (burrow.news?.sources ?? []).filter((s) => NewsSource.safeParse(s).success);
}

/** “NOS Nieuws”, “NOS Nieuws and Omroep Brabant”, “NOS Nieuws, Omroep Brabant and 2 more”. */
function namesText(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

async function write(ctx: ApplyContext, sources: NewsSourceT[], text: string) {
  await ctx.tx
    .update(burrows)
    .set({ news: sources.length ? { sources } : null })
    .where(eq(burrows.id, ctx.burrow.id));
  const event = await ctx.emit({
    type: 'burrow.updated',
    kind: 'System',
    text,
    where: burrowWhere(ctx.services, ctx.burrow.slug),
    payload: { news: sources.map((s) => s.id) },
  });
  return { eventId: event.id as string | null };
}

export const setNewsSources = defineCommand({
  name: 'set_news_sources',
  schema: NewsSetSourcesBody,
  requiredKey: () => manage('choose the news sites'),
  async apply(_tx, ctx, input) {
    const now = newsSourcesOf(ctx.burrow);
    const next: NewsSourceT[] = [];
    for (const id of input.ids) {
      const row = newsSuggestion(id);
      const own = now.find((s) => s.id === id);
      const source = row ? { id: row.id, name: row.name, url: row.url } : own;
      if (!source)
        throw new ApiError(
          'validation_failed',
          'That news site isn’t one Whombat suggests or one that is on.',
          {
            fields: { ids: [`${id} isn’t a news site Whombat knows`] },
          },
        );
      next.push(source);
    }
    if (next.map((s) => s.id).join('\n') === now.map((s) => s.id).join('\n')) return { eventId: null };
    const on = next.filter((s) => !now.some((n) => n.id === s.id)).map((s) => s.name);
    const off = now.filter((s) => !next.some((n) => n.id === s.id)).map((s) => s.name);
    const text = [
      on.length ? `Turned on the news from ${namesText(on)}` : '',
      off.length ? `Turned off the news from ${namesText(off)}` : '',
    ]
      .filter(Boolean)
      .join('. ');
    return write(ctx, next, text || 'Put the news sites in a new order');
  },
});

/** A site `news.addSite` checked: its id, name and feed. */
export const addNewsSite = defineCommand({
  name: 'add_news_site',
  schema: z.object({ source: NewsSource }),
  requiredKey: () => manage('add a news site'),
  async apply(_tx, ctx, input) {
    const now = newsSourcesOf(ctx.burrow);
    const there = now.find((s) => s.id === input.source.id || s.url === input.source.url);
    if (there) return { source: there, eventId: null as string | null };
    if (now.length >= NEWS_SOURCES_MAX) {
      const message = NEWS_WORDS.full.replace('{n}', String(NEWS_SOURCES_MAX));
      throw new ApiError('validation_failed', message, { fields: { url: [message] } });
    }
    const { eventId } = await write(ctx, [...now, input.source], `Added the news site ${input.source.name}`);
    return { source: input.source, eventId };
  },
});
