/**
 * REST and session ops for the person's prompts (`api.prompts.*`, docs/decisions/prompts.md). Writes go through the
 * commit pipeline; T3 Code is asked outside any transaction (its projects, and what it runs for a prompt's AI).
 */
import { api, type PromptProjectsResponse, type UsePromptResponse } from '@whombat/core';
import { chosenAi } from '../council/members';
import { councilConnection, t3Projects } from '../council/run';
import { t3Providers } from '../council/setups';
import { forbidden } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { cachedRead } from '../things/kinds/read';
import type { PromptLaunchAi } from './brief';
import { createPrompt, listPrompts, removePrompt, restorePrompts, savePrompt, usePrompt } from './commands';

/** T3 Code's projects change when the person adds one: kept a minute, so the picker opens at once but stays current. */
const PROJECTS_KEEP_MS = 60_000;

const personOnly = (kind: string) => {
  if (kind !== 'person') throw forbidden('Only you keep your prompts.');
};

/** The projects a prompt can run on, by title; null with the reason when T3 Code can't be asked. */
export async function promptProjects(services: Services, burrowId: string): Promise<PromptProjectsResponse> {
  const connection = await councilConnection(services.db, burrowId);
  if (!connection) return { projects: null, t3: 'not_connected' };
  try {
    const found = await cachedRead(
      services,
      `t3code-projects:${connection.id}`,
      connection,
      () => t3Projects(services, connection),
      PROJECTS_KEEP_MS,
    );
    const projects = found
      .map((p) => ({
        id: p.id.slice(0, 200),
        title: p.title.slice(0, 200),
        folder: p.root ? p.root.slice(0, 400) : null,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return { projects, t3: 'ready' };
  } catch {
    return { projects: null, t3: 'unreachable' };
  }
}

export const promptRoutes: RouteDef[] = [
  route(api.prompts.list, async ({ services, access }) => {
    personOnly(access.principal.kind);
    return { prompts: await listPrompts(services.db, access.burrow.id) };
  }),
  route(api.prompts.create, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    return { prompt: await commitAs(ctx, createPrompt, ctx.body) };
  }),
  route(api.prompts.save, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    return { prompt: await commitAs(ctx, savePrompt, { ...ctx.body, promptId: ctx.params.promptId }) };
  }),
  route(api.prompts.remove, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    return { prompts: await commitAs(ctx, removePrompt, { promptId: ctx.params.promptId }) };
  }),
  route(api.prompts.restore, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    return { prompts: await commitAs(ctx, restorePrompts, {}) };
  }),
  route(api.prompts.projects, async ({ services, access }) => {
    personOnly(access.principal.kind);
    return promptProjects(services, access.burrow.id);
  }),
  route(api.prompts.use, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const prompt = (await listPrompts(ctx.services.db, ctx.access.burrow.id)).find(
      (p) => p.id === ctx.params.promptId,
    );
    // The AI the prompt names, as T3 Code runs it now; the command refuses an unknown prompt itself.
    let ai: PromptLaunchAi = { kind: 'default' };
    if (prompt?.ai) {
      const { providers } = await t3Providers(ctx.services, ctx.access.burrow.id);
      const chosen = providers ? chosenAi(providers, prompt.ai) : null;
      ai = chosen
        ? {
            kind: 'chosen',
            modelSelection: { instanceId: chosen.provider, model: chosen.model, options: chosen.options },
          }
        : { kind: 'unavailable', ai: prompt.ai };
    }
    const used = await commitAs(ctx, usePrompt, {
      promptId: ctx.params.promptId,
      conversationId: ctx.body.conversationId,
      ...(ctx.body.rootId ? { rootId: ctx.body.rootId } : {}),
      project: ctx.body.project,
      ai,
    });
    return used as UsePromptResponse;
  }),
];
