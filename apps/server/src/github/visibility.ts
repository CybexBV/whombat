/**
 * Only switched-on repos are visible to agents; one the burrow doesn't have yet is added for them when its
 * GitHub connection reaches it (agent-repos.md AGR-01), one a person switched off stays hidden. Enforced where agents
 * meet repos:
 * - DispatchContext (runtime/context.ts): no workspace for a repo that is off; facts list only repos on;
 * - search (read/search.ts): branch rooms and PR hits of repos that are off are dropped for agents;
 * - MCP tools (`beforeTool`, called by mcp/server.ts): tools naming a repo, a PR, a branch room or a message
 *   in one answer "not found" when the repo is off — as if it did not exist;
 * - git credentials (runtime/git.ts): no token for a repo that is off.
 */
import type { McpToolName } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { conversations, repos } from '../db/schema/index';
import { notFound } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { loadMessageRow } from '../read/messages';
import { prByNumber } from '../read/work';
import { ensureAgentRepo } from './agent-repos';

/** Ids of the burrow's repos that are switched off. */
export async function hiddenRepoIds(db: Db, burrowId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.enabled, false)));
  return new Set(rows.map((r) => r.id));
}

/** Branch rooms of repos that are switched off (agents never see them). */
export async function hiddenConversationIds(db: Db, burrowId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(repos, eq(repos.id, conversations.repoId))
    .where(
      and(eq(conversations.burrowId, burrowId), eq(conversations.kind, 'branch'), eq(repos.enabled, false)),
    );
  return new Set(rows.map((r) => r.id));
}

async function repoVisible(db: Db, burrowId: string, fullName: string): Promise<void> {
  const [repo] = await db
    .select({ enabled: repos.enabled })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, fullName)));
  if (!repo?.enabled) throw notFound(`Repo ${fullName}`);
}

async function conversationVisible(db: Db, burrowId: string, conversationId: string): Promise<void> {
  if ((await hiddenConversationIds(db, burrowId)).has(conversationId)) throw notFound('Conversation');
}

async function prVisible(db: Db, burrowId: string, number: number, repo?: string): Promise<void> {
  const pr = await prByNumber(db, burrowId, number, repo);
  if (!pr) return; // the command says "not found" itself
  if ((await hiddenRepoIds(db, burrowId)).has(pr.repoId)) throw notFound('Pull request');
}

/**
 * Runs before every MCP tool call: refuses anything about a repo that is switched off, and — for
 * `open_pull_request` — gives the runner a moment to push the branch the agent just committed to.
 */
export async function beforeTool(ctx: ToolContext, name: McpToolName, input: unknown): Promise<void> {
  const db = ctx.services.db;
  const i = input as {
    conversationId?: string;
    messageId?: string;
    repo?: string;
    branch?: string;
    prNumber?: number;
  };
  if (i.conversationId) await conversationVisible(db, ctx.burrowId, i.conversationId);
  if (name === 'reply_in_thread' && i.messageId) {
    const root = await loadMessageRow(db, i.messageId);
    if (root) await conversationVisible(db, ctx.burrowId, root.conversationId);
  }
  // A GitHub repository the burrow doesn't have yet is added for agents when the connection reaches it (agent-repos.md
  // AGR-01), so a run or a pull request on it just goes on.
  if (i.repo && (name === 'start_run' || name === 'open_pull_request')) {
    // A run pushes its branch: on someone else's public repository it runs on the connection's own copy (AGR-07).
    const repo = await ensureAgentRepo(ctx.services, {
      burrowId: ctx.burrowId,
      agentId: ctx.agentId,
      repo: i.repo,
      copy: name === 'start_run',
    });
    // The tool goes on with GitHub's own spelling of the name (`acme/web` for `Acme/Web`), or the run's copy.
    if (repo) i.repo = repo;
  }
  // `start_run` answers a repository agents can't see in words a person acts on, the same for one not added and one
  // switched off (its handler, runtime/checkout-access.ts, resourceful-agents.md RA-DS53).
  if (i.repo && name === 'open_pull_request') await repoVisible(db, ctx.burrowId, i.repo);
  if (i.prNumber && (name === 'review_pull_request' || name === 'merge_pull_request'))
    await prVisible(db, ctx.burrowId, i.prNumber, i.repo);
  if (name === 'open_pull_request' && i.repo && i.branch)
    await ctx.services.github.awaitBranch(ctx.burrowId, i.repo, i.branch);
}
