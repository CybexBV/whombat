/** Read models for branch rooms, runs, approvals, plans, agents, canvases, inbox and onboarding. */
import {
  type AgentProfile,
  type Approval,
  burrowAddress,
  type CanvasDetail,
  type CanvasSummary,
  canDecide,
  conversationLabel,
  DEFAULT_AGENT_FACE,
  DEFAULT_AGENT_NAME,
  groupCommentThreads,
  INBOX_SECTIONS,
  type InboxFilter,
  type InboxResponse,
  keysSummary,
  mergeBlock,
  type OnboardingState,
  type PullRequestDetail,
  prStatus,
  RUN_LOG_VISIBLE_LINES,
  type RunDetail,
} from '@whombat/core';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import {
  approvals,
  canvasComments,
  canvases,
  conversations,
  events,
  notifications,
  onboardingStepOf,
  repos,
  runs,
} from '../db/schema/index';
import { notFound } from '../lib/errors';
import { iso, isoOrNull } from '../lib/time';
import { conversationSummaries, inBurrow, loadConversationRow } from './conversations';
import {
  actorKind,
  engineActor,
  faceOf,
  loadAgentRow,
  loadGrants,
  modelFallbackOf,
  type PrincipalRow,
  toAgent,
} from './principals';
import {
  type ApprovalRow,
  approvalForViewer,
  approvalsForViewer,
  loadPlan,
  loadPullRequest,
  loadRuns,
  type PullRequestRow,
  type RunRow,
  runLogLines,
  toApproval,
} from './work';

const deciderOf = (p: PrincipalRow) => engineActor(p);

/* Pull requests ---------------------------------------------------------------------------------- */

export async function prDetail(
  db: Db,
  viewer: PrincipalRow,
  row: PullRequestRow,
): Promise<PullRequestDetail> {
  const pr = await loadPullRequest(db, row);
  const [staging] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, row.burrowId),
        sql`${approvals.action}->>'type' = 'deploy'`,
        sql`((${approvals.action}->'params'->>'prNumber')::int = ${row.number} or ${approvals.action}->'params'->>'ref' = ${row.branch})`,
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  // PR metadata is burrow-wide, approvals are not: the staging approval only for those who may see it.
  const approval = staging ? toApproval(staging) : null;
  return {
    pr,
    status: prStatus(pr),
    mergeBlock: mergeBlock(pr, actorKind(viewer.kind)),
    staging:
      staging && approval && (await approvalVisible(db, viewer, approval))
        ? await approvalForViewer(db, viewer.id, staging)
        : null,
  };
}

/* Runs ------------------------------------------------------------------------------------------- */

/** A run of the viewer's burrow (404 otherwise): every run's room is the person's. */
export function readableRun(viewer: PrincipalRow, row: RunRow | undefined): RunRow {
  if (!row || row.burrowId !== viewer.burrowId) throw notFound('Run');
  return row;
}

export async function runDetail(db: Db, viewer: PrincipalRow, row: RunRow): Promise<RunDetail> {
  const [run] = await loadRuns(db, [row]);
  const conv = await loadConversationRow(db, row.conversationId);
  if (!run || !conv) throw notFound('Run');
  const [summary] = await conversationSummaries(db, viewer.id, [conv]);
  return {
    run,
    log: await runLogLines(db, row.id, { last: RUN_LOG_VISIBLE_LINES }),
    grants: await loadGrants(db, row.agentId),
    conversation: summary as RunDetail['conversation'],
  };
}

/* Approvals -------------------------------------------------------------------------------------- */

/**
 * The requester, the person who may decide it (one-person.md OP-S62) and whoever reads its conversation — the person
 * and the agent, in every conversation of the burrow — may see an approval.
 */
export async function approvalVisible(db: Db, viewer: PrincipalRow, approval: Approval): Promise<boolean> {
  if (approval.requesterId === viewer.id) return true;
  if (canDecide(approval, deciderOf(viewer)) === null) return true;
  return inBurrow(db, viewer.burrowId, approval.conversationId);
}

