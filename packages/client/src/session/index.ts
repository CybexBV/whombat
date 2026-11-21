/**
 * `@whombat/client/session` — the appliance session (AP-10): the end-to-end secure session (through the relay or
 * directly to the box), the realtime adapter over session subscriptions, durable command tracking, cache
 * scoping and resource helpers.
 */
export * from './commands';
export * from './connector';
export * from './console';
export * from './direct';
export { base32, newRequestId } from './ids';
export type { ListenerErrorHook } from './listeners';
export * from './managed-ops';
export * from './realtime';
export * from './resources';
export * from './scope';
export {
  createSecureSession,
  defaultIsDestructive,
  errorResponse,
  type RetryPolicy,
  resetName,
  retryPolicy,
  type SecureSessionOptions,
} from './secure';
export * from './types';
export {
  CLIENT_PROTOCOL,
  ConnectError,
  type ConnectRequest,
  encodeFrame,
  frameReader,
  type SessionConnector,
  type WireConnection,
} from './wire';
