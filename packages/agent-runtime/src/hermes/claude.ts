/** Claude Code model clients: the person's sign-in and an explicitly chosen AI gateway stay separate routes. */
export const CLAUDE_DIRECTSDK_PROVIDER = 'claude-subscription-directsdk-experimental';
export const CLAUDE_GATEWAY_PROVIDER = 'whombat-claude-gateway';

/** No gateway key is written here: a task uses its turn token, a pod uses the forwarder's placeholder. */
export function claudeGatewayPlugins(
  base: Record<string, unknown>,
  baseUrl: string,
  pod: boolean,
): Record<string, unknown> {
  const entries = (base.entries ?? {}) as Record<string, Record<string, unknown>>;
  const entry = entries[CLAUDE_DIRECTSDK_PROVIDER] ?? {};
  return {
    ...base,
    enabled: [...new Set([...(base.enabled as string[]), 'whombat', CLAUDE_DIRECTSDK_PROVIDER])],
    entries: {
      ...entries,
      [CLAUDE_DIRECTSDK_PROVIDER]: {
        ...entry,
        settings: {
          ...((entry.settings ?? {}) as Record<string, unknown>),
          claude_code_telemetry: false,
          whombat_gateway: { base_url: baseUrl, pod },
        },
      },
    },
  };
}
