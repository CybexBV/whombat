/**
 * The news sources a Whombat reads (docs/decisions/weather-news.md): the person (`burrow.manage`), or the assistant for
 * them through its settings tools, turns suggested sources on and off (`setNewsSources`, by id: a suggestion's, or one
 * of their own that is on now), adds one of their own that `news.addSite` checked (`addNewsSite`), and adds those of
 * another reader's list that `news.importSites` checked (`importNewsSites`, one change for the whole list). Up to
 * `NEWS_SOURCES_MAX`. One `burrow.updated` (System) naming the sources, never their addresses; nothing when nothing
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
import { withUnseenSources } from './older-apps';

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

/** The words for a full list, with the most this app lets the person have. */
export function newsFullError(max: number, field = 'url'): ApiError {
  const message = NEWS_WORDS.full.replace('{n}', String(max));
  return new ApiError('validation_failed', message, { fields: { [field]: [message] } });
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
  // `shown`: how many of the sources the app could see (an older app sees twelve); those after them stay on.
  schema: NewsSetSourcesBody.extend({ shown: z.number().int().min(0).max(NEWS_SOURCES_MAX).optional() }),
  requiredKey: () => manage('choose the news sites'),
  async apply(_tx, ctx, input) {
    const now = newsSourcesOf(ctx.burrow);
    const ids = withUnseenSources(input.ids, now, input.shown);
    if (ids.length > NEWS_SOURCES_MAX) throw newsFullError(NEWS_SOURCES_MAX, 'ids');
    const next: NewsSourceT[] = [];
    for (const id of ids) {
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

/** A source `news.addSite` checked: its id, name, feed and kind; `max`, the most the asking app allows. */
export const addNewsSite = defineCommand({
  name: 'add_news_site',
  schema: z.object({
    source: NewsSource,
    max: z.number().int().min(1).max(NEWS_SOURCES_MAX).default(NEWS_SOURCES_MAX),
  }),
  requiredKey: () => manage('add a news site'),
  async apply(_tx, ctx, input) {
    const now = newsSourcesOf(ctx.burrow);
    const there = now.find((s) => s.id === input.source.id || s.url === input.source.url);
    if (there) return { source: there, eventId: null as string | null };
    if (now.length >= input.max) throw newsFullError(input.max);
    const { eventId } = await write(ctx, [...now, input.source], `Added the news site ${input.source.name}`);
    return { source: input.source, eventId };
  },
});

/**
 * The sources of another reader's list that `news.importSites` checked, in the list's order: each one not on yet is
 * added until `NEWS_SOURCES_MAX` are on, the rest are `full`. One change, and one event, for the whole list.
 */
export const importNewsSites = defineCommand({
  name: 'import_news_sites',
  schema: z.object({ sources: z.array(NewsSource).max(NEWS_SOURCES_MAX) }),
  requiredKey: () => manage('add news sites from another reader’s list'),
  async apply(_tx, ctx, input) {
    const next = newsSourcesOf(ctx.burrow);
    const added: NewsSourceT[] = [];
    const full: NewsSourceT[] = [];
    for (const source of input.sources) {
      if (next.some((s) => s.id === source.id || s.url === source.url)) continue;
      if (next.length >= NEWS_SOURCES_MAX) {
        full.push(source);
        continue;
      }
      next.push(source);
      added.push(source);
    }
    if (added.length === 0) return { added, full, eventId: null as string | null };
    const names = namesText(added.map((s) => s.name));
    const { eventId } = await write(ctx, next, `Added the news from ${names} from another reader’s list`);
    return { added, full, eventId };
  },
});
