/**
 * The guide tool (docs/decisions/assistant-guides.md AG-01, AG-18; contracts CT-82). Spread into `MCP_TOOLS` (`./mcp`).
 * It carries `personal: true`: listed and callable only in a turn for a person, acting for them (OA-10). It needs no key.
 */
import { z } from 'zod';
import { StartableGuideTopic } from '../domain/guides.js';
import { MessageId } from '../ids.js';
import { commitOutcome } from './errors.js';
import type { McpTool } from './mcp.js';

function personalTool<I extends z.ZodObject, O extends z.ZodType>(
  def: McpTool<I, O> & { personal: true },
): McpTool<I, O> & { personal: true } {
  return def;
}

export const GUIDE_MCP_TOOLS = {
  start_guide: personalTool({
    name: 'start_guide',
    title: 'Start a guide',
    description:
      'Start a guided setup in the person’s Chat with you: welcome (what you can set up), email, calendar or files (connect their account) or google_app (the one-time Google setup). Whombat posts the steps as cards; you don’t repeat them. Use it when they ask to set one up. Never ask for passwords, client secrets or codes in chat: the guide has a secure form.',
    input: z.object({ topic: StartableGuideTopic }),
    output: commitOutcome({ messageId: MessageId.describe('The guide’s first card') }),
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
} as const;
