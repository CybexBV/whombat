import { AI_GATEWAY_RELAY_PREFIX } from '@whombat/core';
import { DEMO_PREFIX } from '../demo/routes';
import { ONEPASSWORD_DEV_PATH } from '../vault/onepassword/testing/routes';

/**
 * Paths the loopback listener serves (MA-10, MR-04): the runner protocol, agents' MCP, the AI gateway relay a gateway
 * turn's CLI reaches through the runner (docs/decisions/ai-gateway.md AIG-08), the demo's controls and a development
 * box's stand-in 1Password (runner token; each answers 404 where it is off).
 * People and their devices reach Whombat only through encrypted sessions.
 */
export function isApplianceLocalPath(path: string): boolean {
  return (
    path.startsWith('/internal/runner/') ||
    path.startsWith(`${DEMO_PREFIX}/`) ||
    path === ONEPASSWORD_DEV_PATH ||
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path.startsWith(`${AI_GATEWAY_RELAY_PREFIX}/`)
  );
}
