/**
 * `/internal/runner/*` (runner token): claim, progress, complete, heartbeat, the person, git credentials and gh. Thin
 * adapters over `RunnerRuntime`; the token is `Authorization: Bearer <RUNNER_TOKEN>`.
 */

import { timingSafeEqual } from 'node:crypto';
import { runnerApi } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pushAllowance } from '../approvals/push';
import { bearerOf } from '../auth/request';
import { approvedPushFor } from '../automations/workspace';
import {
  forgetForTurn,
  keepForTurn,
  listForTurn,
  renewKeptSite,
  restoreKeptSites,
} from '../browser/kept-sites';
import { loginSecretFor } from '../browser/logins';
import { previewsFor } from '../browser/previews';
import { dispatches, repos } from '../db/schema/index';
import { authorizeGh } from '../github/agent-gh';
import { ensureAgentRepo } from '../github/agent-repos';
import { ApiError, unauthorized } from '../lib/errors';
import { dispatchCredential } from '../managed/providers/credential-owner';
import { onBehalfOf } from '../mcp/tools';
import { personAccountId } from '../read/principals';
import { OutcomeReply, ok, type RouteDef, runnerRoute as route } from '../routes/define';
import type { Services } from '../services';
import { loginAskFor, loginAskWaitFor } from '../vault/turn-asks';
import { dispatchScopeOf, runInDispatchScope } from './dispatch-scope';
import { authorizeGit } from './git';

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 401 unless the request carries one of the configured runner tokens. */
export function requireRunner(services: Services, req: FastifyRequest): void {
  const token = bearerOf(req.headers);
  if (!token || !services.runtime.tokens().some((t) => sameSecret(t, token)))
    throw unauthorized('A runner token is required.');
}

/**
 * Aborts when the long-polling runner hangs up, so a claim is not handed to nobody. The response's `close` before
 * it finished is the hang-up: the request's own `close` fires as soon as its body was read (Node ≥ 16), which would
 * end every long poll at once — the runner then polls in a tight loop (the managed runtime's memory growth,
 * docs/decisions/managed-runtime.md MR-30).
 */
export function disconnectSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const res = reply.raw;
  if (res.destroyed && !res.writableFinished) controller.abort();
  else
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
  return controller.signal;
}

/**
 * Every runner long-polls `claim` (a request each wait) and sends heartbeats and progress every few seconds:
 * logged at `warn`, so journald and whombat.log keep errors but not a line per poll.
 */
const QUIET = { logLevel: 'warn' } as const;

/** A site's cookies: up to `KEPT_SITE_COOKIES_MAX` of them at their largest. */
const KEPT_COOKIES = { ...QUIET, bodyLimit: 8 * 1024 * 1024 } as const;

