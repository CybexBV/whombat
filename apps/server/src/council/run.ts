/**
 * Running a council (docs/decisions/council.md): what happens between its commits, where Whombat's server calls T3 Code
 * through the connection's own sign-in. A council is one lead thread in T3 Code that runs it there: Whombat starts that
 * thread with the council's brief (`launchLead`, committed as `council.launched`, which watches it), finds the
 * reviewers it starts as its children on every watcher pass and reads each one's answer once it ended (`syncCouncils`,
 * committed as `council.sync`), sends it on when the agent says so (`tellLead`) and stops it. Nothing else is
 * Whombat's: the rounds, the plan, the build and the fixes are the lead's.
 */
import { createHash } from 'node:crypto';
import { COUNCIL_ANSWER_MAX, COUNCIL_ROUNDS_DEFAULT, newId } from '@whombat/core';
import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { CommitOptions } from '../commit/types';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import {
  type CouncilMemberRow,
  type CouncilRow,
  catalogConnections,
  councilMembers,
  councils,
} from '../db/schema/index';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { Services } from '../services';
import { readLastAnswer } from '../t3code/answer';
import { settleLater } from '../t3code/settle';
import { launchTitle, stateArgs, threadStateOf, watchedPullRequestsOf } from '../t3code/threads';
import { rarelyRead, webUrl } from '../things/kinds/business/common';
import { callT3, environmentOf, FINISHED, T3Failure } from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';
import { LIMIT_BRIEF, lateBrief, leadBrief, leadTitle, STOP_BRIEF, tellBrief } from './briefs';
import {
  COUNCIL_QUIET_DAYS,
  type CouncilReviewer,
  councilLaunched,
  councilLaunchFailed,
  councilTold,
  expireCouncil,
  loadCouncil,
  loadMembers,
  memberEnded,
  Reviewer,
  stopCouncil,
  syncCouncil,
} from './commands';
import { childrenOf, childState, type ListedChild, placeChild } from './lead';
import { T3_COUNCIL } from './members';

/** How long a task's picture link works at most (DLG-27). */
export const UPLOAD_HOURS = 48;

/** The T3 Code connection a council runs on: the first one at Manage that works now. */
export async function councilConnection(db: Db | Tx, burrowId: string): Promise<CatalogConnectionRow | null> {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.catalogId, 't3code'),
        eq(catalogConnections.status, 'active'),
        eq(catalogConnections.access, 'manage'),
      ),
    )
    .limit(1);
  return (row as CatalogConnectionRow | undefined) ?? null;
}

export interface T3ProjectFound {
  id: string;
  title: string;
  root: string;
}

/** The person's projects in T3 Code (title and folder). */
export async function t3Projects(
  services: Services,
  connection: CatalogConnectionRow,
): Promise<T3ProjectFound[]> {
  const body = await callT3(services, connection, 't3_project_list', { limit: 100 });
  return list(rec(body).projects)
    .map(rec)
    .flatMap((p) => {
      const id = str(p.id);
      if (!id || p.deletedAt) return [];
      return [{ id, title: str(p.title) ?? '', root: str(p.workspaceRoot) ?? '' }];
    });
}

/** The project a person's words name: its id, its title or its folder (or the folder's last part). */
export function findProject(projects: readonly T3ProjectFound[], words: string): T3ProjectFound | null {
  const w = words.trim().toLowerCase();
  const last = (p: string) =>
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase() ?? '';
  return (
    projects.find((p) => p.id.toLowerCase() === w) ??
    projects.find((p) => p.title.toLowerCase() === w) ??
    projects.find((p) => p.root.toLowerCase() === w || last(p.root) === w) ??
    projects.find((p) => p.title.toLowerCase().includes(w) || last(p.root).includes(w)) ??
    null
  );
}

