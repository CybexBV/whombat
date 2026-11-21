/**
 * A Custom connection's page from its recipe, as a kind (docs/decisions/connection-looks.md): the page reads what the
 * recipe names and lays it out in slots, and the health pass every five minutes keeps its trend's and counts' readings,
 * the card's facts and Worth a look's lines. A connection without a recipe, or with one this version can't read, has the
 * generic page.
 */
import { type ConnectionPage, ConnectionPage as ConnectionPageSchema } from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { problemOf } from '../kinds/read';
import type { KindModule, KindSeen } from '../kinds/registry';
import type { KindView } from '../kinds/types';
import { displayName } from '../part-of';
import { readPoints } from '../points';
import { registerChecks } from '../quiet/defaults';
import {
  type Built,
  buildRecipe,
  PAGE_CHECKS,
  type ReadAnswer,
  recipePointKeys,
  recipePoints,
} from './build';
import { pageRead, readOnce, readOnlyTools } from './read';

registerChecks(PAGE_CHECKS);

/** The entries a recipe may give a page. */
export const RECIPE_CATALOG_IDS: ReadonlySet<string> = new Set(['custom_api', 'custom_mcp']);

/** The connection's recipe when it has one this version reads. */
export function recipeOf(row: Pick<CatalogConnectionRow, 'catalogId' | 'page'>): ConnectionPage | null {
  if (!RECIPE_CATALOG_IDS.has(row.catalogId) || !row.page) return null;
  const parsed = ConnectionPageSchema.safeParse(row.page);
  return parsed.success ? parsed.data : null;
}

/** A week and a day of readings: a count's change on last week, the trend's seven days. */
const POINTS_MS = 8 * 86_400_000;

/**
 * Every read of a recipe, at once. `fresh` reads now and waits for each (the assistant trying it); otherwise the page's
 * cached reads (the last answer while younger than the read's `everyS`).
 */
export async function readAll(
  services: Services,
  row: CatalogConnectionRow,
  page: ConnectionPage,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<{ answers: Map<string, ReadAnswer>; at: Date | null; refreshing: boolean }> {
  const name = displayName(row);
  const tools = page.reads.some((r) => r.tool !== undefined)
    ? await readOnlyTools(services, row.id)
    : new Set<string>();
  const answers = new Map<string, ReadAnswer>();
  let at: Date | null = null;
  let refreshing = false;
  await Promise.all(
    page.reads.map(async (read) => {
      if (fresh) {
        try {
          answers.set(read.id, { ok: true, value: await readOnce(services, row, read, tools) });
          at = services.clock();
        } catch (err) {
          answers.set(read.id, { ok: false, problem: problemOf(err, name).message });
        }
        return;
      }
      const latest = await pageRead(services, row, read, tools);
      if (latest.refreshing) refreshing = true;
      if (latest.ok) {
        answers.set(read.id, { ok: true, value: latest.value });
        if (!at || latest.at > at) at = latest.at;
      } else answers.set(read.id, { ok: false, problem: problemOf(latest.error, name).message });
    }),
  );
  return { answers, at, refreshing };
}

/** The recipe's page, built from its answers and the readings Whombat keeps. */
export async function recipeBuilt(
  services: Services,
  row: CatalogConnectionRow,
  page: ConnectionPage,
  answers: ReadonlyMap<string, ReadAnswer>,
  now: Date,
  timeZone: string,
): Promise<Built> {
  const points = await readPoints(services.db, row.id, recipePointKeys(page), now, POINTS_MS);
  return buildRecipe(page, answers, { now, timeZone, name: displayName(row), points });
}

/** The page part of a connection with a recipe. */
function recipeModule(page: ConnectionPage): KindModule {
  return {
    checks: PAGE_CHECKS,
    async page(ctx): Promise<KindView> {
      const { answers, at, refreshing } = await readAll(ctx.services, ctx.row, page);
      const built = await recipeBuilt(ctx.services, ctx.row, page, answers, ctx.now, ctx.timeZone);
      const failed = [...answers.values()].filter((a) => !a.ok);
      const problem =
        failed.length === answers.size && failed[0] && !failed[0].ok ? failed[0].problem : undefined;
      return {
        ...built.view,
        tabs: [],
        actions: [],
        suggestions: [],
        readAt: at,
        ...(refreshing ? { refreshing: true } : {}),
        ...(problem ? { problem } : {}),
      };
    },
    async seen(services, row, now, timeZone): Promise<KindSeen> {
      const { answers } = await readAll(services, row, page);
      const built = await recipeBuilt(services, row, page, answers, now, timeZone);
      const counts = built.view.panels.find((p) => p.id === 'counts');
      const facts =
        counts?.kind === 'list'
          ? counts.items
              .slice(0, 3)
              .map((i) => ({ label: i.title.slice(0, 40), value: i.figure?.value ?? i.right ?? '' }))
          : [];
      return {
        glance: { facts: facts.filter((f) => f.value) },
        points: recipePoints(page, answers),
        notices: built.view.notices,
      };
    },
  };
}

const modules = new WeakMap<object, KindModule>();

/** The kind a connection's recipe makes, when it has one. */
export function recipeKind(row: Pick<CatalogConnectionRow, 'catalogId' | 'page'>): KindModule | undefined {
  const page = recipeOf(row);
  if (!page || !row.page) return undefined;
  let mod = modules.get(row.page);
  if (!mod) {
    mod = recipeModule(page);
    modules.set(row.page, mod);
  }
  return mod;
}
