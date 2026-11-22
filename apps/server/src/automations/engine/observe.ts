/**
 * Waiting steps (bp-automations BP-C05): is the step done? The outcome to commit, read from what it waits for — the
 * clock, a person's decision, the agent's turn (and GitHub, for a coding step's new commits), a merge's checks — or
 * null to keep waiting.
 */
import {
  type AutomationStep,
  type AutomationVerdict,
  billedTokens,
  type JsonObject,
  parseVerdict,
  renderTemplate,
  stepRequiredRooms,
  VERDICT_APPROVE,
  VERDICT_CHANGES,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { approvals, dispatches, repos } from '../../db/schema/index';
import { loadPrincipalRow } from '../../read/principals';
import { publishDispatch } from '../../runtime/activity';
import { outsidersTurn } from '../../runtime/person';
import { outsidersTurnsInFlight } from '../../runtime/places';
import type { Services } from '../../services';
import { dispatchResult, openedPr, openPrFrom, runScope, type StepOp, stepTimeoutMs } from '../steps';
import { queuedNoteOf, turnFailedWords, turnWaitsWords } from '../steps/turn-words';
import { type AutomationRunRow, type AutomationStepRow, loadStepRows } from '../store';
import { HANDED_OVER_ERROR, HANDED_WIND_DOWN_MS, handedTurnEnded, handedWaitOf } from '../turn-waits';
import { type RunWorkspace, rowWorkspace } from '../workspace';
import { observeHandedWait, stepClockStart } from './handed-wait';
import { observeMerge } from './merge-step';
import { modelKnown, reviewBinds, reviewerVerdict } from './reviewer';

export { namedCommit, sameCommit } from './observe-commit';

import { awaitingYes, deciderName, failure } from './step-ops';

/** Is a waiting step done? The outcome to commit, or null to keep waiting. */
export async function observeStep(
  services: Services,
  run: AutomationRunRow,
  row: AutomationStepRow,
  step: AutomationStep,
  now: Date,
): Promise<StepOp | null> {
  const db = services.db;
  switch (step.kind) {
    case 'wait':
      if (row.wakeAt && row.wakeAt > now) return null;
      return {
        op: 'settle',
        idx: row.idx,
        state: 'succeeded',
        output: { waited: step.minutes },
        from: ['waiting'],
      };
    case 'dispatch_agent':
      // Waiting for a person to let the agent work on its branch (BP-C26).
      if (!row.dispatchId && row.approvalId)
        return awaitingYes(db, row, step, now, (name) => {
          const ws = rowWorkspace(row.output);
          return {
            op: 'settle',
            idx: row.idx,
            state: 'failed',
            error: `${name} declined letting the agent work on ${ws?.branch ?? 'its branch'}.`,
            from: ['waiting'],
          };
        });
      return observeTurn(services, run, row, step, now);
    case 'github_comment':
      // Waiting for a person to let it comment on GitHub (its key asks).
      return awaitingYes(db, row, step, now, (name) => {
        const target = `${step.repo}#${String((row.output as { number?: unknown }).number ?? '')}`;
        const error = `${name} declined the comment on ${target}.`;
        // A no is what `otherwise` is for: skip it and go on, or fail the run.
        return step.otherwise === 'fail'
          ? { op: 'settle', idx: row.idx, state: 'failed', error, from: ['waiting'] }
          : { op: 'settle', idx: row.idx, state: 'skipped', error, from: ['waiting'] };
      });
    case 'tracker_reply':
      // Waiting for a person to let it reply to the customer (its key asks, or the reply needs a look, TA-27, TA-28).
      return awaitingYes(db, row, step, now, (name) => {
        const out = row.output as { connection?: string; number?: number };
        const reason = `${name} declined replying to the customer of ${out.connection ?? 'the tracker'}${out.number ? ` #${out.number}` : ''}.`;
        return step.otherwise === 'fail'
          ? { op: 'settle', idx: row.idx, state: 'failed', error: reason, from: ['waiting'] }
          : {
              op: 'settle',
              idx: row.idx,
              state: 'skipped',
              error: reason,
              output: { sent: false, reason },
              from: ['waiting'],
            };
      });
    case 'tracker_update':
      // Waiting for a person to let it write to the tracker (its key asks, TA-12).
      return awaitingYes(db, row, step, now, (name) => {
        const out = row.output as { connection?: string; number?: number };
        const reason = `${name} declined writing to ${out.connection ?? 'the tracker'}${out.number ? ` #${out.number}` : ''}.`;
        return step.otherwise === 'fail'
          ? { op: 'settle', idx: row.idx, state: 'failed', error: reason, from: ['waiting'] }
          : {
              op: 'settle',
              idx: row.idx,
              state: 'skipped',
              error: reason,
              output: { wrote: false, reason },
              from: ['waiting'],
            };
      });
    case 'merge_pull_request':
      return observeMerge(db, run, row, step, now);
    case 'connection_actions':
      return awaitingYes(db, row, step, now, (name) => {
        const reason = `${name} declined the proposed actions.`;
        return step.otherwise === 'fail'
          ? { op: 'settle', idx: row.idx, state: 'failed', error: reason, from: ['waiting'] }
          : {
              op: 'settle',
              idx: row.idx,
              state: 'skipped',
              error: reason,
              output: { ran: false, count: 0, reason },
              from: ['waiting'],
            };
      });
    case 'request_approval':
    case 'open_pull_request':
      return observeRequest(db, run, row, step, now);
    default:
      return null;
  }
}

/**
 * An agent's turn (BP-C15, BP-C40): done succeeds with its result — for a coding step only with new commits on its
 * branch (M1), for a review only with a verdict (BP-C27) —; failed (with why, when its turn says), stopped or past the
 * step's time since its turn was claimed (the turn is cancelled) is a failed attempt.
 */
async function observeTurn(
  services: Services,
  run: AutomationRunRow,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'dispatch_agent' }>,
  now: Date,
): Promise<StepOp | null> {
  const db = services.db;
  const [d] = row.dispatchId
    ? await db.select().from(dispatches).where(eq(dispatches.id, row.dispatchId))
    : [];
  if (!d) return failure(row, step, 'The agent’s turn is gone.');
  const agent = await loadPrincipalRow(db, d.agentId);
  const agentName = agent ? (agent.shortName ?? agent.name) : 'The agent';
  // The agent's own words may go into the step's error (shown on the run page and in the thread) only when the
  // step read and acted in the run's room alone (BP-C20).
  const quotable = stepRequiredRooms(run.definition, run.conversationId, row.idx).every(
    (r) => r === run.conversationId,
  );
  const said = async () => {
    if (!quotable) return '';
    const text = (await dispatchResult(db, row, d.agentId)).text.trim();
    const first =
      text
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? '';
    return first ? ` It said: “${first.slice(0, 280)}${first.length > 280 ? '…' : ''}”` : '';
  };
  // Its turn handed its wait for T3 Code to Whombat (docs/decisions/outsiders-turns.md): the step waits for the thread, then gets its next turn.
  if (handedTurnEnded(d)) return observeHandedWait(services, row, step, d, now);
  // A handed turn holds the one outsiders' profile while it winds down: one that doesn't end soon is stopped, and the
  // wait carries on.
  if (
    d.waitsOn &&
    (d.state === 'claimed' || d.state === 'running') &&
    now.getTime() - Date.parse(d.waitsOn.at) > HANDED_WIND_DOWN_MS
  ) {
    await services.pipeline.transactAccount(async (tx, session) => {
      const stopped = await tx
        .update(dispatches)
        .set({ state: 'cancelled', cancelReason: 'cancelled', error: HANDED_OVER_ERROR, finishedAt: now })
        .where(and(eq(dispatches.id, d.id), sql`${dispatches.state} in ('claimed', 'running')`))
        .returning();
      for (const c of stopped) publishDispatch(session, c);
    });
    return null;
  }
  if (d.state === 'done') {
    const result = await dispatchResult(db, row, d.agentId);
    // As billed (prompt-efficiency.md PE-04): a prompt-cache read counts a tenth.
    // With what its turns that handed their wait over used (`turn-waits.ts`).
    const handedTokens = handedWaitOf(row.output)?.tokens ?? 0;
    const tokens = d.usage || handedTokens ? (d.usage ? billedTokens(d.usage) : 0) + handedTokens : null;
    const extra: JsonObject = {};
    // Coding work (M1): the turn finished and the branch has new commits on GitHub; else the step fails.
    const ws = rowWorkspace(row.output);
    if (step.workspace?.access === 'write' && ws) {
      const ahead = await commitsAhead(services, ws);
      if (typeof ahead === 'string') return failure(row, step, `${ahead}${await said()}`.slice(0, 1000));
      if (ahead.commits === 0)
        return failure(
          row,
          step,
          `${agentName} finished without new commits on ${ws.branch}.${await said()}`.slice(0, 1000),
        );
      extra.commits = ahead.commits;
      // The commit a review after it reads, and a merge step checks the pull request still is (AR-46).
      if (ahead.head) extra.head = ahead.head;
    }
    // A verdict (BP-C27): the agent's reply starts with “Approve” or “Changes needed”.
    if (step.verdict) {
      const verdict = verdictOf(result.messageTexts);
      if (!verdict)
        return failure(
          row,
          step,
          `${agentName} didn’t start its reply with “${VERDICT_APPROVE}” or “${VERDICT_CHANGES}”.${await said()}`.slice(
            0,
            1000,
          ),
        );
      extra.verdict = verdict;
      // A review of work a T3 Code thread pushed (no write checkout of this run's): the approval holds when another
      // model's review read this branch (the commit its verdict's line names is on it), for the branch's head as GitHub
      // has it now, which the merge then compares with the pull request's. When the reviewer
      // or GitHub can't be read the step is asked once more; without them then, it is no approval.
      const pushed = !ws && verdict === 'approve' ? await reviewedHead(services, run, row.idx) : null;
      if (pushed) {
        // The reviewer's own last answer decides, on the commit it read; the step's reply only relays it (TA-57).
        const scope = runScope(run, await loadStepRows(services.db, run.id));
        const own = await reviewerVerdict(services, run, scope);
        // The reviewer the automation chose needs no providers (`reviewBinds`); any other does.
        const chosen =
          (run.definition as { recipe?: { t3Review?: { model?: string } } }).recipe?.t3Review?.model ?? null;
        // Asked once more (a fresh turn) when the reviewer couldn't be read or GitHub didn't answer: the run goes on
        // by itself; still without them, it is no approval, and the person hears (TA-61).
        if (
          row.attempt === 0 &&
          (!own ||
            !modelKnown(own.model) ||
            !modelKnown(own.fixerModel) ||
            ((!own.provider || !own.fixerProvider) && own.model !== chosen) ||
            !pushed.head)
        )
          return {
            op: 'settle',
            idx: row.idx,
            state: 'pending',
            retry: true,
            error: !pushed.head
              ? 'GitHub didn’t say which commit the branch is at, so the review is read again.'
              : 'The review couldn’t be read in T3 Code, so it is read again.',
            from: ['waiting'],
          };
        extra.reviewer = own ? 'read' : 'unread';
        // Its “Changes needed” no longer stops the fix by itself: the fix thread deals with what one review found and
        // pushes, and this step's verdict says whether it did.
        const bound = !own
          ? { ok: false as const, reason: 'Its review couldn’t be read in T3 Code.' }
          : !pushed.head
            ? { ok: false as const, reason: 'The reviewed branch couldn’t be read on GitHub.' }
            : reviewBinds(
                own,
                { sha: pushed.head, committedAt: pushed.committedAt, commits: pushed.commits },
                chosen,
              );
        if (bound.ok) extra.head = pushed.head;
        else {
          extra.verdict = 'changes_needed';
          extra.unbound = bound.reason;
        }
      }
    }
    const { messageTexts: _texts, ...kept } = result;
    return {
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: {
        ...kept,
        ...extra,
        agentId: d.agentId,
        dispatchState: 'done',
        resultDispatchId: d.id,
        ...(tokens !== null ? { tokens } : {}),
      },
      from: ['waiting'],
    };
  }
  if (d.state === 'failed')
    return failure(row, step, `${turnFailedWords(agentName, d)}${await said()}`.slice(0, 1000));
  if (d.state === 'cancelled') return failure(row, step, 'The agent’s turn was stopped.');
  const noted = queuedNoteOf(row.output)?.note ?? null;
  if (d.state === 'queued') {
    // Waiting to be taken uses none of the step's time; the run's own deadline still bounds the wait. Behind another
    // outsiders' turn (they run one at a time), the step says so.
    const ahead = outsidersTurn(d) ? await outsidersTurnAhead(db, d, now) : null;
    const note = ahead ? turnWaitsWords(ahead) : null;
    return note === noted ? null : { op: 'turn_queue', idx: row.idx, note };
  }
  if (noted) return { op: 'turn_queue', idx: row.idx, note: null };
  // The step's time counts from its turn's claim (a turn taken again after a crash starts it again; a turn after a
  // handed wait keeps its first turn's).
  const start = stepClockStart(row, d);
  const deadline = start ? new Date(start.getTime() + stepTimeoutMs(step)) : row.deadlineAt;
  if (deadline && now > deadline) {
    await services.pipeline.transactAccount(async (tx, session) => {
      const cancelled = await tx
        .update(dispatches)
        .set({
          state: 'cancelled',
          cancelReason: 'cancelled',
          error: 'automation_timeout',
          finishedAt: now,
        })
        .where(and(eq(dispatches.id, d.id), sql`${dispatches.state} in ('queued', 'claimed', 'running')`))
        .returning();
      for (const c of cancelled) publishDispatch(session, c);
    });
    return failure(row, step, 'The agent didn’t finish in time.');
  }
  return null;
}

