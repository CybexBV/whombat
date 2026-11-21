/**
 * `connection_look` (Whombat docs/decisions/connection-looks.md): the assistant gives a Custom connection its logo and its
 * page. Without `save` it only tries: Whombat fetches the logo, reads what the page recipe names and answers with what
 * the page would show and what is wrong; with `save` it keeps them. The recipe's shape is `ConnectionPage`
 * (`domain/connection-page.ts`), checked on the server and explained in the `whombat:connection-pages` skill, so the
 * tool's own schema stays small.
 */
import { z } from 'zod';
import { ConnectionId } from '../ids.js';
import type { McpTool } from './mcp.js';

export const ConnectionLookInput = z.object({
  /** The connection's id (`con_…`) or its name. */
  connection: z.string().trim().min(1).max(120),
  /** An https address of the service's logo as an SVG, or `none` for the generic mark again. */
  logo: z.string().trim().min(1).max(500).optional(),
  /** The page recipe (the skill's format); null removes the page. */
  page: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Keep the logo and the page; without it, Whombat only tries them and says what they would show. */
  save: z.boolean().optional(),
});
export type ConnectionLookInput = z.input<typeof ConnectionLookInput>;

export const ConnectionLookOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    connectionId: ConnectionId,
    saved: z.boolean(),
    /** The logo it found: where it came from and how many shapes it has; null for the generic mark. */
    logo: z.object({ from: z.string(), shapes: z.number().int() }).nullable().optional(),
    /** What the page would show, a line per part (“Live · Charging now: Model 3 — 64 %”), and what is wrong. */
    page: z
      .object({ shows: z.array(z.string()), problems: z.array(z.string()) })
      .nullable()
      .optional(),
  }),
  z.object({
    status: z.literal('refused'),
    reason: z.enum(['not_found', 'not_custom', 'invalid', 'logo', 'page', 'not_here']),
    message: z.string(),
  }),
]);
export type ConnectionLookOutput = z.infer<typeof ConnectionLookOutput>;

export const CONNECTION_LOOK_MCP_TOOLS = {
  connection_look: {
    name: 'connection_look',
    title: 'Give a connection its logo and page',
    description:
      'Give a Custom connection (an MCP server or API you set up) its logo (an https SVG address) and a page built from what it can read: read the whombat:connection-pages skill first. Without save it only tries and says what the page would show and what is wrong; fix that, then save.',
    input: ConnectionLookInput,
    output: ConnectionLookOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  } satisfies McpTool<typeof ConnectionLookInput, typeof ConnectionLookOutput> & { personal: true },
} as const;
