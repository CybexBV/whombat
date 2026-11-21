/**
 * Where tolerant decoding stops (AP-266, amends AP-255 and updates.md UP-B3b). Tolerant decoding leaves out what this
 * app doesn't know; in a security view that can hide what matters — a device that still has access vanishes from the
 * Devices list, an approved key shows as off. These answers are decoded strictly: a mismatch is a
 * `NeedsNewerAppError`, and the screen says it needs a newer version of the app.
 *
 * - session ops: endpoints (devices), enrollment (claim, pairing, device links), recovery, passkeys, and the recovery
 *   kit's backup material;
 * - API endpoints: approvals, API tokens, an agent's and an automation's keys, Vault keys. (Push
 *   registrations, `devices.*`, grant no access: they stay tolerant.)
 * - parts of an answer (AP-707): the agent's profile (`agent.get`) is read tolerantly except its keys (`grants`), which
 *   are read strictly. A newer runtime's new status, role or recent row no longer costs the whole agent screen; a key
 *   this app can't read still does.
 */

const STRICT_SESSION_PREFIXES = [
  'endpoints.',
  'enroll.',
  'recovery.',
  // What can open the Whombat (passkeys.md AP-788): a passkey this app can't read must not vanish from the list.
  'passkey.',
  'passkeys.',
  // Box passkeys (own-address.md): the same, for the passkeys of the box's own address.
  'boxPasskey.',
  // Who may get into the box and what they did (remote-help.md AP-4441): a grant, a connection or a step this app can't
  // read must not vanish from the card.
  'remoteHelp.',
] as const;
const STRICT_SESSION_OPS: ReadonlySet<string> = new Set(['backup.recoveryMaterial']);

const STRICT_API_PREFIXES = ['approvals.'] as const;
const STRICT_API_IDS: ReadonlySet<string> = new Set([
  'auth.listTokens',
  'auth.createToken',
  'auth.revokeToken',
  'agent.setKeys',
  'automations.get',
  'automations.saveDraft',
  'automations.discardDraft',
  'automations.publish',
  'automations.setEnabled',
  'automations.setKeys',
  'automations.webhook',
  'vault.giveKey',
  'vault.takeKey',
]);

/** Whether a session-native op's answer is decoded strictly. */
export function isStrictSessionOp(op: string): boolean {
  return STRICT_SESSION_OPS.has(op) || STRICT_SESSION_PREFIXES.some((p) => op.startsWith(p));
}

/** Whether an API endpoint's answer (by endpoint id) is decoded strictly. */
export function isStrictEndpoint(id: string): boolean {
  return STRICT_API_IDS.has(id) || STRICT_API_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * Answers read tolerantly except some of their members, read strictly (AP-707): endpoint id → the members. A mismatch
 * in one of them is a `NeedsNewerAppError`, as for a strict endpoint; anything else is left out as elsewhere.
 */
const STRICT_API_PARTS: ReadonlyMap<string, readonly string[]> = new Map([['agent.get', ['grants']]]);

/** The members of an endpoint's answer (by endpoint id) decoded strictly, or null when there are none. */
export function strictPartsOf(id: string): readonly string[] | null {
  return STRICT_API_PARTS.get(id) ?? null;
}
