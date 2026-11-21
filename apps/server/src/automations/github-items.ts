/**
 * GitHub issues and pull requests in automation runs (docs/decisions/automation-recipes.md): what `{{trigger.*}}` reads
 * for one (the same for a real event and a test run on a sample), the readable `trigger.text` a recipe's prompt embeds,
 * the run's item key (`github:acme/web#57`) and the thread earlier runs about the same item started.
 */
import {
  type AutomationDefinition,
  type Expr,
  GITHUB_PR_EVENTS,
  type GitHubTrigger,
  type GitHubTriggerEvent,
  type JsonObject,
  parseExpr,
  RECIPE_FIX_BRANCH,
} from '@whombat/core';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { automationRuns, githubIssues, messages, pullRequests, repos } from '../db/schema/index';
import type { GhPullRequest, GitHubAdapter } from '../github/adapter';
import { prBranch } from '../github/adapter';
import { githubScope } from '../managed/providers/github-adapter';

/** An issue or a pull request as a run sees it. */
export const GitHubItem = z.object({
  item: z.enum(['issue', 'pull_request']),
  repo: z.string().min(3).max(255),
  number: z.number().int().positive(),
  title: z.string().max(1000),
  body: z.string().max(8192),
  /** GitHub login of whoever opened it. */
  author: z.string().max(255).nullable(),
  bot: z.boolean(),
  url: z.string().max(2000),
  labels: z.array(z.string().max(100)).max(20),
  /** Pull requests only (else false / null). */
  draft: z.boolean(),
  /** The head branch as the burrow keys it (a fork's is `owner:ref`). */
  branch: z.string().max(255).nullable(),
  base: z.string().max(255).nullable(),
  sha: z.string().max(64).nullable(),
  fork: z.boolean(),
  /** GitHub's `author_association` of whoever opened it (null: unknown); `trigger.trusted` (AR-27). */
  authorAssociation: z.string().max(40).nullable(),
  /** Logins assigned to it; `trigger.assigned`. */
  assignees: z.array(z.string().max(100)).max(20),
  /** An issue only: an open pull request of the repo says it closes it, or is on its fix branch; `trigger.linkedPr`. */
  linkedPr: z.boolean(),
});
export type GitHubItem = z.infer<typeof GitHubItem>;

/* Who opened it, who works on it (AR-27, AR-28) -------------------------------------------------------- */

/** The `author_association`s that mean the author has access to the repo: its owner, a member or a collaborator. */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** `trigger.trusted`: the author has access to the repo. Unknown (null, anything else) is not trusted. */
export function isTrustedAssociation(association: string | null | undefined): boolean {
  return !!association && TRUSTED_ASSOCIATIONS.includes(association.toUpperCase());
}

/** The branch a recipe fixes issue `number` on (`RECIPE_FIX_BRANCH`: `feat/issue-142`). */
export function fixBranchOf(number: number): string {
  return RECIPE_FIX_BRANCH.replace('{{trigger.number}}', String(number));
}

const CLOSING_KEYWORDS = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a pull request's text closes issue `number` of `repo` the way GitHub reads it: a closing keyword (close,
 * closes, closed, fix, fixes, fixed, resolve, resolves, resolved; any case, an optional colon) and then `#142`,
 * `acme/web#142` or the issue's link. `#1420` and `hotfixes #142` don't count.
 */
export function closesIssue(text: string, repo: string, number: number): boolean {
  if (!text) return false;
  const name = escapeRegExp(repo);
  const ref = `(?:(?:${name})?#${number}|https?://github\\.com/${name}/issues/${number})(?![0-9])`;
  return new RegExp(`(?<![\\w-])${CLOSING_KEYWORDS}:?\\s+${ref}`, 'i').test(text);
}

/**
 * `trigger.linkedPr` of issue `number`: an open pull request whose title or description closes it (`closesIssue`), or
 * whose head branch is the issue's fix branch (`feat/issue-<n>`, a fork's too).
 */
export function linksIssue(
  pr: { title: string; body: string | null; headRef: string },
  repo: string,
  number: number,
): boolean {
  return (
    pr.headRef === fixBranchOf(number) ||
    closesIssue(pr.title, repo, number) ||
    closesIssue(pr.body ?? '', repo, number)
  );
}

/** Whether one of these open pull requests links issue `number` of `repo` (`linksIssue`). */
export function linkedByAny(prs: readonly GhPullRequest[], repo: string, number: number): boolean {
  return prs.some((p) => p.state === 'open' && linksIssue(p, repo, number));
}

