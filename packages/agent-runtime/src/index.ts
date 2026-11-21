/**
 * @whombat/agent-runtime — agent turns on Hermes Agent (hermes-engine.md HE-01): the provider, the CLIs it runs (their
 * sign-in, checks and model lists), the managed sandbox, workspaces and the agent's words.
 */
import type { AgentProvider as AgentProviderKind } from '@whombat/core';

/** What an agent runs on (`AgentModelRuntime.provider`): Claude Code, Codex, or a model on the person's network. */
export type ProviderKind = AgentProviderKind;

export {
  agentEnv,
  agentEnvExtras,
  type Confinement,
  credentialPaths,
  findBwrap,
  identityEnv,
  onPath,
  toolchainConfigPaths,
} from './access';
export * from './access/managed/index';
export * from './acp/index';
export {
  ATTACHMENT_LIMITS,
  attachmentSection,
  type Delivery,
  describeAttachment,
  fileSize,
  needsBytes,
  type PlannedAttachment,
  planAttachments,
} from './attachments';
export {
  type AgentProvider,
  type Availability,
  BASIC_CAPABILITIES,
  type ModelListRequest,
  type PodNeeds,
  type ProviderCapabilities,
  type Sandbox,
  type SandboxNeeds,
  TOOL_OUTPUT_TAIL,
  type ToolAsk,
  type ToolAskAnswer,
  type ToolCategory,
  type ToolEventIds,
  type ToolOutcome,
  type TurnAttachment,
  type TurnEvent,
  type TurnGateway,
  type TurnHost,
  type TurnInput,
  type TurnPod,
  type TurnSteer,
  type TurnSteering,
  type TurnUsage,
  type TurnVaultMcpServer,
  unavailableKind,
} from './contract';
export * from './credentials';
export {
  classifyTurnFailure,
  type FailureSignals,
  gatewayRoomAt,
  providerDeclinedContent,
} from './failures';
export {
  FILES_HOME_LINE,
  FILES_IN_HOME,
  FILES_LEFT_OUT_NAMED,
  type FileLeftOut,
  filesTurnLines,
  planTurnFiles,
  type TurnFilesPlan,
} from './files';
export * from './hermes/index';
export { defaultWhombatHome, defaultWorkspaceRoot } from './host';
export { connectWhombatMcp, type McpTarget, type ToolCallResult, type WhombatMcp } from './mcp-client';
export * from './models/index';
export { isOutsideTurn } from './outside';
export * from './persona/index';
export { type CliKind, cliAvailability, listCliModels } from './providers/cli-check';
export * from './usage/index';
export {
  type BranchChanges,
  type CleanupResult,
  type CommitPaths,
  fenceIsStale,
  type GitCredentialsProvider,
  type HostLock,
  hostLock,
  hostLockWaiters,
  LockBusyError,
  type PreparedWorkspace,
  pullRequestRef,
  WorkspaceBusyError,
  type WorkspaceFence,
  WorkspaceFencedError,
  WorkspaceManager,
  type WorkspaceManagerOptions,
  type WorkspaceTarget,
  withHostLock,
} from './workspace';
