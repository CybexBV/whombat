/**
 * Coding work in automation runs (docs/decisions/bp-automations.md BP-C26). A `dispatch_agent` step with a
 * `workspace` gives its agent a checkout: `write` on the agent's own branch (its branch key decides, before the
 * agent is asked: can → go, asks → a person approves first, bound to the step, no → Blocked), `read` of a branch
 * or the base. The rendered workspace is kept on the step row (`output.workspace`), where the dispatch context
 * (runtime/context.ts) and the git credentials route (a push the person approved) read it.
 */
import {
  type AutomationDefinition,
  type AutomationStep,
  branchWriteKey,
  type Decision,
  decide,
  type JsonObject,
  renderTemplate,
  type StepWorkspace,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  approvals,
  automationRunSteps,
  automationRuns,
  automations,
  dispatches,
  pullRequests,
  repos,
} from '../db/schema/index';
import { type GitHubAdapter, GitHubError } from '../github/adapter';
import { githubScope } from '../managed/providers/github-adapter';
import { engineActor, loadGrants, type PrincipalRow } from '../read/principals';
import { intersect } from './authority';
import { handedWaitOf, resumedLine } from './turn-waits';

/** The checkout a step's agent gets, as rendered for this run. */
export interface RunWorkspace {
  repo: string;
  branch: string;
  baseBranch: string;
  /** The repository's own default branch: what the branch key is classified against (BP-C36), never `base`. */
  defaultBranch: string;
  access: 'write' | 'read';
  /** A pull request's checkout (`workspace.pullRequest`, automation-recipes.md): its number. */
  pullRequest?: number;
}

/**
 * The branch a pull request's read-only checkout is of (automation-recipes.md). A branch of the repo itself while the
 * pull request is open: that branch. A fork's (its branch keyed `owner:ref`), or a closed one whose branch may be gone:
 * `pull/<n>/head`, the server↔runner convention — the runner fetches GitHub's `refs/pull/<n>/head` for it
 * (`pullRequestRef` in @whombat/agent-runtime). The base is the pull request's base.
 */
export function pullRequestBranch(pr: {
  number: number;
  branch: string;
  open: boolean;
  fork: boolean;
}): string {
  return pr.open && !pr.fork && !pr.branch.includes(':') ? pr.branch : `pull/${pr.number}/head`;
}