/** How much of the description `trigger.text` carries (the prompt is rendered to at most 3900 characters). */
export const TEXT_BODY_MAX = 2000;

/** What a run about this item remembers it by: later runs of the automation about it continue its thread. */
export function itemKeyOf(repo: string, number: number): string {
  return `github:${repo.toLowerCase()}#${number}`;
}

/** “acme/web#142”. */
export const itemRef = (item: Pick<GitHubItem, 'repo' | 'number'>) => `${item.repo}#${item.number}`;

function quoted(title: string): string {
  return `“${title.replace(/\s+/g, ' ').trim()}”`;
}

/** The first line of `trigger.text`: what happened, to what, by whom. */
export function githubHeadline(
  event: GitHubTriggerEvent,
  item: GitHubItem,
  extra: { checksState?: string | null; readied?: boolean } = {},
): string {
  const by = item.author ? ` by @${item.author}` : '';
  if (item.item === 'issue') return `New issue #${item.number} on ${item.repo}${by}: ${quoted(item.title)}`;
  const what = `pull request #${item.number} on ${item.repo}${by}`;
  const tail = `: ${quoted(item.title)}${item.branch && item.base ? ` (${item.branch} → ${item.base})` : ''}`;
  switch (event) {
    case 'pr_opened':
      return extra.readied
        ? `Pull request #${item.number} on ${item.repo}${by} is ready for review${tail}`
        : `New ${what}${tail}`;
    case 'pr_updated':
      return `New commits on ${what}${tail}`;
    case 'checks_completed':
      return `Checks ${extra.checksState === 'failed' ? 'failed' : extra.checksState === 'passed' ? 'passed' : 'finished'} on ${what}${tail}`;
    case 'review_submitted':
      return `A review on ${what}${tail}`;
    default:
      return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)}${tail}`;
  }
}

/**
 * `trigger.text` for an issue or pull request: a readable block a recipe's prompt embeds — the headline, the link, the
 * labels, a word on drafts and forks, then the description (cut to `TEXT_BODY_MAX`).
 */
export function githubTriggerText(
  event: GitHubTriggerEvent,
  item: GitHubItem,
  extra: { checksState?: string | null; readied?: boolean } = {},
): string {
  const lines = [githubHeadline(event, item, extra), item.url];
  if (item.labels.length) lines.push(`Labels: ${item.labels.slice(0, 10).join(', ')}`);
  if (item.item === 'pull_request' && item.draft) lines.push('It is still a draft.');
  if (item.fork) lines.push('This pull request comes from a fork: read its code, don’t run it.');
  const body = item.body.trim();
  if (body)
    lines.push('', body.length > TEXT_BODY_MAX ? `${body.slice(0, TEXT_BODY_MAX - 1).trimEnd()}…` : body);
  return lines.join('\n');
}

/** What `{{trigger.*}}` reads for an issue or pull request (`prNumber` only for a pull request). */
export function githubItemScope(
  event: GitHubTriggerEvent,
  item: GitHubItem,
  extra: { checksState?: string | null; readied?: boolean } = {},
): JsonObject {
  return {
    kind: 'github',
    event,
    item: item.item,
    repo: item.repo,
    number: item.number,
    ...(item.item === 'pull_request' ? { prNumber: item.number } : {}),
    title: item.title,
    body: item.body,
    author: item.author,
    bot: item.bot,
    url: item.url,
    labels: item.labels,
    draft: item.draft,
    fork: item.fork,
    branch: item.branch,
    base: item.base,
    sha: item.sha,
    checksState: extra.checksState ?? null,
    ...(extra.readied ? { readied: true } : {}),
    // Who opened it and whether someone works on it (AR-27, AR-28): the auto-fix gate reads them fresh from GitHub.
    trusted: isTrustedAssociation(item.authorAssociation),
    assigned: item.assignees.length > 0,
    linkedPr: item.linkedPr,
    text: githubTriggerText(event, item, extra),
  };
}

/** A pull request row as an item (null when it isn't in the burrow). */
export async function pullRequestItem(db: Db, prId: string): Promise<GitHubItem | null> {
  const [row] = await db
    .select({ pr: pullRequests, repo: repos.fullName })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(eq(pullRequests.id, prId));
  if (!row) return null;
  const pr = row.pr;
  return {
    item: 'pull_request',
    repo: row.repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.authorLogin,
    bot: pr.authorBot,
    url: pr.url ?? `https://github.com/${row.repo}/pull/${pr.number}`,
    labels: [],
    draft: pr.draft,
    branch: pr.branch,
    base: pr.baseBranch,
    sha: pr.headSha,
    // A fork's branch is keyed `owner:ref` (`prBranch`): git refs can't hold a colon.
    fork: pr.branch.includes(':'),
    authorAssociation: pr.authorAssociation,
    assignees: pr.assignees,
    linkedPr: false,
  };
}

