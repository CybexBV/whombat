/**
 * The news in Settings → This Whombat (docs/decisions/weather-news.md): `news.sources` reads the sites on and the
 * suggestions for the place; `news.setSources` turns sites on and off; `news.addSite` looks at a site the person typed
 * (outside the commit: one read, a feed or the feed a page names) and adds it.
 */

import type { AnyEndpoint } from '@whombat/core';
import {
  api,
  NEWS_SOURCES_MAX,
  NEWS_SUGGESTIONS,
  NEWS_WORDS,
  type NewsChosenSource,
  ownNewsSourceId,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { ApiError, notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { addNewsSite, newsSourcesOf, setNewsSources } from './commands';
import { findFeed } from './discover';
import { newsFor } from './reader';
import { newsSourcesView } from './view';

async function burrowRow(ctx: Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>) {
  const [row] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.access.burrow.id));
  if (!row) throw notFound('Whombat');
  return row;
}

export const newsRoutes: RouteDef[] = [
  route(api.news.sources, async (ctx) => newsSourcesView(newsFor(ctx.services), await burrowRow(ctx))),
  route(api.news.setSources, async (ctx) => {
    await commitAs(ctx, setNewsSources, ctx.body);
    return newsSourcesView(newsFor(ctx.services), await burrowRow(ctx));
  }),
  route(api.news.addSite, async (ctx) => {
    // Full is said before the site is read.
    if (newsSourcesOf(await burrowRow(ctx)).length >= NEWS_SOURCES_MAX) {
      const message = NEWS_WORDS.full.replace('{n}', String(NEWS_SOURCES_MAX));
      throw new ApiError('validation_failed', message, { fields: { url: [message] } });
    }
    const feed = await findFeed(ctx.services, ctx.body.url);
    // A site Whombat suggests keeps its own id and name.
    const known = NEWS_SUGGESTIONS.find((s) => s.url === feed.url);
    const source = known
      ? { id: known.id, name: known.name, url: known.url }
      : { id: ownNewsSourceId(feed.url), name: feed.name || 'News', url: feed.url };
    const { source: added } = await commitAs(ctx, addNewsSite, { source });
    const news = newsSourcesView(newsFor(ctx.services), await burrowRow(ctx));
    const shown: NewsChosenSource = news.chosen.find((s) => s.id === added.id) ?? { ...added, own: !known };
    return { added: shown, news };
  }),
];
