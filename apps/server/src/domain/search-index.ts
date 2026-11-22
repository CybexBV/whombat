/**
 * Keeps `search_documents` in sync (post-commit hooks). One document per message, run, pull request and
 * canvas; `conversation_id` gates who may see a hit (re-checked by the search route).
 */
import {
  approvalPhase,
  approvalView,
  conversationLabel,
  formatDate,
  type LinkRef,
  type MessageProvenance,
  PLAN_STEP_LABELS,
  plainMessageText,
  planProgress,
  type SearchResultType,
  type StoredCard,
  type Tone,
} from '@whombat/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { outsidersRun } from '../automations/runs';
import { markdownPlainText } from '../collab/document';
import type { Db } from '../db/client';
import {
  approvals,
  automationRunSteps,
  automationRuns,
  automations,
  canvases,
  events,
  messages,
  plans,
  prCommits,
  principals,
  pullRequests,
  runs,
  searchDocuments,
} from '../db/schema/index';
import { loadConversationRow } from '../read/conversations';
import { shortName } from '../read/principals';
import { toApproval } from '../read/work';
import { linkOfConversation, linkOfMessage, prLink, repoFullName } from './links';

export interface SearchDoc {
  id: string;
  burrowId: string;
  type: SearchResultType;
  conversationId: string | null;
  where: string;
  authorId: string;
  text: string;
  link: LinkRef;
  createdAt: Date;
  /** The pill of a PLAN, DECISION or AUTOMATION result (WS-21). */
  status?: { text: string; tone: Tone } | null;
}

export async function upsertSearchDoc(db: Db, doc: SearchDoc): Promise<void> {
  const status = doc.status ?? null;
  await db
    .insert(searchDocuments)
    .values({ ...doc, status, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: searchDocuments.id,
      set: {
        type: doc.type,
        conversationId: doc.conversationId,
        where: doc.where,
        authorId: doc.authorId,
        text: doc.text,
        link: doc.link,
        status,
        updatedAt: sql`now()`,
      },
    });
}

/** Searchable text of a card (research rows, review comments, receipts, digest items). */
function cardText(card: StoredCard | null): string {
  if (!card) return '';
  switch (card.kind) {
    case 'research':
      return [card.topic, ...card.rows.map((r) => `${r.name} ${r.note}`)].join(' ');
    case 'review':
      return [card.file, ...card.comments.map((c) => c.text)].join(' ');
    case 'commits':
      return card.commits.map((c) => c.message).join(' ');
    case 'pill':
      return card.text;
    // A followed server task (task-feedback.md TF-10): what it did and how it went.
    case 'task':
      return [card.title, card.server, card.result ?? ''].join(' ');
    case 'answer':
      return card.receipts.map((r) => `${r.source} ${r.detail}`).join(' ');
    // A council: what it is about and the agent's words under the card (council.md CNL-42).
    case 'council':
      return [card.title, card.note ?? ''].join(' ');
    // A delegation: what it is for, its tasks and the agent's words under the card (delegate.md).
    case 'delegation':
      return [card.title, ...card.tasks.map((t) => t.title), card.note ?? ''].join(' ');
    case 'digest':
      return [
        card.title,
        ...card.sections.flatMap((sec) =>
          sec.items.map((i) => [i.title, i.source, i.note].filter(Boolean).join(' ')),
        ),
      ].join(' ');
    default:
      return '';
  }
}

/**
 * Messages never indexed: what an agent wrote while assessing a website visitor's report (Whombat Feedback), and
 * whatever a run started by outsiders' input posted (an incoming email's, a tracker customer's: `outsiders_run`). It
 * is text outsiders can steer, which every prompt shows only inside an untrusted wrapper, and a search snippet (search
 * page, search answers, the `search` tool) carries none (docs/decisions/feedback.md FB-F3-03,
 * docs/decisions/outsiders-turns.md). The handoff message (`feedback_handoff`) is Whombat's own fixed text and stays
 * searchable.
 */
export const UNSEARCHABLE_PROVENANCE = [
  'feedback_assessment',
] as const satisfies readonly MessageProvenance[];

const unsearchable = (row: { provenance: MessageProvenance | null; outsidersRun: boolean }) =>
  row.outsidersRun ||
  (UNSEARCHABLE_PROVENANCE as readonly (MessageProvenance | null)[]).includes(row.provenance);

