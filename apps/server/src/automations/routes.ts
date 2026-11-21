/** REST adapters for automations (`api.automations.*`): thin, over the automation commands and the read side. */
import {
  AUTOMATION_TEMPLATES,
  type AutomationDefinition,
  type AutomationExport,
  AutomationExport as AutomationExportSchema,
  type AutomationSample,
  api,
  GITHUB_PR_EVENTS,
  validateDefinition,
} from '@whombat/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BurrowAccess } from '../auth/request';
import { automationRuns, automations, automationVersions, repos } from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { githubScope } from '../managed/providers/github-adapter';
import { commitAs } from '../routes/burrows';
import { route } from '../routes/define';
import type { Services } from '../services';
import { trackerConnectionRow } from '../trackers/connection';
import type { TrackerRunItem } from '../trackers/items';
import { reportSamples, sampleReportItem } from '../trackers/samples';
import { trackerTriggers } from '../trackers/store';
import {
  controlAutomationRun,
  createAutomation,
  deleteAutomation,
  discardAutomationDraft,
  publishAutomationDraft,
  reviewAutomationStep,
  runAutomationNow,
  saveAutomationDraft,
  setAutomationEnabled,
  setAutomationKeys,
  setAutomationWebhook,
} from './commands';
import { fetchGitHubItem, type GitHubItem, githubTriggers } from './github-items';
import { acceptAutomationPlan, declineAutomationPlan } from './plans';
import {
  type AutomationRow,
  liveDefinition,
  loadAutomationRow,
  loadRunRow,
  recentRunSummaries,
  toAutomation,
  toRun,
  toRuns,
} from './store';

function canManage(access: BurrowAccess): boolean {
  // The person holds every right (one-person.md OP-S07).
  return access.principal.kind === 'person';
}

async function detail(services: Services, access: BurrowAccess, id: string) {
  const row = await loadAutomationRow(services.db, access.burrow.id, id);
  const versions = await services.db
    .select()
    .from(automationVersions)
    .where(eq(automationVersions.automationId, row.id))
    .orderBy(desc(automationVersions.n));
  return {
    automation: await toAutomation(services.db, row),
    versions: versions.map((v) => ({
      n: v.n,
      definitionHash: v.definitionHash,
      publishedById: v.publishedById,
      publishedAt: iso(v.publishedAt),
    })),
    // Webhooks need the server's own public address; a box has none (MR-04, MR-45).
    webhookUrl: null,
  };
}

async function runDetail(services: Services, access: BurrowAccess, runId: string) {
  const row = await loadRunRow(services.db, runId);
  if (row.burrowId !== access.burrow.id) throw notFound('Automation run');
  // A deleted automation's runs still show it, with `deletedAt` (automation-recipes.md).
  const automation = await loadAutomationRow(services.db, access.burrow.id, row.automationId, {
    deleted: true,
  });
  return {
    run: await toRun(services.db, row),
    automation: await toAutomation(services.db, automation),
  };
}

/**
 * The definition a test run of this automation runs (the valid draft, else the live version), for what “Try it on …”
 * reads before the run is made; null when it has neither.
 */
async function testedDefinition(
  services: Services,
  row: AutomationRow,
): Promise<AutomationDefinition | null> {
  if (row.draftJson) {
    const check = validateDefinition(row.draftJson);
    if (check.ok) return check.definition;
  }
  return liveDefinition(services.db, row);
}

/**
 * Who may try an automation (test-run it): the person (BP-C19). Every room it uses is theirs; the run's own checks
 * refuse a room that isn't the burrow's. The same 403 as the test run itself.
 */
function requireTester(access: BurrowAccess) {
  if (!canManage(access)) throw forbidden('Only you can try an automation.');
}