/** A thread's page in T3 Code's web app, else T3 Code's address. */
export async function threadUrl(services: Services, connection: CatalogConnectionRow, threadId: string) {
  const env = environmentOf(
    await rarelyRead(
      services,
      `t3code-env:${connection.id}`,
      connection,
      () => callT3(services, connection, 't3_environment_read', {}),
      { optional: true },
    ),
  ).id;
  const address = connection.baseUrl.replace(/\/+$/, '');
  return (
    (env ? webUrl(`${address}/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}`) : null) ??
    webUrl(address)
  );
}

const opts = (council: Pick<CouncilRow, 'burrowId' | 'agentId'>): CommitOptions => ({
  burrowId: council.burrowId,
  actorId: council.agentId,
});

/** The agent's short name, as its threads' titles start (“Dusty - …”). */
export async function leadName(db: Db, agentId: string): Promise<string> {
  const agent = await loadPrincipalRow(db, agentId);
  return agent ? shortName(agent) : 'Whombat';
}

/**
 * Where a thread runs: a scratch folder, the project's own checkout, a new worktree (from `baseRef`, `HEAD` unless
 * said; fetched fresh from the remote with `fromOrigin`; T3 Code names the branch when none is given), or one there is.
 */
export type Place =
  | { kind: 'scratch' }
  | { kind: 'root'; projectId: string }
  | { kind: 'worktree'; projectId: string; branch?: string; baseRef?: string; fromOrigin?: boolean }
  | { kind: 'existing'; projectId: string; worktreePath: string };

export function placeArgs(place: Place): Record<string, unknown> {
  switch (place.kind) {
    case 'scratch':
      return { scratch: true };
    case 'root':
      return { projectId: place.projectId };
    case 'worktree':
      return {
        projectId: place.projectId,
        workspaceStrategy: {
          type: 'worktree',
          baseRef: place.baseRef ?? 'HEAD',
          ...(place.branch ? { branch: place.branch } : {}),
          startFromOrigin: !!place.fromOrigin,
        },
      };
    case 'existing':
      return {
        projectId: place.projectId,
        workspaceStrategy: { type: 'existing_worktree', worktreePath: place.worktreePath },
      };
  }
}

/**
 * Starts one thread in T3 Code with its brief on the seat's model, at the first of `places` T3 Code takes; its id and
 * title as T3 Code keeps them.
 */
async function launch(
  services: Services,
  connection: CatalogConnectionRow,
  member: CouncilMemberRow,
  input: { lead: string; title: string; brief: string; places: readonly Place[] },
): Promise<{ threadId: string; title: string; body: unknown }> {
  const title = launchTitle(input.lead, input.title);
  let refused: unknown = null;
  for (const place of input.places) {
    try {
      const body = await callT3(
        services,
        connection,
        't3_thread_launch',
        {
          ...placeArgs(place),
          title,
          message: input.brief,
          // Nobody is there to approve its commands: a narrower mode stalls on the first one.
          runtimeMode: 'full-access',
          modelSelection: { instanceId: member.provider, model: member.model, options: member.options },
        },
        'things.action',
      );
      const threadId = str(rec(body).threadId);
      if (!threadId) throw new T3Failure('no_thread', 'T3 Code answered without a thread.');
      return { threadId, title, body };
    } catch (err) {
      // A place T3 Code can't make (no such base in this checkout): the next one.
      if (!(err instanceof T3Failure) || err.code !== 'invalid_request') throw err;
      refused = err;
    }
  }
  throw refused ?? new T3Failure('no_thread', 'T3 Code has no place for the thread.');
}

