/** Test helper: an MCP client for `/mcp` authenticated with an agent token. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_PATH } from '@whombat/core';

export interface TestMcp {
  client: Client;
  /** Calls a tool; returns `structuredContent` plus the MCP error flag. */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function mcpClient(baseUrl: string, token: string): Promise<TestMcp> {
  const client = new Client({ name: 'whombat-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_PATH, baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return {
    client,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      return {
        isError: res.isError === true,
        body: (res.structuredContent ?? {}) as Record<string, unknown>,
      };
    },
    close: () => client.close(),
  };
}
