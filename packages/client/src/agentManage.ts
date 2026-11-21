/**
 * Whether the agent can be changed — its keys, its notes (Whombat one-agent.md OA-09; app one-agent.md AP-4902): the
 * person may change the agent (one-person.md OP-01); nobody changes a system actor. The server decides; clients use
 * this to leave out what it would refuse (“Always allow {Agent} to …” on an approval card). Shared by the web and the
 * phone.
 */
import {
  type Approval,
  type ApprovalAction,
  type ApprovalViewContext,
  alwaysAllowRow,
  approvalView,
  type CommandScope,
} from '@whombat/core';

/** What `canManageAgent` reads of the agent: a system actor (GitHub, automations, OA-17) is nobody's to change. */
export interface ManagedAgent {
  kind: string;
}

export function canManageAgent(agent: ManagedAgent | undefined): boolean {
  return agent?.kind === 'agent';
}

/**
 * Whether an approval card offers “Always allow” the requesting agent a risk row (RA-06, RA-DC08): for the agent, never
 * a system actor.
 */
export function canAlwaysAllow(action: ApprovalAction, agent: ManagedAgent | undefined): boolean {
  return alwaysAllowRow(action) !== null && canManageAgent(agent);
}

/**
 * What a yes says, as far as it went (AC-42, GF-05, RA-06): core's toast for the approval decided with `scope` — “Allowed
 * for this task. …” for a command, “Approved. From now on Banjo may merge into main without asking.” for “Always allow”
 * on a risk-row card (`toasts.always`).
 */
export function approveToastFor(
  approval: Approval,
  scope: CommandScope | undefined,
  ctx: ApprovalViewContext,
): string {
  if (scope === 'agent' && alwaysAllowRow(approval.action)) {
    const view = approvalView(approval, ctx);
    return view.toasts.always ?? view.toasts.approve;
  }
  // “Don’t ask again on The Titan” (Whombat server-asks.md SA-07): “Approved. Whombat won’t ask again on The Titan.”
  if (scope === 'agent' && stopAskingServer(approval.action)) {
    const view = approvalView(approval, ctx);
    return view.toasts.always ?? view.toasts.approve;
  }
  return approvalView(scope ? { ...approval, scope } : approval, ctx).toasts.approve;
}

/**
 * The server a Servers approval may stop asking on (Whombat server-asks.md SA-07; contracts CT-381): the Whombat names
 * it on a `connection_call` that asks only for the Servers catalog's sensitive rules. Null otherwise.
 */
export function stopAskingServer(action: ApprovalAction): { id: string; name: string } | null {
  return action.type === 'connection_call' ? (action.params.server ?? null) : null;
}
