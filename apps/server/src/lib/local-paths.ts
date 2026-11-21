import { AI_GATEWAY_RELAY_PREFIX } from '@whombat/core';
import { DEMO_PREFIX } from '../demo/routes';

/**
 * Paths the loopback listener serves (MA-10, MR-04): the runner protocol, agents' MCP, the AI gateway relay a gateway
 * turn's CLI reaches through the runner (docs/decisions/ai-gateway.md AIG-08) and the demo's controls (runner token).
 * People and their devices reach Whombat only through encrypted sessions.
 */
export function isApplianceLocalPath(path: string): boolean {
  return (
    path.startsWith('/internal/runner/') ||
    path.startsWith(`${DEMO_PREFIX}/`) ||
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path.startsWith(`${AI_GATEWAY_RELAY_PREFIX}/`)
  );
}
