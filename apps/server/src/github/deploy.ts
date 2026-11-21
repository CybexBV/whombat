/**
 * The real deploy executor (ARCHITECTURE "Approvals", docs/github.md "Deploys"): an approved `deploy` runs a
 * configured GitHub Actions workflow through `workflow_dispatch` (as the host's gh account) and completes
 * when the poller sees its run finish. Without `GITHUB_DEPLOY_WORKFLOW` the simulated executor stays (dev,
 * demo).
 *
 * `GITHUB_DEPLOY_WORKFLOW` is either one file for every repo and environment (`deploy.yml`) or a comma list
 * of `<repo>[:<environment>]=<file>` with `*` for any repo:
 *   `whombat/billing:production=deploy-prod.yml, whombat/billing=deploy.yml, *=deploy.yml`
 * The most specific entry wins (repo+env, repo, *+env, *).
 *
 * The workflow receives the inputs `environment`, `ref`, `sha`, `service` and `whombat_approval`; setting
 * `run-name: Deploy ${{ inputs.whombat_approval }}` lets the poller find its approval exactly (otherwise the
 * oldest open deploy of that repo and workflow is matched).
 */
import type { Approval } from '@whombat/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import { approvals, githubDeploys, repos } from '../db/schema/index';
import { recordDeployJob } from '../deployments/commands';
import { prByNumber } from '../read/work';
import type { Services } from '../services';
import type { GhWorkflowRun } from './adapter';
import type { GitHubService } from './service';

export type DeployWorkflowLookup = (repo: string, environment: string) => string | null;

/** An approval id in a run's title (`run-name: Deploy ${{ inputs.whombat_approval }}`). */
const NAMES_APPROVAL = /\bapr_[A-Za-z0-9_-]{6,}/;

/** Parses `GITHUB_DEPLOY_WORKFLOW` (see the file comment). Throws on a malformed entry. */
export function parseDeployWorkflows(spec: string | null | undefined): DeployWorkflowLookup | null {
  const table = deployWorkflowTable(spec);
  if (!table) return null;
  return (repo, environment) => {
    const r = repo.toLowerCase();
    const e = environment.toLowerCase();
    return table.get(`${r}:${e}`) ?? table.get(r) ?? table.get(`*:${e}`) ?? table.get('*') ?? null;
  };
}

/**
 * Every deploy workflow file `GITHUB_DEPLOY_WORKFLOW` names for a repo, in any environment (its own entries and the
 * `*` ones): an agent's `gh workflow run` of one of them needs the Deploy key (agent-gh.md AGH-05). Empty when none is
 * configured or the setting doesn't parse.
 */
export function deployWorkflowFiles(spec: string | null | undefined, repo: string): string[] {
  let table: Map<string, string> | null;
  try {
    table = deployWorkflowTable(spec);
  } catch {
    return [];
  }
  const r = repo.toLowerCase();
  const files = [...(table ?? new Map<string, string>())]
    .filter(([key]) => {
      const name = key.split(':')[0];
      return name === '*' || name === r;
    })
    .map(([, file]) => file);
  return [...new Set(files)];
}

function deployWorkflowTable(spec: string | null | undefined): Map<string, string> | null {
  const text = spec?.trim();
  if (!text) return null;
  const table = new Map<string, string>();
  for (const raw of text.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf('=');
    const key = eq < 0 ? '*' : entry.slice(0, eq).trim();
    const file = (eq < 0 ? entry : entry.slice(eq + 1)).trim();
    if (!file || !/^[\w.-]+\.ya?ml$|^\d+$/.test(file))
      throw new Error(`GITHUB_DEPLOY_WORKFLOW: “${entry}” needs a workflow file like deploy.yml`);
    if (!/^(\*|[\w.-]+\/[\w.-]+)(:[\w.-]+)?$/.test(key))
      throw new Error(`GITHUB_DEPLOY_WORKFLOW: “${key}” is not <owner/repo>[:<environment>] or *`);
    table.set(key.toLowerCase(), file);
  }
  return table;
}