export async function approvalList(
  db: Db,
  viewer: PrincipalRow,
  burrowId: string,
  options: { state?: Approval['state']; before?: string; limit: number },
) {
  const where = [eq(approvals.burrowId, burrowId)];
  if (options.state) where.push(eq(approvals.state, options.state));
  if (options.before && /^\d+$/.test(options.before))
    where.push(lt(approvals.number, Number(options.before)));
  const rows = await db
    .select()
    .from(approvals)
    .where(and(...where))
    .orderBy(desc(approvals.number))
    .limit(options.limit + 1);
  const visible: ApprovalRow[] = [];
  for (const r of rows.slice(0, options.limit)) {
    const a = toApproval(r);
    if (await approvalVisible(db, viewer, a)) visible.push(r);
  }
  const last = rows[options.limit - 1];
  return {
    approvals: await approvalsForViewer(db, viewer.id, visible),
    before: rows.length > options.limit && last ? String(last.number) : null,
  };
}

/* Agents ----------------------------------------------------------------------------------------- */

async function currentRuns(db: Db, agentIds: readonly string[]) {
  if (agentIds.length === 0) return new Map<string, RunRow>();
  const rows = await db
    .select()
    .from(runs)
    .where(and(inArray(runs.agentId, [...agentIds]), inArray(runs.status, ['live', 'paused'])))
    .orderBy(desc(runs.startedAt));
  const out = new Map<string, RunRow>();
  for (const r of rows) if (!out.has(r.agentId)) out.set(r.agentId, r);
  return out;
}

export async function agentProfile(db: Db, _viewer: PrincipalRow, row: PrincipalRow): Promise<AgentProfile> {
  const [grants, running] = await Promise.all([loadGrants(db, row.id), currentRuns(db, [row.id])]);
  const recentRows = await db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, row.burrowId), eq(events.actorId, row.id), isNotNull(events.text)))
    .orderBy(desc(events.seq))
    .limit(3);
  const run = running.get(row.id);
  return {
    agent: toAgent(row),
    grants,
    keys: keysSummary(grants),
    recent: recentRows.map((e) => ({
      eventId: e.id,
      text: e.text ?? '',
      at: iso(e.createdAt),
      link: e.ref ?? null,
    })),
    currentRun: run ? { number: run.number, status: run.status, title: run.title } : null,
    // Its last turn ran on the tool's default because its model wasn't available (model-effort.md ME-05).
    modelFallback: modelFallbackOf(row),
  };
}

/* Canvases --------------------------------------------------------------------------------------- */

type CanvasRow = typeof canvases.$inferSelect;

