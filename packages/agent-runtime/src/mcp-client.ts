/**
 * A small client for the Whombat MCP server (`/mcp`, streamable HTTP, per-dispatch agent token): the runner posts a
 * turn's final text through it when the agent did not post one.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolInput, McpToolName } from '@whombat/core';

export interface ToolCallResult {
  /** False on a tool error (validation, forbidden, conflict, rate limit …) or a `blocked` outcome. */
  ok: boolean;
  isError: boolean;
  /** `structuredContent`: the commit outcome, or `{error: {code, message}}`. */
  body: Record<string, unknown>;
}

export interface WhombatMcp {
  call<N extends McpToolName>(name: N, args: McpToolInput<N>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface McpTarget {
  url: string;
  token: string;
}

export async function connectWhombatMcp(
  target: McpTarget,
  clientName = 'whombat-runner',
): Promise<WhombatMcp> {
  const client = new Client({ name: clientName, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: { Authorization: `Bearer ${target.token}` } },
  });
  await client.connect(transport);
  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const body = (res.structuredContent ?? {}) as Record<string, unknown>;
      const isError = res.isError === true;
      return { ok: !isError && body.status !== 'blocked', isError, body };
    },
    close: () => client.close(),
  };
}