/** The repo an automation's GitHub triggers watch (the first one's), one of the burrow's (else 400). */
async function sampleRepo(services: Services, burrowId: string, def: AutomationDefinition): Promise<string> {
  const repo = githubTriggers(def)[0]?.repo;
  if (!repo) throw badRequest('This automation doesn’t start from GitHub.');
  const [row] = await services.db
    .select({ fullName: repos.fullName, enabled: repos.enabled })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), sql`lower(${repos.fullName}) = lower(${repo})`));
  if (!row?.enabled)
    throw badRequest(`${repo} isn’t one of the repositories on this Whombat. Check its name.`);
  return row.fullName;
}

function githubAdapter(services: Services) {
  const adapter = services.github.adapter;
  if (!adapter) throw new ApiError('conflict', 'GitHub isn’t connected on this Whombat.');
  return adapter;
}

/** A GitHub failure as the API answers it: 404 for a number GitHub doesn't have, else 409 with what it said. */
function githubFailure(err: unknown, what: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof GitHubError && err.status === 404) return notFound(what);
  return new ApiError('conflict', err instanceof Error ? err.message : String(err));
}

/** GitHub's time as the contract's timestamp (the epoch when it gave none or one that doesn't parse). */
function openedAt(at: string | null): string {
  const ms = at ? Date.parse(at) : Number.NaN;
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/**
 * Recent open issues and pull requests of the repo its GitHub triggers watch, newest first, of the kinds they start on
 * (automation-recipes.md: “Try it on …”).
 */
export async function automationSamples(
  services: Services,
  access: BurrowAccess,
  id: string,
): Promise<{ samples: AutomationSample[] }> {
  const row = await loadAutomationRow(services.db, access.burrow.id, id);
  const def = await testedDefinition(services, row);
  if (!def) throw badRequest('This automation doesn’t start from GitHub.');
  // A tracker trigger's connection: its newest open reports of the kinds it fires on (report-trackers.md TA-19).
  const tracker = trackerTriggers(def)[0];
  if (tracker) {
    requireTester(access);
    const connection = await trackerConnectionRow(services.db, access.burrow.id, tracker.connectionId);
    if (!connection) throw badRequest('Its tracker connection is gone: choose another in the form.');
    return { samples: await reportSamples(services, connection, tracker.itemKinds) };
  }
  const repo = await sampleRepo(services, access.burrow.id, def);
  requireTester(access);
  const triggers = githubTriggers(def);
  const issues = triggers.some((t) => t.event === 'issue_opened');
  const prs = triggers.some((t) => GITHUB_PR_EVENTS.includes(t.event));
  const adapter = githubAdapter(services);
  const out: AutomationSample[] = [];
  try {
    await githubScope.run({ burrowId: access.burrow.id }, async () => {
      if (issues) {
        const read = await adapter.openIssues(repo, null);
        if (read.modified)
          for (const i of read.data)
            out.push({
              kind: 'issue',
              repo,
              number: i.number,
              title: i.title,
              author: i.author,
              url: i.url,
              draft: false,
              openedAt: openedAt(i.createdAt),
            });
      }
      if (prs) {
        const read = await adapter.openPullRequests(repo, []);
        if (read.modified)
          for (const p of read.data)
            out.push({
              kind: 'pull_request',
              repo,
              number: p.number,
              title: p.title,
              author: p.author,
              url: p.url,
              draft: p.draft,
              openedAt: openedAt(p.createdAt),
            });
      }
    });
  } catch (err) {
    throw githubFailure(err, 'Repository');
  }
  out.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt) || b.number - a.number);
  return { samples: out.slice(0, 10) };
}

/** The tracker report a test run is tried on, read live before the run is made (report-trackers.md TA-19). */
export async function sampleReport(
  services: Services,
  access: BurrowAccess,
  id: string,
  reportId: string,
): Promise<TrackerRunItem> {
  const row = await loadAutomationRow(services.db, access.burrow.id, id);
  const def = await testedDefinition(services, row);
  if (!def) throw conflict('Publish it first, or test-run the draft.');
  const trigger = trackerTriggers(def)[0];
  if (!trigger) throw badRequest('This automation doesn’t start from a tracker’s reports.');
  requireTester(access);
  const connection = await trackerConnectionRow(services.db, access.burrow.id, trigger.connectionId);
  if (!connection) throw badRequest('Its tracker connection is gone: choose another in the form.');
  return sampleReportItem(services, connection, trigger, reportId);
}