/** Records a started thread (its watch too), or that it couldn't start. */
async function launched(
  services: Services,
  council: CouncilRow,
  connection: CatalogConnectionRow,
  member: CouncilMemberRow,
  start: () => Promise<{ threadId: string; title: string }>,
  wake: boolean,
): Promise<boolean> {
  try {
    const { threadId, title } = await start();
    const url = await threadUrl(services, connection, threadId).catch(() => null);
    const res = await services.pipeline.commit(
      councilLaunched,
      { councilId: council.id, memberId: member.id, threadId, title: title.slice(0, 160), url },
      opts(council),
    );
    // Stopped while it started: stop the new thread too.
    if (res.status === 'ok' && res.result.cancelled) {
      await stopThreads(services, council, [{ id: member.id, threadId }], 'The council stopped.');
      return false;
    }
    return true;
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.message : String(err), councilId: council.id },
      'council: a thread could not start',
    );
    await services.pipeline
      .commit(councilLaunchFailed, { councilId: council.id, memberId: member.id, wake }, opts(council))
      .catch(warnFailed(services, council.id, 'council: marking a thread that could not start'));
    return false;
  }
}

/** A branch name's words from a title: “improve-the-settings-page”. */
const slug = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'council';

/**
 * Where the lead works: a council that improves a project builds in a worktree of its own on a new branch (from the
 * remote's default branch, else as the person has it); a review or research looks at the person's own checkout as it
 * is, uncommitted changes included; plain research has a scratch folder.
 */
export function leadPlaces(council: Pick<CouncilRow, 'id' | 'kind' | 'projectId' | 'title'>): Place[] {
  if (!council.projectId) return [{ kind: 'scratch' }];
  if (council.kind !== 'improve') return [{ kind: 'root', projectId: council.projectId }];
  const branch = `council/${slug(council.title)}-${council.id.slice(-5).toLowerCase()}`;
  return [
    { kind: 'worktree', projectId: council.projectId, branch, baseRef: 'origin/HEAD' },
    { kind: 'worktree', projectId: council.projectId, branch },
  ];
}

/**
 * Starts the council's lead thread with its brief on its row's AI (the chat's own, else the builder seat's). False when
 * it couldn't start (the row is marked failed; the tool's answer tells the agent).
 */
export async function launchLead(
  services: Services,
  council: CouncilRow,
  lead: CouncilMemberRow,
  personWords: string | null = null,
): Promise<boolean> {
  const connection = await connectionOf(services, council);
  if (!connection) {
    await services.pipeline
      .commit(councilLaunchFailed, { councilId: council.id, memberId: lead.id, wake: false }, opts(council))
      .catch(warnFailed(services, council.id, 'council: marking a lead without a connection'));
    return false;
  }
  const name = await leadName(services.db, council.agentId);
  const brief = leadBrief({
    lead: name,
    kind: council.kind,
    question: council.question,
    seats: council.seats,
    t3Council: council.setupName === T3_COUNCIL,
    project: !!council.projectId,
    rounds: council.roundsMax,
    target: council.target,
    goAllTheWay: council.goAllTheWay,
    personWords,
  });
  return launched(
    services,
    council,
    connection,
    lead,
    () =>
      launch(services, connection, lead, {
        lead: name,
        title: leadTitle(council.title),
        brief,
        places: leadPlaces(council),
      }),
    false,
  );
}

/**
 * How the reviewers are read. `answerSettleMs`: a finished reviewer's answer is read this long after it ended at the
 * earliest, as T3 Code tells its lead first (a test sets it).
 */
export const councilTiming = { answerSettleMs: 20_000 };
/** The lead's reviewers are listed this many at a time, at most this many pages a pass. */
const CHILD_PAGE = 100;
const CHILD_PAGES = 3;
/** At most this many reviewers go into one `council.sync`; the rest come with the next pass. */
const REVIEWERS_PER_SYNC = 80;

