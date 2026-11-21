/**
 * Limits of the Vault's and connections' own network code that contracts 0.125 no longer name (the relays that shared
 * them went, hermes-engine.md HE-43): the server keeps them for the calls it still makes — connection tools, an
 * entry's check, SSH sign-in and adding a server.
 */

/** Longest request body Whombat sends for a connection or an entry's check. */
export const VAULT_REQUEST_BODY_MAX = 256 * 1024;
/** How long an idle MCP or connection client stays open. */
export const VAULT_POOL_IDLE_MS = 5 * 60_000;
/** Keep-alive of an SSH connection Whombat holds. */
export const VAULT_SSH_KEEPALIVE_MS = 15_000;
/** Longest tool output an entry's check reads. */
export const VAULT_TOOL_OUTPUT_MAX = 64 * 1024;
