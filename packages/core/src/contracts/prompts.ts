/**
 * The person's prompts (Whombat docs/decisions/prompts.md): the list Chat offers after `/` and Settings shows, keeping
 * and changing one, the T3 Code projects one can run on, and using one, which posts the person's message in Chat and
 * has the agent hand the prompt's words to a new T3 Code thread in the project. Session ops too (`prompts.*`); a
 * Whombat without them answers `unknown_op`, and the apps then show no prompts.
 */
import { z } from 'zod';
import { PROMPT_TEXT_MAX, PROMPT_TITLE_MAX, Prompt, PromptAi, PromptId } from '../domain/prompts.js';
import { ConversationId, MessageId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const PromptsResponse = z.object({ prompts: z.array(Prompt) });
export type PromptsResponse = z.infer<typeof PromptsResponse>;

/** A prompt's words as the person keeps them. */
export const SavePromptBody = z.strictObject({
  title: z.string().trim().min(1).max(PROMPT_TITLE_MAX),
  text: z.string().trim().min(1).max(PROMPT_TEXT_MAX),
  onRepository: z.boolean(),
  ownIt: z.boolean(),
  /** Absent (an app from before it): the prompt keeps what it had. */
  merge: z.boolean().optional(),
  ai: PromptAi.nullable(),
});
export type SavePromptBody = z.infer<typeof SavePromptBody>;

export const PromptResponse = z.object({ prompt: Prompt });
export type PromptResponse = z.infer<typeof PromptResponse>;

/** A project of T3 Code a prompt can run on. */
export const PromptProject = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(200),
  /** Its folder on the person's computer, when T3 Code says. */
  folder: z.string().max(400).nullable(),
});
export type PromptProject = z.infer<typeof PromptProject>;

/**
 * T3 Code's projects by title (null when it isn't connected at Manage or can't be reached; `t3` says which). The apps
 * put those a prompt ran on first, from its `runs`.
 */
export const PromptProjectsResponse = z.object({
  projects: z.array(PromptProject).nullable(),
  t3: z.enum(['ready', 'not_connected', 'unreachable']),
});
export type PromptProjectsResponse = z.infer<typeof PromptProjectsResponse>;

/**
 * Use a prompt on a project: in `conversationId` (the person's Chat), as a new thread or, with `rootId`, as a reply in
 * that thread.
 */
export const UsePromptBody = z.strictObject({
  conversationId: ConversationId,
  rootId: MessageId.optional(),
  project: z.strictObject({ id: z.string().min(1).max(200), title: z.string().trim().min(1).max(200) }),
});
export type UsePromptBody = z.infer<typeof UsePromptBody>;

/** The message posted for the person, and the thread it is in (itself when it started one). */
export const UsePromptResponse = z.object({ messageId: MessageId, rootId: MessageId });
export type UsePromptResponse = z.infer<typeof UsePromptResponse>;

export const promptEndpoints = {
  list: endpoint({
    id: 'prompts.list',
    method: 'GET',
    path: '/burrows/:burrow/prompts',
    summary:
      'The caller’s prompts in the order Chat offers them: the ones Whombat shipped that they kept, then their own, each with where it ran.',
    params: B,
    response: PromptsResponse,
  }),
  create: endpoint({
    id: 'prompts.create',
    method: 'POST',
    path: '/burrows/:burrow/prompts',
    summary: 'Keep words as a prompt, under a title.',
    params: B,
    body: SavePromptBody,
    response: PromptResponse,
    status: 201,
  }),
  save: endpoint({
    id: 'prompts.save',
    method: 'PUT',
    path: '/burrows/:burrow/prompts/:promptId',
    summary:
      'Change a prompt: its title, its words, whether it is for a repository, and the AI its thread runs on.',
    params: B.extend({ promptId: PromptId }),
    body: SavePromptBody,
    response: PromptResponse,
  }),
  remove: endpoint({
    id: 'prompts.remove',
    method: 'DELETE',
    path: '/burrows/:burrow/prompts/:promptId',
    summary:
      'Remove a prompt from the list. One Whombat shipped stays away until the shipped prompts are brought back.',
    params: B.extend({ promptId: PromptId }),
    response: PromptsResponse,
  }),
  restore: endpoint({
    id: 'prompts.restore',
    method: 'POST',
    path: '/burrows/:burrow/prompts/restore',
    summary:
      'Bring back the prompts Whombat shipped, as shipped: the removed ones return and changed ones get their words back. The caller’s own prompts stay.',
    params: B,
    body: z.strictObject({}),
    response: PromptsResponse,
  }),
  projects: endpoint({
    id: 'prompts.projects',
    method: 'GET',
    path: '/burrows/:burrow/prompts/projects',
    summary: 'The projects of T3 Code a prompt can run on, by title.',
    params: B,
    response: PromptProjectsResponse,
  }),
  use: endpoint({
    id: 'prompts.use',
    method: 'POST',
    path: '/burrows/:burrow/prompts/:promptId/use',
    summary:
      'Use a prompt on a project of T3 Code: posts the caller’s message in their Chat (“<title> · <project>”) and has the agent start a T3 Code thread in the project with the prompt’s words as they are.',
    params: B.extend({ promptId: PromptId }),
    body: UsePromptBody,
    response: UsePromptResponse,
    status: 201,
  }),
} as const;
