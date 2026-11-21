/**
 * Web search for the agent with a Brave Search key (Whombat web-search.md): the person (`burrow.manage`) sets it, its
 * check is kept, and the person removes it. Setting and removing sign `burrow.web_search_changed` under Keys
 * (`webSearchKeysText`, never the key) and publish the burrow.
 */
import { WebSearchApiKey, WebSearchCheck, webSearchKeysText } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { burrows } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { sealWebSearchKey, webSearchKeyOf } from '../web-search/store';
import { publishBurrow } from './burrows';

const manage = (attempt: string) => ({ keyId: 'burrow.manage' as const, attempt, where: null });

/**
 * Turns web search on with a key the route already checked (`check`; a key Brave turned away never gets here). The key
 * is sealed (`burrows.web_search_key_enc`). The same key saved again writes and signs nothing: the route keeps its
 * fresh check with `recordWebSearchCheck` under the returned `updatedAt`.
 */
export const setWebSearch = defineCommand({
  name: 'set_web_search',
  schema: z.object({ apiKey: WebSearchApiKey, check: WebSearchCheck }),
  requiredKey: () => manage('turn on web search'),
  async apply(tx, ctx, input) {
    const saved = ctx.burrow.webSearch;
    const savedKey = saved ? webSearchKeyOf(ctx.services.custody, ctx.burrow) : null;
    if (saved && savedKey === input.apiKey)
      return { eventId: null as string | null, updatedAt: saved.updatedAt, changed: false };
    const change = saved ? ('changed' as const) : ('set' as const);
    const updatedAt = ctx.at;
    const [row] = await tx
      .update(burrows)
      .set({
        webSearch: { provider: 'brave', check: input.check, updatedAt },
        webSearchKeyEnc: sealWebSearchKey(ctx.services.custody, ctx.burrow.id, input.apiKey),
      })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    const event = await ctx.emit({
      type: 'burrow.web_search_changed',
      kind: 'Keys',
      text: webSearchKeysText({ actor: ctx.actor.shortName, change }),
      where: 'Settings · AI',
      payload: { change },
    });
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, event.id);
    }
    return { eventId: event.id as string | null, updatedAt, changed: true };
  },
});

/**
 * Before checking the saved key again: the person only (`burrow.manage`), and the key with its `updatedAt`, so the result
 * is kept only for it. `not_found` while web search is off or its key doesn't open. Writes nothing: the route checks
 * outside the transaction.
 */
export const prepareWebSearchCheck = defineCommand({
  name: 'prepare_web_search_check',
  schema: z.object({}),
  requiredKey: () => manage('check web search'),
  async apply(_tx, ctx) {
    const saved = ctx.burrow.webSearch;
    const key = saved ? webSearchKeyOf(ctx.services.custody, ctx.burrow) : null;
    if (!saved || !key) throw notFound('Web search');
    return { key, updatedAt: saved.updatedAt };
  },
});

/**
 * A check's result kept on web search (`WebSearchView.check`) and the burrow published — only while the key is the one
 * checked (`updatedAt`): a save in between keeps its own. Not signed: nothing about the setting changed.
 */
export const recordWebSearchCheck = defineCommand({
  name: 'record_web_search_check',
  schema: z.object({ updatedAt: z.string().min(1), check: WebSearchCheck }),
  requiredKey: () => manage('check web search'),
  async apply(tx, ctx, input) {
    const [row] = await tx
      .update(burrows)
      .set({
        webSearch: sql`jsonb_set(${burrows.webSearch}, '{check}', ${JSON.stringify(input.check)}::jsonb)`,
      })
      .where(and(eq(burrows.id, ctx.burrow.id), sql`${burrows.webSearch}->>'updatedAt' = ${input.updatedAt}`))
      .returning();
    if (!row) return { kept: false };
    ctx.burrow = row;
    await publishBurrow(ctx, row, null);
    return { kept: true };
  },
});

/** Turns web search off and forgets the key. Signs `removed`; nothing when there was none. */
export const clearWebSearch = defineCommand({
  name: 'clear_web_search',
  schema: z.object({}),
  requiredKey: () => manage('turn off web search'),
  async apply(tx, ctx) {
    if (!ctx.burrow.webSearch && !ctx.burrow.webSearchKeyEnc)
      return { removed: false, eventId: null as string | null };
    const [row] = await tx
      .update(burrows)
      .set({ webSearch: null, webSearchKeyEnc: null })
      .where(eq(burrows.id, ctx.burrow.id))
      .returning();
    const event = await ctx.emit({
      type: 'burrow.web_search_changed',
      kind: 'Keys',
      text: webSearchKeysText({ actor: ctx.actor.shortName, change: 'removed' }),
      where: 'Settings · AI',
      payload: { change: 'removed' },
    });
    if (row) {
      ctx.burrow = row;
      await publishBurrow(ctx, row, event.id);
    }
    return { removed: true, eventId: event.id as string | null };
  },
});
