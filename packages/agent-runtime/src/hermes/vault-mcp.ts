/**
 * The turn person's Vault MCP entries as Hermes's own MCP servers for that turn (contracts CT-1241; hermes-engine.md
 * HE-S154): `mcp_servers.vault_<entry key>` in the turn's `config.yaml`, its address and sign-in headers only
 * as `${VAR}` placeholders, which Hermes fills from its environment for this turn (`WHOMBAT_VAULT_MCP_<n>_…`); the
 * tools the person left on as `tools.include`. The secret is never in a file; the plugin keeps the variables from every
 * command and from the CLI (`whombat_hermes/env.py`), and Claude Code gets the servers through `--mcp-config` as every
 * Hermes MCP server. The runner opens each server's address for the turn (`endpointAllowance`).
 */
import type { TurnVaultMcpServer } from '../contract';

/** Every variable of a Vault MCP server starts so (the plugin treats it as a credential). */
export const VAULT_MCP_ENV_PREFIX = 'WHOMBAT_VAULT_MCP_';

const urlVar = (n: number) => `${VAULT_MCP_ENV_PREFIX}${n}_URL`;
const headerVar = (n: number, h: number) => `${VAULT_MCP_ENV_PREFIX}${n}_H${h}`;

/** `mcp_servers` of the turn's config: placeholders only. */
export function vaultMcpConfig(servers: readonly TurnVaultMcpServer[]): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((s, n) => [
      s.name,
      {
        url: `\${${urlVar(n)}}`,
        ...(s.headers.length
          ? { headers: Object.fromEntries(s.headers.map((h, i) => [h.name, `\${${headerVar(n, i)}}`])) }
          : {}),
        tools: { include: [...s.tools] },
      },
    ]),
  );
}

/** The values behind the placeholders: Hermes's environment for this turn only. */
export function vaultMcpEnv(servers: readonly TurnVaultMcpServer[]): Record<string, string> {
  const env: Record<string, string> = {};
  servers.forEach((s, n) => {
    env[urlVar(n)] = s.url;
    s.headers.forEach((h, i) => {
      env[headerVar(n, i)] = h.value;
    });
  });
  return env;
}
