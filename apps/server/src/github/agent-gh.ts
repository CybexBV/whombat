/**
 * An agent's `gh` through Whombat (docs/decisions/agent-gh.md): the server side of `runner.ghAuthorize`.
 *
 * The runner sends one command of the turn — the words after `gh`, and the files and stdin it reads — and the server:
 *
 * 1. checks the turn has `gh` through Whombat (`DispatchContext.gh`, AGH-12) and the input's size (AGH-08);
 * 2. plans it (`gh-plan.ts`: the table of AGH-05 and AGH-07, the repo of AGH-04); a repository it names that the
 *    burrow doesn't have yet is added for agents when the GitHub connection reaches it (agent-repos.md AGR-01);
 * 3. decides it: a read needs nothing more (AGH-06); a write is the command `github.gh`, the plan's key deciding for
 *    the agent through the commit pipeline (On signs “Ran gh issue comment on acme/web” and runs, Off is Blocked and
 *    exit 126, Ask is one card in the turn's thread and exit 125, AGH-09); `gh pr create`, `merge` and `review` are
 *    Whombat's own `open_pr`, `merge_pr` and `review_pr`, as the agent (AGH-05); `gh repo create` is decided like a
 *    write (`code.write`, or `deploy` for a public one) and then made by Whombat as the GitHub connection and switched
 *    on for agents (AGH-19, AGH-20);
 * 4. answers `run` — the exact words, the repo for `GH_REPO` and the agent's GitHub token
 *    (`GitHubService.agentToken`, AGH-01), which only the runner's gh process sees (AGH-03) — or `done` with what the
 *    stand-in prints and its exit code.
 *
 * An Ask's card is a `custom` approval that carries only `ghHash` (the sha256 of the repo, the words as decided and the
 * files and stdin they read): the words stay with the agent (SEC-PACK-ARGS). A yes wakes the agent (`custom`'s
 * executor, EA-07) and runs nothing itself; the same agent's identical command within 24 hours of the yes then runs
 * once, signed with the approval's id, and a second run of it asks again.
 */
import { createHash } from 'node:crypto';
import {
  conversationLabel,
  GH_INPUT_MAX_BYTES,
  type GhAuthorizeBody,
  type GhAuthorizeReply,
  type GhDispatchContext,
  KEY_CATALOG,
  KeyId,
} from '@whombat/core';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { asQuestion, createApproval } from '../approvals/create';
import { chatRoomOf } from '../chats/rooms';
import { openPr } from '../commands/agent-tools';
import { mergePr, reviewPr } from '../commands/prs';
import type { ApplyContext, CommandDef, CommitResult } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { approvals, dispatches, events, pullRequests, repos } from '../db/schema/index';
import { andList } from '../guides/copy';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { onBehalfOf } from '../mcp/tools';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, loadPrincipalsByIds, shortName } from '../read/principals';
import { type DispatchRow, dispatchCheckout } from '../runtime/context';
import { dispatchScopeOf, runInDispatchScope } from '../runtime/dispatch-scope';
import type { Services } from '../services';
import { GitHubError } from './adapter';
import { ghContextFor } from './agent-gh-context';
import { createAgentRepo, ensureAgentRepo } from './agent-repos';
import { deployWorkflowFiles } from './deploy';
import { type GhPlan, type GhPrRef, type GhWhombatOp, ghNotSwitchedOn, planGh } from './gh-plan';

/** How long a yes lets the agent run its gh command once (AGH-09). */
export const GH_ALLOWANCE_MS = 24 * 60 * 60_000;

/* Copy ---------------------------------------------------------------------------------------------- */

export const GH_NOT_IN_TURN = 'gh doesn’t go through Whombat in this turn.';
export const GH_INPUT_TOO_BIG = 'gh can read at most 1 MiB of files and stdin together here.';
const signature = (agent: string) => `— ${agent} via Whombat`;
const ranText = (words: readonly string[], repo: string) =>
  `Ran gh ${words.join(' ')} on ${repo}`.slice(0, 500);
