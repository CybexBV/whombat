/**
 * `show_pages` (Whombat docs/decisions/page-sets.md): the agent shows the person a folder of pages — mockups, a report,
 * screenshots with captions, a small static site — as one file on a message, which the person opens and clicks through
 * in Whombat wherever they are. Spread into `MCP_TOOLS` (`./mcp`).
 */
import { z } from 'zod';
import { Count } from '../domain/common.js';
import { AttachmentId, MessageId } from '../ids.js';
import {
  PAGES_DEFAULT_OPEN,
  PAGES_MAX_BYTES,
  PAGES_MAX_FILES,
  PAGES_MAX_PROBLEMS,
  PAGES_TITLE_MAX,
} from '../text/pages.js';
import type { McpTool } from './mcp.js';

export const SHOW_PAGES_TOOL = 'show_pages';

export const ShowPagesInput = z.object({
  folder: z
    .string()
    .min(1)
    .max(500)
    .describe('The folder, in your working directory (like mockups or site/dist)'),
  open: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe(`The page it opens on, in the folder (default ${PAGES_DEFAULT_OPEN})`),
  title: z.string().min(1).max(PAGES_TITLE_MAX).describe('What it is, in a few words'),
  replaces: AttachmentId.optional().describe('Your earlier set in this conversation that this one replaces'),
});
export type ShowPagesInput = z.input<typeof ShowPagesInput>;

/**
 * `show_pages`' answer: the set's file (for `post_message` `attachmentIds`, or on the message it replaced, `messageId`),
 * what is in it, and the links its check found broken; the picture of its first page travels beside it as MCP image
 * content. Or why not.
 */
export const ShowPagesOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    attachmentId: AttachmentId,
    name: z.string().max(255),
    files: Count,
    pages: Count,
    bytes: Count,
    problems: z.array(z.string().max(300)).max(PAGES_MAX_PROBLEMS),
    /** The message whose set it replaced (`replaces`): it is there already, nothing to post. */
    messageId: MessageId.optional(),
  }),
  z.object({ status: z.enum(['refused', 'failed']), reason: z.string().max(500) }),
]);
export type ShowPagesOutput = z.infer<typeof ShowPagesOutput>;

export const PAGES_MCP_TOOLS = {
  show_pages: {
    name: SHOW_PAGES_TOOL,
    title: 'Show pages',
    description: `Show the person a folder of pages: mockups, a report, screenshots with captions, a small static site. It becomes one file with a picture of its first page; they open it and click through its pages in Whombat, on the web and the phone, at home or away. Pages may link each other and use the folder's pictures, styles, scripts and fonts; nothing loads from the internet. Up to ${PAGES_MAX_FILES} files and ${PAGES_MAX_BYTES / 1024 / 1024} MB. Fix the problems it reports and show it again, then post it (attachmentIds) with a sentence on what it is; with replaces it takes that set's place on its message instead. Use this rather than a web server for anything to look at.`,
    input: ShowPagesInput,
    output: ShowPagesOutput,
    requiredKey: null,
    // It keeps a file in the conversation.
    readOnly: false,
  } satisfies McpTool<typeof ShowPagesInput, typeof ShowPagesOutput>,
} as const;