/** The lead thread's reviewers, as T3 Code lists them. */
async function listChildren(
  services: Services,
  connection: CatalogConnectionRow,
  council: CouncilRow,
): Promise<ListedChild[]> {
  const found: ListedChild[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < CHILD_PAGES; page++) {
    const body = await callT3(services, connection, 't3_thread_list', {
      ...(council.projectId ? { projectId: council.projectId } : { allProjects: true }),
      includeSubagents: true,
      limit: CHILD_PAGE,
      ...(cursor !== null ? { cursor } : {}),
    });
    found.push(...childrenOf(body, council.builderThreadId as string));
    const threads = list(rec(body).threads).map(rec);
    const next = rec(body).nextCursor;
    if (typeof next !== 'number' || !threads.length) break;
    // The list is the one last changed first: once a page ends with a thread that last changed before the council
    // began, nothing after it can be one of its reviewers.
    const last = threads.at(-1);
    const changed = str(last?.updatedAt) ?? str(last?.createdAt);
    if (changed && Date.parse(changed) < council.createdAt.getTime()) break;
    cursor = next;
  }
  const seen = new Set<string>();
  return found.filter((c) => !seen.has(c.threadId) && !!seen.add(c.threadId));
}

/**
 * One council's reviewers as T3 Code has them now, kept (`council.sync`): new ones placed, ended ones with their whole
 * answer (read once the lead had time to hear of it; at once with `final`, when the lead itself is done). A reviewer
 * Whombat can't keep (a title or a date it can't read) is left out, never failing the others. Throws when T3 Code
 * can't be read: the next pass reads again.
 */
export async function syncCouncilNow(
  services: Services,
  council: CouncilRow,
  { final = false }: { final?: boolean } = {},
): Promise<void> {
  if (!council.builderThreadId) return;
  const connection = await connectionOf(services, council);
  if (!connection) return;
  const now = services.clock().getTime();
  const [children, rows] = await Promise.all([
    listChildren(services, connection, council),
    services.db.transaction((tx) => loadMembers(tx, council.id)),
  ]);
  const known = [...rows];
  // A seat a reviewer takes over (T3 Code's own council) is its own for the next ones in this pass too.
  const seats = [...council.seats];
  const placing = { ...council, seats };
  const reviewers: CouncilReviewer[] = [];
  for (const child of children) {
    if (reviewers.length >= REVIEWERS_PER_SYNC) break;
    const row = rows.find((m) => m.threadId === child.threadId);
    if (row && row.state !== 'working') continue;
    let state = childState(child.status);
    let answer: string | null = null;
    if (state === 'done') {
      const ended = child.updatedAt ? Date.parse(child.updatedAt) : 0;
      if (!final && now - ended < councilTiming.answerSettleMs) state = 'working';
      else
        try {
          answer = await readLastAnswer(
            services,
            connection,
            child.threadId,
            child.items,
            COUNCIL_ANSWER_MAX,
          );
        } catch (err) {
          // At the lead's end every answer counts: the whole read is tried again. Else this one waits for the next
          // pass, and the others are kept.
          if (final) throw err;
          warnFailed(services, council.id, 'council: reading a reviewer’s answer')(err);
          continue;
        }
    }
    if (row && state === 'working') continue;
    const placed = row ?? placeChild(placing, known, child);
    const reviewer = Reviewer.safeParse({
      threadId: child.threadId,
      stage: placed.stage as CouncilReviewer['stage'],
      round: placed.round,
      position: placed.position,
      provider: placed.provider,
      providerName: placed.providerName,
      model: placed.model,
      label: placed.label,
      options: placed.options,
      url: row?.url ?? (await threadUrl(services, connection, child.threadId).catch(() => null)),
      startedAt: child.createdAt,
      state,
      answer,
    } satisfies CouncilReviewer);
    if (!reviewer.success) {
      services.log.warn(
        { councilId: council.id, threadId: child.threadId },
        'council: a reviewer could not be kept',
      );
      continue;
    }
    if (!row) {
      known.push({ ...placed, role: 'member' } as (typeof known)[number]);
      const seat = seats[placed.position];
      if (seat && seat.model !== placed.model)
        seats[placed.position] = {
          ...seat,
          model: placed.model,
          label: placed.label,
          options: placed.options,
        };
    }
    reviewers.push(reviewer.data as CouncilReviewer);
  }
  // Even with nothing new: a reviewer may have run out of time.
  const late = rows.some((m) => m.role === 'member' && m.state === 'working' && m.deadline.getTime() < now);
  if (reviewers.length || late)
    await services.pipeline.commit(syncCouncil, { councilId: council.id, reviewers }, opts(council));
}