/** The outsiders' turn a queued outsiders' turn waits for (the claim takes one at a time), or null. */
async function outsidersTurnAhead(
  db: Db,
  d: { runId: string | null },
  now: Date,
): Promise<{ trigger: string } | null> {
  const [ahead] = await db.execute<{ id: string; trigger: string }>(
    sql`${outsidersTurnsInFlight(sql`${d.runId}`, now)} order by outsider.claimed_at limit 1`,
  );
  return ahead ? { trigger: ahead.trigger } : null;
}

/**
 * A `request_approval` step's person's decision, or an `open_pull_request` step's approval to open it (and whether
 * it opened, or was opened meanwhile, AR-41).
 */
async function observeRequest(
  db: Db,
  run: AutomationRunRow,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'request_approval' | 'open_pull_request' }>,
  now: Date,
): Promise<StepOp | null> {
  const [a] = row.approvalId ? await db.select().from(approvals).where(eq(approvals.id, row.approvalId)) : [];
  if (!a) return failure(row, step, 'The approval is gone.');
  if (a.state === 'declined') {
    const name = await deciderName(db, a);
    if (step.kind === 'open_pull_request')
      return {
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: `${name} declined opening the pull request.`,
        from: ['waiting'],
      };
    return {
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: { decision: 'declined', decidedById: a.decidedById, decidedByName: name },
      from: ['waiting'],
    };
  }
  if (a.execution.state === 'failed') {
    const refusal = (row.output as { refusal?: string }).refusal;
    if (step.kind === 'open_pull_request' && !refusal) {
      // Opened while the person decided (by hand, or an older automation): that one is the pull request (AR-41),
      // and its own body goes on it as a comment (RN-S3d).
      const branch = String((row.output as { branch?: string }).branch ?? '');
      const pr = await openPrFrom(db, run.burrowId, step.repo, branch);
      if (pr) return { op: 'already_open', idx: row.idx };
    }
    // The approved pull request couldn't be opened (not a refusal by the guard): post it for a person.
    if (step.kind === 'open_pull_request' && !refusal && step.otherwise === 'post_payload')
      return {
        op: 'fallback',
        idx: row.idx,
        reason: `opening it failed: ${a.execution.error ?? 'GitHub said no'}`.slice(0, 500),
      };
    if (refusal === 'stale')
      return step.kind === 'request_approval'
        ? { op: 'settle', idx: row.idx, state: 'pending', reRequest: true, from: ['waiting'] }
        : {
            op: 'settle',
            idx: row.idx,
            state: 'pending',
            error: 'The branch moved: asking again.',
            from: ['waiting'],
          };
    return {
      op: 'settle',
      idx: row.idx,
      state: 'blocked',
      error: a.execution.error ?? 'It was refused.',
      from: ['waiting'],
    };
  }
  if (a.execution.state === 'succeeded' && step.kind === 'open_pull_request') {
    const branch = String((row.output as { branch?: string }).branch ?? '');
    const pr = await openedPr(db, run.burrowId, step.repo, branch);
    return {
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: {
        opened: true,
        prNumber: pr?.number ?? null,
        text: pr ? `PR #${pr.number} is open: ${pr.url}` : 'the pull request is open',
      },
      from: ['waiting'],
    };
  }
  if (a.state === 'pending' && row.deadlineAt && now > row.deadlineAt)
    return {
      op: 'settle',
      idx: row.idx,
      state: 'failed',
      error: 'Nobody decided in time.',
      from: ['waiting'],
    };
  return null;
}

