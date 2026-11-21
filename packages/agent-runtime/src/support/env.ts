/**
 * Environment for provider subprocesses. Agents run shell commands that inherit the CLI's environment, so
 * it is built from an allowlist, not by stripping known secrets: the runner's token, the server's secrets
 * from a shared `.env` (database, master key, SMTP, push keys, leftover GitHub App settings), git credentials
 * and the operator's SSH agent must never reach an agent, whatever they are called.
 *
 * Passed: what any CLI and the tools it runs need (paths, user, locale, terminal, temp dirs, proxies, CA
 * certificates), the provider's own login variables, and names the operator lists explicitly
 * (`WHOMBAT_PROVIDER_ENV`, comma-separated). Never passed, even when listed: `FORBIDDEN_ENV`.
 */

/** What a CLI and its tools need to run. */
const SYSTEM_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TZ|TMPDIR|TMP|TEMP|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|XDG_RUNTIME_DIR|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$/;

/**
 * Never passed to a provider, whatever a caller lists: the runner's and the server's settings and secrets,
 * git credentials (`GIT_CONFIG_*` carries the push token's header), GitHub tokens and the SSH agent.
 */
const FORBIDDEN_ENV =
  /^(RUNNER_|WHOMBAT_|DATABASE_URL$|PG[A-Z]*$|SMTP_|GITHUB_|GH_|GIT_|SSH_|VAPID_|FCM_|APNS_|NODE_OPTIONS$)/;

/** Name of the env var carrying the per-dispatch MCP bearer token (never on a command line). */
export const MCP_TOKEN_ENV = 'WHOMBAT_MCP_TOKEN';

/** Operator setting: extra variable names a provider may see (a custom model provider's key, …). */
export const PROVIDER_ENV_SETTING = 'WHOMBAT_PROVIDER_ENV';

export interface ProviderEnvOptions {
  /** The provider's login variables (model keys, endpoints), given the whole base env. */
  login?: (key: string, env: NodeJS.ProcessEnv) => boolean;
  /** Extra names to pass (default: `WHOMBAT_PROVIDER_ENV` of the base env). */
  pass?: readonly string[];
}

/** Names listed in `WHOMBAT_PROVIDER_ENV`. */
export function listedProviderEnv(env: NodeJS.ProcessEnv): string[] {
  return (env[PROVIDER_ENV_SETTING] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True for variables that must never reach an agent. */
export function isForbiddenEnv(key: string): boolean {
  return FORBIDDEN_ENV.test(key);
}

/** The base environment for a provider subprocess (the caller adds the MCP token and its own settings). */
export function providerEnv(env: NodeJS.ProcessEnv, options: ProviderEnvOptions = {}): NodeJS.ProcessEnv {
  const pass = new Set(options.pass ?? listedProviderEnv(env));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isForbiddenEnv(key)) continue;
    if (SYSTEM_ENV.test(key) || pass.has(key) || options.login?.(key, env)) out[key] = value;
  }
  return out;
}

/**
 * Any variable that could carry a provider login or another credential (model keys, cloud credentials, tokens,
 * secrets). A managed turn's provider never takes one of these from the runner's environment or an operator's list:
 * its login comes only from the person's credential home (docs/decisions/managed-providers.md PV-04).
 */
const LOGIN_LIKE_ENV =
  /^(OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|AZURE_|AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|VERTEX_|CLOUD_ML_|BEDROCK_|FOUNDRY_|GH_|GITHUB_|HF_)|(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|_KEY)$/i;

/** Names a managed turn may still pass through (`passEnv`, `WHOMBAT_PROVIDER_ENV`): none that look like a login. */
export function managedPassEnv(names: readonly string[]): string[] {
  return names.filter((name) => !LOGIN_LIKE_ENV.test(name) && !isForbiddenEnv(name));
}

/**
 * Variables that point a provider CLI at a model login or endpoint of its own: Anthropic's and OpenAI's families,
 * Codex's, Claude Code's cloud switches and OAuth token, its config dir. A turn through the burrow's AI gateway takes
 * none of them from the runner's environment, a trusted agent's included (Whombat ai-gateway.md AIG-10): its CLI reaches
 * the gateway and nothing else, whoever's key the runner happens to hold.
 */
const MODEL_LOGIN_ENV =
  /^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|CODEX_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CONFIG_DIR$)/;

/** `env` without the variables of any model login (`MODEL_LOGIN_ENV`). */
export function withoutModelLogins(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!MODEL_LOGIN_ENV.test(key)) out[key] = value;
  return out;
}
