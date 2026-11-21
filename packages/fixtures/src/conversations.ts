/**
 * The PR #482 branch room and Mara's two rooms with Dusty: her Chat and her (still empty) Feedback room (Whombat
 * one-agent.md OA-04). Every conversation is Mara's with Dusty (one-person.md OP-03).
 */
import type { ChatRoom, Conversation } from '@whombat/core/domain';
import { BURROW_ID } from './burrow.js';
import { at } from './time.js';

export const cnv_pr482: Conversation = {
  id: 'cnv_pr482',
  burrowId: BURROW_ID,
  kind: 'branch',
  slug: 'pr-482',
  title: 'feat/invoice-pdf',
  topic: 'PR #482 · Invoice PDF export · opened by Dusty',
  actions: [{ label: 'Plan canvas', link: { type: 'canvas', slug: 'invoice-pdf-export-plan' } }],
  prNumber: 482,
  repoId: 'rep_billing',
  createdAt: at('10:48'),
  lastMessageAt: at('11:30'),
};

/** Mara's Chat with Dusty: threaded, every top-level message starts a thread (CHT-01). */
export const cnv_dm_dusty: Conversation = {
  id: 'cnv_dm-dusty',
  burrowId: BURROW_ID,
  kind: 'dm',
  slug: 'chat-mara',
  title: 'Chat',
  topic: '',
  actions: [],
  prNumber: null,
  repoId: null,
  createdAt: at('08:00', -14),
  lastMessageAt: at('14:04'),
};

/** Mara's Feedback room: where her website feedback lands (CHT-03). Nothing has arrived yet. */
export const cnv_feedback_mara: Conversation = {
  id: 'cnv_feedback-mara',
  burrowId: BURROW_ID,
  kind: 'dm',
  slug: 'feedback-mara',
  title: 'Feedback',
  topic: '',
  actions: [],
  prNumber: null,
  repoId: null,
  createdAt: at('08:00', -14),
  lastMessageAt: null,
};

export const CONVERSATIONS: Conversation[] = [cnv_pr482, cnv_dm_dusty, cnv_feedback_mara];

export function conversation(id: string): Conversation | undefined {
  return CONVERSATIONS.find((c) => c.id === id);
}

/**
 * Which of a person's rooms a `dm` is (`conversationLink`'s `room`): a `Conversation` doesn't say, so the fixtures know
 * their one Feedback room by id. Undefined for a branch room.
 */
export function roomOf(c: Pick<Conversation, 'id' | 'kind'>): ChatRoom | undefined {
  if (c.kind !== 'dm') return undefined;
  return c.id === cnv_feedback_mara.id ? 'feedback' : 'chat';
}
