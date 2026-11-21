/**
 * What an agent does with a tool answer that isn't `ok` (Whombat resourceful-agents.md RA-12, contracts 0.44.0): never
 * “stop”. The agent obeyed “stop” every time it read it; these lines keep it working. Used in the tool descriptions and
 * copy the contracts carry; the runtime's prompt says the same.
 */

/**
 * `pending_approval` (a person was asked): “do what doesn’t depend on it, then end your turn with one line saying what
 * waits; the answer wakes you”.
 */
export const PENDING_APPROVAL_GUIDANCE =
  'do what doesn’t depend on it, then end your turn with one line saying what waits; the answer wakes you';

/**
 * `blocked` (a key that is Off): “ask for the key with request_approval (grant_key) in one line and carry on with what
 * you can do without it”.
 */
export const BLOCKED_GUIDANCE =
  'ask for the key with request_approval (grant_key) in one line and carry on with what you can do without it';