/** A mirrored issue as an item (null when it isn't in the burrow); `linkedPr` from the pull requests the burrow knows. */
export async function issueItem(db: Db, issueId: string): Promise<GitHubItem | null> {
  const [row] = await db.select().from(githubIssues).where(eq(githubIssues.id, issueId));
  if (!row) return null;
  return {
    item: 'issue',
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    author: row.authorLogin,
    bot: row.authorBot,
    url: row.url,
    labels: row.labels,
    draft: false,
    branch: null,
    base: null,
    sha: null,
    fork: false,
    authorAssociation: row.authorAssociation,
    assignees: row.assignees,
    linkedPr: await linkedInBurrow(db, row.burrowId, row.repo, row.number),
  };
}

/** Whether an open pull request the burrow mirrored links issue `number` (`linksIssue`). */
async function linkedInBurrow(db: Db, burrowId: string, repo: string, number: number): Promise<boolean> {
  const open = await db
    .select({ title: pullRequests.title, body: pullRequests.body, branch: pullRequests.branch })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(eq(pullRequests.burrowId, burrowId), eq(repos.fullName, repo), eq(pullRequests.state, 'open')),
    );
  return open.some((p) =>
    // A fork's branch is keyed `owner:ref`.
    linksIssue({ ...p, headRef: p.branch.slice(p.branch.indexOf(':') + 1) }, repo, number),
  );
}

/**
 * An issue or pull request read from GitHub now (“Try it on …”, a test run on a sample), as the burrow's GitHub
 * connection. A `GitHubError` 404 when the repo has no such number.
 */
export async function fetchGitHubItem(
  adapter: GitHubAdapter,
  burrowId: string,
  repo: string,
  number: number,
): Promise<GitHubItem> {
  return githubScope.run({ burrowId }, async () => {
    const issue = await adapter.getIssue(repo, number);
    if (!issue.pullRequest)
      return {
        item: 'issue',
        repo,
        number: issue.number,
        title: issue.title.slice(0, 1000),
        body: (issue.body ?? '').slice(0, 8192),
        author: issue.author,
        bot: issue.authorBot,
        url: issue.url,
        labels: issue.labels.slice(0, 20),
        draft: false,
        branch: null,
        base: null,
        sha: null,
        fork: false,
        authorAssociation: issue.authorAssociation,
        assignees: issue.assignees.slice(0, 20),
        linkedPr: await linkedOnGitHub(adapter, repo, number),
      };
    const pr = await adapter.getPullRequest(repo, number);
    return {
      item: 'pull_request',
      repo,
      number: pr.number,
      title: pr.title.slice(0, 1000),
      body: (pr.body ?? '').slice(0, 8192),
      author: pr.author,
      bot: pr.authorBot,
      url: pr.url,
      labels: issue.labels.slice(0, 20),
      draft: pr.draft,
      branch: prBranch(pr),
      base: pr.baseRef,
      sha: pr.headSha,
      fork: pr.fork !== null,
      authorAssociation: pr.authorAssociation,
      assignees: pr.assignees.slice(0, 20),
      linkedPr: false,
    };
  });
}

/** Whether an open pull request on GitHub links issue `number` (`linksIssue`); can't be read: linked (AR-28). */
async function linkedOnGitHub(adapter: GitHubAdapter, repo: string, number: number): Promise<boolean> {
  try {
    const open = await adapter.openPullRequests(repo, []);
    return !open.modified || linkedByAny(open.data, repo, number);
  } catch {
    return true;
  }
}

/** The `trigger.*` facts the gate reads fresh from GitHub (AR-28). */
export const GATE_FACTS = ['trusted', 'assigned', 'linkedPr'] as const;

/** Whether a condition reads `trigger.trusted`, `trigger.assigned` or `trigger.linkedPr` (false when it doesn't parse). */
export function readsGateFacts(condition: string): boolean {
  let expr: Expr;
  try {
    expr = parseExpr(condition);
  } catch {
    return false;
  }
  const reads = (e: Expr): boolean => {
    switch (e.k) {
      case 'path':
        return e.parts[0] === 'trigger' && (GATE_FACTS as readonly string[]).includes(e.parts[1] ?? '');
      case 'call':
        return e.args.some(reads);
      case 'not':
        return reads(e.e);
      case 'bin':
        return reads(e.a) || reads(e.b);
      default:
        return false;
    }
  };
  return reads(expr);
}