/**
 * Tells a council's lead what it still has to hear about its reviewers (`stopPending` on their rows): which ran out
 * of time, and that it started a round past what the council allows. Marked as told only once T3 Code took the
 * message; a failure is tried again later. A lead that is done is told nothing more: it would start again for nobody.
 */
async function tellPending(services: Services, council: CouncilRow): Promise<void> {
  const rows = await services.db.transaction((tx) => loadMembers(tx, council.id));
  const pending = rows.filter((m) => m.role === 'member' && m.stopPending);
  if (!pending.length) return;
  const ids = pending.map((m) => m.id);
  const lead = rows.find((m) => m.role === 'builder' && m.threadId === council.builderThreadId);
  const connection = lead?.state === 'working' ? await connectionOf(services, council) : null;
  if (!connection) return stopsDone(services, ids);
  const due = pending.filter((m) => !m.stopNextAt || m.stopNextAt.getTime() <= services.clock().getTime());
  if (!due.length) return;
  const late = due.filter((m) => m.state === 'no_answer');
  const past = due.filter((m) => m.state !== 'no_answer');
  const message = [
    ...(late.length ? [lateBrief(late.map((m) => m.label))] : []),
    ...(past.length ? [LIMIT_BRIEF] : []),
  ].join('\n');
  if (await sayToLead(services, council, connection, message, 'auto')) return stopsDone(services, ids);
  for (const m of due) await stopLater(services, m.id, m.stopTries);
}

/** Sends the lead thread a message; a failure is logged, never thrown (the next pass or the agent tries again). */
async function sayToLead(
  services: Services,
  council: CouncilRow,
  connection: CatalogConnectionRow,
  message: string,
  mode: 'auto' | 'restart',
): Promise<boolean> {
  try {
    await callT3(
      services,
      connection,
      't3_thread_send',
      { threadId: council.builderThreadId as string, message, mode },
      'things.action',
    );
    return true;
  } catch (err) {
    warnFailed(services, council.id, 'council: telling the lead')(err);
    return false;
  }
}

/**
 * The agent sends the lead on (`council_tell`): its words reach the lead thread (steering it when it works, starting it
 * when it rests), and the council's rows say it works again. `goAhead`: the person's go-ahead on the plan it waits
 * with; without it a waiting council changes its plan and waits again. Whether it went, and whether it builds now.
 * A council that ended while the message was on its way (a Stop) has its lead told to stop again.
 */