/** The write waits for a person (AGH-09). */
export const ghAskedText = (people: string, where: string, number: number) =>
  `I asked ${people} on a card ${where} (approval #${number}). When they say yes you are woken: run the same gh command again.`;
/** Whombat's own command waits for a person: their yes does it (a merge as the person, `open_pr` and `review_pr` again). */
export const ghWhombatAskedText = (people: string, where: string, number: number) =>
  `I asked ${people} on a card ${where} (approval #${number}). When they say yes, Whombat does it: don’t run the command again.`;
const noOpenPr = (branch: string, repo: string) => `No open pull request for ${branch} in ${repo}.`;
const reviewedText = (decision: 'approve' | 'request_changes' | 'comment', n: number) =>
  decision === 'approve'
    ? `✓ Approved pull request #${n}`
    : decision === 'request_changes'
      ? `✓ Requested changes to pull request #${n}`
      : `✓ Reviewed pull request #${n}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** `gh repo create` with no GitHub connection to make it as (AGH-19). */
export const GH_REPO_NOT_CONNECTED =
  'Nobody connected GitHub to this Whombat yet: a person connects it in Settings → Connections → GitHub.';
const alreadyHere = (repo: string) => `${repo} is already one of this Whombat’s repositories: use it.`;
/** What gh prints for a repository it made. */
const createdText = (repo: string) =>
  `✓ Created repository ${repo} on github.com\n  https://github.com/${repo}\n`;

/* The command --------------------------------------------------------------------------------------- */

/** A write that now waits for a person: the approval it waits for (exit 125). */
export interface PendingGh {
  pending: { approvalId: string; approvalNumber: number; eventId: string };
}

const GhInput = z.object({
  /** The turn asking: where an Ask's card goes, and whether it is the person's. */
  dispatchId: z.string().min(1),
  repo: z.string().min(3).max(200),
  keyId: KeyId,
  /** What it does (“comment on issue #12”). */
  action: z.string().min(1).max(200),
  /** The command words up to the first flag, at most four (AGH-13). */
  words: z.array(z.string().max(100)).min(1).max(4),
  /** sha256 (hex) of the repo, the words as decided, and the files and stdin they read. */
  ghHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** `gh repo create` (AGH-19): `repo` is the one it makes, not one of the burrow's; `action` names it already. */
  creates: z.boolean().optional(),
  /**
   * Not one of the burrow's repositories (AGH-23): someone else's that the connection reaches (`owner/name`), or the
   * GitHub account and its organizations (`repo` = {@link GH_ACCOUNT}). A repository a person switched off stays off.
   */
  foreign: z.boolean().optional(),
  /** The branch it changes (gh api's contents, refs, merges): its key's scope. */
  branch: z.string().min(1).max(255).optional(),
});
type GhInput = z.infer<typeof GhInput>;

/** What an account-wide write names as its repository (`gh ssh-key add`, `gh api user/…`, AGH-23). */
export const GH_ACCOUNT = 'github.com';

/**
 * “comment on issue #12 in acme/web”, “create the public repository acme/site”, “add a key to the GitHub account”:
 * the Blocked, Asks and card texts.
 */
const attemptOf = (input: Pick<GhInput, 'action' | 'repo' | 'creates'>) =>
  input.creates || input.repo === GH_ACCOUNT ? input.action : `${input.action} in ${input.repo}`;

/**
 * An agent's gh write (AGH-06, AGH-09, AGH-13): the plan's key decides, scoped to the repo. Signs `github.gh` before
 * the runner runs it; at Ask it runs under the yes to this same command (once), or asks.
 */
