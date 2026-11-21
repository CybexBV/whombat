/**
 * `@whombat/agent-runtime/providers`: provider identities on a managed appliance (docs/decisions/managed-providers.md):
 * the eligibility policy, credential states, pinned bundles and drift, credential homes, the sign-in
 * drivers of the providers' own CLIs, and the credential of a managed turn.
 */

export * from '../usage/index';
export * from './bundles';
export * from './cli-check';
export * from './clients';
export * from './credential-home';
export * from './drift';
export * from './eligibility';
export * from './gateway-home';
export {
  CHATGPT_STEPS_MODULE,
  type ChatgptDeviceLoginOptions,
  type ChatgptLendRefusal,
  ChatgptStepError,
  type ChatgptSteps,
  type ChatgptUsageOptions,
  chatgptAccessTokenLogin,
  chatgptDeviceLogin,
  chatgptInstall,
  chatgptLend,
  chatgptLoginFailure,
  chatgptModelLabel,
  chatgptModels,
  chatgptModelsFrom,
  chatgptRemove,
  chatgptSteps,
  chatgptUsageFrom,
  chatgptUsageProbe,
  jwtExpiry,
  openaiApiKeyLogin,
} from './login/chatgpt';
export {
  CLAUDE_SDK_SUBSCRIPTION_GONE,
  CLAUDE_SUBSCRIPTION_CONSOLE_PENDING,
  claudeApiKeyLogin,
  claudeKeyShapeOk,
  claudeLoginStatus,
  claudeLogout,
} from './login/claude';
export { type CliResult, type CliRun, loginEnv, redact, runCli } from './login/cli';
export {
  CLAUDE_CONSOLE_ARGS,
  ClaudeConsoleLogin,
  type ClaudeConsoleOptions,
  CONSOLE_TERM,
  type ConsoleOutcome,
  type ConsoleStopReason,
  claudeAuthStatus,
  claudeConsoleEnv,
} from './login/console';
export {
  type DeviceCode,
  type DeviceLogin,
  deviceFailure,
  githubDeviceParser,
  type LoginFailure,
  type LoginOutcome,
  startDeviceLogin,
} from './login/device';
export {
  type GitHubLoginOptions,
  githubDeviceLogin,
  githubLogout,
  githubStatus,
  githubToken,
  githubTokenLogin,
} from './login/github';
export { type Fetch, type Verification, verifyAnthropicKey, verifyOpenAIKey } from './login/verify';
export * from './signin-executor';
export * from './states';
export * from './turn-credential';
export * from './types';