export const runnerRoutes: RouteDef[] = [
  route(
    runnerApi.claim,
    async ({ body, req, reply, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.claim(body, disconnectSignal(reply));
      // Whose provider sign-in the turn uses (managed-providers.md PV-04; DispatchContext.credential in 0.5.0): always
      // on a managed appliance; self-hosted only for an agent with a credential source (SUB-22), else the operator's.
      if (!dispatch) return { dispatch };
      // A turn through the AI gateway uses no sign-in (ai-gateway.md AIG-07): no credential, no requester refusals.
      if (dispatch.gateway) return { dispatch };
      // Nor does one on the scripted Hermes of a server that allows it (HE-46: the dev stack, the demo, tests).
      if (services.runtime.scriptedRunner(body.runnerId)) return { dispatch };
      const credential = await dispatchCredential(services, dispatch);
      return { dispatch: credential ? { ...dispatch, credential } : dispatch };
    },
    QUIET,
  ),

  route(
    runnerApi.progress,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      return services.runtime.progress(params.dispatchId, body);
    },
    QUIET,
  ),

  route(runnerApi.complete, async ({ body, params, req, services }) => {
    requireRunner(services, req);
    // The final reply is the dispatch's own work: what it hands to other agents is for the same person (CT-69).
    const [row] = await services.db.select().from(dispatches).where(eq(dispatches.id, params.dispatchId));
    if (row)
      await runInDispatchScope(dispatchScopeOf(row), () =>
        services.runtime.complete(params.dispatchId, body),
      );
    else await services.runtime.complete(params.dispatchId, body);
    return { ok: true as const };
  }),

  route(
    runnerApi.heartbeat,
    async ({ body, req, services }) => {
      requireRunner(services, req);
      return services.runtime.heartbeat(body);
    },
    QUIET,
  ),

  // The Whombat's person (one-person.md OP-S131): the runner moves the files it kept per account to them at its start.
  route(runnerApi.person, async ({ req, services }) => {
    requireRunner(services, req);
    return { accountId: await personAccountId(services.db) };
  }),

  // A login's password for the turn's Hermes to fill (HE-S141): the runner holding the live lease, a login of the turn's.
  route(
    runnerApi.loginSecret,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      return loginSecretFor(services, dispatch, params.entryId);
    },
    QUIET,
  ),

  // Kept sites (docs/decisions/kept-sites.md): keep, forget and list in the agent's turn (the live lease); restore and
  // renew from the person's pod, outside any one turn. Cookies pass through here: never logged.
  route(
    runnerApi.keptSiteKeep,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      return { site: await keepForTurn(services, dispatch, body) };
    },
    KEPT_COOKIES,
  ),

  route(
    runnerApi.keptSiteForget,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      return { forgotten: await forgetForTurn(services, dispatch, body.origins) };
    },
    QUIET,
  ),

  route(
    runnerApi.keptSiteList,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      return { sites: await listForTurn(services, dispatch) };
    },
    QUIET,
  ),

  route(
    runnerApi.keptSiteRestore,
    async ({ req, services }) => {
      requireRunner(services, req);
      return { sites: await restoreKeptSites(services) };
    },
    QUIET,
  ),

  route(
    runnerApi.keptSiteRenew,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      return { site: await renewKeptSite(services, params.siteId, body.cookies) };
    },
    KEPT_COOKIES,
  ),

  // Hermes asks the person for a login or a code in their turn (vault-simplify.md VLT-45): the card in the turn's thread.
  route(
    runnerApi.loginAsk,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      return loginAskFor(services, dispatch, body);
    },
    QUIET,
  ),

  // A long poll on that card: never logged (a code passes through it once).
  route(
    runnerApi.loginAskWait,
    async ({ params, query, req, reply, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, query);
      return loginAskWaitFor(services, dispatch, params.messageId, query.waitMs, disconnectSignal(reply));
    },
    QUIET,
  ),

  // A folder for a browser_preview of the turn (BT-48), or a page for a page_preview: only the runner holding the
  // dispatch's lease may answer.
  route(
    runnerApi.submitPreview,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      // A folder comes with its files; a page (page_preview) with its screenshot alone.
      const upload =
        body.files || body.shot
          ? { files: body.files ?? [], ...(body.shot ? { shot: body.shot } : {}) }
          : { error: body.error ?? 'The runner sent nothing.' };
      previewsFor(services).fulfil(dispatch.id, params.previewId, upload);
      return { ok: true as const };
    },
    // The folder as base64 JSON: up to BROWSER_PREVIEW_MAX_BYTES of files.
    { bodyLimit: 80 * 1024 * 1024 },
  ),

  route(runnerApi.gitCredentials, async ({ body, params, req, services }) => {
    requireRunner(services, req);
    const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
    const host = services.runtime.gitHost;
    // A repo created on the Whombat (repositories.md RP-04) needs no git host: its origin is on this machine.
    const [local] = await services.db
      .select({ originPath: repos.originPath })
      .from(repos)
      .where(
        and(eq(repos.burrowId, dispatch.burrowId), eq(repos.fullName, body.repo), eq(repos.source, 'local')),
      );
    if (!host && !local?.originPath)
      throw new ApiError(
        'not_implemented',
        'GitHub is not configured on this server (WHOMBAT_GITHUB=off), so there are no git credentials.',
        { details: { endpoint: runnerApi.gitCredentials.id } },
      );
    // An automation's coding step whose branch key asks carries a person's approval of exactly this push
    // (bp-automations.md BP-C26): the push runs under it (an ask is let through, a no still blocks).
    const approvalId =
      body.operation === 'push'
        ? await approvedPushFor(services.db, dispatch.id, body.repo, body.branch)
        : null;
    // A person said yes to this agent pushing this branch and commit (essentials-agents.md EA-05): it goes through.
    const pushApprovalId =
      body.operation === 'push' && !approvalId
        ? await pushAllowance(services.db, {
            burrowId: dispatch.burrowId,
            agentId: dispatch.agentId,
            repo: body.repo,
            branch: body.branch,
            sha: body.sha ?? null,
          })
        : null;
    // A fetch of a GitHub repository the burrow doesn't have yet adds it for agents when the connection reaches it
    // (agent-repos.md AGR-01): `git clone` of its URL just works.
    const repo =
      body.operation === 'fetch' && host && !local
        ? ((await ensureAgentRepo(services, {
            burrowId: dispatch.burrowId,
            agentId: dispatch.agentId,
            repo: body.repo,
          })) ?? body.repo)
        : body.repo;
    const request = {
      repo,
      branch: body.branch,
      operation: body.operation,
      dispatchId: dispatch.id,
      ...(body.operation === 'push' && body.sha ? { sha: body.sha } : {}),
      ...(approvalId ? { stepApproval: { dispatchId: dispatch.id, approvalId } } : {}),
      ...(pushApprovalId ? { pushApprovalId } : {}),
    };
    // What the turn asks is for the turn's person (the approval a push asks for records them, SUB-28).
    const behalf = await onBehalfOf(services, dispatch);
    const authorized = ok(
      await runInDispatchScope(dispatchScopeOf(dispatch), () =>
        services.pipeline.commit(authorizeGit, request, {
          burrowId: dispatch.burrowId,
          actorId: dispatch.agentId,
          onBehalfOf: behalf,
        }),
      ),
    );
    // The push waits for a person: the runner says so and the turn goes on without it.
    if ('pending' in authorized)
      throw new OutcomeReply(202, {
        approvalRequired: true,
        approvalId: authorized.pending.approvalId,
        approvalNumber: authorized.pending.approvalNumber,
        eventId: authorized.pending.eventId,
      });
    // No token: the runner fetches from and pushes to the origin's path, under the same keys as any push.
    const credentials = local?.originPath
      ? {
          token: '',
          expiresAt: new Date(services.clock().getTime() + 3600_000).toISOString(),
          remoteUrl: local.originPath,
        }
      : await (host as NonNullable<typeof host>).credentials({
          burrowId: dispatch.burrowId,
          repo: authorized.repo,
          branch: body.branch,
          operation: body.operation,
          agentId: dispatch.agentId,
          dispatchId: dispatch.id,
          ...(body.operation === 'push' && body.sha ? { sha: body.sha } : {}),
        });
    // The push credential handed out under the yes is what it allowed: “Allowed Dusty to push …” (EA-06).
    if (pushApprovalId && authorized.approvalId === pushApprovalId)
      await services.approvals.completeDeferred(pushApprovalId, { ok: true, resultUrl: null });
    return credentials;
  }),

  // One gh command of the turn (agent-gh.md AGH-02): only the runner holding the dispatch's lease may ask.
  route(
    runnerApi.ghAuthorize,
    async ({ body, params, req, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(params.dispatchId, body);
      return authorizeGh(services, dispatch, body);
    },
    // Up to GH_ARGS_MAX words of GH_ARG_MAX characters, and 1 MiB of files and stdin as base64.
    { bodyLimit: 20 * 1024 * 1024 },
  ),
];