export async function tellLead(
  services: Services,
  council: CouncilRow,
  input: { message: string; goAhead: boolean; personWords?: string | null },
): Promise<{ ok: true; goAhead: boolean } | { ok: false; message: string }> {
  const connection = await connectionOf(services, council);
  if (!connection || !council.builderThreadId)
    return { ok: false, message: 'Its T3 Code thread can’t be reached now.' };
  const name = await leadName(services.db, council.agentId);
  const waiting = council.stage === 'approve';
  const how = waiting ? (input.goAhead ? 'go' : 'revise') : 'tell';
  const sent = await sayToLead(
    services,
    council,
    connection,
    tellBrief(name, input.message, how, input.personWords ?? null),
    'auto',
  );
  if (!sent) return { ok: false, message: 'T3 Code didn’t take the message. Try again in a moment.' };
  const res = await services.pipeline
    .commit(
      councilTold,
      { councilId: council.id, text: input.message, goAhead: input.goAhead },
      opts(council),
    )
    .catch(() => null);
  if (res?.status === 'ok') return { ok: true, goAhead: res.result.goAhead };
  // The council ended meanwhile: the message must not leave its lead at work behind a stopped card.
  await sayToLead(services, council, connection, `The council ended. ${STOP_BRIEF}`, 'restart');
  return { ok: false, message: 'The council ended meanwhile, so its lead was told to stop.' };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

async function connectionOf(services: Services, council: CouncilRow): Promise<CatalogConnectionRow | null> {
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(and(eq(catalogConnections.id, council.connectionId), eq(catalogConnections.status, 'active')));
  return (row as CatalogConnectionRow | undefined) ?? null;
}

/**
 * Stops threads that still work (the council ended, or the lead ran out of time). The lead thread is told to stop and
 * to cancel its reviewers, which are its own tasks in T3 Code (only when it can't be told is it interrupted); a thread
 * of a council from before the lead thread is interrupted. A refusal leaves them be, to be tried again.
 */
export async function stopThreads(
  services: Services,
  council: Pick<CouncilRow, 'id' | 'connectionId' | 'burrowId'> &
    Partial<Pick<CouncilRow, 'builderThreadId'>>,
  members: readonly { id: string; threadId: string | null; stopTries?: number }[],
  reason: string,
): Promise<void> {
  const threads = members.filter(
    (m): m is { id: string; threadId: string; stopTries?: number } => !!m.threadId,
  );
  if (!threads.length) return;
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, council.connectionId));
  // No connection any more: nothing can stop them, and nothing to try again.
  if (!connection) {
    await stopsDone(
      services,
      threads.map((m) => m.id),
    );
    return;
  }
  const row = connection as CatalogConnectionRow;
  const lead = council.builderThreadId ?? null;
  if (lead) {
    // Its reviewers are the lead's own tasks, which only it can cancel: the lead is told, whether it works itself or
    // only they do. All of them are stopped once it took the message; else every one is tried again later.
    try {
      await callT3(
        services,
        row,
        't3_thread_send',
        { threadId: lead, message: `${reason} ${STOP_BRIEF}`, mode: 'restart' },
        'things.action',
      ).catch(async (err: unknown) => {
        if (await threadOver(services, row, lead, err)) return;
        await callT3(services, row, 't3_thread_interrupt', { threadId: lead, reason }, 'things.action');
      });
      await stopsDone(
        services,
        threads.map((m) => m.id),
      );
    } catch (err) {
      services.log.warn(
        {
          err: err instanceof T3Failure ? err.code : err instanceof Error ? err.message : String(err),
          councilId: council.id,
        },
        'council: its lead could not be told to stop yet',
      );
      for (const m of threads) await stopLater(services, m.id, m.stopTries ?? 0);
    }
    return;
  }
  await Promise.all(
    threads.map(async (m) => {
      try {
        await callT3(services, row, 't3_thread_interrupt', { threadId: m.threadId, reason }, 'things.action');
        await stopsDone(services, [m.id]);
      } catch (err) {
        // Only an answer that it stopped, ended or is gone ends the stop; anything else is tried again later.
        if (await threadOver(services, row, m.threadId, err)) {
          await stopsDone(services, [m.id]);
          return;
        }
        services.log.warn(
          {
            err: err instanceof T3Failure ? err.code : err instanceof Error ? err.message : String(err),
            councilId: council.id,
          },
          'council: a thread could not be stopped yet',
        );
        await stopLater(services, m.id, m.stopTries ?? 0);
      }
    }),
  );
}

/**
 * Settles the lead thread in T3 Code once its council ended with its work complete, so the person's list there stays
 * short: once it has been quiet, as every thread Whombat settles, so a command it left running isn't stopped
 * (`t3code/settle.ts`).
 */
export async function settleLead(services: Services, council: CouncilRow): Promise<void> {
  if (!council.builderThreadId) return;
  const connection = await connectionOf(services, council);
  if (!connection) return;
  // A pull request T3 Code still watches for it runs the thread again when its checks move, which a settled thread
  // refuses: it stays in the list until that is over.
  const watched = await callT3(services, connection, 'list_thread_pull_requests', {
    threadId: council.builderThreadId,
  }).then(watchedPullRequestsOf, () => []);
  if (watched.length) return;
  await settleLater(services.db, connection.id, council.builderThreadId, services.clock()).catch(
    warnFailed(services, council.id, 'council: settling the lead thread'),
  );
}