/** Finds a pull request's checkout: the burrow's mirror of it, else GitHub. */
async function pullRequestCheckout(
  db: Db,
  burrowId: string,
  repo: { id: string; fullName: string; source: string },
  number: number,
  adapter: GitHubAdapter | null,
): Promise<{ ok: true; branch: string; base: string } | { ok: false; reason: string }> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, number)));
  if (row && (row.localOnly || repo.source === 'local'))
    // Whombat's own pull request (no GitHub one): its branch is a real one of the repo.
    return { ok: true, branch: row.branch, base: row.baseBranch };
  if (row)
    return {
      ok: true,
      branch: pullRequestBranch({
        number,
        branch: row.branch,
        open: row.state === 'open',
        fork: row.branch.includes(':'),
      }),
      base: row.baseBranch,
    };
  if (!adapter || repo.source === 'local')
    return { ok: false, reason: `${repo.fullName} has no pull request #${number} that Whombat knows of.` };
  try {
    const pr = await githubScope.run({ burrowId }, () => adapter.getPullRequest(repo.fullName, number));
    return {
      ok: true,
      branch: pullRequestBranch({
        number,
        branch: pr.headRef,
        open: pr.state === 'open',
        fork: pr.fork !== null,
      }),
      base: pr.baseRef,
    };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404)
      return { ok: false, reason: `${repo.fullName} has no pull request #${number}.` };
    return {
      ok: false,
      reason: `Pull request #${number} of ${repo.fullName} couldn’t be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Branch names the runner accepts (git's rules, conservatively). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,255}(?<![./])$/;

/**
 * Renders a step's workspace for this run: the repo must be switched on for agents. A `pullRequest` that renders to a
 * number is that pull request's head (its base unless the step names one); one that renders to nothing (an issue started
 * the run) leaves the checkout the base, as without it. `adapter`: GitHub, for a pull request the burrow hasn't mirrored.
 */
export async function resolveStepWorkspace(
  db: Db,
  burrowId: string,
  spec: StepWorkspace,
  scope: Record<string, unknown>,
  adapter: GitHubAdapter | null = null,
): Promise<{ ok: true; workspace: RunWorkspace } | { ok: false; reason: string }> {
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, spec.repo)));
  if (!repo) return { ok: false, reason: `${spec.repo} isn’t a repository of this Whombat.` };
  if (!repo.enabled) return { ok: false, reason: `${spec.repo} isn’t switched on for agents.` };
  let baseBranch = spec.base ?? repo.defaultBranch;
  let branch = spec.branch ? renderTemplate(spec.branch, scope, 255).trim() : baseBranch;
  let pullRequest: number | undefined;
  const asked = spec.pullRequest ? renderTemplate(spec.pullRequest, scope, 20).trim() : '';
  if (asked) {
    if (!/^[1-9][0-9]{0,9}$/.test(asked))
      return { ok: false, reason: `“${asked}” isn’t a pull request number.` };
    const found = await pullRequestCheckout(db, burrowId, repo, Number(asked), adapter);
    if (!found.ok) return found;
    pullRequest = Number(asked);
    branch = found.branch;
    baseBranch = spec.base ?? found.base;
  }
  for (const b of [branch, baseBranch])
    if (!BRANCH.test(b)) return { ok: false, reason: `“${b}” isn’t a branch name Whombat can use.` };
  return {
    ok: true,
    workspace: {
      repo: repo.fullName,
      branch,
      baseBranch,
      defaultBranch: repo.defaultBranch,
      access: spec.access,
      ...(pullRequest ? { pullRequest } : {}),
    },
  };
}

/**
 * Whether the agent may write the branch: its own branch key (the keys engine, as for a push) ∩ what the person who
 * published the automation may do (BP-C04).
 */
export async function branchDecision(
  db: Db,
  agent: PrincipalRow,
  publisher: PrincipalRow,
  ws: RunWorkspace,
): Promise<Decision> {
  // The repository's default branch, not the step's `base`: a step based on another branch must not turn `main` into
  // a shared branch (BP-C36).
  const keyId = branchWriteKey(ws.branch, ws.defaultBranch);
  const scope = { repo: ws.repo, branch: ws.branch };
  const own = decide({ id: agent.id, kind: 'agent' }, await loadGrants(db, agent.id), keyId, scope);
  const person = decide(engineActor(publisher), [], keyId, scope);
  return intersect(own, person);
}

/** The proposal a person approves when the agent's branch key asks (re-rendered by the approval guard). */
export function branchProposal(agentName: string, ws: RunWorkspace): { title: string; details: string } {
  return {
    title: `Let ${agentName} work on ${ws.branch} in ${ws.repo}`.slice(0, 160),
    details:
      `${agentName} gets a checkout of ${ws.branch} (from ${ws.baseBranch}), commits the fix there, and Whombat pushes it to ${ws.repo}. Nothing is merged.`.slice(
        0,
        2000,
      ),
  };
}

/** The workspace a step row holds (`output.workspace`), when it has one. */
export function rowWorkspace(output: unknown): RunWorkspace | null {
  const ws = (output as { workspace?: RunWorkspace } | null)?.workspace;
  if (!ws || typeof ws.repo !== 'string' || typeof ws.branch !== 'string') return null;
  return ws;
}

/** Whether `approvalId` is an approved branch request of exactly this run step and attempt. */
export async function approvedBranchRequest(
  db: Db,
  approvalId: string,
  runId: string,
  step: Pick<AutomationStep, 'id'>,
  attempt: number,
): Promise<boolean> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  const binding = row?.actionBinding;
  return row?.state === 'approved' && binding?.runId === runId && binding.stepId === `${step.id}#${attempt}`;
}

/** A dispatch's automation workspace (the step that created it), for the runner's context. */
export async function dispatchWorkspace(db: Db, dispatchId: string): Promise<RunWorkspace | null> {
  const [row] = await db
    .select({ output: automationRunSteps.output })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.dispatchId, dispatchId));
  return row ? rowWorkspace(row.output) : null;
}

/**
 * The automation owns the pull request of a coding step (run9 review RN-S3): a `dispatch_agent` step with a write checkout
 * followed later in the definition by an `open_pull_request` step for the same repository and the same branch template.
 * That later step opens it — after the review — with its own title and body; null when the step isn't such a one.
 */
