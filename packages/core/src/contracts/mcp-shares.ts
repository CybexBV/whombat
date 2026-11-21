/**
 * Sharing a thread by link for the assistant (Whombat docs/decisions/share-links.md). Spread into `MCP_TOOLS`
 * (`./mcp`); `personal: true` (only in a turn for the person). It always asks the person first on a card that says what
 * the link shows and how long it works; on their yes Whombat makes the link and wakes the assistant with it.
 */
import { z } from 'zod';
import { ApprovalId, MessageId } from '../ids.js';
import { ShareExpiry } from '../share/index.js';
import type { McpTool } from './mcp.js';

export const ShareLinkInput = z.object({
  thread: MessageId.optional().describe(
    'The first message of the thread to share; leave out for the thread you are answering in',
  ),
  from: MessageId.optional().describe(
    'Share from this message of the thread on (leave out for the whole thread)',
  ),
  pictures: z.boolean().optional().describe('Keep the pictures in the copy (default true)'),
  expiry: ShareExpiry.optional().describe(
    'How long the link works: 1d, 7d (default), 30d or never. Use what the person asked for',
  ),
});
export type ShareLinkInput = z.infer<typeof ShareLinkInput>;

export const ShareLinkOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending_approval'), approvalId: ApprovalId, message: z.string() }),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['not_here', 'not_found', 'unavailable']),
    message: z.string(),
  }),
]);
export type ShareLinkOutput = z.infer<typeof ShareLinkOutput>;

export const SHARE_MCP_TOOLS = {
  share_link: {
    name: 'share_link',
    title: 'Share a thread by link',
    description:
      'Makes a link anyone can open to read a copy of a thread of the person’s Chat (their words, yours, pictures and charts; never commands, files or approvals). Only when the person asks for a link. Whombat always asks them on a card first; on their yes you are woken with the link: give it to them as it is. The link stops working after 7 days unless they asked for another time, and they can stop it in Settings.',
    input: ShareLinkInput,
    output: ShareLinkOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof ShareLinkInput, typeof ShareLinkOutput> & { personal: true },
} as const;