/** Whether a thread whose stop T3 Code refused has stopped all the same: gone, or not at work any more. */
export async function threadOver(
  services: Services,
  connection: CatalogConnectionRow,
  threadId: string,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof T3Failure)) return false;
  if (err.code === 'thread_not_found') return true;
  try {
    const state = threadStateOf(await callT3(services, connection, 't3_thread_read', stateArgs(threadId, 0)));
    return !!state && (state.status === 'idle' || FINISHED.includes(state.status));
  } catch (read) {
    return read instanceof T3Failure && read.code === 'thread_not_found';
  }
}

/** T3 Code answered the stop: bookkeeping, nobody's change. */
async function stopsDone(services: Services, memberIds: readonly string[]): Promise<void> {
  if (!memberIds.length) return;
  await services.db
    .update(councilMembers)
    .set({ stopPending: false, stopTries: 0, stopNextAt: null })
    .where(inArray(councilMembers.id, [...memberIds]));
}

/** The first retry waits a pass; each one after twice as long, up to a quarter of an hour. */
const STOP_RETRY_MS = 15_000;
const STOP_RETRY_MAX_MS = 15 * 60_000;

async function stopLater(services: Services, memberId: string, tries: number): Promise<void> {
  const wait = Math.min(STOP_RETRY_MS * 2 ** Math.min(tries, 10), STOP_RETRY_MAX_MS);
  await services.db
    .update(councilMembers)
    .set({ stopPending: true, stopTries: tries + 1, stopNextAt: new Date(services.clock().getTime() + wait) })
    .where(eq(councilMembers.id, memberId));
}

/** The person's Stop: the council ends, then its threads that still work stop. */
export async function stopByPerson(
  services: Services,
  burrowId: string,
  personId: string,
  councilId: string,
): Promise<CouncilRow> {
  const res = await services.pipeline.commit(stopCouncil, { councilId }, { burrowId, actorId: personId });
  if (res.status !== 'ok') throw new Error('council stop refused');
  const { working, council } = res.result;
  await stopThreads(services, council, working, 'The person stopped the council.');
  return (await services.db.transaction((tx) => loadCouncil(tx, burrowId, councilId))) ?? council;
}

/** At most this many councils have their reviewers read in one pass. */
const COUNCILS_PER_PASS = 20;
/** A council whose lead thread never started is ended after this long (a crash between its commits). */
const UNSTARTED_MS = 10 * 60_000;

/**
 * The councils' part of the T3 Code watcher's pass: stops tried again, a quiet council ended, a council without a lead
 * thread ended (one from before the lead thread, or one whose lead never started), each council's reviewers read
 * (`syncCouncilNow`), and a lead that ran out of time stopped and counted as not answering.
 */
