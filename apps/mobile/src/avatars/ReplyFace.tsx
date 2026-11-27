/**
 * The face beside the assistant's newest message in Chat: it shows what the assistant does about the next reply
 * (thinking, at work once it does something, sorry when the reply failed). Every other message's face is the still one.
 * A face too small to move (`faceAllowance`) is the still one too, and then nothing here listens for typing.
 */
import { faceAllowance } from '@whombat/avatars/motion';
import { agentFaceOf, agentNowFor, isAutomationPrincipal } from '@whombat/client';
import { useAgentNow, useTyping } from '@whombat/client/react';
import type { Principal } from '@whombat/core';
import { PrincipalAvatar } from './Avatars';
import { replyFaceState } from './faceEngine';
import { LiveFace } from './LiveFace';

/** Where the reply is being worked on: the conversation and the thread (null: its top level). */
export interface ReplyPlace {
  conversationId: string;
  threadRootId: string | null;
}

export function ReplyFace({
  principal,
  size,
  live,
  failed,
}: {
  principal: Principal | null | undefined;
  size: number;
  /** Set on the assistant's newest message only. */
  live: ReplyPlace | null;
  /** The message is a reply that failed. */
  failed: boolean;
}) {
  const agent = principal?.kind === 'agent' && !isAutomationPrincipal(principal) ? principal : null;
  if (!live || !agent || !faceAllowance(size, 'full').live)
    return <PrincipalAvatar principal={principal} size={size} />;
  return <LiveReplyFace agent={agent} size={size} place={live} failed={failed} />;
}

function LiveReplyFace({
  agent,
  size,
  place,
  failed,
}: {
  agent: Extract<Principal, { kind: 'agent' }>;
  size: number;
  place: ReplyPlace;
  failed: boolean;
}) {
  const { typing } = useTyping(place.conversationId, place.threadRootId);
  const agentNow = useAgentNow(place.conversationId);
  const thinking = typing.some((t) => t.principalId === agent.id);
  const acting = !!agentNowFor(agentNow, agent.id, place.threadRootId, Date.now())?.title.trim();
  const state = replyFaceState({ typing: thinking, acting, failed });
  return <LiveFace face={agentFaceOf(agent)} size={size} state={state} />;
}
