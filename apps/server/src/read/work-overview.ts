/**
 * The Work view (`work.overview`, docs/decisions/work-supervision.md WS-18, WS-19): one supervision list for one
 * viewer, built from existing state — approvals, plan steps, agents' open questions, skill proposals to decide
 * (skills-library.md SL-D60), turns (dispatches), runs and automation runs — with no new source of truth. Every item
 * links to the object that owns its state and offers that object's own controls. Objects in every conversation of the
 * burrow, all of them the person's; one query per source (plus one for labels and one per activity lookup), each capped.
 */
import {
  type Activity,
  type AgentProvider,
  type Approval,
  type AutomationRunStatus,
  approvalInboxText,
  type ConversationLink,
  canDecide,
  conversationLabel,
  conversationLink,
  type DispatchTrigger,
  type LinkRef,
  PlanStep,
  type PlanStepAction,
  planStepActions,
  type RunStatus,
  type Tone,
  turnFailureDetail,
  turnFailureRetryable,
  WORK_SECTIONS,
  type WorkAction,
  type WorkFailure,
  type WorkHealth,
  type WorkItem,
  type WorkOverview,
  type WorkSection,
  workHealth,
} from '@whombat/core';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { roomByKey } from '../chats/rooms';
import {
  activities,
  approvals,
  automationRuns,
  automations,
  conversations,
  dispatches,
  messages,
  principals,
  runLog,
  runs,
} from '../db/schema/index';
import { chatPart } from '../domain/links';
import { iso, isoOrNull } from '../lib/time';
import { type ActivityRow, toActivities } from '../runtime/activity';
import { retryable } from '../runtime/failure';
import { mayStopTurn } from '../runtime/stop';
import { turnProvider } from '../runtime/turn-runtime';
import type { Services } from '../services';
import { burrowConversationIds, repoNames } from './conversations';
import { unansweredByPeople } from './messages';
import { engineActor, nameInfo, type PrincipalRow } from './principals';
import { toApproval } from './work';

/** Items per section; `counts` say how many there were before the cut. */
const SECTION_CAP = 25;
/** Rows read per source. */
const SOURCE_CAP = 60;
/** Failed and done items look back this far. */
const RECENT_MS = 24 * 3_600_000;
/** Open questions older than this aren't “needs you” any more (AS-03 still counts them for the status). */
const QUESTION_MS = 7 * 24 * 3_600_000;

const TRIGGER_WORDS: Record<DispatchTrigger, string> = {
  mention: 'asked in a mention',
  dm: 'a direct message',
  search: 'answering a search',
  approval_declined: 'after a declined approval',
  schedule: 'scheduled work',
  run_control: 'going on with a run',
  automation: 'an automation step',
  expand: 'more detail',
  feedback: 'assessing a report',
  approval_granted: 'going on after an approval',
  retry: 'trying again after a failure',
  // Contracts 0.44 (RA-31).
  notify: 'after a background job',
  // Contracts 0.91 (home-redesign.md HR-03).
  undo_requested: 'undoing a change',
  // Contracts 0.116 (task-feedback.md TF-12).
  task_finished: 'after a server task ended',
  t3_thread: 'after T3 Code finished or asked something',
  council: 'after the council’s members answered',
  delegation: 'after tasks handed to T3 Code ended',
  // Contracts 3.5 (look-research.md LR-05, LR-08).
  look: 'looking into something that needs a look',
  look_fix: 'taking the step you let it take',
};

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'ChatGPT',
  local: 'Custom AI model',
};

type Refs = Partial<WorkItem['refs']>;
type Draft = Omit<WorkItem, 'refs' | 'health' | 'activity' | 'agentId' | 'ownerId' | 'detail'> & {
  refs: Refs;
  health?: WorkHealth | null;
  activity?: Activity | null;
  agentId?: string | null;
  ownerId?: string | null;
  detail?: string | null;
};