export const githubGh = defineCommand({
  name: 'github.gh',
  schema: GhInput,
  requiredKey: (input) => ({
    keyId: input.keyId,
    scope:
      input.repo === GH_ACCOUNT
        ? {}
        : { repo: input.repo, ...(input.branch ? { branch: input.branch } : {}) },
    attempt: attemptOf(input),
    where: input.repo,
    // An `ask` is this command's own: it runs under a person's yes to this same command, or asks for one (below).
    onAsk: 'apply' as const,
  }),
  async apply(tx, ctx, input): Promise<{ approvalId: string | null } | PendingGh> {
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (dispatch?.agentId !== ctx.actor.id || dispatch.burrowId !== ctx.burrow.id) throw forbidden();
    const [repo] = await tx
      .select({ enabled: repos.enabled, source: repos.source })
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), sql`lower(${repos.fullName}) = lower(${input.repo})`));
    const usable = repo?.enabled === true && repo.source === 'github';
    if (input.creates && repo) throw conflict(alreadyHere(input.repo));
    // Someone else's repository or the account: only one the burrow has and a person switched off is out (AGH-23).
    if (input.foreign ? repo && !usable : !input.creates && !usable)
      throw repo && !usable ? forbidden(ghNotSwitchedOn(input.repo)) : notFound(`Repo ${input.repo}`);
    let approvalId: string | null = null;
    if (ctx.decision?.outcome === 'ask') {
      // Inside the burrow's lock: two identical commands can't both use one yes.
      approvalId = await ghAllowance(tx, {
        burrowId: ctx.burrow.id,
        agentId: ctx.actor.id,
        now: ctx.now,
        input,
      });
      if (!approvalId) return askForGh(ctx, input, dispatch);
    }
    await ctx.emit({
      type: 'github.gh',
      kind: 'Code',
      text: ranText(input.words, input.repo),
      where: input.repo,
      payload: {
        repo: input.repo,
        words: input.words,
        keyId: input.keyId,
        ghHash: input.ghHash,
        ...(input.creates ? { creates: true } : {}),
        ...(input.foreign ? { foreign: true } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(approvalId ? { approvalId } : {}),
      },
    });
    return { approvalId };
  },
});

type ApprovalRow = typeof approvals.$inferSelect;

/** The agent's own `github.gh` requests for exactly this command (its hash, key and phrase) in one state. */
async function ghRequests(
  db: Db | Tx,
  where: { burrowId: string; agentId: string; input: GhInput },
  state: 'pending' | 'approved',
  decidedSince?: Date,
): Promise<ApprovalRow[]> {
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, where.burrowId),
        eq(approvals.requesterId, where.agentId),
        eq(approvals.state, state),
        sql`${approvals.action}->>'type' = 'custom'`,
        sql`${approvals.action}->'params'->'data'->>'ghHash' = ${where.input.ghHash}`,
        ...(decidedSince ? [gte(approvals.decidedAt, decidedSince)] : []),
      ),
    )
    .orderBy(desc(approvals.createdAt));
  // Only a card that says what this command does: a request the agent wrote itself carrying the same hash under
  // another name or key covers nothing (AGH-DS notes).
  const attempt = attemptOf(where.input);
  return rows.filter(
    (r) =>
      r.action.type === 'custom' &&
      r.action.params.keyId === where.input.keyId &&
      r.action.params.name === attempt.slice(0, 80) &&
      r.title === cap(attempt),
  );
}

/**
 * The yes this command runs under now, or null (AGH-09): the agent's approved request for exactly this command, decided
 * within 24 hours, that no `github.gh` event has used yet.
 */
export async function ghAllowance(
  db: Db | Tx,
  where: { burrowId: string; agentId: string; now: Date; input: GhInput },
): Promise<string | null> {
  const since = new Date(where.now.getTime() - GH_ALLOWANCE_MS);
  for (const row of await ghRequests(db, where, 'approved', since)) {
    const [used] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.burrowId, where.burrowId),
          eq(events.type, 'github.gh'),
          sql`${events.payload}->>'approvalId' = ${row.id}`,
        ),
      )
      .limit(1);
    if (!used) return row.id;
  }
  return null;
}

