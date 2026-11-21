/**
 * Host paths (S-03): `WHOMBAT_HOME` and the workspaces root. One implementation for the server and the runner:
 * `@whombat/agent-runtime/host` (Node only, no providers).
 */
export {
  type HostPathSettings,
  type HostPaths,
  hostPathIssues,
  hostPaths,
} from '@whombat/agent-runtime/host';
