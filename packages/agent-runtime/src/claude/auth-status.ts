/**
 * `claude auth status --json` (Claude Code 2.1.283): the CLI's own answer about its own login. Whombat reads a
 * Claude sign-in's state only from this and from turn errors, never from the CLI's credential files
 * (docs/decisions/provider-subscriptions.md SUB-03). Exit code 0 when signed in, 1 when not; stdout is JSON either
 * way. `authMethod`: `claude.ai` (a subscription login), `oauth_token` (`CLAUDE_CODE_OAUTH_TOKEN`), `api_key`
 * (`ANTHROPIC_API_KEY`), `api_key_helper` (flag settings' `apiKeyHelper`), `third_party` (Bedrock, Google Cloud,
 * Foundry) or `none`. A subscription login also names `email`, `orgName` and `subscriptionType`; Whombat keeps none
 * of those (they're the person's, not needed to run turns). Pure.
 */

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`, `none` (or a newer value). */
  authMethod: string;
  /** `firstParty`, `bedrock`, `vertex`, `foundry`, `gateway`, … */
  apiProvider: string | null;
  /** A Claude subscription login (claude.ai, or a long-lived token from `claude setup-token`). */
  subscription: boolean;
}

export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let json: unknown;
  try {
    json = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (typeof r.loggedIn !== 'boolean') return null;
  const authMethod = typeof r.authMethod === 'string' ? r.authMethod : 'none';
  return {
    loggedIn: r.loggedIn,
    authMethod,
    apiProvider: typeof r.apiProvider === 'string' ? r.apiProvider : null,
    subscription: r.loggedIn && (authMethod === 'claude.ai' || authMethod === 'oauth_token'),
  };
}
