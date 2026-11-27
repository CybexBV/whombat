/**
 * Where code work goes in a turn's preface (Whombat docs/decisions/t3code.md): with T3 Code connected at Manage, the
 * person's coding agents on their own computer do it. Building, fixing bugs and looking into code is handed to a T3
 * Code thread: work that continues what a thread of this Whombat thread did goes to that same thread, which keeps what
 * it learned and its worktree, anything else to a new one; a repository T3 Code lacks is cloned into it first, and gh
 * and GitHub are for GitHub itself. In a turn the person's own message started Whombat adds their words to the brief,
 * so the agent doesn't retell them. In the person's turns the agent waits a minute or two at most: Whombat wakes it
 * when the thread finishes or asks, and it settles a thread it started once the job is finished. Nothing without a T3
 * Code connection, or with one that looks only (the person chose that).
 */
import type { DispatchContext } from '@whombat/core/contracts';
import { T3_HANDOFFS_HEADING } from '@whombat/core/domain';
import { defuseDelimiters } from './defuse';

type Connections = Pick<DispatchContext, 'connections'> &
  Partial<Pick<DispatchContext, 'outside' | 't3Handoffs' | 't3PersonWords'>> & {
    dispatch?: Pick<DispatchContext['dispatch'], 'trigger'>;
  };

/** The T3 Code connection code work goes to: the first one at Manage, active or needing signing in again. */
export function codeConnection(ctx: Connections) {
  const t3 = (ctx.connections ?? []).filter((c) => c.catalogId === 't3code' && c.access !== 'read');
  return t3.find((c) => c.status === 'active') ?? t3[0] ?? null;
}

/** Whether code work goes to T3 Code in this turn (an active connection at Manage). */
export function codeGoesToT3(ctx: Connections): boolean {
  return codeConnection(ctx)?.status === 'active';
}

export function codeLines(ctx: Connections): string[] {
  const t3 = codeConnection(ctx);
  if (!t3) return [];
  if (t3.status !== 'active')
    return [
      `Code work goes to T3 Code (${t3.handle}), which can’t be reached now: say so before anything else, and do code work here only when the person asks.`,
    ];
  // A turn on a customer's report (outsiders-turns.md OT-11) or an automation's step has no schedule: it waits for the
  // thread itself. A step's reply is what its automation goes on with, so “T3 Code is on it” can't be its last word.
  const long = ctx.outside
    ? 'Wait for it in this turn, however long it takes: work from outside can’t schedule.'
    : ctx.dispatch?.trigger === 'automation'
      ? 'Wait for it in this turn, however long it takes, and reply once it is done: the automation goes on with your reply and can’t schedule.'
      : 'Wait only a minute or two: when it takes longer, end your turn, as Whombat wakes you in this thread when it finishes or asks something (never schedule a turn for it).';
  // The person's words reach the thread unchanged (the server says when), so the brief holds only what they left out.
  const brief = ctx.t3PersonWords
    ? 'Whombat adds what the person wrote in this turn to your message, word for word, so don’t retell it: write only what they couldn’t know or didn’t say here (which project, what earlier messages settled, what done means).'
    : 'Your message says what to do and what done means.';
  // In the person's own turns Whombat posts the thread's report in the chat itself when it ends, so the agent's line
  // promises only that; a turn that waits for its thread itself reports the result in its own reply.
  const onIt =
    ctx.outside || ctx.dispatch?.trigger === 'automation'
      ? 'Say in a line that T3 Code is on it (the thread by its title), and wait with t3_thread_wait.'
      : 'Say in one line only that T3 Code is on it (the thread by its title) and that its report appears in this thread when it is done; promise no updates in between. Then wait with t3_thread_wait.';
  // Whombat settles a step's and an outside turn's threads itself once the turn is over; in the person's turns only the
  // agent knows when the job is finished, so it settles the thread then.
  const settle =
    ctx.outside || ctx.dispatch?.trigger === 'automation'
      ? ''
      : ' Once the job you handed a thread you started is finished (done, and it waits for no build, deploy, pull request or answer), settle that thread: t3_thread_organize {threadId, action "settle"}. Not before, and never the person’s own threads.';
  const threads = (ctx.t3Handoffs ?? []).filter((h) => h.connection === t3.handle);
  return [
    `Code work goes to T3 Code (${t3.handle}, its tools through connection_call), the person’s coding agents: building, fixing bugs and looking into code, every time. Work that continues what a T3 Code thread of this thread did (a fix after its look, a correction, “also do …”, a question about what it did) goes to that same thread with t3_thread_send, also once it ended: it keeps what it learned and its worktree, and one that only looked may change things when you say so and how to finish (its repository’s own instructions say how). Anything else, or when that thread is gone, gets a new thread: find the project with t3_project_list (by its title or folder); a repository it doesn’t have yet you clone beside its other projects (t3_project_clone, then t3_project_create); then t3_thread_launch (for a question, to look and answer without changing anything, in a worktree of its own and with runtimeMode "full-access" — never "approval-required", which stalls on its first command when nobody is there to approve it). ${brief} ${onIt} ${long}${settle} Never a run, a checkout or a clone of your own for it.`,
    ...(threads.length
      ? [
          `${T3_HANDOFFS_HEADING}, newest first: ${threads
            .map(
              (h) =>
                `“${defuseDelimiters(h.title)}” threadId ${h.threadId} (${h.state === 'working' ? 'at work' : 'ended'})`,
            )
            .join('; ')}.`,
        ]
      : []),
  ];
}

/**
 * Goal-carrying guidance when a person's turn is in the thread of a finished report automation run whose fix did not
 * land yet: reminds the assistant to finish landing it and call `automation_continue_run` once T3 Code pushes.
 */
export function unlandedFixLines(
  ctx: Partial<Pick<DispatchContext, 'outside' | 'unlandedFix'>> & {
    dispatch?: Pick<DispatchContext['dispatch'], 'trigger'>;
  },
): string[] {
  const u = ctx.unlandedFix;
  if (!u || ctx.outside || ctx.dispatch?.trigger === 'automation') return [];
  const where = u.repo ? ` in ${defuseDelimiters(u.repo)}` : '';
  const onBranch = u.branch ? ` on ${defuseDelimiters(u.branch)}` : '';
  const finish = u.merges
    ? 'review passes, Whombat opens and merges the pull request, and the fix ships'
    : 'review passes and Whombat opens the pull request';
  return [
    `This thread’s report automation run (#${u.runNumber}, runId ${u.runId}, ${defuseDelimiters(u.connection)} #${u.reportNumber}${where}${onBranch}) stopped before its fix landed: ${defuseDelimiters(u.reason)} The goal is to finish landing it (${finish}), not stop after pushing commits. Send follow-up work to the T3 Code thread this run’s look or fix used (t3_thread_send, among the threads listed above), never a new one: the run’s review reads only the threads its report started. Once T3 Code has pushed the fix and finished its review, call automation_continue_run with runId "${u.runId}", fromStepId "${u.nextStepId}", and a short note summarizing what changed and that the branch was pushed, so Whombat runs the remaining steps instead of improvising timers or stopping early.`,
  ];
}