export function ownPullRequestStep(
  def: Pick<AutomationDefinition, 'steps'>,
  idx: number,
): { prStep: Extract<AutomationStep, { kind: 'open_pull_request' }>; reviewed: boolean } | null {
  const step = def.steps[idx];
  if (step?.kind !== 'dispatch_agent' || step.workspace?.access !== 'write' || !step.workspace.branch)
    return null;
  const ws = step.workspace;
  const later = def.steps.slice(idx + 1);
  const at = later.findIndex(
    (s) =>
      s.kind === 'open_pull_request' &&
      s.repo.toLowerCase() === ws.repo.toLowerCase() &&
      s.branch === ws.branch,
  );
  const prStep = later[at];
  if (prStep?.kind !== 'open_pull_request') return null;
  // A review between them: an agent step that gives a verdict.
  const reviewed = later.slice(0, at).some((s) => s.kind === 'dispatch_agent' && !!s.verdict);
  return { prStep, reviewed };
}

/** The line a coding step's instructions end with when the automation opens its pull request itself (RN-S3a). */
export function ownPullRequestLine(reviewed: boolean): string {
  return `This automation opens the pull request itself ${reviewed ? 'after the review' : 'once you’re done'}, so commit your work and don’t open a pull request or start a run for it.`;
}

/** What an agent hears when it opens a pull request in such a step's turn (RN-S3b). */
export function automationOpensPrText(reviewed: boolean): string {
  return `This automation opens the pull request itself ${reviewed ? 'after the review' : 'once you’re done'}. Finish with your reply.`;
}

/**
 * Whether a dispatch is the turn of a coding step whose pull request its automation opens (RN-S3): the agent doesn't
 * open one in it, and runs started in it get none from RC-08.
 */
export async function automationOwnsPullRequest(
  db: Db,
  dispatchId: string,
): Promise<{ reviewed: boolean } | null> {
  const [row] = await db
    .select({
      idx: automationRunSteps.idx,
      definition: automationRuns.definition,
      trigger: dispatches.trigger,
    })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(dispatches, eq(dispatches.id, automationRunSteps.dispatchId))
    .where(eq(automationRunSteps.dispatchId, dispatchId))
    .limit(1);
  if (row?.trigger !== 'automation') return null;
  const owned = ownPullRequestStep(row.definition, row.idx);
  return owned ? { reviewed: owned.reviewed } : null;
}

/** The instructions of the automation step a dispatch belongs to (CNR-08); null for any other dispatch. */
export async function dispatchInstructions(db: Db, dispatchId: string): Promise<string | null> {
  const [row] = await db
    .select({ output: automationRunSteps.output })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.dispatchId, dispatchId));
  const instructions = (row?.output as { instructions?: unknown } | undefined)?.instructions;
  if (typeof instructions !== 'string' || !instructions.trim()) return null;
  // A turn after a handed wait goes on from the thread it handed over.
  const handed = handedWaitOf(row?.output);
  return handed ? `${instructions}\n\n${resumedLine(handed.threadId)}` : instructions;
}

/**
 * The approval that lets this automation dispatch push `branch` of `repo` although the agent's key asks: a person
 * approved exactly that step (BP-C26). The git credentials route executes the push under it (an `ask` then counts
 * as allowed; a `no` still blocks). Null for every other dispatch, repo or branch.
 */
export async function approvedPushFor(
  db: Db,
  dispatchId: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const [row] = await db
    .select({ step: automationRunSteps, trigger: dispatches.trigger, agentId: dispatches.agentId })
    .from(automationRunSteps)
    .innerJoin(dispatches, eq(dispatches.id, automationRunSteps.dispatchId))
    .where(eq(automationRunSteps.dispatchId, dispatchId));
  if (row?.trigger !== 'automation') return null;
  const output = row.step.output as JsonObject;
  const ws = rowWorkspace(output);
  const approvalId = typeof output.branchApprovalId === 'string' ? output.branchApprovalId : null;
  if (ws?.access !== 'write' || ws.repo !== repo || ws.branch !== branch || !approvalId) return null;
  const [approval] = await db
    .select({ state: approvals.state, binding: approvals.actionBinding, requesterId: approvals.requesterId })
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  const automationId = approval?.binding?.automationId;
  const [automation] = automationId
    ? await db
        .select({ principalId: automations.principalId })
        .from(automations)
        .where(eq(automations.id, automationId))
    : [];
  if (
    approval?.state !== 'approved' ||
    approval.binding?.runId !== row.step.runId ||
    approval.binding.stepId !== `${row.step.stepId}#${row.step.attempt}` ||
    approval.requesterId !== automation?.principalId
  )
    return null;
  return approvalId;
}