/**
 * Cards that are their own search documents (WS-23): a plan card is found as its PLAN, an approval card as its
 * DECISION, with the card message's text folded in; replies under them stay messages.
 */
export const FOLDED_CARD_KINDS = ['plan', 'approval'] as const;

const folded = (card: StoredCard | null) =>
  !!card && (FOLDED_CARD_KINDS as readonly string[]).includes(card.kind);

/** Messages index as MESSAGE, thread roots with replies as THREAD. */
export async function indexMessage(db: Db, messageId: string): Promise<void> {
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!row) return;
  if (unsearchable(row) || folded(row.card)) {
    // Also drops a document indexed before this rule existed.
    await db.delete(searchDocuments).where(eq(searchDocuments.id, row.id));
    return;
  }
  const conversation = await loadConversationRow(db, row.conversationId);
  if (!conversation) return;
  const isThread = row.threadRootId === null && row.replyCount > 0;
  // Plain words, not Markdown: snippets read “Worth a look”, not “**Worth a look**” (RM-03).
  const text = [plainMessageText(row.text), cardText(row.card)].filter(Boolean).join(' ').trim();
  if (!text) return;
  await upsertSearchDoc(db, {
    id: row.id,
    burrowId: row.burrowId,
    type: isThread ? 'THREAD' : 'MESSAGE',
    conversationId: row.conversationId,
    where: conversationLabel(conversation),
    authorId: row.authorId,
    text,
    link: await linkOfMessage(db, conversation, row.id, isThread ? row.id : row.threadRootId),
    createdAt: row.createdAt,
  });
}

export async function indexRun(db: Db, runId: string): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  await upsertSearchDoc(db, {
    id: run.id,
    burrowId: run.burrowId,
    type: 'RUN',
    conversationId: run.conversationId,
    where: `Run #${run.number} · ${run.title}`,
    authorId: run.agentId,
    text: [run.title, run.summary ?? run.activity, run.branch].filter(Boolean).join('. '),
    link: { type: 'run', number: run.number },
    createdAt: run.startedAt,
  });
}

export async function indexPullRequest(db: Db, prId: string, timeZone: string): Promise<void> {
  const [pr] = await db.select().from(pullRequests).where(eq(pullRequests.id, prId));
  if (!pr) return;
  const commits = await db.select().from(prCommits).where(eq(prCommits.prId, prId));
  const state =
    pr.state === 'merged' && pr.mergedAt
      ? `merged ${formatDate(pr.mergedAt, timeZone, { year: 'never' })}`
      : pr.title;
  await upsertSearchDoc(db, {
    id: pr.id,
    burrowId: pr.burrowId,
    type: 'PATCH',
    conversationId: pr.conversationId,
    where: `PR #${pr.number} · ${state}`,
    authorId: pr.authorId ?? pr.mergedById ?? '',
    text: [pr.title, pr.branch, ...commits.map((c) => c.message)].join('. '),
    link: prLink(pr.number, await repoFullName(db, pr.repoId)),
    createdAt: pr.openedAt,
  });
}

/** Indexes a canvas: `text` is its live document's plain text (collab), else its exported Markdown's. */
export async function indexCanvas(db: Db, canvasId: string, text?: string): Promise<void> {
  const [canvas] = await db.select().from(canvases).where(eq(canvases.id, canvasId));
  if (!canvas) return;
  const body = text ?? markdownPlainText(canvas.markdown);
  await upsertSearchDoc(db, {
    id: canvas.id,
    burrowId: canvas.burrowId,
    type: 'CANVAS',
    conversationId: canvas.conversationId,
    where: canvas.title,
    authorId: canvas.provenance.createdById,
    text: body.startsWith(canvas.title) ? body : [canvas.title, body].filter(Boolean).join('\n'),
    link: { type: 'canvas', slug: canvas.slug },
    createdAt: canvas.createdAt,
  });
}

/* Plans, decisions and automation outcomes (work-supervision WS-21…WS-24) ---------------------------- */

const upper = (s: string) => s.toUpperCase().slice(0, 60);

async function cardMessageText(db: Db, messageId: string | null): Promise<string> {
  if (!messageId) return '';
  const [row] = await db
    .select({ text: messages.text, provenance: messages.provenance, outsidersRun: messages.outsidersRun })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!row || unsearchable(row)) return '';
  return plainMessageText(row.text);
}