export function toCanvas(row: CanvasRow) {
  return {
    id: row.id,
    burrowId: row.burrowId,
    slug: row.slug,
    title: row.title,
    conversationId: row.conversationId,
    planId: row.planId,
    provenance: row.provenance,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** The burrow's canvases, newest first: every one is the person's, as its conversation is. */
export async function canvasList(db: Db, burrowId: string): Promise<CanvasSummary[]> {
  const rows = await db
    .select({ c: canvases, title: conversations.title, kind: conversations.kind })
    .from(canvases)
    .leftJoin(conversations, eq(conversations.id, canvases.conversationId))
    .where(eq(canvases.burrowId, burrowId))
    .orderBy(desc(canvases.updatedAt));
  const out: CanvasSummary[] = [];
  for (const r of rows) {
    out.push({
      ...toCanvas(r.c),
      conversationTitle: r.title && r.kind ? conversationLabel({ kind: r.kind, title: r.title }) : null,
    });
  }
  return out;
}

/** A canvas of the burrow by its slug (404 otherwise). */
export async function readableCanvas(db: Db, burrowId: string, slug: string): Promise<CanvasRow> {
  const [row] = await db
    .select()
    .from(canvases)
    .where(and(eq(canvases.burrowId, burrowId), eq(canvases.slug, slug)));
  if (!row) throw notFound('Canvas');
  return row;
}

export async function canvasDetail(db: Db, row: CanvasRow): Promise<CanvasDetail> {
  const conv = row.conversationId ? await loadConversationRow(db, row.conversationId) : undefined;
  const comments = await db
    .select()
    .from(canvasComments)
    .where(eq(canvasComments.canvasId, row.id))
    .orderBy(asc(canvasComments.createdAt));
  return {
    canvas: toCanvas(row),
    conversationTitle: conv ? conversationLabel(conv) : null,
    plan: row.planId ? ((await loadPlan(db, row.planId)) ?? null) : null,
    comments: groupCommentThreads(
      comments.map((c) => ({
        id: c.id,
        canvasId: c.canvasId,
        anchor: c.anchor,
        parentId: c.parentId,
        authorId: c.authorId,
        text: c.text,
        createdAt: iso(c.createdAt),
        resolved: c.resolved,
      })),
    ),
    presentIds: [],
    documentName: `canvas:${row.id}`,
  };
}

/* Inbox ------------------------------------------------------------------------------------------ */

const FILTER_KINDS: Record<InboxFilter, readonly string[]> = {
  all: ['needs_you', 'mention', 'agent_update'],
  needs_you: ['needs_you'],
  mentions: ['mention'],
  agents: ['agent_update'],
};

/**
 * Item order within an inbox section. NEEDS YOU and FROM AGENTS surface the freshest thing first (they're
 * status: a newer deploy ask or push supersedes an older one). MENTIONS is a queue of things someone is
 * waiting on you to read — oldest unaddressed mention first, so an early-morning ask doesn't get buried
 * under an afternoon one — matching the mock's `mentions` (Priya at 10:40, then Dusty at 14:04; see
 * docs/decisions/polish-ci.md). `items` arrives sorted newest-first from the query, so mentions only need
 * a reverse.
 */
function sectionOrder<T extends { kind: string }>(kind: string, items: T[]): T[] {
  return kind === 'mention' ? [...items].reverse() : items;
}

export async function inbox(db: Db, principalId: string, filter: InboxFilter): Promise<InboxResponse> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.principalId, principalId))
    .orderBy(desc(notifications.createdAt))
    .limit(200);
  const approvalIds = rows.map((r) => r.approvalId).filter((x): x is string => !!x);
  const approvalRows = approvalIds.length
    ? await db.select().from(approvals).where(inArray(approvals.id, approvalIds))
    : [];
  // The inbox's owner may be an approver outside the approval's conversation (SEC-PACK-ARGS).
  const byApproval = new Map((await approvalsForViewer(db, principalId, approvalRows)).map((a) => [a.id, a]));
  const items = rows.map((r) => ({
    id: r.id,
    burrowId: r.burrowId,
    principalId: r.principalId,
    kind: r.kind,
    actorId: r.actorId,
    where: r.where,
    text: r.text,
    link: r.link,
    approvalId: r.approvalId,
    createdAt: iso(r.createdAt),
    readAt: isoOrNull(r.readAt),
    approval: r.approvalId ? (byApproval.get(r.approvalId) ?? null) : null,
  }));
  const shown = new Set(FILTER_KINDS[filter]);
  return {
    sections: INBOX_SECTIONS.filter((s) => shown.has(s.kind)).map((s) => ({
      kind: s.kind,
      title: s.title,
      items: sectionOrder(
        s.kind,
        items.filter((i) => i.kind === s.kind),
      ),
    })),
    counts: {
      all: items.length,
      needs_you: items.filter((i) => i.kind === 'needs_you').length,
      mentions: items.filter((i) => i.kind === 'mention').length,
      agents: items.filter((i) => i.kind === 'agent_update').length,
    },
    unread: items.filter((i) => !i.readAt).length,
  };
}

/* Onboarding and repos --------------------------------------------------------------------- */

export function toRepo(r: typeof repos.$inferSelect) {
  return {
    id: r.id,
    burrowId: r.burrowId,
    fullName: r.fullName,
    description: r.description,
    language: r.language,
    defaultBranch: r.defaultBranch,
    enabled: r.enabled,
    pushedAt: isoOrNull(r.pushedAt),
    // Where it lives (repositories.md RP-01): a local repo says where Whombat keeps it and since when.
    source: r.source,
    path: r.source === 'local' && r.originPath ? r.originPath : null,
    ...(r.createdAt ? { createdAt: iso(r.createdAt) } : {}),
  };
}

export async function repoRows(db: Db, burrowId: string) {
  return db
    .select()
    .from(repos)
    .where(eq(repos.burrowId, burrowId))
    .orderBy(asc(repos.position), asc(repos.fullName));
}

export async function onboardingState(db: Db, burrow: BurrowRow, origin: string): Promise<OnboardingState> {
  const agent = await loadAgentRow(db, burrow.id);
  const o = burrow.onboarding;
  return {
    step: onboardingStepOf(o),
    burrowName: burrow.name,
    slug: burrow.slug,
    host: burrowAddress(burrow.slug, origin),
    // “Meet your agent” (one-agent.md OA-13): the agent made with the burrow, as named so far.
    agentName: agent?.name ?? DEFAULT_AGENT_NAME,
    agentFace: agent ? faceOf(agent) : DEFAULT_AGENT_FACE,
    provider: o.provider ?? null,
    clients: o.clients ?? [],
    completedAt: o.completedAt,
  };
}

export async function unreadNotifications(db: Db, principalId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.principalId, principalId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}
