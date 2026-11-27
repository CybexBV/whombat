/**
 * The news in Settings → News and weather (docs/decisions/weather-news.md): `news.sources` reads the sources on and the
 * suggestions for the place; `news.browse` lists a country's suggestions from the table on the box; `news.setSources`
 * turns sources on and off; `news.addSite` looks at a source the person typed (outside the commit: one read, a feed or
 * the feed it leads to) and adds it; `news.importSites` looks at another reader's list the same way and adds what it
 * can in one commit. An app before more news is answered and limited as it was built (`older-apps.ts`).
 */

import type { AnyEndpoint } from '@whombat/core';
import {
  api,
  NEWS_SOURCES_MAX,
  NEWS_WORDS,
  type NewsChosenSource,
  type NewsImportSkipped,
  newsBrowse,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { placeOfBurrow } from '../place/store';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { addNewsSite, importNewsSites, newsFullError, newsSourcesOf, setNewsSources } from './commands';
import { findFeed } from './discover';
import { checkImports, newsSourceOfFeed } from './import';
import { addSiteResultFor, newsSourcesMaxFor, newsSourcesShownTo, newsViewFor } from './older-apps';
import { newsFor } from './reader';
import { newsSourcesView } from './view';

async function burrowRow(ctx: Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>) {
  const [row] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.access.burrow.id));
  if (!row) throw notFound('Whombat');
  return row;
}

/** `news.sources` as it is now. */
async function viewNow(ctx: Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>) {
  return newsSourcesView(newsFor(ctx.services), await burrowRow(ctx));
}

export const newsRoutes: RouteDef[] = [
  route(api.news.sources, async (ctx) => newsViewFor(await viewNow(ctx), ctx.protocolMinor)),
  route(api.news.browse, async (ctx) => {
    const row = await burrowRow(ctx);
    const on = new Set(newsSourcesOf(row).map((s) => s.id));
    return newsBrowse({ country: ctx.query.country, place: placeOfBurrow(row), on });
  }),
  route(api.news.setSources, async (ctx) => {
    const shown = newsSourcesShownTo(ctx.protocolMinor);
    await commitAs(ctx, setNewsSources, { ...ctx.body, ...(shown !== undefined && { shown }) });
    return newsViewFor(await viewNow(ctx), ctx.protocolMinor);
  }),
  route(api.news.addSite, async (ctx) => {
    const max = newsSourcesMaxFor(ctx.protocolMinor);
    // Full is said before the source is read.
    if (newsSourcesOf(await burrowRow(ctx)).length >= max) throw newsFullError(max);
    const { own, ...source } = newsSourceOfFeed(await findFeed(ctx.services, ctx.body.url));
    const { source: added } = await commitAs(ctx, addNewsSite, { source, max });
    const news = await viewNow(ctx);
    const shown: NewsChosenSource = news.chosen.find((s) => s.id === added.id) ?? { ...added, own };
    return addSiteResultFor({ added: shown, news }, ctx.protocolMinor);
  }),
  route(api.news.importSites, async (ctx) => {
    const checked = await checkImports(ctx.services, ctx.body.urls, newsSourcesOf(await burrowRow(ctx)));
    const sources = checked.flatMap((c) => ('source' in c ? [c.source] : []));
    const { added, full } = sources.length
      ? await commitAs(ctx, importNewsSites, { sources })
      : { added: [], full: [] };
    const fullIds = new Set(full.map((s) => s.id));
    const fullWords = NEWS_WORDS.full.replace('{n}', String(NEWS_SOURCES_MAX));
    const skipped: NewsImportSkipped[] = checked.flatMap((c) =>
      'problem' in c
        ? [{ url: c.url, problem: c.problem }]
        : 'source' in c && fullIds.has(c.source.id)
          ? [{ url: c.url, problem: fullWords }]
          : [],
    );
    const news = await viewNow(ctx);
    const addedIds = new Set(added.map((s) => s.id));
    return { added: news.chosen.filter((s) => addedIds.has(s.id)), skipped, news };
  }),
];