/** Whether a card's message was posted by an outsiders' run (its card's words can be theirs too). */
async function outsidersCard(db: Db, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const [row] = await db
    .select({ outsidersRun: messages.outsidersRun })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row?.outsidersRun === true;
}

async function namesOf(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await db.select().from(principals).where(inArray(principals.id, wanted));
  return new Map(rows.map((r) => [r.id, shortName(r)]));
}

/**
 * A plan as a PLAN document: its title, the card's words and every step with owner, state and note; the pill is
 * its progress (“2 OF 4 DONE”). Written in the transaction that changed the plan.
 */
export async function indexPlan(db: Db, planId: string): Promise<void> {
  const doc = await planDoc(db, planId);
  if (doc) await upsertSearchDoc(db, doc);
}

export async function planDoc(db: Db, planId: string): Promise<SearchDoc | null> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) return null;
  const conversation = await loadConversationRow(db, plan.conversationId);
  if (!conversation) return null;
  const card = await cardMessageText(db, plan.messageId);
  const [cardAuthor] = plan.messageId
    ? await db.select({ id: messages.authorId }).from(messages).where(eq(messages.id, plan.messageId))
    : [];
  const steps = plan.steps.map(
    (s, i) =>
      `${i + 1}. ${s.title} · ${s.stateLabel || PLAN_STEP_LABELS[s.state]}${s.note ? ` · ${s.note}` : ''}`,
  );
  // OA: needs contracts 0.123.0 — `planProgress` reads no owner or handoff once `PlanStep` has neither (OA-14).
  const { done, total } = planProgress({
    steps: plan.steps.map((s) => ({ ...s, ownerId: plan.createdById ?? '', handoff: null })),
  });
  const tone: Tone = plan.steps.some((s) => s.state === 'blocked')
    ? 'bad'
    : plan.steps.some((s) => s.state === 'gate')
      ? 'warn'
      : total > 0 && done === total
        ? 'ok'
        : 'neutral';
  return {
    id: plan.id,
    burrowId: plan.burrowId,
    type: 'PLAN',
    conversationId: plan.conversationId,
    where: `Plan · ${conversationLabel(conversation)}`,
    authorId: plan.createdById ?? cardAuthor?.id ?? '',
    text: [plan.title, card, ...steps].filter(Boolean).join('\n'),
    link: { type: 'plan', planId: plan.id, in: await linkOfConversation(db, conversation) },
    createdAt: plan.createdAt ?? plan.updatedAt,
    status: { text: total ? `${done} OF ${total} DONE` : 'NO STEPS', tone },
  };
}

/** Approvals whose content is a website visitor's report: indexed without it (feedback FB-F3-03, WS-22). */
function assessmentApproval(row: typeof approvals.$inferSelect): boolean {
  return row.action.type === 'custom' && String(row.action.params.name ?? '').startsWith('feedback');
}

/**
 * An approval as a DECISION document: title, question, the outside-safe WHAT HAPPENS (never a pack tool's
 * arguments), how and by whom it was decided and the decline note (not a private approval's); the pill is its
 * outcome (“APPROVED BY MARA”, “DECLINED”). Written in the transaction that changed the approval.
 */
export async function indexApproval(db: Db, approvalId: string): Promise<void> {
  const doc = await approvalDoc(db, approvalId);
  if (doc) await upsertSearchDoc(db, doc);
  // One an outsiders' run asked for isn't searchable (its words, a file's or a value's name, can be theirs); this also
  // drops one indexed before.
  else await db.delete(searchDocuments).where(eq(searchDocuments.id, approvalId));
}

