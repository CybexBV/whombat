/**
 * What the runner does with a turn's checkout: it pushes what the agent committed (the server decides whether its key
 * allows it) and tells the server what it did and what went wrong (`WorkspaceReport`, run-checkout.md RC-09).
 */

import type { WorkspaceProblem, WorkspaceReport } from '@whombat/core';
import { pushIfAhead } from '../workspace';
import type { TurnScope } from './scope';

export class TurnCheckout {
  /** Pushes of the workspace branch during and after the turn (coding turns). */
  readonly pushes: string[] = [];
  readonly #report: WorkspaceReport = { pushedCommits: 0, problems: [] };
  readonly #turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'resources'>;

  constructor(turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'resources'>) {
    this.#turn = turn;
  }

  /** Pushes what the agent committed (the server decides whether its key allows it). */
  async push(when: string): Promise<void> {
    const { ctx, deps, id, resources } = this.#turn;
    const git = resources.prepared?.git;
    // A read-only checkout (an automation's review or investigation) is never pushed from.
    if (!git || ctx.workspace?.access === 'read') return;
    // Git's control files back as they were before the runner's git reads them (AC-22).
    const planted = (await resources.commands?.beforeRunnerGit()) ?? [];
    if (planted.length) {
      this.#problem('push', `Git’s settings couldn’t be restored, so nothing was pushed: ${planted[0]}`);
      return;
    }
    const res = await pushIfAhead(git);
    if (res.status === 'nothing') return;
    if (res.status === 'pushed') this.#report.pushedCommits += res.commits;
    // Waiting on a person's yes is no problem: the approval card says so.
    else if (res.status !== 'pending_approval') this.#problem('push', res.message);
    const line =
      res.status === 'pushed' ? `pushed ${res.commits} commit(s) ${when}` : `${res.status}: ${res.message}`;
    this.pushes.push(line);
    deps.log(res.status === 'pushed' ? 'info' : 'warn', `${ctx.agent.name} · ${line}`, { dispatchId: id });
  }

  /** A turn that is done: what the agent committed is pushed. */
  async afterTurn(): Promise<void> {
    const { deps, id, resources } = this.#turn;
    await this.push('after the turn').catch((err) => {
      deps.log('warn', 'push failed', { dispatchId: id, err: String(err) });
      this.#problem('push', String(err));
    });
    const { prepared } = resources;
    if (prepared?.problem) this.#problem('checkout', prepared.problem);
  }

  /** What the completion says of the checkout: for a turn that has one, or should have had one. */
  report(): { workspace?: WorkspaceReport } {
    const { prepared } = this.#turn.resources;
    return prepared?.git || prepared?.problem ? { workspace: this.#report } : {};
  }

  #problem(step: WorkspaceProblem['step'], message: string): void {
    if (this.#report.problems.length < 5)
      this.#report.problems.push({ step, message: message.slice(0, 500) });
  }
}
