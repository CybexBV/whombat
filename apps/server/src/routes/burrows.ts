import type { AnyEndpoint } from '@whombat/core';
import { api, isValidBurrowSlug, RESERVED_SLUGS, slugify, WEB_SEARCH_COPY } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { canManageClients } from '../clients/routes';
import { aiClients, isClientProvider } from '../clients/service';
import {
  burrowWhere,
  clearLocalModel,
  completeOnboarding,
  createBurrow,
  prepareLocalModelTest,
  recordLocalModelCheck,
  setAgentsReachLan,
  setAiGateway,
  setLocalModel,
  setRepoEnabled,
  updateBurrow,
  updateOnboarding,
  webOrigin,
} from '../commands/burrows';
import {
  clearWebSearch,
  prepareWebSearchCheck,
  recordWebSearchCheck,
  setWebSearch,
} from '../commands/web-search';
import type { CommandDef } from '../commit/types';
import { burrows, repos } from '../db/schema/index';
import { localRepoCreateInfo } from '../github/local-repos';
import { ApiError, conflict, notFound, unauthorized } from '../lib/errors';
import { testLocalModel } from '../local-model/check';
import { localModelView } from '../local-model/store';
import { loadPrincipalRow, toAgent, toPerson } from '../read/principals';
import { burrowView } from '../read/views';
import { onboardingState, repoRows, toRepo } from '../read/work-views';
import { checkWebSearchKey } from '../web-search/check';
import { webSearchView } from '../web-search/store';
import type { HandlerContext } from './define';
import { ok, route } from './define';

/** Runs a command as the caller in the route's burrow; 403 / 202 for blocked / asked. */
export async function commitAs<S extends z.ZodType, R>(
  ctx: Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>,
  command: CommandDef<S, R>,
  input: z.input<S>,
): Promise<R> {
  return ok(
    await ctx.services.pipeline.commit(command, input, {
      burrowId: ctx.access.burrow.id,
      actorId: ctx.access.principal.id,
    }),
  );
}

async function reloadBurrow(ctx: HandlerContext<AnyEndpoint>) {
  const [row] = await ctx.services.db.select().from(burrows).where(eq(burrows.id, ctx.access.burrow.id));
  if (!row) throw notFound('Whombat');
  return row;
}