export async function approvalDoc(db: Db, approvalId: string): Promise<SearchDoc | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!row || (await outsidersCard(db, row.messageId))) return null;
  const conversation = await loadConversationRow(db, row.conversationId);
  if (!conversation) return null;
  const approval = toApproval(row);
  const phase = approvalPhase(approval);
  const names = await namesOf(db, [row.decidedById]);
  const decider = row.decidedById ? (names.get(row.decidedById) ?? 'someone') : null;
  const label = approvalView(approval, {
    names: () => undefined,
    now: approval.createdAt,
    timeZone: 'UTC',
  }).planStep.label;
  const status: { text: string; tone: Tone } =
    phase === 'needs_person'
      ? { text: 'WAITING FOR A PERSON', tone: 'warn' }
      : phase === 'declined'
        ? { text: 'DECLINED', tone: 'bad' }
        : phase === 'failed'
          ? { text: 'FAILED', tone: 'bad' }
          : phase === 'executed'
            ? { text: upper(label), tone: 'ok' }
            : { text: upper(decider ? `Approved by ${decider}` : 'Approved'), tone: 'ok' };
  const assessment = assessmentApproval(row);
  let note = '';
  if (phase === 'declined' && !assessment) {
    const [declined] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.approvalId, row.id), eq(events.type, 'approval.declined')))
      .orderBy(desc(events.seq))
      .limit(1);
    const value = declined?.payload?.note;
    note = typeof value === 'string' ? value : '';
  }
  const decided =
    decider && row.decidedAt
      ? `${row.state === 'declined' ? 'Declined' : 'Approved'} by ${decider} on ${formatDate(row.decidedAt, 'UTC', { year: 'always' })}.`
      : '';
  // The snippet reads outcome first: the question (the title again only when it says more), how it was decided and
  // why, then what happens and the card's words.
  const asked = row.question.replace(/\?$/, '') === row.title ? [row.question] : [row.title, row.question];
  const text = assessment
    ? [...asked, decided].filter(Boolean).join('\n')
    : [
        ...asked,
        decided,
        note,
        ...(row.whatHappensOutside ?? row.whatHappens),
        await cardMessageText(db, row.messageId),
      ]
        .filter(Boolean)
        .join('\n');
  return {
    id: row.id,
    burrowId: row.burrowId,
    type: 'DECISION',
    conversationId: row.conversationId,
    where: `Approval #${row.number} · ${conversationLabel(conversation)}`,
    authorId: row.requesterId,
    text,
    link: { type: 'approval', number: row.number, in: await linkOfConversation(db, conversation) },
    createdAt: row.createdAt,
    status,
  };
}

const AUTOMATION_STATUS: Record<string, { text: string; tone: Tone }> = {
  queued: { text: 'QUEUED', tone: 'neutral' },
  running: { text: 'RUNNING', tone: 'neutral' },
  waiting: { text: 'WAITING', tone: 'warn' },
  paused: { text: 'PAUSED', tone: 'warn' },
  succeeded: { text: 'SUCCEEDED', tone: 'ok' },
  failed: { text: 'FAILED', tone: 'bad' },
  cancelled: { text: 'STOPPED', tone: 'neutral' },
  skipped: { text: 'SKIPPED', tone: 'neutral' },
  needs_review: { text: 'NEEDS REVIEW', tone: 'warn' },
};

/**
 * An automation run as an AUTOMATION document: the automation's name, the run's number and status, its steps'
 * names and states and the run's error (not an outsiders' run's: it can quote what their agent said). Never a step's
 * input or output (a room's content, redacted per viewer; WS-22). Test runs of drafts and runs that haven't started
 * are not indexed.
 */
export async function indexAutomationRun(db: Db, runId: string): Promise<void> {
  const doc = await automationRunDoc(db, runId);
  if (doc) await upsertSearchDoc(db, doc);
}

export async function automationRunDoc(db: Db, runId: string): Promise<SearchDoc | null> {
  const [run] = await db.select().from(automationRuns).where(eq(automationRuns.id, runId));
  if (!run || run.test || run.status === 'queued') return null;
  const [automation] = await db
    .select({ name: automations.name, principalId: automations.principalId })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  if (!automation) return null;
  const steps = await db
    .select({ idx: automationRunSteps.idx, name: automationRunSteps.name, state: automationRunSteps.state })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.runId, run.id))
    .orderBy(automationRunSteps.idx);
  const status = AUTOMATION_STATUS[run.status] ?? { text: upper(run.status), tone: 'neutral' as Tone };
  return {
    id: run.id,
    burrowId: run.burrowId,
    type: 'AUTOMATION',
    conversationId: run.conversationId,
    where: `Automation run #${run.number} · ${automation.name}`,
    authorId: automation.principalId,
    text: [
      `${automation.name} · run #${run.number} · ${status.text.toLowerCase()}`,
      ...steps.map((s) => `${s.idx + 1}. ${s.name} · ${s.state}`),
      outsidersRun(run.trigger) ? '' : (run.error ?? ''),
    ]
      .filter(Boolean)
      .join('\n'),
    link: { type: 'automation_run', number: run.number },
    createdAt: run.startedAt ?? run.createdAt,
    status,
  };
}