/**
 * The write asks a person (AGH-09): one `custom` approval naming what it does and carrying only its hash, its card in
 * the turn's thread, for the turn's person. A request for the same command still waiting answers instead of a second
 * card.
 */
async function askForGh(ctx: ApplyContext, input: GhInput, dispatch: DispatchRow): Promise<PendingGh> {
  const decision = ctx.decision;
  if (!decision) throw forbidden('A person has to approve this first.');
  const [waiting] = await ghRequests(
    ctx.tx,
    { burrowId: ctx.burrow.id, agentId: ctx.actor.id, input },
    'pending',
  );
  if (waiting?.eventId)
    return { pending: { approvalId: waiting.id, approvalNumber: waiting.number, eventId: waiting.eventId } };
  const conversation = await loadConversationRow(ctx.tx, dispatch.conversationId);
  if (!conversation) throw notFound('Conversation');
  const agent = ctx.actor.shortName;
  const attempt = attemptOf(input);
  const label = KEY_CATALOG[input.keyId].label;
  const { approval, eventId } = await createApproval(ctx, {
    keyId: input.keyId,
    action: {
      type: 'custom',
      params: { name: attempt.slice(0, 80), keyId: input.keyId, data: { ghHash: input.ghHash } },
    },
    decision,
    title: cap(attempt),
    question: asQuestion(cap(attempt)),
    target: input.repo,
    whatHappens: [cap(attempt), `${agent} is woken to run the same gh command again, once.`],
    explainer: `${agent} holds “${label}”, a key that only turns when a person approves. If you approve, ${agent} runs this gh command once in its next turn.`,
    summary: `${agent} wants to ${attempt}.`,
    conditions: [],
    involvedIds: [],
    conversation,
    threadRootId: dispatch.threadRootId,
    cardText: `I need a person to say yes before I ${attempt}.`,
    where: input.repo,
    command: null,
    onBehalfOfAccountId: dispatch.onBehalfOfAccountId ?? null,
  });
  return { pending: { approvalId: approval.id, approvalNumber: approval.number, eventId } };
}

/* The turn ------------------------------------------------------------------------------------------ */

/** A turn's `gh`: its context (null: none) and its checkout. */
export interface GhTurn {
  context: GhDispatchContext | null;
  checkout: { repo: string; branch: string } | null;
}

/** `DispatchContext.gh` and the checkout of a live dispatch, as its context gave them (AGH-12). */
export async function ghTurnOf(services: Services, row: DispatchRow): Promise<GhTurn> {
  if (!(await loadConversationRow(services.db, row.conversationId))) return { context: null, checkout: null };
  const workspace = await dispatchCheckout(services.db, row);
  const context = await ghContextFor(services, row, workspace);
  return { context, checkout: workspace ? { repo: workspace.repo, branch: workspace.branch } : null };
}

/* runner.ghAuthorize -------------------------------------------------------------------------------- */

const done = (exitCode: number, stdout: string, stderr = ''): GhAuthorizeReply => ({
  outcome: 'done',
  exitCode,
  stdout: stdout.slice(0, 64_000),
  stderr: stderr.slice(0, 8_000),
});
const fail = (exitCode: number, message: string) => done(exitCode, '', `${message}\n`);

/** sha256 of the repo, the words as decided, and every file and stdin the command sent (AGH-09). */
export function ghHash(
  repo: string,
  words: readonly string[],
  body: Pick<GhAuthorizeBody, 'files' | 'stdin'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([repo, words, body.files.map((f) => f.base64), body.stdin]))
    .digest('hex');
}