export async function sweepCouncils(services: Services): Promise<void> {
  const now = services.clock();
  await retryStops(services);
  const quiet = await services.db
    .select({ id: councils.id, burrowId: councils.burrowId, agentId: councils.agentId })
    .from(councils)
    .where(
      and(
        eq(councils.state, 'active'),
        lt(councils.updatedAt, new Date(now.getTime() - COUNCIL_QUIET_DAYS * 86_400_000)),
      ),
    )
    .limit(10);
  for (const c of quiet)
    await services.pipeline
      .commit(expireCouncil, { councilId: c.id }, opts(c))
      .catch(warnFailed(services, c.id, 'council sweep: expiring a quiet council'));
  const leadless = await services.db
    .select()
    .from(councils)
    .where(
      and(
        eq(councils.state, 'active'),
        isNull(councils.builderThreadId),
        lt(councils.createdAt, new Date(now.getTime() - UNSTARTED_MS)),
      ),
    )
    .limit(10);
  for (const c of leadless) {
    const res = await services.pipeline
      .commit(expireCouncil, { councilId: c.id, why: 'legacy' }, opts(c))
      .catch(warnFailed(services, c.id, 'council sweep: ending a council without a lead thread'));
    if (res?.status === 'ok' && res.result)
      await stopThreads(services, c, res.result.working, 'The council stopped.');
  }
  // Only a council whose lead is at work can have reviewers at work: one that waits for the go-ahead is left alone.
  const active = await services.db
    .select({ council: councils })
    .from(councils)
    .innerJoin(
      councilMembers,
      and(
        eq(councilMembers.councilId, councils.id),
        eq(councilMembers.role, 'builder'),
        eq(councilMembers.state, 'working'),
      ),
    )
    .where(and(eq(councils.state, 'active'), isNotNull(councils.builderThreadId)))
    .orderBy(councils.createdAt)
    .limit(COUNCILS_PER_PASS);
  await Promise.all(
    active.map(async ({ council: c }) => {
      await syncCouncilNow(services, c).catch(
        warnFailed(services, c.id, 'council sweep: reading its reviewers'),
      );
      await tellPending(services, c).catch(warnFailed(services, c.id, 'council sweep: telling its lead'));
    }),
  );
  const late = await services.db
    .select({ member: councilMembers, council: councils })
    .from(councilMembers)
    .innerJoin(councils, eq(councils.id, councilMembers.councilId))
    .where(
      and(
        eq(councilMembers.state, 'working'),
        eq(councilMembers.role, 'builder'),
        eq(councils.state, 'active'),
        lt(councilMembers.deadline, now),
      ),
    )
    .limit(20);
  for (const { member, council } of late) {
    if (!member.threadId) continue;
    // Counted first (its thread is then to be stopped), so a stop T3 Code doesn't answer is tried again below.
    await services.pipeline
      .commit(
        memberEnded,
        { councilId: council.id, threadId: member.threadId, state: 'no_answer', answer: null },
        opts(council),
      )
      .catch(warnFailed(services, council.id, 'council sweep: ending a late lead'));
    await stopThreads(services, council, [member], 'It ran out of time for the council.');
  }
}

/**
 * Threads still to be stopped (T3 Code couldn't be reached when the council stopped them, or a thread started after its
 * council ended): tried again on every pass, whatever became of their council.
 */
export async function retryStops(services: Services): Promise<void> {
  const now = services.clock();
  // Those due, the ones never tried again first: a thread that keeps failing waits longer, so it never holds up others.
  const pending = await services.db
    .select({ member: councilMembers, council: councils })
    .from(councilMembers)
    .innerJoin(councils, eq(councils.id, councilMembers.councilId))
    .where(
      and(
        eq(councilMembers.stopPending, true),
        isNotNull(councilMembers.threadId),
        // A reviewer's mark while its council works means its lead has something to hear (`tellPending`), not a stop.
        or(
          eq(councilMembers.role, 'builder'),
          ne(councils.state, 'active'),
          isNull(councils.builderThreadId),
        ),
        or(isNull(councilMembers.stopNextAt), lte(councilMembers.stopNextAt, now)),
      ),
    )
    .orderBy(sql`${councilMembers.stopNextAt} asc nulls first`)
    .limit(20);
  await Promise.all(
    pending.map(({ member, council }) => stopThreads(services, council, [member], 'The council stopped.')),
  );
}

/** A new council's id, rounds and target as the agent asked (`council_start`). */
export function councilDefaults(input: {
  kind: string;
  target?: number | undefined;
  rounds?: number | undefined;
}) {
  return {
    id: newId('council'),
    roundsMax: input.rounds ?? COUNCIL_ROUNDS_DEFAULT,
    target: input.kind === 'improve' ? (input.target ?? 9) : (input.target ?? null),
  };
}

/** A council's step failed: say so in the log and go on; the next pass or event tries it again. */
function warnFailed(services: Services, councilId: string, what: string): (err: unknown) => void {
  return (err) => services.log.warn({ err: String(err), councilId }, `${what} failed`);
}