/** What the auto-fix gate reads about an issue or pull request, from GitHub now (AR-28). */
export interface GateFacts {
  trusted: boolean;
  assigned: boolean;
  linkedPr: boolean;
  /** Why GitHub couldn't be read (then: not trusted, assigned and linked, so a person is asked). */
  unreadable?: string;
}

/** What the gate reads when GitHub can't be read: a person decides (AR-28). */
export const UNREADABLE_FACTS: Omit<GateFacts, 'unreadable'> = {
  trusted: false,
  assigned: true,
  linkedPr: true,
};

/**
 * `trigger.trusted`, `assigned` and `linkedPr` of an issue or pull request as GitHub has them now, for a condition that
 * reads them (the auto-fix gate, AR-28): who opened it and who is assigned (`getIssue`), and for an issue the open pull
 * requests that link it. Anything GitHub doesn't answer counts against fixing on its own (`UNREADABLE_FACTS`).
 */
export async function gateFacts(
  adapter: GitHubAdapter | null,
  burrowId: string,
  item: { item: GitHubItem['item']; repo: string; number: number },
): Promise<GateFacts> {
  if (!adapter) return { ...UNREADABLE_FACTS, unreadable: 'GitHub isn’t connected.' };
  try {
    return await githubScope.run({ burrowId }, async () => {
      const now = await adapter.getIssue(item.repo, item.number);
      let linkedPr = false;
      if (item.item === 'issue') {
        const open = await adapter.openPullRequests(item.repo, []);
        // Without a list (GitHub answered “unchanged” to a read without ETags) nothing says it isn't linked.
        linkedPr = !open.modified || linkedByAny(open.data, item.repo, item.number);
      }
      return {
        trusted: isTrustedAssociation(now.authorAssociation),
        assigned: now.assignees.length > 0,
        linkedPr,
      };
    });
  } catch (err) {
    return {
      ...UNREADABLE_FACTS,
      unreadable: `GitHub couldn’t be read: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        300,
      ),
    };
  }
}

/**
 * The thread the latest earlier run of this automation about the same item started in its room, when its root is still
 * there (null: this run starts one). One issue or pull request, one thread (automation-recipes.md).
 */
export async function itemThread(
  db: Db,
  automationId: string,
  itemKey: string,
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ threadRootId: automationRuns.threadRootId })
    .from(automationRuns)
    .innerJoin(messages, eq(messages.id, automationRuns.threadRootId))
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        eq(automationRuns.itemKey, itemKey),
        eq(automationRuns.conversationId, conversationId),
        isNotNull(automationRuns.threadRootId),
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  return row?.threadRootId ?? null;
}

/** A definition's GitHub triggers, in order. */
export function githubTriggers(definition: AutomationDefinition): GitHubTrigger[] {
  return definition.triggers.filter((t): t is GitHubTrigger => t.kind === 'github');
}

/**
 * The repos a stored definition watches, read without validating it (a draft may not validate yet): its GitHub
 * triggers' and its recipe's `when.repo`. Whose pictures `github.avatar` shows (automation-list.md AL-S05).
 */
export function watchedRepos(definition: unknown): string[] {
  if (!definition || typeof definition !== 'object') return [];
  const d = definition as {
    triggers?: unknown;
    recipe?: { when?: { kind?: unknown; repo?: unknown } } | null;
  };
  const out: string[] = [];
  if (Array.isArray(d.triggers))
    for (const t of d.triggers as { kind?: unknown; repo?: unknown }[])
      if (t?.kind === 'github' && typeof t.repo === 'string') out.push(t.repo);
  const when = d.recipe?.when;
  if (when?.kind === 'github' && typeof when.repo === 'string') out.push(when.repo);
  return out;
}

/**
 * The trigger a test run on a sample stands in for (“Try it on …”): an issue → the `issue_opened` trigger; a pull
 * request → `pr_opened`, else the first other pull request trigger. Null when none fires on that kind of item.
 */
export function sampleTrigger(
  definition: AutomationDefinition,
  item: GitHubItem['item'],
): GitHubTrigger | null {
  const triggers = githubTriggers(definition);
  if (item === 'issue') return triggers.find((t) => t.event === 'issue_opened') ?? null;
  return (
    triggers.find((t) => t.event === 'pr_opened') ??
    triggers.find((t) => GITHUB_PR_EVENTS.includes(t.event)) ??
    null
  );
}