function item(d: Draft): WorkItem {
  return {
    ...d,
    title: d.title.slice(0, 200),
    where: d.where.slice(0, 120),
    detail: d.detail ? d.detail.slice(0, 280) : null,
    status: { text: d.status.text.slice(0, 60), tone: d.status.tone },
    agentId: d.agentId ?? null,
    ownerId: d.ownerId ?? null,
    health: d.health ?? null,
    activity: d.activity ?? null,
    refs: {
      conversationId: d.refs.conversationId ?? null,
      messageId: d.refs.messageId ?? null,
      runNumber: d.refs.runNumber ?? null,
      runId: d.refs.runId ?? null,
      approvalNumber: d.refs.approvalNumber ?? null,
      approvalId: d.refs.approvalId ?? null,
      planId: d.refs.planId ?? null,
      stepId: d.refs.stepId ?? null,
      automationRunNumber: d.refs.automationRunNumber ?? null,
      automationRunId: d.refs.automationRunId ?? null,
      dispatchId: d.refs.dispatchId ?? null,
    },
  };
}

const status = (text: string, tone: Tone) => ({ text, tone });

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} min`;
}

/** Plan step actions as Work actions (`cancel` stays in the plan pane). */
function stepActions(step: PlanStep, editor: boolean): WorkAction[] {
  if (!editor) return ['open'];
  const map: Partial<Record<PlanStepAction, WorkAction>> = {
    start: 'start_step',
    retry: 'retry_step',
    mark_done: 'mark_step_done',
  };
  const out = planStepActions(step)
    .map((a) => map[a])
    .filter((a): a is WorkAction => !!a);
  return [...out, 'open'];
}

/** Raw plan rows as the Work view reads them (`created_by_id` through `to_jsonb`, WS-47). */
type PlanLite = {
  id: string;
  title: string;
  conversation_id: string;
  steps: unknown[];
  updated_at: Date | string;
  created_by_id: string | null;
  /** Who wrote the message the plan was made from (the agent makes it from a person's request). */
  asked_by_id: string | null;
};

interface HealthInput {
  heartbeatAt: Date | null;
  lastProgressAt: Date | null;
  waiting: 'approval' | 'question' | null;
}

function healthText(h: WorkHealth): { text: string; tone: Tone } {
  switch (h.state) {
    case 'progressing':
      return status('WORKING', 'ok');
    case 'quiet':
      return status('WORKING QUIETLY', 'neutral');
    case 'waiting':
      return status('WAITING', 'warn');
    case 'stalled':
      return status('NO WORD FROM THE RUNNER', 'warn');
  }
}

export async function workOverview(
  services: Services,
  viewer: PrincipalRow,
  burrowId: string,
): Promise<WorkOverview> {
  const db = services.db;
  const now = services.clock();
  const since = new Date(now.getTime() - RECENT_MS);
  // Every conversation of the burrow is the person's.
  const rooms = await burrowConversationIds(db, burrowId);
  const sections = new Map<WorkSection, WorkItem[]>(WORK_SECTIONS.map((s) => [s.section, []]));
  const add = (section: WorkSection, draft: Omit<Draft, 'section'>) =>
    sections.get(section)?.push(item({ ...draft, section }));
  const person = viewer.kind === 'person';

  if (rooms.length) {
    // Every source reads at once: one query each, all bounded to the burrow's rooms.
    const [approvalRows, planRows, questionRows, automationRows, dispatchRows, runRows, conversationRows] =
      await Promise.all([
        db
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.burrowId, burrowId),
              eq(approvals.state, 'pending'),
              inArray(approvals.conversationId, rooms),
            ),
          )
          .orderBy(desc(approvals.createdAt))
          .limit(SOURCE_CAP),
        // `created_by_id` read through `to_jsonb` so the view works before and after plans record their author.
        db.execute<PlanLite>(sql`
        select p.id, p.title, p.conversation_id, p.steps, p.updated_at, to_jsonb(p) ->> 'created_by_id' as created_by_id,
          (select m.author_id from messages m where m.id = p.source_message_id) as asked_by_id
        from plans p
        where p.burrow_id = ${burrowId} and p.conversation_id in ${rooms}
          and exists (select 1 from jsonb_array_elements(p.steps) s where s ->> 'state' in ('gate', 'blocked'))
        order by p.updated_at desc limit ${SOURCE_CAP}`),
        // Agents' questions nobody answered yet (agent-status.md AS-03: no person spoke after them in that place).
        db
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            threadRootId: messages.threadRootId,
            authorId: messages.authorId,
            text: messages.text,
            mentions: messages.mentions,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(principals, eq(principals.id, messages.authorId))
          .where(
            and(
              eq(messages.burrowId, burrowId),
              eq(messages.asks, true),
              eq(principals.kind, 'agent'),
              // A retired agent's question waits for nobody (EP-20).
              inArray(messages.conversationId, rooms),
              gt(messages.createdAt, new Date(now.getTime() - QUESTION_MS)),
              unansweredByPeople(messages),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(SOURCE_CAP),
        db
          .select({ run: automationRuns, name: automations.name })
          .from(automationRuns)
          .innerJoin(automations, eq(automations.id, automationRuns.automationId))
          .where(
            and(
              eq(automationRuns.burrowId, burrowId),
              inArray(automationRuns.conversationId, rooms),
              or(
                eq(automationRuns.status, 'needs_review'),
                and(
                  inArray(automationRuns.status, ['failed', 'succeeded']),
                  gt(automationRuns.finishedAt, since),
                ),
              ),
            ),
          )
          .orderBy(desc(automationRuns.createdAt))
          .limit(SOURCE_CAP),
        db
          .select({
            d: dispatches,
            name: principals.name,
            runtime: principals.runtime,
          })
          .from(dispatches)
          .innerJoin(principals, eq(principals.id, dispatches.agentId))
          .where(
            and(
              eq(dispatches.burrowId, burrowId),
              inArray(dispatches.conversationId, rooms),
              or(
                inArray(dispatches.state, ['queued', 'claimed', 'running']),
                and(eq(dispatches.state, 'failed'), gt(dispatches.finishedAt, since)),
                // A finished turn counts as done work only when it did something observable.
                and(
                  eq(dispatches.state, 'done'),
                  gt(dispatches.finishedAt, since),
                  sql`exists (select 1 from ${activities} a where a.dispatch_id = ${dispatches.id})`,
                ),
              ),
            ),
          )
          .orderBy(desc(dispatches.createdAt))
          .limit(SOURCE_CAP * 2),
        db
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.burrowId, burrowId),
              inArray(runs.conversationId, rooms),
              or(
                inArray(runs.status, ['live', 'paused']),
                and(inArray(runs.status, ['failed', 'done']), gt(runs.finishedAt, since)),
              ),
            ),
          )
          .orderBy(desc(runs.startedAt))
          .limit(SOURCE_CAP),
        db.select().from(conversations).where(inArray(conversations.id, rooms)),
      ]);

    /* Labels and links ---------------------------------------------------------------------------- */
    const convById = new Map(conversationRows.map((c) => [c.id, c]));
    const where = (id: string) => {
      const c = convById.get(id);
      if (!c) return 'A conversation';
      return conversationLabel(c);
    };
    const repoOf = await repoNames(
      db,
      conversationRows.filter((c) => c.kind === 'branch').map((c) => c.repoId),
    );
    const inLink = (id: string): ConversationLink | null => {
      const c = convById.get(id);
      if (!c) return null;
      // Branch rooms carry their repository (CT-170, docs/decisions/essentials-conversations.md EC-24).
      const repo = c.repoId ? (repoOf.get(c.repoId) ?? null) : null;
      return conversationLink({ ...c, repo, chat: chatPart(c), room: roomByKey(c) ?? undefined });
    };
    const messageLink = (conversationId: string, messageId: string | null, threadRootId: string | null) => {
      const place = inLink(conversationId);
      if (!place) return { type: 'work' } as LinkRef;
      if (!messageId) return place as LinkRef;
      return {
        type: 'message',
        in: place,
        messageId,
        ...(threadRootId ? { threadRootId } : {}),
      } as LinkRef;
    };

    /* Needs you: approvals ------------------------------------------------------------------------ */
    const decider = engineActor(viewer);
    const approvalNames = new Map(
      (
        await db
          .select()
          .from(principals)
          .where(
            inArray(principals.id, [
              ...new Set(
                approvalRows.flatMap((r) => [
                  r.requesterId,
                  ...r.involvedIds,
                  ...r.conditions.flatMap((c) => (c.kind === 'review_approved' ? [c.reviewerId] : [])),
                ]),
              ),
              viewer.id,
            ]),
          )
      ).map((n) => [n.id, nameInfo(n)]),
    );
    const pendingApprovals = new Map<string, Approval>();
    /** Approvals the viewer has as a Needs-you item: a plan step they gate isn't a second item (one decision). */
    const approvalItems = new Set<string>();
    for (const row of approvalRows) {
      const a = toApproval(row);
      pendingApprovals.set(a.id, a);
      if (canDecide(a, decider) !== null) continue;
      const place = inLink(a.conversationId);
      approvalItems.add(a.id);
      add('needs_you', {
        id: `approval:${a.id}`,
        kind: 'approval',
        title: a.title,
        where: where(a.conversationId),
        agentId: a.requesterId,
        ownerId: viewer.id,
        status: status('NEEDS A PERSON', 'warn'),
        // The inbox's sentence (“… Goes out once checks pass.”), not the question, which repeats the title.
        detail: approvalInboxText(a, { names: (id) => approvalNames.get(id) }),
        since: a.createdAt,
        link: { type: 'approval', number: a.number, ...(place ? { in: place } : {}) },
        actions: ['approve', 'decline', 'open'],
        refs: {
          conversationId: a.conversationId,
          messageId: a.messageId,
          approvalNumber: a.number,
          approvalId: a.id,
        },
      });
    }

    /* Needs you / blocked: plan steps ------------------------------------------------------------- */
    // Who asked each step's turn (the author of the message that handed it out): a step they started that now asks
    // a person to check its result is theirs too (WS-53).
    const stepTurns = planRows.flatMap((plan) =>
      (plan.steps ?? []).flatMap((raw) => {
        const d = (raw as { dispatchId?: unknown }).dispatchId;
        return typeof d === 'string' ? [d] : [];
      }),
    );
    const startedBy = new Map<string, string>();
    if (stepTurns.length) {
      const rows = await db
        .select({ id: dispatches.id, authorId: messages.authorId })
        .from(dispatches)
        .innerJoin(messages, eq(messages.id, dispatches.messageId))
        .where(inArray(dispatches.id, stepTurns));
      for (const r of rows) startedBy.set(r.id, r.authorId);
    }
    for (const plan of planRows) {
      const place = inLink(plan.conversation_id);
      const updated = plan.updated_at instanceof Date ? plan.updated_at : new Date(plan.updated_at);
      for (const raw of plan.steps ?? []) {
        const parsed = PlanStep.safeParse(raw);
        if (!parsed.success) continue;
        const step = parsed.data;
        if (step.state !== 'gate' && step.state !== 'blocked') continue;
        const mine =
          plan.created_by_id === viewer.id ||
          plan.asked_by_id === viewer.id ||
          (!!step.dispatchId && startedBy.get(step.dispatchId) === viewer.id);
        // Needs you: a step at a gate that is theirs (they made the plan, asked for it or for the step). Blocked: any in
        // their rooms.
        if (step.state === 'gate' && !mine) continue;
        // The approval gating it is already the viewer's item, with Approve and Decline: one decision, one item.
        if (step.state === 'gate' && step.approvalId && approvalItems.has(step.approvalId)) continue;
        const section: WorkSection = step.state === 'blocked' ? 'blocked' : 'needs_you';
        add(section, {
          id: `plan_step:${plan.id}:${step.id}`,
          kind: 'plan_step',
          title: step.title,
          where: where(plan.conversation_id),
          status: status(step.stateLabel.toUpperCase(), step.state === 'blocked' ? 'bad' : 'warn'),
          detail: step.note ?? `A step of “${plan.title}”`,
          since: step.updatedAt ?? iso(updated),
          link: place
            ? { type: 'plan', planId: plan.id, in: place, stepId: step.id }
            : { type: 'work', section },
          actions: stepActions(step, person),
          refs: {
            conversationId: plan.conversation_id,
            planId: plan.id,
            stepId: step.id,
            runId: step.runId,
            runNumber: step.refs.runNumber,
            approvalId: step.approvalId,
            approvalNumber: step.refs.approvalNumber,
            automationRunId: step.automationRunId,
            automationRunNumber: step.refs.automationRunNumber,
            dispatchId: step.dispatchId,
          },
        });
      }
    }

    /* Needs you: questions ------------------------------------------------------------------------ */
    for (const q of questionRows) {
      add('needs_you', {
        id: `question:${q.id}`,
        kind: 'question',
        title: q.text.split('\n')[0]?.trim() || 'A question',
        where: where(q.conversationId),
        agentId: q.authorId,
        // Addressed to the viewer when it mentions them; otherwise anyone in the room may answer.
        ownerId: q.mentions.includes(viewer.id) ? viewer.id : null,
        status: status('QUESTION', 'warn'),
        detail: null,
        since: iso(q.createdAt),
        link: messageLink(q.conversationId, q.id, q.threadRootId),
        actions: ['reply', 'open'],
        refs: { conversationId: q.conversationId, messageId: q.id },
      });
    }

    /* Automation runs ----------------------------------------------------------------------------- */
    for (const { run, name } of automationRows) {
      const s = run.status as AutomationRunStatus;
      const section: WorkSection = s === 'needs_review' ? 'needs_you' : s === 'failed' ? 'failed' : 'done';
      add(section, {
        id: `automation_run:${run.id}`,
        kind: 'automation_run',
        title: `${name} · run #${run.number}`,
        where: where(run.conversationId),
        ownerId: s === 'needs_review' ? viewer.id : null,
        status:
          s === 'needs_review'
            ? status('NEEDS REVIEW', 'warn')
            : s === 'failed'
              ? status('FAILED', 'bad')
              : status('DONE', 'ok'),
        detail: s === 'failed' ? (run.error ?? null) : null,
        since: iso(run.finishedAt ?? run.createdAt),
        link: { type: 'automation_run', number: run.number },
        actions: ['open'],
        refs: {
          conversationId: run.conversationId,
          automationRunNumber: run.number,
          automationRunId: run.id,
        },
      });
    }

    /* Turns and runs: activity, heartbeats and run log -------------------------------------------- */
    const runById = new Map(runRows.map((r) => [r.id, r]));
    /** The run a turn works on (it controls it, or started it). */
    const runOfDispatch = new Map<string, string>();
    for (const { d } of dispatchRows) if (d.runId && runById.has(d.runId)) runOfDispatch.set(d.id, d.runId);
    for (const r of runRows) if (r.dispatchId) runOfDispatch.set(r.dispatchId, r.id);
    /** Each run's newest turn. */
    const turnOfRun = new Map<string, (typeof dispatchRows)[number]>();
    for (const row of dispatchRows) {
      const runId = runOfDispatch.get(row.d.id);
      if (!runId) continue;
      const prev = turnOfRun.get(runId);
      if (!prev || prev.d.createdAt < row.d.createdAt) turnOfRun.set(runId, row);
    }
    const turnIds = dispatchRows.map(({ d }) => d.id);
    const runIds = runRows.map((r) => r.id);
    const [latestRows, progressRows, logRows] = await Promise.all([
      turnIds.length || runIds.length
        ? db.execute<{ id: string }>(sql`
            select distinct on (coalesce(a.run_id, a.dispatch_id)) a.id from ${activities} a
            where ${turnIds.length ? sql`a.dispatch_id in ${turnIds}` : sql`false`}
               or ${runIds.length ? sql`a.run_id in ${runIds}` : sql`false`}
            order by coalesce(a.run_id, a.dispatch_id), a.important desc, a.rev desc`)
        : Promise.resolve([] as { id: string }[]),
      turnIds.length
        ? db
            .select({ dispatchId: activities.dispatchId, at: sql<Date>`max(${activities.updatedAt})` })
            .from(activities)
            .where(inArray(activities.dispatchId, turnIds))
            .groupBy(activities.dispatchId)
        : Promise.resolve([] as { dispatchId: string; at: Date }[]),
      runIds.length
        ? db
            .select({ runId: runLog.runId, at: sql<Date>`max(${runLog.at})` })
            .from(runLog)
            .where(inArray(runLog.runId, runIds))
            .groupBy(runLog.runId)
        : Promise.resolve([] as { runId: string; at: Date }[]),
    ]);
    const latestIds = [...latestRows].map((r) => r.id);
    const latestFull: ActivityRow[] = latestIds.length
      ? await db.select().from(activities).where(inArray(activities.id, latestIds))
      : [];
    const latest = new Map<string, Activity>();
    for (const a of await toActivities(db, latestFull)) {
      latest.set(a.runId ?? a.dispatchId, a);
      if (!latest.has(a.dispatchId)) latest.set(a.dispatchId, a);
    }
    const asDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
    const progressOf = new Map(progressRows.map((p) => [p.dispatchId, asDate(p.at)]));
    const logOf = new Map(logRows.map((l) => [l.runId, asDate(l.at)]));
    const maxDate = (...ds: (Date | null | undefined)[]) =>
      ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);
    const health = (h: HealthInput) =>
      workHealth({
        now,
        heartbeatAt: isoOrNull(h.heartbeatAt),
        lastProgressAt: isoOrNull(h.lastProgressAt),
        leaseMs: services.runtime.options.leaseMs,
        waiting: h.waiting,
      });
    const waitingOn = (a: Activity | undefined) =>
      a?.status === 'waiting' && a.approvalId ? ('approval' as const) : null;

    /* Queued: why ---------------------------------------------------------------------------------- */
    const runners = services.runtime.connectedRunners();
    const liveFor = new Set(
      dispatchRows
        .filter(({ d }) => d.state === 'claimed' || d.state === 'running')
        .map(({ d }) => `${d.agentId}|${d.conversationId}`),
    );
    const queuedWhy = (row: (typeof dispatchRows)[number]): { text: string; detail: string } => {
      const d = row.d;
      // A turn that hit a usage limit carries on after the reset (resourceful-agents.md RA-32).
      if (d.requeuedFor === 'usage_limit' && d.notBefore && d.notBefore > now)
        return {
          text: 'QUEUED · AFTER THE USAGE LIMIT',
          detail: `The usage limit was reached; it carries on in ${minutes(d.notBefore.getTime() - now.getTime())}.`,
        };
      if (d.notBefore && d.notBefore > now)
        return {
          text: 'QUEUED · RETRY SOON',
          detail: `The last try failed; tries again in ${minutes(d.notBefore.getTime() - now.getTime())}.`,
        };
      if (services.maintenance.paused)
        return { text: 'QUEUED · ON HOLD', detail: 'Whombat is updating; turns start again after it.' };
      if (services.licence.lapsed)
        return { text: 'QUEUED · ON HOLD', detail: 'Turns start again once Whombat is licensed.' };
      if (runners.length === 0)
        return { text: 'QUEUED · WAITING FOR A RUNNER', detail: 'No runner is connected.' };
      // The provider the turn waits for: its Chat thread's choice, else its agent's (chat-runtime-server.md CR-S03).
      const provider = turnProvider(row.runtime, d) as AgentProvider;
      if (!runners.some((r) => r.providers.includes(provider)))
        return {
          text: 'QUEUED · PROVIDER NOT READY',
          detail: `${PROVIDER_NAMES[provider] ?? provider} isn’t ready on a runner.`,
        };
      if (liveFor.has(`${d.agentId}|${d.conversationId}`))
        return { text: 'QUEUED', detail: `After ${row.name}’s current turn here.` };
      return { text: 'QUEUED · WAITING FOR A RUNNER', detail: 'Starts when a runner takes it.' };
    };

    /* Failed turns: why, and Try again (essentials-agents.md EA-08, EA-09) --------------------------- */
    // The technical detail is the person's (OP-S06); the agent reads the public sentence.
    const seesDetail = person;
    const failureOf = (row: (typeof dispatchRows)[number]): WorkFailure | null => {
      const f = row.d.state === 'failed' ? row.d.failure : null;
      if (!f) return null;
      return {
        code: f.code,
        reason: f.reason,
        detail: seesDetail ? turnFailureDetail(f.detail ?? row.d.error) : null,
        retriedAt: f.retriedAt,
        retryDispatchId: f.retryDispatchId,
      };
    };
    /** Try again: the person, once per failed turn whose code a retry can help (not a content refusal). */
    const mayRetry = (row: (typeof dispatchRows)[number]) =>
      person &&
      row.d.state === 'failed' &&
      !!row.d.failure &&
      turnFailureRetryable(row.d.failure.code) &&
      !row.d.failure.retryDispatchId &&
      retryable(row.d);

    /** Stop: the person, on any turn they may stop (review-features.md RF-01, one-person.md OP-S07). */
    const mayStop = (row: (typeof dispatchRows)[number]) => mayStopTurn(viewer, row.d);

    /* Runs ----------------------------------------------------------------------------------------- */
    const runActions = (s: RunStatus): WorkAction[] => {
      if (!person) return ['open'];
      if (s === 'live') return ['pause', 'take_over', 'open'];
      if (s === 'paused') return ['resume', 'take_over', 'open'];
      return ['open'];
    };
    for (const r of runRows) {
      const turn = turnOfRun.get(r.id);
      const activity = latest.get(r.id) ?? (turn ? latest.get(turn.d.id) : undefined);
      const base = {
        id: `run:${r.id}`,
        kind: 'run' as const,
        title: `Run #${r.number} · ${r.title}`,
        where: where(r.conversationId),
        agentId: r.agentId,
        ownerId: r.takenOverById ?? r.askedById,
        activity: activity ?? null,
        link: { type: 'run', number: r.number } as LinkRef,
        actions: runActions(r.status),
        refs: {
          conversationId: r.conversationId,
          messageId: r.messageId,
          runNumber: r.number,
          runId: r.id,
          dispatchId: turn?.d.id ?? r.dispatchId,
        },
      };
      if (r.status === 'failed' || r.status === 'done') {
        // A run stopped by its failed turn offers that turn's Try again (EA-09).
        const failure = r.status === 'failed' && turn ? failureOf(turn) : null;
        add(r.status === 'failed' ? 'failed' : 'done', {
          ...base,
          status: r.status === 'failed' ? status('FAILED', 'bad') : status('DONE', 'ok'),
          detail: failure?.reason ?? r.summary,
          since: iso(r.finishedAt ?? r.updatedAt),
          ...(failure ? { failure } : {}),
          ...(failure && turn && mayRetry(turn) ? { actions: ['retry_turn', ...base.actions] } : {}),
        });
        continue;
      }
      if (r.status === 'paused') {
        add('blocked', {
          ...base,
          status: status('PAUSED', 'warn'),
          detail: 'Paused. Resume it or take over.',
          since: iso(r.updatedAt),
        });
        continue;
      }
      // Live. A run that needs a person (RC-11; RA-DS62: what its agent asked for) says so, not a finished turn's
      // silence, until a turn of it is under way again.
      if (r.attention && !(turn && ['queued', 'claimed', 'running'].includes(turn.d.state))) {
        add('blocked', {
          ...base,
          status: status('NEEDS A PERSON', 'warn'),
          detail: r.attention,
          since: iso(r.updatedAt),
        });
        continue;
      }
      const waiting = waitingOn(activity);
      const h = health({
        heartbeatAt: turn?.d.heartbeatAt ?? null,
        lastProgressAt: maxDate(turn ? progressOf.get(turn.d.id) : null, logOf.get(r.id)),
        waiting,
      });
      if (waiting) {
        add('blocked', {
          ...base,
          status: status('WAITING FOR APPROVAL', 'warn'),
          // The health line says it already; the detail is only what the activity adds.
          detail: activity?.detail ?? null,
          since: activity?.updatedAt ?? iso(r.updatedAt),
          health: h,
        });
        continue;
      }
      if (turn && turn.d.state === 'queued') {
        const why = queuedWhy(turn);
        add('queued', {
          ...base,
          status: status(why.text, 'neutral'),
          detail: why.detail,
          since: iso(turn.d.createdAt),
        });
        continue;
      }
      add('running', {
        ...base,
        status: healthText(h),
        detail: activity ? `${activity.title}${activity.detail ? ` · ${activity.detail}` : ''}` : null,
        since: iso(r.startedAt),
        health: h,
      });
    }

    /* Turns ---------------------------------------------------------------------------------------- */
    for (const row of dispatchRows) {
      const d = row.d;
      const runId = runOfDispatch.get(d.id);
      // A turn on a run shows as its run (the run item carries its health and activity).
      if (runId && runById.has(runId)) continue;
      const activity = latest.get(d.id);
      const base = {
        id: `dispatch:${d.id}`,
        kind: 'dispatch' as const,
        title: `${row.name}’s turn · ${TRIGGER_WORDS[d.trigger] ?? d.trigger}`,
        where: where(d.conversationId),
        agentId: d.agentId,
        activity: activity ?? null,
        link: messageLink(d.conversationId, d.messageId, d.threadRootId),
        actions: ['open'] as WorkAction[],
        refs: {
          conversationId: d.conversationId,
          messageId: d.messageId,
          dispatchId: d.id,
          ...(d.runId ? { runId: d.runId } : {}),
        },
      };
      if (d.state === 'queued') {
        const why = queuedWhy(row);
        add('queued', {
          ...base,
          status: status(why.text, 'neutral'),
          detail: why.detail,
          since: iso(d.createdAt),
          ...(mayStop(row) ? { actions: ['stop_turn', 'open'] as WorkAction[] } : {}),
        });
      } else if (d.state === 'claimed' || d.state === 'running') {
        const waiting = waitingOn(activity);
        const h = health({
          heartbeatAt: d.heartbeatAt,
          lastProgressAt: progressOf.get(d.id) ?? null,
          waiting,
        });
        add('running', {
          ...base,
          status: healthText(h),
          detail: activity ? `${activity.title}${activity.detail ? ` · ${activity.detail}` : ''}` : null,
          since: iso(d.claimedAt ?? d.createdAt),
          health: h,
          ...(mayStop(row) ? { actions: ['stop_turn', 'open'] as WorkAction[] } : {}),
        });
      } else if (d.state === 'failed') {
        const failure = failureOf(row);
        add('failed', {
          ...base,
          status: status('FAILED', 'bad'),
          detail: failure?.reason ?? activity?.title ?? null,
          since: iso(d.finishedAt ?? d.createdAt),
          ...(failure ? { failure } : {}),
          ...(mayRetry(row) ? { actions: ['retry_turn', 'open'] as WorkAction[] } : {}),
        });
      } else if (d.state === 'done') {
        add('done', {
          ...base,
          status: status('DONE', 'ok'),
          detail: activity?.title ?? null,
          since: iso(d.finishedAt ?? d.createdAt),
        });
      }
    }
  }

  const out = WORK_SECTIONS.map(({ section, title }) => {
    const items = sections.get(section) ?? [];
    // The queue in its order (oldest first); everything else newest first.
    items.sort((a, b) =>
      section === 'queued' ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since),
    );
    return { section, title, items };
  });
  const counts = Object.fromEntries(out.map((s) => [s.section, s.items.length])) as WorkOverview['counts'];
  return {
    sections: out.map((s) => ({ ...s, items: s.items.slice(0, SECTION_CAP) })),
    counts,
    generatedAt: now.toISOString(),
  };
}