export class DeployExecutor {
  readonly lookup: DeployWorkflowLookup | null;

  constructor(
    private readonly services: Services,
    private readonly github: GitHubService,
  ) {
    this.lookup = parseDeployWorkflows(services.config.GITHUB_DEPLOY_WORKFLOW);
  }

  /** Installs the executor for `deploy` approvals when GitHub and a deploy workflow are configured. */
  install(): boolean {
    if (!this.github.adapter || !this.lookup) return false;
    this.services.approvals.setExecutor('deploy', (approval) => this.execute(approval));
    return true;
  }

  /** The repo a deploy is from: its own `repo`, else the repo of its PR. */
  private async repoOf(approval: Approval): Promise<string | null> {
    if (approval.action.type !== 'deploy') return null;
    const p = approval.action.params;
    if (p.repo) return p.repo;
    if (p.prNumber) {
      const pr = await prByNumber(this.services.db, approval.burrowId, p.prNumber);
      if (pr) {
        const [repo] = await this.services.db.select().from(repos).where(eq(repos.id, pr.repoId));
        if (repo) return repo.fullName;
      }
    }
    const enabled = await this.services.db
      .select({ fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.burrowId, approval.burrowId), eq(repos.enabled, true)));
    return enabled.length === 1 ? (enabled[0]?.fullName ?? null) : null;
  }

  /** Dispatches the workflow; the approval completes when the poller sees the run end (deferred). */
  async execute(approval: Approval) {
    if (approval.action.type !== 'deploy') return { ok: false as const, error: 'Not a deploy.' };
    const adapter = this.github.require();
    const p = approval.action.params;
    const repo = await this.repoOf(approval);
    if (!repo) return { ok: false as const, error: 'there is no repo to deploy from' };
    const workflow = this.lookup?.(repo, p.environment) ?? null;
    if (!workflow)
      return { ok: false as const, error: `no deploy workflow is set up for ${repo} ${p.environment}` };
    if (!(await this.github.connectedRepo(approval.burrowId, repo)))
      return { ok: false as const, error: `${repo} is not connected to GitHub` };
    const now = this.services.clock();
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx.delete(githubDeploys).where(eq(githubDeploys.approvalId, approval.id));
      await tx.insert(githubDeploys).values({
        approvalId: approval.id,
        burrowId: approval.burrowId,
        repo,
        workflow,
        ref: p.ref,
        environment: p.environment,
        state: 'dispatched',
        dispatchedAt: now,
      });
    });
    try {
      await externalEffect('github.workflow', () =>
        adapter.dispatchWorkflow({
          repo,
          workflow,
          ref: p.ref,
          inputs: {
            environment: p.environment,
            ref: p.ref,
            sha: p.sha ?? '',
            service: p.service,
            whombat_approval: approval.id,
          },
        }),
      );
    } catch (err) {
      await this.mark(approval.id, 'failed');
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
    // Its workflow run is read on the fast cadence from now (docs/decisions/polling.md PL-01).
    this.github.poller.wake(approval.burrowId, repo);
    return { deferred: true as const };
  }

  private async mark(
    approvalId: string,
    state: string,
    extra: Partial<typeof githubDeploys.$inferInsert> = {},
  ) {
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .update(githubDeploys)
        .set({ state, ...extra })
        .where(eq(githubDeploys.approvalId, approvalId)),
    );
  }

  /**
   * A workflow run the poller saw: moves the matching open deploy of that burrow and repo along (by run id,
   * the approval id in the run's title, the ref, else the oldest). Runs created before a deploy was
   * dispatched are never its run, a run another deploy already has is that deploy's (finished or not), and
   * a run whose title names an approval is only that approval's. True when it moved one.
   */
  async onWorkflowRun(burrowId: string, repo: string, run: GhWorkflowRun): Promise<boolean> {
    if (run.event && run.event !== 'workflow_dispatch') return false;
    const db = this.services.db;
    const mine = and(eq(githubDeploys.burrowId, burrowId), eq(githubDeploys.repo, repo));
    const title = `${run.displayTitle ?? ''} ${run.name ?? ''}`;
    // The deploy the run already belongs to (its id recorded), or the one its title names.
    const [owner] = await db
      .select({ approvalId: githubDeploys.approvalId })
      .from(githubDeploys)
      .where(and(mine, eq(githubDeploys.runId, run.id)));
    const [named] = owner
      ? []
      : await db
          .select({ approvalId: githubDeploys.approvalId })
          .from(githubDeploys)
          .where(and(mine, sql`strpos(${title}, ${githubDeploys.approvalId}) > 0`))
          .limit(1);
    // A title naming an approval this burrow never dispatched is another burrow's (or instance's) run.
    if (!owner && !named && NAMES_APPROVAL.test(title)) return false;
    const open = await db
      .select()
      .from(githubDeploys)
      .where(and(mine, inArray(githubDeploys.state, ['dispatched', 'running'])))
      .orderBy(asc(githubDeploys.dispatchedAt));
    const file = (run.path ?? '').split('/').at(-1) ?? '';
    const created = Date.parse(run.createdAt ?? '') || 0;
    const claimed = owner ?? named;
    const candidates = open.filter(
      (d) =>
        d.runId === run.id ||
        (d.runId === null &&
          (!claimed || d.approvalId === claimed.approvalId) &&
          (d.workflow === file || d.workflow === run.name) &&
          created >= d.dispatchedAt.getTime() - 60_000),
    );
    const deploy =
      candidates.find((d) => d.runId === run.id) ??
      candidates.find((d) => d.ref === run.headBranch) ??
      candidates[0];
    if (!deploy) return false;
    if (run.status !== 'completed') {
      if (deploy.state === 'running' && deploy.runId === run.id) return false;
      await this.mark(deploy.approvalId, 'running', { runId: run.id, runUrl: run.url });
      return true;
    }
    const ok = run.conclusion === 'success';
    const started = Date.parse(run.runStartedAt ?? run.createdAt ?? '');
    const ended = Date.parse(run.updatedAt ?? '');
    const durationMs =
      Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : undefined;
    await this.mark(deploy.approvalId, ok ? 'succeeded' : 'failed', {
      runId: run.id,
      runUrl: run.url,
      completedAt: this.services.clock(),
    });
    await this.services.approvals.completeDeferred(
      deploy.approvalId,
      ok
        ? { ok: true, resultUrl: run.url, ...(durationMs !== undefined ? { durationMs } : {}) }
        : {
            ok: false,
            error: `the ${deploy.workflow} run ended ${run.conclusion ?? 'without a result'}`,
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
    );
    await this.recordOutcome(burrowId, deploy, run, ok);
    return true;
  }

  /**
   * The finished job on the Deploys board, with its card where the approval card is (review-features.md RF-02): once
   * per approval, by the person whose yes ran it. Never fails the poll.
   */
  private async recordOutcome(
    burrowId: string,
    deploy: typeof githubDeploys.$inferSelect,
    run: GhWorkflowRun,
    ok: boolean,
  ) {
    try {
      const [approval] = await this.services.db
        .select({ requesterId: approvals.requesterId })
        .from(approvals)
        .where(eq(approvals.id, deploy.approvalId));
      if (!approval) return;
      await this.services.pipeline.commit(
        recordDeployJob,
        {
          approvalId: deploy.approvalId,
          status: ok ? 'succeeded' : 'failed',
          repo: deploy.repo,
          workflow: deploy.workflow,
          runUrl: run.url,
          conclusion: run.conclusion,
        },
        { burrowId, actorId: approval.requesterId },
      );
    } catch (err) {
      this.services.log.warn(
        { err: String(err), approvalId: deploy.approvalId },
        'could not record a finished deploy job',
      );
    }
  }
}