/** The issue or pull request a test run is tried on, read from GitHub before the run is made. */
export async function sampleItem(
  services: Services,
  access: BurrowAccess,
  id: string,
  number: number,
): Promise<GitHubItem> {
  const row = await loadAutomationRow(services.db, access.burrow.id, id);
  const def = await testedDefinition(services, row);
  if (!def) throw conflict('Publish it first, or test-run the draft.');
  const repo = await sampleRepo(services, access.burrow.id, def);
  try {
    return await fetchGitHubItem(githubAdapter(services), access.burrow.id, repo, number);
  } catch (err) {
    throw githubFailure(err, `#${number} of ${repo}`);
  }
}

async function runIdByNumber(services: Services, burrowId: string, number: number) {
  const [row] = await services.db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.burrowId, burrowId), eq(automationRuns.number, number)));
  if (!row) throw notFound('Automation run');
  return row.id;
}

export const automationRoutes = [
  route(api.automations.list, async ({ access, services }) => {
    const rows = await services.db
      .select()
      .from(automations)
      // Deleted ones left every list (automation-recipes.md).
      .where(and(eq(automations.burrowId, access.burrow.id), isNull(automations.deletedAt)))
      .orderBy(desc(automations.updatedAt));
    // Every row's run history in one query (automation-list.md AL-S02).
    const recent = await recentRunSummaries(
      services.db,
      rows.map((r) => r.id),
    );
    return {
      automations: await Promise.all(
        rows.map((r) => toAutomation(services.db, r, { recentRuns: recent.get(r.id) ?? [] })),
      ),
    };
  }),

  route(api.automations.templates, async () => ({
    templates: AUTOMATION_TEMPLATES.map((t) => ({ ...t, fields: t.fields.map((f) => ({ ...f })) })),
  })),

  route(api.automations.create, async (ctx) => {
    const { automationId } = await commitAs(ctx, createAutomation, ctx.body);
    return detail(ctx.services, ctx.access, automationId);
  }),

  route(api.automations.get, async ({ access, params, services }) => detail(services, access, params.id)),

  route(api.automations.delete, async (ctx) =>
    commitAs(ctx, deleteAutomation, { automationId: ctx.params.id }),
  ),

  route(api.automations.samples, async ({ access, params, services }) =>
    automationSamples(services, access, params.id),
  ),

  route(api.automations.saveDraft, async (ctx) => {
    await commitAs(ctx, saveAutomationDraft, { automationId: ctx.params.id, ...ctx.body });
    return detail(ctx.services, ctx.access, ctx.params.id);
  }),

  route(api.automations.discardDraft, async (ctx) => {
    await commitAs(ctx, discardAutomationDraft, { automationId: ctx.params.id });
    return detail(ctx.services, ctx.access, ctx.params.id);
  }),

  route(api.automations.publish, async (ctx) => {
    await commitAs(ctx, publishAutomationDraft, {
      automationId: ctx.params.id,
      enable: ctx.body.enable,
      definitionHash: ctx.body.definitionHash,
    });
    return detail(ctx.services, ctx.access, ctx.params.id);
  }),

  // A plan the agent proposed in Chat: turned on, or not now (automation-chat.md).
  route(api.automations.acceptPlan, async (ctx) => {
    const { automationId } = await commitAs(ctx, acceptAutomationPlan, { planId: ctx.params.planId });
    return detail(ctx.services, ctx.access, automationId);
  }),

  route(api.automations.declinePlan, async (ctx) =>
    commitAs(ctx, declineAutomationPlan, { planId: ctx.params.planId }),
  ),

  route(api.automations.setEnabled, async (ctx) => {
    await commitAs(ctx, setAutomationEnabled, { automationId: ctx.params.id, enabled: ctx.body.enabled });
    return detail(ctx.services, ctx.access, ctx.params.id);
  }),

  route(api.automations.setKeys, async (ctx) => {
    await commitAs(ctx, setAutomationKeys, { automationId: ctx.params.id, grants: ctx.body.grants });
    return detail(ctx.services, ctx.access, ctx.params.id);
  }),

  route(api.automations.webhook, async (ctx) => {
    const { secret } = await commitAs(ctx, setAutomationWebhook, {
      automationId: ctx.params.id,
      ...ctx.body,
    });
    return { ...(await detail(ctx.services, ctx.access, ctx.params.id)), secret };
  }),

  route(api.automations.export, async ({ access, params, query, services }): Promise<AutomationExport> => {
    const row = await loadAutomationRow(services.db, access.burrow.id, params.id);
    const definition = query.draft === 'true' ? row.draftJson : await liveDefinition(services.db, row);
    if (!definition)
      throw conflict(query.draft === 'true' ? 'There is no draft.' : 'Nothing is published yet.');
    const file = AutomationExportSchema.safeParse({
      whombat: 'automation',
      name: row.name,
      description: row.description,
      definition,
    });
    if (!file.success) throw conflict('The draft doesn’t validate yet, so it can’t be exported.');
    return file.data;
  }),

  route(api.automations.runNow, async (ctx) => {
    // “Try it on …”: the issue or pull request is read from GitHub first, outside the commit (automation-recipes.md);
    // a tracker report likewise from its tracker (report-trackers.md TA-19).
    const wanted = ctx.body.test ? ctx.body.sample : undefined;
    const sample =
      wanted && 'number' in wanted
        ? await sampleItem(ctx.services, ctx.access, ctx.params.id, wanted.number)
        : undefined;
    const report =
      wanted && 'reportId' in wanted
        ? await sampleReport(ctx.services, ctx.access, ctx.params.id, wanted.reportId)
        : undefined;
    const { runId } = await commitAs(ctx, runAutomationNow, {
      automationId: ctx.params.id,
      ...ctx.body,
      ...(sample ? { sampleItem: sample } : {}),
      ...(report ? { sampleReport: report } : {}),
    });
    if (!runId) throw conflict('That run exists already.');
    return runDetail(ctx.services, ctx.access, runId);
  }),

  route(api.automations.runs, async ({ access, query, services }) => {
    const where = [eq(automationRuns.burrowId, access.burrow.id)];
    if (query.automation) where.push(eq(automationRuns.automationId, query.automation));
    if (query.status) where.push(inArray(automationRuns.status, [query.status]));
    const rows = await services.db
      .select()
      .from(automationRuns)
      .where(and(...where))
      .orderBy(desc(automationRuns.createdAt))
      .limit(query.limit);
    return { runs: await toRuns(services.db, rows) };
  }),

  route(api.automations.run, async ({ access, params, services }) =>
    runDetail(services, access, await runIdByNumber(services, access.burrow.id, params.number)),
  ),

  ...(['pauseRun', 'resumeRun', 'cancelRun'] as const).map((name) =>
    route(api.automations[name], async (ctx) => {
      if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can do this.');
      const action = name === 'pauseRun' ? 'pause' : name === 'resumeRun' ? 'resume' : 'cancel';
      const { runId } = await commitAs(ctx, controlAutomationRun, { number: ctx.params.number, action });
      return runDetail(ctx.services, ctx.access, runId);
    }),
  ),

  route(api.automations.reviewStep, async (ctx) => {
    const { runId } = await commitAs(ctx, reviewAutomationStep, {
      number: ctx.params.number,
      stepId: ctx.params.stepId,
      resolution: ctx.body.resolution,
    });
    return runDetail(ctx.services, ctx.access, runId);
  }),
];
