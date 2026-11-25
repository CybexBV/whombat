/**
 * `@whombat/client` — typed HTTP client over the `@whombat/core` REST contract and the reconnecting
 * realtime client. Shared by web and React Native (no DOM-only APIs here).
 *
 * Subpaths: `@whombat/client/query` (TanStack Query keys, options, cache reducers),
 * `@whombat/client/react` (provider and hooks), `@whombat/client/web` (browser helpers).
 */

export * from './agentFace';
export * from './agentKeys';
export * from './agentManage';
export * from './agentName';
export * from './agentPermissions';
export * from './assessment';
export * from './automationAsker';
export * from './automationView';
export * from './avatarPhoto';
export * from './backup';
export * from './cardDisplay';
export * from './cardFrame';
export * from './chat';
export * from './codeTokens';
export * from './composer';
export * from './conversations';
export * from './council';
export * from './councilSetups';
export * from './delegation';
export * from './delegationAi';
export * from './featureRequest';
export * from './files';
export * from './gateway';
export * from './guides';
export * from './handoff';
export * from './home';
export * from './host';
export * from './http/client';
export * from './http/errors';
export * from './http/problem';
export type * from './http/types';
export * from './imap';
export * from './inbox';
export * from './job';
export * from './jobResult';
export * from './keptSites';
export * from './localModel';
export * from './memory';
export * from './mermaid';
export * from './modelEffort';
export * from './movedCard';
export * from './notifications';
export * from './onePassword';
export * from './paths';
export * from './places';
export * from './prompts';
export * from './pullRequests';
export * from './realtime/realtime';
export * from './runs';
export * from './schedules';
export {
  type ApplianceSession,
  OutcomeRedactedError,
  OutcomeUnknownError,
  phaseForError,
  SessionClosedError,
  wentThrough,
} from './session';
export * from './settingsGroups';
export * from './shares';
export { isStrictEndpoint, isStrictSessionOp } from './strict';
export * from './svg';
export * from './teamReports';
export * from './threads';
export {
  isUnsupportedCard,
  itemsNeedNewerApp,
  type LeftOut,
  leftOut,
  NEEDS_NEWER_APP,
  PART_NEEDS_NEWER_APP,
  SCREEN_NEEDS_NEWER_APP,
  UNSUPPORTED_CARD,
  unsupportedItems,
} from './tolerant';
export * from './trackerItem';
export * from './uploads';
export * from './usageView';
export * from './vaultAsk';
export * from './vaultForm';
export * from './vaultRow';
export * from './vaultSaved';
export * from './working';
export * from './workLine';
