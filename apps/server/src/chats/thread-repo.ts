/**
 * Which repository a thread's work is in, for its row's icon (docs/decisions/chat-inbox.md): the repository of the
 * automation runs the thread belongs to; without one, of the work handed over from it (a T3 Code job's pull request, a
 * run of the agent's own). One repository or none: when the thread's runs or jobs name different repositories, it
 * can't be told and the row shows no repository.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/** A GitHub `owner/name` (never a template like `{{trigger.repo}}`). */
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` when the value is one, else null. */
export function repoFullName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return FULL_NAME.test(name) && !name.endsWith('/.') && !name.endsWith('/..') ? name : null;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The repositories an automation's definition works in: its recipe's (the GitHub trigger's, else the checkout it reads),
 * its GitHub triggers', and its steps' (a checkout, a comment, a pull request, a merge).
 */
export function definitionRepos(definition: unknown): string[] {
  const d = rec(definition);
  const recipe = rec(d.recipe);
  const found = [
    rec(recipe.when).repo,
    recipe.repo,
    ...list(d.triggers).map((t) => rec(t).repo),
    ...list(d.steps).flatMap((s) => [rec(s).repo, rec(rec(s).workspace).repo, rec(rec(s).bindBranch).repo]),
  ];
  return found.flatMap((v) => {
    const name = repoFullName(v);
    return name ? [name] : [];
  });
}

/** The one repository the names agree on (case aside), as first written; null for none or several. */
export function oneRepo(names: Iterable<string>): string | null {
  let first: string | null = null;
  for (const name of names) {
    if (first === null) first = name;
    else if (first.toLowerCase() !== name.toLowerCase()) return null;
  }
  return first;
}

/** The thread's repository: its automation runs' when they name any, else its jobs'. */
export function threadRepoOf(automation: readonly string[], jobs: readonly string[]): string | null {
  return automation.length ? oneRepo(automation) : oneRepo(jobs);
}

/** The short name a row shows (`owner/name` → `name`). */
export function repoShortName(fullName: string): string {
  return fullName.slice(fullName.indexOf('/') + 1) || fullName;
}

const inList = (ids: readonly string[]) =>
  sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  );

/**
 * The repository of each thread of a room that has one, in two queries whatever the number of threads: the automation
 * runs whose thread it is, and the work handed over from it.
 */
export async function threadRepos(
  db: Db,
  room: { burrowId: string; conversationId: string },
  rootIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rootIds.length) return out;
  const [runs, jobs] = await Promise.all([
    // One definition per automation version is enough: later runs of the same version say the same.
    db.execute<{ root_id: string; definition: unknown }>(sql`
      select distinct on (thread_root_id, automation_id, version) thread_root_id as root_id, definition
        from automation_runs
       where thread_root_id in (${inList(rootIds)})
         and burrow_id = ${room.burrowId} and conversation_id = ${room.conversationId}`),
    db.execute<{ root_id: string; repo: string | null }>(sql`
      select w.thread_root_id as root_id, w.progress #>> '{pullRequest,repo}' as repo
        from t3_watches w
       where w.conversation_id = ${room.conversationId} and w.thread_root_id in (${inList(rootIds)})
      union all
      select coalesce(cm.thread_root_id, cm.id), p.full_name
        from runs u
        join repos p on p.id = u.repo_id
        join messages cm on cm.id = u.message_id
       where u.burrow_id = ${room.burrowId} and cm.conversation_id = ${room.conversationId}
         and coalesce(cm.thread_root_id, cm.id) in (${inList(rootIds)})
      union all
      select d.thread_root_id, p.full_name
        from runs u
        join repos p on p.id = u.repo_id
        join dispatches d on d.id = u.dispatch_id
       where u.burrow_id = ${room.burrowId} and d.conversation_id = ${room.conversationId}
         and d.thread_root_id in (${inList(rootIds)})`),
  ]);
  const byAutomation = new Map<string, string[]>();
  for (const r of runs)
    byAutomation.set(r.root_id, [...(byAutomation.get(r.root_id) ?? []), ...definitionRepos(r.definition)]);
  const byJob = new Map<string, string[]>();
  for (const r of jobs) {
    const name = repoFullName(r.repo);
    if (name) byJob.set(r.root_id, [...(byJob.get(r.root_id) ?? []), name]);
  }
  for (const id of rootIds) {
    const repo = threadRepoOf(byAutomation.get(id) ?? [], byJob.get(id) ?? []);
    if (repo) out.set(id, repo);
  }
  return out;
}