/** One gh command of a live dispatch (`runner.ghAuthorize`): plan, decide, and answer `run` or `done`. */
export async function authorizeGh(
  services: Services,
  dispatch: DispatchRow,
  body: GhAuthorizeBody,
): Promise<GhAuthorizeReply> {
  const files = body.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.base64, 'base64') }));
  const stdin = body.stdin === null ? null : Buffer.from(body.stdin, 'base64');
  const size = files.reduce((n, f) => n + f.bytes.length, 0) + (stdin?.length ?? 0);
  if (size > GH_INPUT_MAX_BYTES) return fail(1, GH_INPUT_TOO_BIG);
  const turn = await ghTurnOf(services, dispatch);
  if (!turn.context) return fail(1, GH_NOT_IN_TURN);
  const agent = await loadPrincipalRow(services.db, dispatch.agentId);
  if (!agent) throw notFound('Agent');
  const planFor = (repos: readonly string[]) =>
    planGh(body.args, {
      repos,
      defaultRepo: turn.context?.defaultRepo ?? null,
      checkout: turn.checkout,
      files: files.map((f) => ({ path: f.path, text: f.bytes.toString('utf8') })),
      stdin: stdin?.toString('utf8') ?? null,
      deployWorkflows: (repo) => deployWorkflowFiles(services.config.GITHUB_DEPLOY_WORKFLOW, repo),
      signature: signature(shortName(agent)),
    });
  let plan = planFor(turn.context.repos);
  /** Repositories the command may use that aren't the burrow's (AGH-23). */
  const foreign = new Set<string>();
  // A repository the burrow's GitHub connection reaches is added for agents the first time one names it (AGR-01).
  if (plan.kind === 'refuse' && plan.repo) {
    const wanted = plan.repo;
    const added = await ensureAgentRepo(services, {
      burrowId: dispatch.burrowId,
      agentId: dispatch.agentId,
      repo: wanted,
    });
    if (added) plan = planFor([...turn.context.repos, added]);
    // Anyone else's repository (an upstream's issues, a template, a fork's source) is used as it is, by the agent's
    // keys (AGH-23); only one the burrow has — switched off by a person, or kept on this Whombat — stays refused.
    else if (!(await burrowHasRepo(services, dispatch.burrowId, wanted))) {
      foreign.add(wanted.toLowerCase());
      plan = planFor([...turn.context.repos, wanted]);
    }
  }
  try {
    switch (plan.kind) {
      case 'refuse':
        return fail(plan.exitCode, plan.message);
      case 'read':
        return await runReply(services, dispatch, plan.args, plan.repo);
      case 'write':
        return await write(services, dispatch, plan, body, foreign);
      case 'whombat':
        return await whombat(services, dispatch, plan.repo, plan.op);
      case 'create_repo':
        return await createRepo(services, dispatch, plan, body);
    }
  } catch (err) {
    // A GitHub sign-in that can't be used (managedGitToken's sentences), a refusal of a command (a PR already open,
    // a merge rule), GitHub's own refusal of a new repository: the stand-in prints it (AGH-15).
    if (err instanceof ApiError || err instanceof GitHubError) return fail(1, err.message);
    throw err;
  }
}

/** `run`: the words, the repo for `GH_REPO`, and the agent's token (AGH-01, AGH-03). */
async function runReply(
  services: Services,
  dispatch: DispatchRow,
  args: string[],
  repo: string | null,
): Promise<GhAuthorizeReply> {
  const token = await services.github.agentToken({ burrowId: dispatch.burrowId, agentId: dispatch.agentId });
  return { outcome: 'run', args, repo, token: token.token, expiresAt: token.expiresAt };
}

/** A command as the agent, in its turn's scope (what it asks is for the turn's person, SUB-28). */
async function commitAsAgent<R>(
  services: Services,
  dispatch: DispatchRow,
  command: CommandDef<z.ZodType, R>,
  input: unknown,
): Promise<CommitResult<R>> {
  const behalf = await onBehalfOf(services, dispatch);
  return runInDispatchScope(dispatchScopeOf(dispatch), () =>
    services.pipeline.commit(command, input, {
      burrowId: dispatch.burrowId,
      actorId: dispatch.agentId,
      onBehalfOf: behalf,
    }),
  );
}

/** Whether the burrow has this repository at all (switched on or off, on GitHub or kept here). */
async function burrowHasRepo(services: Services, burrowId: string, repo: string): Promise<boolean> {
  if (repo.toLowerCase().startsWith('local/')) return true;
  const [row] = await services.db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), sql`lower(${repos.fullName}) = lower(${repo})`))
    .limit(1);
  return !!row;
}

