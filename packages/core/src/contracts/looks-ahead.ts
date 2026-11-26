/**
 * Looks ahead (Whombat looks-ahead.md): its switch, calendars, incoming mail switch, standing rules, stopped kinds,
 * what it keeps an eye on, recent checks, an on-demand check, and Inbox finding actions (promote to Chat, direct
 * feedback). The person's own.
 */
import { z } from 'zod';
import { Conversation } from '../domain/conversation.js';
import {
  AheadInboxFeedbackBody,
  AheadInboxFeedbackResponse,
  AheadPromoteBody,
  LooksAheadCheckNowResult,
  LooksAheadUpdate,
  LooksAheadView,
} from '../domain/looks-ahead.js';
import { Message } from '../domain/message.js';
import { AheadCheckId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });
const FindingParams = B.extend({ checkId: AheadCheckId });

export const AheadPromoteResponse = z.object({ conversation: Conversation, message: Message });
export type AheadPromoteResponse = z.infer<typeof AheadPromoteResponse>;

export const looksAheadEndpoints = {
  get: endpoint({
    id: 'looksAhead.get',
    method: 'GET',
    path: '/burrows/:burrow/looks-ahead',
    summary:
      'Looks ahead: whether the assistant checks upcoming plans and incoming mail, which calendars, standing rules, stopped kinds, what it keeps an eye on, the last week and recent checks.',
    params: B,
    response: LooksAheadView,
  }),
  update: endpoint({
    id: 'looksAhead.update',
    method: 'PUT',
    path: '/burrows/:burrow/looks-ahead',
    summary:
      'Switch Looks ahead, incoming mail, a calendar or a kind of finding on or off, add/remove a standing rule, or stop keeping an eye on something. The person’s own.',
    params: B,
    body: LooksAheadUpdate,
    response: LooksAheadView,
  }),
  checkNow: endpoint({
    id: 'looksAhead.checkNow',
    method: 'POST',
    path: '/burrows/:burrow/looks-ahead/check',
    summary: 'Run one Looks ahead pass right now (fresh calendar and mail read) and return the updated view.',
    params: B,
    body: z.strictObject({}),
    response: LooksAheadCheckNowResult,
  }),
  promote: endpoint({
    id: 'looksAhead.promote',
    method: 'POST',
    path: '/burrows/:burrow/looks-ahead/findings/:checkId/promote',
    summary:
      'Open a Looks ahead Inbox finding as a thread in Chat, optionally posting the person’s reply or one-tap action to wake the assistant.',
    params: FindingParams,
    body: AheadPromoteBody,
    response: AheadPromoteResponse,
  }),
  feedback: endpoint({
    id: 'looksAhead.feedback',
    method: 'POST',
    path: '/burrows/:burrow/looks-ahead/findings/:checkId/feedback',
    summary:
      'Mark a Looks ahead Inbox finding as not useful or stop checking for that kind (or matter) directly from the Inbox.',
    params: FindingParams,
    body: AheadInboxFeedbackBody,
    response: AheadInboxFeedbackResponse,
  }),
};