export const burrowRoutes = [
  route(api.burrows.slugCheck, async ({ query, services }) => {
    const slug = slugify(query.name);
    const reserved = RESERVED_SLUGS.includes(slug);
    const valid = isValidBurrowSlug(slug);
    const [taken] = valid
      ? await services.db.select({ id: burrows.id }).from(burrows).where(eq(burrows.slug, slug))
      : [];
    return {
      name: query.name,
      slug,
      host: burrowWhere(services, slug),
      available: valid && !taken,
      reason: reserved
        ? ('reserved' as const)
        : !valid
          ? ('invalid' as const)
          : taken
            ? ('taken' as const)
            : null,
    };
  }),

  route(api.burrows.create, async ({ auth, body, services }) => {
    if (!auth.account) throw unauthorized();
    const { burrowId, principalId } = await createBurrow(services, auth.account.id, body.name);
    const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
    const me = await loadPrincipalRow(services.db, principalId);
    if (!burrow || !me) throw notFound('Whombat');
    return {
      burrow: await burrowView(services.db, burrow),
      me: toPerson(me),
      onboarding: await onboardingState(services.db, burrow, webOrigin(services)),
    };
  }),

  route(api.burrows.get, async ({ access, services }) => ({
    burrow: await burrowView(services.db, access.burrow),
  })),

  route(api.burrows.update, async (ctx) => {
    await commitAs(ctx, updateBurrow, ctx.body);
    return { burrow: await burrowView(ctx.services.db, await reloadBurrow(ctx)) };
  }),

  // “Agents may reach your local network” (resourceful-agents.md RA-41).
  route(api.burrows.setAgentsReachLan, async (ctx) => {
    const { eventId } = await commitAs(ctx, setAgentsReachLan, ctx.body);
    return { burrow: await burrowView(ctx.services.db, await reloadBurrow(ctx)), eventId };
  }),

  // The AI gateway's switches (ai-gateway.md AIG-05, AIG-06).
  route(api.burrows.setAiGateway, async (ctx) => {
    const { eventId } = await commitAs(ctx, setAiGateway, ctx.body);
    return { burrow: await burrowView(ctx.services.db, await reloadBurrow(ctx)), eventId };
  }),

  // The model on the person's network (hermes-engine.md HE-08, HE-32, HE-S90…; CT-1171): saved, then tested at once
  // outside the transaction, the result kept unless it changed meanwhile.
  route(api.burrows.setLocalModel, async (ctx) => {
    const saved = await commitAs(ctx, setLocalModel, ctx.body);
    const check = await testLocalModel(ctx.services, saved.target);
    await commitAs(ctx, recordLocalModelCheck, { updatedAt: saved.updatedAt, check });
    const row = await reloadBurrow(ctx);
    const localModel = localModelView(row);
    if (!localModel) throw notFound('Custom AI model');
    return { burrow: await burrowView(ctx.services.db, row), localModel, eventId: saved.eventId };
  }),

  route(api.burrows.testLocalModel, async (ctx) => {
    const { target, updatedAt } = await commitAs(ctx, prepareLocalModelTest, ctx.body);
    const check = await testLocalModel(ctx.services, target);
    if (updatedAt) await commitAs(ctx, recordLocalModelCheck, { updatedAt, check });
    return { check };
  }),

  route(api.burrows.clearLocalModel, async (ctx) => {
    const { removed, eventId } = await commitAs(ctx, clearLocalModel, {});
    return { burrow: await burrowView(ctx.services.db, await reloadBurrow(ctx)), removed, eventId };
  }),

  // Web search with a Brave Search key (web-search.md): the key is checked first, outside any transaction, and a key
  // Brave turns away is never saved; any other answer is saved with its check.
  route(api.burrows.setWebSearch, async (ctx) => {
    const check = await checkWebSearchKey(ctx.services, ctx.body.apiKey);
    if (check.state === 'invalid_key')
      throw new ApiError('validation_failed', WEB_SEARCH_COPY.invalidKey, {
        fields: { apiKey: [WEB_SEARCH_COPY.invalidKey] },
      });
    const saved = await commitAs(ctx, setWebSearch, { apiKey: ctx.body.apiKey, check });
    // The same key again: nothing changed, but the fresh check is kept.
    if (!saved.changed) await commitAs(ctx, recordWebSearchCheck, { updatedAt: saved.updatedAt, check });
    const row = await reloadBurrow(ctx);
    const webSearch = webSearchView(row);
    if (!webSearch) throw notFound('Web search');
    return { burrow: await burrowView(ctx.services.db, row), webSearch, eventId: saved.eventId };
  }),

  route(api.burrows.testWebSearch, async (ctx) => {
    const { key, updatedAt } = await commitAs(ctx, prepareWebSearchCheck, {});
    const check = await checkWebSearchKey(ctx.services, key);
    await commitAs(ctx, recordWebSearchCheck, { updatedAt, check });
    return { check };
  }),

  route(api.burrows.clearWebSearch, async (ctx) => {
    const { removed, eventId } = await commitAs(ctx, clearWebSearch, {});
    return { burrow: await burrowView(ctx.services.db, await reloadBurrow(ctx)), removed, eventId };
  }),

  route(api.onboarding.get, async ({ access, services }) =>
    onboardingState(services.db, access.burrow, webOrigin(services)),
  ),

  route(api.onboarding.update, async (ctx) => {
    await commitAs(ctx, updateOnboarding, ctx.body);
    // “Set up your AI” (CT-68): choosing Claude Code installs it (`clients.install`), for the person; each install
    // runs on in the background and shows in `clients.list`. Choosing ChatGPT installs nothing (HN-A01).
    const install = (ctx.body.clients ?? []).filter(isClientProvider);
    if (install.length && (await canManageClients(ctx.services, ctx.auth))) {
      const clients = await aiClients(ctx.services);
      for (const provider of install)
        void clients
          .install(provider)
          .catch((err) =>
            ctx.services.log.warn(
              { err: String(err), provider },
              'onboarding: could not install the AI client',
            ),
          );
    }
    return onboardingState(ctx.services.db, await reloadBurrow(ctx), webOrigin(ctx.services));
  }),

  route(api.onboarding.complete, async (ctx) => {
    const result = await commitAs(ctx, completeOnboarding, ctx.body);
    const db = ctx.services.db;
    const agent = await loadPrincipalRow(db, result.agentId);
    if (!agent) throw notFound('Agent');
    return {
      burrow: await burrowView(ctx.services.db, await reloadBurrow(ctx)),
      agent: toAgent(agent),
      redirectTo: result.redirectTo,
    };
  }),

  route(api.repos.list, async ({ access, auth, services }) => {
    const rows = await repoRows(services.db, access.burrow.id);
    return {
      repos: rows.map(toRepo),
      githubConnected: await services.github.isConnected(access.burrow.id),
      // Creating one on this Whombat (repositories.md RP-03): whether the caller may, and as which account.
      create: localRepoCreateInfo(access, auth),
    };
  }),

  // An older app's repo switch: every repository is the agent's now (docs/decisions/agent-repos.md AGR-11), so switching
  // one on still works and switching one off is refused.
  route(api.repos.update, async (ctx) => {
    if (!ctx.body.enabled)
      throw conflict('Repositories can’t be switched off any more. Your assistant can work in all of them.');
    await commitAs(ctx, setRepoEnabled, { repoId: ctx.params.repoId, enabled: ctx.body.enabled });
    const [row] = await ctx.services.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, ctx.params.repoId), eq(repos.burrowId, ctx.access.burrow.id)));
    if (!row) throw notFound('Repository');
    return { repo: toRepo(row) };
  }),
];