async function write(
  services: Services,
  dispatch: DispatchRow,
  plan: Extract<GhPlan, { kind: 'write' }>,
  body: GhAuthorizeBody,
  foreign: ReadonlySet<string>,
): Promise<GhAuthorizeReply> {
  // The token first: a sign-in that can't be used signs nothing.
  const token = await services.github.agentToken({ burrowId: dispatch.burrowId, agentId: dispatch.agentId });
  const repo = plan.repo ?? GH_ACCOUNT;
  const res = await commitAsAgent(services, dispatch, githubGh, {
    dispatchId: dispatch.id,
    repo,
    keyId: plan.keyId,
    action: plan.action,
    words: plan.words,
    ghHash: ghHash(repo, plan.hashArgs, body),
    ...(plan.repo === null || foreign.has(repo.toLowerCase()) ? { foreign: true } : {}),
    ...(plan.branch ? { branch: plan.branch } : {}),
  });
  const waits = await notDecided(services, dispatch, res);
  if (waits) return waits;
  return { outcome: 'run', args: plan.args, repo: plan.repo, token: token.token, expiresAt: token.expiresAt };
}

/** A `github.gh` that didn't go through: Blocked (exit 126), or waiting for a person (exit 125); null when it did. */
async function notDecided(
  services: Services,
  dispatch: DispatchRow,
  res: CommitResult<{ approvalId: string | null } | PendingGh>,
): Promise<GhAuthorizeReply | null> {
  if (res.status === 'blocked') return fail(126, res.message);
  if (res.status === 'pending_approval')
    return fail(
      125,
      ghAskedText(...(await askedWhom(services, dispatch, res.approvalId)), res.approvalNumber),
    );
  if ('pending' in res.result) {
    const p = res.result.pending;
    return fail(125, ghAskedText(...(await askedWhom(services, dispatch, p.approvalId)), p.approvalNumber));
  }
  return null;
}

/**
 * `gh repo create` (AGH-19, AGH-20): named in the connection's account unless it names an owner; the key decides as for
 * a write (once per yes); then Whombat makes it as the connection and switches it on for agents.
 */
async function createRepo(
  services: Services,
  dispatch: DispatchRow,
  plan: Extract<GhPlan, { kind: 'create_repo' }>,
  body: GhAuthorizeBody,
): Promise<GhAuthorizeReply> {
  const github = services.github;
  const login =
    github.adapter && (await github.isConnected(dispatch.burrowId))
      ? await github.connectionLoginFor(dispatch.burrowId)
      : null;
  if (!login) return fail(1, GH_REPO_NOT_CONNECTED);
  const { owner: named, ...spec } = plan.repo;
  const owner = named ?? login;
  const fullName = `${owner}/${spec.name}`;
  const res = await commitAsAgent(services, dispatch, githubGh, {
    dispatchId: dispatch.id,
    repo: fullName,
    keyId: plan.keyId,
    action: `${plan.action} ${fullName}`,
    words: plan.words,
    ghHash: ghHash(fullName, plan.hashArgs, body),
    creates: true,
  });
  const waits = await notDecided(services, dispatch, res);
  if (waits) return waits;
  const made = await createAgentRepo(services, {
    burrowId: dispatch.burrowId,
    agentId: dispatch.agentId,
    login,
    owner,
    spec,
  });
  return done(0, createdText(made));
}

