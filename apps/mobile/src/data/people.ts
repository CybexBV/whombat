/**
 * Principal lookups and the approval-view context, built from the bootstrap. A Whombat has one agent (Whombat
 * one-agent.md OA-01): `People.agent` is it (`theAgentOf`, never one of Whombat's own signers). Pure.
 */
import { automationAsker, namesWithAsker, theAgentOf } from '@whombat/client';
import {
  type Approval,
  type ApprovalViewContext,
  type Bootstrap,
  type ConversationSummary,
  conversationLabel,
  type Decider,
  type Principal,
  shortNameOf,
} from '@whombat/core';

export type AgentPrincipal = Extract<Principal, { kind: 'agent' }>;

export interface People {
  byId: ReadonlyMap<string, Principal>;
  get(id: string | null | undefined): Principal | undefined;
  /** Name for copy: the person's full name ("Mara Okafor") or the agent name. */
  name(id: string | null | undefined): string;
  /** The Whombat's agent (OA-01), once the bootstrap has it. */
  agent: AgentPrincipal | undefined;
  byHandle(handle: string): Principal | undefined;
}

export function peopleFrom(principals: readonly Principal[]): People {
  const byId = new Map(principals.map((p) => [p.id, p]));
  const byHandle = new Map(principals.map((p) => [p.handle, p]));
  return {
    byId,
    get: (id) => (id ? byId.get(id) : undefined),
    name: (id) => (id ? (byId.get(id)?.name ?? 'Someone') : 'Someone'),
    agent: theAgentOf(principals),
    byHandle: (handle) => byHandle.get(handle),
  };
}

/** The person, who decides everything on their Whombat (one-person-android.md AP-5734). */
export function viewerOf(bootstrap: Pick<Bootstrap, 'me'>): Decider {
  return { id: bootstrap.me.id, kind: 'person' };
}

/** Every conversation the sidebar knows, by id: the person's Chat and Feedback room, and the branch rooms. */
export function conversationsById(bootstrap: Pick<Bootstrap, 'sidebar'>): Map<string, ConversationSummary> {
  const { branchRooms, dms } = bootstrap.sidebar;
  return new Map([...branchRooms, ...dms].map((c) => [c.id, c]));
}

/** A conversation's title (“PR #482”, “Chat”) for a conversation id, when the viewer can see it. */
export function whereOf(bootstrap: Pick<Bootstrap, 'sidebar'>, conversationId: string): string | undefined {
  const c = conversationsById(bootstrap).get(conversationId);
  return c ? conversationLabel(c) : undefined;
}

export interface ViewContext {
  people: People;
  viewer: Decider;
  now: Date;
  timeZone: string;
}

/**
 * The approval-view context for one request on the phone's lists and screens. An automation asking is “The automation”
 * in the sentences, not its principal's name (AP-999).
 */
export function approvalContext(
  ctx: ViewContext,
  approval: Pick<Approval, 'action' | 'requesterId'>,
  where?: string,
): ApprovalViewContext {
  const names: ApprovalViewContext['names'] = (id) => {
    const p = ctx.people.get(id);
    return p ? { name: p.name, shortName: shortNameOf(p) } : undefined;
  };
  const asker = automationAsker(approval, ctx.people.get(approval.requesterId));
  return {
    names: namesWithAsker(names, approval.requesterId, asker),
    viewer: ctx.viewer,
    now: ctx.now,
    timeZone: ctx.timeZone,
    where,
  };
}
