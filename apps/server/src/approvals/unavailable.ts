/**
 * The words for actions Whombat can't carry out (docs/decisions/essentials-agents.md EA-03): what an agent reads when
 * it asks for one, and why an old approved one did nothing. Pure text over the engine's registry.
 */
import type { ApprovalAction, ApprovalActionType } from '@whombat/core';

/** Whether an executor is installed for a type (`ApprovalEngine.hasExecutor`). */
export interface ExecutorRegistry {
  hasExecutor(type: ApprovalActionType): boolean;
}

/** What an agent reads when it asks for (or tries) an action nobody here can carry out; null when one can. */
export function unavailableAction(action: ApprovalAction, engine: ExecutorRegistry): string | null {
  if (engine.hasExecutor(action.type)) return null;
  switch (action.type) {
    case 'refund':
      return 'Whombat can’t issue refunds here: no payment system is connected. Ask a person to do it, and say what exactly.';
    case 'message_external':
      return 'Whombat can’t send messages outside this Whombat here: nothing is connected to send them. Ask a person to send it, and say what exactly.';
    case 'deploy':
      return 'perform_action can’t deploy here: Whombat has no deploy workflow for this repository. That is only one way: deploy the way the project is deployed (its README, scripts and the server), with your own commands, such as ssh or rsync to a server you hold a Vault key to. Only when none of your tools reaches it, say exactly what is missing.';
    default:
      return 'Whombat can’t do this here: nothing is set up to carry it out. Ask a person to do it, and say what exactly.';
  }
}

/** Why an approved request of a type nobody can carry out did nothing (the `approval.failed` text's detail). */
export function nothingHappened(action: ApprovalAction): string {
  switch (action.type) {
    case 'refund':
      return 'no payment system is connected to Whombat, so no refund was issued.';
    case 'message_external':
      return 'nothing is connected to Whombat to send it, so no message was sent.';
    case 'deploy':
      return 'no deploy workflow is set up on this Whombat, so nothing was deployed.';
    default:
      return 'nothing on this Whombat carries this out, so nothing happened.';
  }
}

/**
 * `perform_action` runs only what Whombat itself does. A push is the runner's (commit, and Whombat pushes after the
 * turn); a `custom` action names something only the agent can do, so there is nothing to run.
 */
export function notPerformable(action: ApprovalAction): string | null {
  if (action.type === 'push_shared_branch')
    return 'Pushes aren’t actions: commit your work and Whombat pushes it when your turn ends, asking a person first when the branch needs it.';
  if (action.type === 'custom')
    return `Whombat has nothing to run for “${action.params.name}”. If you hold its key, do it yourself; if it needs a person’s yes, ask with request_approval.`;
  return null;
}
