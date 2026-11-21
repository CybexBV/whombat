/**
 * Provider identities on a managed appliance (docs/decisions/managed-providers.md; one-person.md OP-09): which providers
 * and authentication modes exist, the workflows, and the credential states people see. Pure: no I/O,
 * so the server, the runner and tests share it.
 */

/** Model providers with a Whombat adapter (ACP and the scripted demo are not provider identities). */
export const MODEL_PROVIDERS = ['claude', 'codex'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Everything a person can sign in to on the appliance: the model providers and GitHub. */
export const CREDENTIAL_PROVIDERS = ['claude', 'codex', 'github'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/**
 * Authentication modes per provider (the `authMode` of `appliance.status.providers[]`, CT-24):
 * - claude `api_key`: the person's own Anthropic Console API key, read by the Claude Code
 *   binary through its `apiKeyHelper`.
 * - claude `cloud`: a customer's Bedrock / Google Cloud / Foundry credential (no sign-in built yet).
 * - claude `subscription_sdk`: a Claude.ai subscription login through the Agent SDK — never used (Whombat runs the
 *   binary, SUB-02, SUB-10; excluded everywhere).
 * - claude `subscription_cli`: a person signed in to the unmodified Claude Code binary through Anthropic's own flow,
 *   Whombat driving that binary (`ClaudeProvider`, the CLI's login in the home's `config/`; SUB-01…SUB-03).
 * - codex `api_key`: an OpenAI API key (`codex login --with-api-key`).
 * - codex `chatgpt`: ChatGPT sign-in by device code (`codex login --device-auth`).
 * - codex `access_token`: a Business/Enterprise Codex access token its creator stored (`--with-access-token`).
 * - github `device`: GitHub CLI's device flow (`gh auth login --web`, no localhost callback).
 * - github `token`: a personal access token the person pasted (`gh auth login --with-token`).
 */
export const AUTH_MODES = {
  claude: ['api_key', 'cloud', 'subscription_sdk', 'subscription_cli'],
  codex: ['api_key', 'chatgpt', 'access_token'],
  github: ['device', 'token'],
} as const satisfies Record<CredentialProvider, readonly string[]>;
export type AuthMode<P extends CredentialProvider = CredentialProvider> = (typeof AUTH_MODES)[P][number];

export function isAuthMode<P extends CredentialProvider>(provider: P, mode: string): mode is AuthMode<P> {
  return (AUTH_MODES[provider] as readonly string[]).includes(mode);
}

/**
 * The workflow a run belongs to (provider-evidence.md; one-person.md OP-09): `PI` the person asks the agent that runs
 * on their own credential (or what carries on from their asking); `NA` an automation of theirs runs on it while they
 * are away (outsiders' input included).
 */
export const WORKFLOWS = ['PI', 'NA'] as const;
export type Workflow = (typeof WORKFLOWS)[number];

/**
 * The path segment of the burrow's AI gateway's homes (`<root>/gateway/<connectionId>/<provider>`, Whombat ai-gateway.md
 * AIG-10); never an account id (`acc_…`).
 */
export const GATEWAY_OWNER_SEGMENT = 'gateway';

/** A gateway connection's id as a path segment (`con_…`, contracts' `ConnectionId`): never `..`, `/` or a path. */
export const GATEWAY_CONNECTION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/** `appliance.status.providers[].state` (contracts 0.4.0, CT-24). */
export const CREDENTIAL_STATES = [
  'ready',
  'not_signed_in',
  'quota_exhausted',
  'auth_expired',
  'auth_revoked',
  'outage',
  'version_drift',
  'gated',
] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/** States a turn's failure reports about the credential (the others come from configuration, not from a run). */
export type RunSignalState = Extract<
  CredentialState,
  'quota_exhausted' | 'auth_expired' | 'auth_revoked' | 'outage'
>;

/** People's name for each sign-in's provider: `codex` is ChatGPT (contracts 2.1, CT-1450; hermes-native.md HN-K13). */
export const PROVIDER_NAMES: Record<CredentialProvider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  github: 'GitHub',
};

export const AUTH_MODE_NAMES: Record<string, string> = {
  'claude:api_key': 'Anthropic API key',
  'claude:cloud': 'cloud provider credential',
  'claude:subscription_sdk': 'Claude subscription',
  'claude:subscription_cli': 'Claude subscription (Claude Code sign-in)',
  'codex:api_key': 'OpenAI API key',
  'codex:chatgpt': 'ChatGPT account',
  'codex:access_token': 'Codex access token',
  'github:device': 'GitHub account',
  'github:token': 'GitHub token',
};

export function authModeName(provider: CredentialProvider, mode: string): string {
  return AUTH_MODE_NAMES[`${provider}:${mode}`] ?? mode;
}
