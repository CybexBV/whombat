/**
 * Deep links. Receipts, audit events, search results, notifications and conversation actions all point
 * somewhere with a `LinkRef`; `linkPath()` turns it into the web route (ARCHITECTURE "Web app" routes).
 */
import { z } from 'zod';
import { ConversationId, EventId, MessageId, PlanId, StepId } from '../ids.js';
import { Handle, RepoFullName } from './common.js';

/**
 * A person's own room with the agent (Whombat one-agent.md OA-04): their Chat (`/:burrow/chat`, the default) or their
 * Feedback room (`/:burrow/feedback`).
 */
export const DmLink = z.object({ type: z.literal('dm'), room: z.enum(['chat', 'feedback']).optional() });
export const PrLink = z.object({
  type: z.literal('pr'),
  number: z.number().int().positive(),
  /**
   * The branch room's repository (`owner/name`, 0.26, CT-170): a PR number is unique only within its repo. Every link
   * the runtime makes to a branch room carries it; absent on older links (the web then asks which room when the
   * number is ambiguous).
   */
  repo: RepoFullName.optional(),
  tab: z.enum(['conversation', 'files']).optional(),
});
/**
 * A task chat with the person's Whombat (0.80.1, CT-348; Whombat one-whombat.md ONE-06): `/:burrow/chats/:id`. A link
 * to a DM that is a task chat is this, so it opens that chat and not the default one (`DmLink` names only the agent).
 */
export const ChatLink = z.object({ type: z.literal('chat'), id: ConversationId });

/** Where a conversation lives: a person's room with the agent, a branch room (PR) or a task chat. */
export const ConversationLink = z.discriminatedUnion('type', [DmLink, PrLink, ChatLink]);
export type ConversationLink = z.infer<typeof ConversationLink>;

export const MessageLink = z.object({
  type: z.literal('message'),
  in: ConversationLink,
  messageId: MessageId,
  /** Open the thread pane on this root. */
  threadRootId: MessageId.optional(),
});
export const RunLink = z.object({ type: z.literal('run'), number: z.number().int().positive() });
export const ApprovalLink = z.object({
  type: z.literal('approval'),
  number: z.number().int().positive(),
  /** Page the modal opens over; defaults to the approval's conversation. */
  in: ConversationLink.optional(),
});
/** Settings → Agent (OA-09): `/:burrow/settings/agent`. */
export const AgentLink = z.object({ type: z.literal('agent') });
export const CanvasLink = z.object({ type: z.literal('canvas'), slug: z.string().min(1) });
export const LogLink = z.object({
  type: z.literal('log'),
  eventId: EventId.optional(),
  who: Handle.optional(),
});
export const SearchLink = z.object({
  type: z.literal('search'),
  q: z.string(),
  filter: z.string().optional(),
});
/**
 * A page of the app by its path (`/reports/<id>`): it opens wherever the person uses Whombat (the hosted app, a box's own
 * address, the phone), where an address would name one of them.
 */
export const AppPagePath = z
  .string()
  .max(2048)
  .regex(/^\/(?![/\\])\S*$/, 'A path of the app, starting with one /');
/** A web page by its address, or a page of the app by its path (`AppPagePath`). */
export const ExternalLink = z.object({ type: z.literal('external'), url: z.union([z.url(), AppPagePath]) });
/** A plan in its conversation's plan pane (`?plan=`), optionally one step (`&step=`); work-supervision WS-09. */
export const PlanLink = z.object({
  type: z.literal('plan'),
  planId: PlanId,
  in: ConversationLink,
  stepId: StepId.optional(),
});
/** An automation run's page (`/:burrow/automation-runs/:number`). */
export const AutomationRunLink = z.object({
  type: z.literal('automation_run'),
  number: z.number().int().positive(),
});
/** `WorkLink.section` of Work · Deploys (`/:burrow/work/deploys`, 0.55, CT-296). */
export const DEPLOYS_SECTION = 'deploys';

/** The Work view (`/:burrow/work`, WS-18), optionally one section. */
export const WorkLink = z.object({ type: z.literal('work'), section: z.string().max(20).optional() });

export const LinkRef = z.discriminatedUnion('type', [
  DmLink,
  PrLink,
  ChatLink,
  MessageLink,
  RunLink,
  ApprovalLink,
  AgentLink,
  CanvasLink,
  LogLink,
  SearchLink,
  ExternalLink,
  PlanLink,
  AutomationRunLink,
  WorkLink,
]);
export type LinkRef = z.infer<typeof LinkRef>;

function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** `base` with more query parameters (`?` or `&` as `base` needs). */
function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const q = query(params);
  return q ? `${base}${base.includes('?') ? '&' : '?'}${q.slice(1)}` : base;
}

/** `owner/name` as a query value: encoded, with the slash kept readable (`?repo=acme/Whombat`). */
function repoParam(repo: string): string {
  return encodeURIComponent(repo).replace(/%2F/gi, '/');
}

function conversationPath(burrow: string, link: ConversationLink): string {
  switch (link.type) {
    case 'dm':
      return `/${burrow}/${link.room ?? 'chat'}`;
    case 'pr': {
      const params = [
        ...(link.repo ? [`repo=${repoParam(link.repo)}`] : []),
        ...(link.tab === 'files' ? ['tab=files'] : []),
      ];
      return `/${burrow}/pr/${link.number}${params.length ? `?${params.join('&')}` : ''}`;
    }
    case 'chat':
      return `/${burrow}/chats/${encodeURIComponent(link.id)}`;
  }
}

/**
 * Web route for a link inside a burrow (`burrow` is the burrow slug). External links return their URL.
 * `fallbackApprovalIn` is used for approval links without `in`.
 */
export function linkPath(burrow: string, link: LinkRef, fallbackApprovalIn?: ConversationLink): string {
  switch (link.type) {
    case 'dm':
    case 'pr':
    case 'chat':
      return conversationPath(burrow, link);
    case 'message': {
      const base = conversationPath(burrow, {
        ...link.in,
        ...(link.in.type === 'pr' ? { tab: undefined } : {}),
      });
      if (link.threadRootId) return withQuery(base, { thread: link.threadRootId });
      return `${base}#${link.messageId}`;
    }
    case 'run':
      return `/${burrow}/runs/${link.number}`;
    case 'approval': {
      const where = link.in ?? fallbackApprovalIn;
      const base = where ? conversationPath(burrow, where) : `/${burrow}/log`;
      return withQuery(base, { approval: link.number });
    }
    case 'agent':
      return `/${burrow}/settings/agent`;
    case 'canvas':
      return `/${burrow}/canvases/${encodeURIComponent(link.slug)}`;
    case 'log':
      return `/${burrow}/log${query({ who: link.who, open: link.eventId })}`;
    case 'search':
      return `/${burrow}/search${query({ q: link.q, type: link.filter })}`;
    case 'external':
      return link.url;
    case 'plan': {
      const base = conversationPath(burrow, {
        ...link.in,
        ...(link.in.type === 'pr' ? { tab: undefined } : {}),
      });
      return withQuery(base, { plan: link.planId, step: link.stepId });
    }
    case 'automation_run':
      return `/${burrow}/automation-runs/${link.number}`;
    case 'work':
      // Work · Deploys is its own page (0.55, CT-296, Whombat WE-17).
      if (link.section === DEPLOYS_SECTION) return `/${burrow}/work/deploys`;
      return `/${burrow}/work${query({ section: link.section })}`;
  }
}