/** Who was asked (“Joris and Mara”) and where the card is (“in this thread”, “in Joris’s Chat”, “in feat/pdf”). */
async function askedWhom(
  services: Services,
  dispatch: DispatchRow,
  approvalId: string,
): Promise<[people: string, where: string]> {
  const [row] = await services.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!row) return ['a person', 'here'];
  const ids = row.conditions.flatMap((c) => (c.kind === 'person_approves' ? c.approverIds : []));
  const people = (await loadPrincipalsByIds(services.db, [...new Set(ids)])).map((p) => shortName(p));
  let where = 'here';
  if (row.conversationId === dispatch.conversationId)
    where = dispatch.threadRootId ? 'in this thread' : 'here';
  else {
    const conversation = row.conversationId
      ? await loadConversationRow(services.db, row.conversationId)
      : undefined;
    if (conversation) where = `in ${await roomLabel(services, conversation)}`;
  }
  return [people.length ? andList(people) : 'a person', where];
}

/**
 * A room as the agent reads it in a gh answer: a person's own room with the agent by whose it is (its title is the
 * agent's own name, one-agent.md OA-S29), any other by its label.
 */
async function roomLabel(services: Services, conversation: ConversationRow): Promise<string> {
  const room = chatRoomOf(conversation);
  const person = room ? await loadPrincipalRow(services.db, conversation.dmPersonId ?? '') : undefined;
  if (!room || !person) return conversationLabel(conversation);
  return `${shortName(person)}’s ${room === 'feedback' ? 'Feedback room' : 'Chat'}`;
}

/** The number of the pull request a `pr` command names (by number, or its head branch's open one). */
async function prNumber(services: Services, burrowId: string, repo: string, ref: GhPrRef): Promise<number> {
  if ('number' in ref) return ref.number;
  const [row] = await services.db
    .select({ number: pullRequests.number })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.burrowId, burrowId),
        eq(repos.fullName, repo),
        eq(pullRequests.branch, ref.branch),
        eq(pullRequests.state, 'open'),
      ),
    )
    .orderBy(desc(pullRequests.number))
    .limit(1);
  if (!row) throw new ApiError('not_found', noOpenPr(ref.branch, repo));
  return row.number;
}

/** `gh pr create`, `merge` and `review` as Whombat's own commands, printed like gh prints them (AGH-05). */
async function whombat(
  services: Services,
  dispatch: DispatchRow,
  repo: string,
  op: GhWhombatOp,
): Promise<GhAuthorizeReply> {
  let res: CommitResult<unknown>;
  let printed: (result: unknown) => Promise<string>;
  if (op.op === 'pr_create') {
    const [row] = await services.db
      .select({ id: repos.id, defaultBranch: repos.defaultBranch })
      .from(repos)
      .where(and(eq(repos.burrowId, dispatch.burrowId), eq(repos.fullName, repo)));
    if (!row) throw notFound(`Repo ${repo}`);
    res = await commitAsAgent(services, dispatch, openPr, {
      repo,
      branch: op.head,
      base: op.base ?? row.defaultBranch,
      title: op.title,
      body: op.body,
      conversationId: dispatch.conversationId,
    });
    printed = async (result) => {
      const n = (result as { number: number }).number;
      const [pr] = await services.db
        .select({ url: pullRequests.url })
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, row.id), eq(pullRequests.number, n)));
      return `${pr?.url ?? `PR #${n}`}\n`;
    };
  } else {
    const number = await prNumber(services, dispatch.burrowId, repo, op.pr);
    if (op.op === 'pr_merge') {
      res = await commitAsAgent(services, dispatch, mergePr, {
        number,
        repo,
        ...(op.method ? { method: op.method } : {}),
        conversationId: dispatch.conversationId,
      });
      printed = async () => `✓ Merged pull request #${number}\n`;
    } else {
      const decision = op.decision;
      res = await commitAsAgent(services, dispatch, reviewPr, {
        prNumber: number,
        repo,
        decision,
        body: op.body,
        comments: [],
      });
      printed = async () => `${reviewedText(decision, number)}\n`;
    }
  }
  if (res.status === 'blocked') return fail(126, res.message);
  if (res.status === 'pending_approval')
    return fail(
      125,
      ghWhombatAskedText(...(await askedWhom(services, dispatch, res.approvalId)), res.approvalNumber),
    );
  return done(0, await printed(res.result));
}
