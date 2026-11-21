/** The ACP client Hermes is driven with (hermes-engine.md HE-01, HE-S15): negotiation, events, permissions, prompts. */
export { ACP_PROTOCOL_VERSION, type AcpNegotiated, negotiatedFrom } from './capabilities';
export { AcpEventMapper } from './events';
export {
  decidePermission,
  describeToolCall,
  type KnownToolCall,
  type PermissionDecision,
  type PermissionPolicy,
  permissionResponse,
  whombatToolName,
} from './permissions';
export { acpPromptContent } from './prompt';
export { ACP_MAX_LINE_BYTES, boundedNdJsonStream, isJsonRpcMessage } from './stream';