/**
 * Commits on a coding step's branch that its base doesn't have, as GitHub sees them (the runner pushes before the
 * turn ends), and the branch's head then (null when it couldn't be read: AR-46's “the commit the review read”). A
 * string: why the commits couldn't be found out.
 */
async function commitsAhead(
  services: Services,
  ws: RunWorkspace,
): Promise<{ commits: number; head: string | null } | string> {
  const github = services.github.adapter;
  if (!github) return 'GitHub isn’t connected, so the new commits can’t be checked.';
  try {
    if (!(await github.branchExists(ws.repo, ws.branch))) return { commits: 0, head: null };
    const commits = (await github.compare(ws.repo, ws.baseBranch, ws.branch)).length;
    if (!commits) return { commits, head: null };
    const head = await github
      .branchHead(ws.repo, ws.branch, null)
      .then((read) => (read.modified ? read.data : null))
      .catch(() => null);
    return { commits, head };
  } catch (err) {
    return `The commits on ${ws.branch} couldn’t be checked: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * The head of the branch a later step of the run opens its pull request from, as GitHub has it now: what a review
 * step of T3 Code's work approved. Null when no later step opens one; `head` null when GitHub didn't say.
 */
async function reviewedHead(
  services: Services,
  run: AutomationRunRow,
  idx: number,
): Promise<{ head: string | null; committedAt: string | null; commits: string[] } | null> {
  const steps = run.definition.steps;
  const pr = steps.slice(idx + 1).find((s) => s.kind === 'open_pull_request');
  if (pr?.kind !== 'open_pull_request') return null;
  const branch = renderTemplate(
    pr.branch,
    runScope(run, await loadStepRows(services.db, run.id)),
    255,
  ).trim();
  const github = services.github.adapter;
  if (!branch || !github) return { head: null, committedAt: null, commits: [] };
  const head = await github
    .branchHead(pr.repo, branch, null)
    .then((read) => (read.modified ? read.data : null))
    .catch(() => null);
  if (!head) return { head: null, committedAt: null, commits: [] };
  // The branch's commits on GitHub: the one a review names must be among them, and when the head was committed
  // tells a review that names none whether it saw the head.
  const [repo] = await services.db
    .select({ defaultBranch: repos.defaultBranch })
    .from(repos)
    .where(and(eq(repos.burrowId, run.burrowId), eq(repos.fullName, pr.repo)));
  const commits = await github.compare(pr.repo, repo?.defaultBranch ?? 'main', branch).catch(() => []);
  const commit = commits.find((c) => c.sha === head);
  // The committer's date only (TA-57): an amend or a cherry-pick keeps the author's.
  return { head, committedAt: commit?.committedAt ?? null, commits: commits.map((c) => c.sha) };
}

/** The verdict of the agent's last message that starts with one (BP-C27). */
function verdictOf(texts: readonly string[]): AutomationVerdict | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const v = parseVerdict(texts[i] ?? '');
    if (v) return v;
  }
  return null;
}
